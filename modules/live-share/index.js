// live-share: share this device's live state with other IRMS apps through a share code.
//
// Host side: only possible while live telemetry upload is on (the collector refuses a share for
// a run that is not ingesting). The module pushes a compact snapshot a few times per second and
// receives the viewer list and any queued setting changes in the same response. Viewers are
// read-only until the host ticks "allow changes" for them; a change is applied by the app, which
// re-validates it and refuses it while a session is running.
//
// Viewer side: join with a code, then long-poll for new state. No telemetry is needed to watch.
//
// Needs ctx.liveShare (App 1.2.0-beta.16+). No other module can reach these capabilities.

const PUSH_MIN_INTERVAL_MS = 250
const HEARTBEAT_MS = 2000
const VIEWER_RETRY_MS = 2000
const LONG_POLL_TIMEOUT_MS = 25000
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/

export function normalizeCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '')
  return CODE_RE.test(code) ? code : null
}

export const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`

const errorText = (body, fallback) =>
  body && typeof body === 'object' && typeof body.error === 'string' ? body.error : fallback

/** Host session: create a share, push snapshots, relay viewer permissions and commands. */
export function createHost(api, { setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  const s = {
    status: 'idle', // idle | starting | sharing | ended
    code: null,
    error: null,
    viewers: [],
    lastCommand: null,
    warning: null
  }
  let token = null
  let unsubscribe = null
  let timer = null
  let dirty = false
  let inFlight = false
  let lastPush = 0
  const listeners = new Set()
  const emit = () => listeners.forEach((fn) => fn(s))

  function end(reason) {
    if (unsubscribe) unsubscribe()
    unsubscribe = null
    if (timer != null) clearTimer(timer)
    timer = null
    token = null
    s.status = 'ended'
    s.error = reason
    s.viewers = []
    emit()
  }

  async function call(method, path, body) {
    return api.request({ method, path, token, body })
  }

  async function push() {
    inFlight = true
    dirty = false
    lastPush = now()
    try {
      const state = { ...api.snapshot(), lastCommand: s.lastCommand }
      const res = await call('POST', `/v1/share/${s.code}/state`, { state })
      if (s.status !== 'sharing') return
      if (res.status !== 200) {
        end(errorText(res.body, `分享已結束(${res.status})`))
        return
      }
      s.warning = null
      s.viewers = Array.isArray(res.body.viewers) ? res.body.viewers : []
      for (const cmd of res.body.commands ?? []) {
        const result = cmd.type === 'setParams' ? api.applyParams(cmd.params ?? {}) : { ok: false, error: '不支援的指令' }
        s.lastCommand = { id: cmd.id, viewerName: cmd.viewerName, ok: result.ok, error: result.error ?? null, at: cmd.at }
        dirty = true // tell viewers the outcome on the next push
      }
      emit()
    } catch (err) {
      s.warning = `網路暫時無法連線:${err instanceof Error ? err.message : String(err)}`
      emit()
    } finally {
      inFlight = false
    }
  }

  function tick() {
    timer = null
    if (s.status !== 'sharing') return
    const since = now() - lastPush
    if (!inFlight && ((dirty && since >= PUSH_MIN_INTERVAL_MS) || since >= HEARTBEAT_MS)) void push()
    timer = setTimer(tick, PUSH_MIN_INTERVAL_MS)
  }

  return {
    state: s,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async start() {
      if (s.status === 'starting' || s.status === 'sharing') return
      s.status = 'starting'
      s.error = null
      emit()
      try {
        const tel = await api.telemetry()
        if (!tel.enabled) {
          s.status = 'idle'
          s.error = '需先在「設定 → 隱私」開啟即時遙測上傳,並等待資料開始上傳後再分享。'
          emit()
          return
        }
        const res = await api.request({ method: 'POST', path: '/v1/share', body: { runId: tel.runId } })
        if (res.status !== 200) {
          s.status = 'idle'
          s.error = errorText(res.body, `無法建立分享(${res.status})`)
          emit()
          return
        }
        token = res.body.hostToken
        s.code = res.body.code
        s.status = 'sharing'
        s.lastCommand = null
        unsubscribe = api.subscribe(() => {
          dirty = true
        })
        dirty = true
        emit()
        tick()
      } catch (err) {
        s.status = 'idle'
        s.error = `無法建立分享:${err instanceof Error ? err.message : String(err)}`
        emit()
      }
    },
    async setCanEdit(viewerId, canEdit) {
      if (s.status !== 'sharing') return
      const res = await call('POST', `/v1/share/${s.code}/viewers/${viewerId}`, { canEdit })
      if (res.status === 200) s.viewers = res.body.viewers
      emit()
    },
    async kick(viewerId) {
      if (s.status !== 'sharing') return
      const res = await call('DELETE', `/v1/share/${s.code}/viewers/${viewerId}`)
      if (res.status === 200) s.viewers = res.body.viewers
      emit()
    },
    async stop() {
      if (s.status !== 'sharing') return
      const code = s.code
      const t = token
      end(null)
      s.status = 'idle'
      emit()
      try {
        await api.request({ method: 'DELETE', path: `/v1/share/${code}`, token: t })
      } catch {
        // The server also closes the share once the host stops pushing.
      }
    }
  }
}

/** Viewer session: join by code and follow the host's state. */
export function createViewer(api, { setTimer = setTimeout } = {}) {
  const s = {
    status: 'idle', // idle | joining | watching | ended
    code: null,
    error: null,
    live: null,
    updatedAt: null,
    canEdit: false,
    notice: null
  }
  let token = null
  let version = 0
  let generation = 0
  const listeners = new Set()
  const emit = () => listeners.forEach((fn) => fn(s))

  function end(reason) {
    generation++
    token = null
    s.status = 'ended'
    s.error = reason
    emit()
  }

  async function poll(gen) {
    while (gen === generation) {
      try {
        const res = await api.request({
          method: 'GET',
          path: `/v1/share/${s.code}/state?after=${version}`,
          token,
          timeoutMs: LONG_POLL_TIMEOUT_MS
        })
        if (gen !== generation) return
        if (res.status !== 200) {
          end(res.status === 401 ? '主機已將你移出此分享。' : errorText(res.body, '分享已結束。'))
          return
        }
        version = res.body.version
        s.canEdit = Boolean(res.body.canEdit)
        if (res.body.state != null) s.live = res.body.state
        s.updatedAt = res.body.updatedAt
        s.error = null
        emit()
      } catch (err) {
        if (gen !== generation) return
        s.error = `網路暫時無法連線,重試中:${err instanceof Error ? err.message : String(err)}`
        emit()
        await new Promise((r) => setTimer(r, VIEWER_RETRY_MS))
      }
    }
  }

  return {
    state: s,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async join(rawCode, name) {
      const code = normalizeCode(rawCode)
      if (!code) {
        s.error = '分享碼應為 8 個英數字(例如 AB12-CD34)。'
        emit()
        return
      }
      s.status = 'joining'
      s.error = null
      emit()
      try {
        const res = await api.request({ method: 'POST', path: `/v1/share/${code}/join`, body: { name } })
        if (res.status !== 200) {
          s.status = 'idle'
          s.error = errorText(res.body, `無法加入(${res.status})`)
          emit()
          return
        }
        token = res.body.viewerToken
        s.code = code
        s.canEdit = false
        s.live = null
        s.status = 'watching'
        version = 0
        emit()
        void poll(++generation)
      } catch (err) {
        s.status = 'idle'
        s.error = `無法加入:${err instanceof Error ? err.message : String(err)}`
        emit()
      }
    },
    async sendParams(params) {
      if (s.status !== 'watching') return
      const res = await api.request({ method: 'POST', path: `/v1/share/${s.code}/commands`, token, body: { type: 'setParams', params } })
      s.notice = res.status === 202 ? '已送出,等待主機套用…' : errorText(res.body, `送出失敗(${res.status})`)
      emit()
    },
    async leave() {
      if (s.status !== 'watching') return
      const code = s.code
      const t = token
      end(null)
      s.status = 'idle'
      s.live = null
      emit()
      try {
        await api.request({ method: 'POST', path: `/v1/share/${code}/leave`, token: t })
      } catch {
        // Idle viewers are dropped server-side anyway.
      }
    }
  }
}

// ── DOM rendering (no framework; uses the app's own CSS classes) ──

function h(tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'className') node.className = value
    else if (key === 'style') node.setAttribute('style', value)
    else if (key in node) node[key] = value
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const PHASE = { idle: '等待進入目標區', holding: '保持中', restPending: '已計一下,等待回到休息位' }
const deg = (v) => (v == null ? '—' : `${v}°`)

// Hosts before App beta.17 send zone.overLimit; newer hosts send limits { comfort, limit } (null = not measured).
function limitText(live) {
  if (live.limits) {
    const parts = []
    if (live.limits.comfort != null) parts.push(`舒適 ${live.limits.comfort}°`)
    if (live.limits.limit != null) parts.push(`極限 ${live.limits.limit}°`)
    return parts.length ? ` · ${parts.join(' · ')}` : ''
  }
  return live.zone.overLimit != null ? ` · 安全上限 ${live.zone.overLimit}°` : ''
}

function liveView(live, updatedAt) {
  if (!live) return h('p', { className: 'field-hint' }, '等待主機傳來第一筆資料…')
  const zone = live.zone.max == null ? `≥ ${live.zone.min}°` : `${live.zone.min}–${live.zone.max}°`
  const ageSec = updatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(updatedAt)) / 1000)) : null
  const flags = [
    live.demo ? '示範資料(非真實量測)' : null,
    live.connected ? '裝置已連線' : '裝置未連線',
    live.hardwareError ? `硬體錯誤 ${live.hardwareError}` : null,
    live.session.alarmActive ? '⚠ 超過極限範圍' : live.session.overComfort ? '超過舒適角度' : null
  ].filter(Boolean)
  return h(
    'div',
    { className: 'live-share-view' },
    h('p', { className: 'text-sm' }, flags.join(' · ')),
    h('div', { style: 'font-size:2.4rem;font-weight:600;line-height:1.1' }, deg(live.metric.value)),
    h('p', { className: 'text-text-muted text-sm' }, `${live.metric.label} · 目標 ${zone}${limitText(live)}`),
    h(
      'p',
      { className: 'text-sm' },
      live.session.running
        ? `療程進行中 · ${live.session.reps} 下 · ${PHASE[live.session.phase] ?? live.session.phase} · 保持 ${live.session.holdProgress}%`
        : '未在療程中'
    ),
    h(
      'p',
      { className: 'text-text-muted text-xs font-mono' },
      `目標 ${live.params.targetAngle}° ± ${live.params.tolerance}° · 保持 ${live.params.holdTimeMs} ms` +
        (ageSec != null ? ` · ${ageSec} 秒前更新` : '')
    ),
    live.lastCommand
      ? h(
          'p',
          { className: 'field-hint' },
          `最近一次遠端變更(${live.lastCommand.viewerName}):${live.lastCommand.ok ? '已套用' : `未套用 — ${live.lastCommand.error}`}`
        )
      : null
  )
}

function numberField(label, value, min, max, step) {
  const input = h('input', { type: 'number', value: String(value), min, max, step })
  return { input, node: h('div', { className: 'field', style: 'flex:1;min-width:110px' }, h('label', null, label), input) }
}

function renderHost(host) {
  const s = host.state
  if (s.status !== 'sharing') {
    return h(
      'div',
      null,
      h('p', { className: 'text-text-muted text-sm' }, '產生分享碼,讓其他 IRMS App 即時看到這台裝置的角度、療程進度與設定。預設只能觀看,可逐一允許變更設定。'),
      h('button', { className: 'btn btn-primary', disabled: s.status === 'starting', onclick: () => void host.start() }, s.status === 'starting' ? '建立中…' : '開始分享'),
      s.error ? h('p', { className: 'field-hint text-warning' }, s.error) : null
    )
  }
  return h(
    'div',
    null,
    h('p', { className: 'text-sm' }, '分享碼'),
    h('div', { className: 'font-mono', style: 'font-size:2rem;letter-spacing:.12em;font-weight:600' }, formatCode(s.code)),
    h(
      'div',
      { className: 'row', style: 'gap:8px;margin:8px 0' },
      h('button', { className: 'btn btn-secondary btn-sm', onclick: () => void navigator.clipboard?.writeText(formatCode(s.code)) }, '複製分享碼'),
      h('button', { className: 'btn btn-danger-ghost btn-sm', onclick: () => void host.stop() }, '停止分享')
    ),
    s.warning ? h('p', { className: 'field-hint text-warning' }, s.warning) : null,
    h('p', { className: 'text-sm', style: 'margin-top:8px' }, `觀看者(${s.viewers.length})`),
    s.viewers.length === 0
      ? h('p', { className: 'field-hint' }, '還沒有人加入。')
      : h(
          'ul',
          { className: 'modules-tips' },
          s.viewers.map((v) =>
            h(
              'li',
              { className: 'row', style: 'gap:10px;align-items:center;justify-content:space-between' },
              h('span', null, v.name),
              h(
                'span',
                { className: 'row', style: 'gap:10px;align-items:center' },
                h(
                  'label',
                  { className: 'modules-toggle' },
                  h('input', { type: 'checkbox', checked: v.canEdit, onchange: (e) => void host.setCanEdit(v.id, e.target.checked) }),
                  '允許變更設定'
                ),
                h('button', { className: 'btn btn-danger-ghost btn-sm', onclick: () => void host.kick(v.id) }, '移除')
              )
            )
          )
        ),
    s.lastCommand
      ? h('p', { className: 'field-hint' }, `最近一次遠端變更(${s.lastCommand.viewerName}):${s.lastCommand.ok ? '已套用' : `未套用 — ${s.lastCommand.error}`}`)
      : null
  )
}

function renderViewer(viewer, keep) {
  const s = viewer.state
  if (s.status !== 'watching') {
    const code = h('input', { placeholder: 'AB12-CD34', value: keep.code ?? '', oninput: (e) => (keep.code = e.target.value) })
    const name = h('input', { placeholder: '顯示給主機的名稱', value: keep.name ?? '', maxLength: 40, oninput: (e) => (keep.name = e.target.value) })
    return h(
      'div',
      null,
      h(
        'div',
        { className: 'row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' },
        h('div', { className: 'field', style: 'flex:1;min-width:140px' }, h('label', null, '分享碼'), code),
        h('div', { className: 'field', style: 'flex:1;min-width:140px' }, h('label', null, '你的名稱'), name),
        h('button', { className: 'btn btn-secondary', disabled: s.status === 'joining', onclick: () => void viewer.join(code.value, name.value) }, s.status === 'joining' ? '加入中…' : '加入')
      ),
      s.error ? h('p', { className: 'field-hint text-warning' }, s.error) : null
    )
  }
  let editor = null
  if (s.canEdit && s.live) {
    const t = numberField('目標角度 (°)', s.live.params.targetAngle, 0, 180, 1)
    const tol = numberField('容錯 (°)', s.live.params.tolerance, 0, 45, 1)
    const hold = numberField('保持 (ms)', s.live.params.holdTimeMs, 0, 60000, 100)
    editor = h(
      'div',
      { style: 'margin-top:10px' },
      h('p', { className: 'text-sm' }, '主機已允許你變更設定(療程進行中會被拒絕)'),
      h('div', { className: 'row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' }, t.node, tol.node, hold.node,
        h('button', {
          className: 'btn btn-primary',
          onclick: () => void viewer.sendParams({ targetAngle: Number(t.input.value), tolerance: Number(tol.input.value), holdTimeMs: Number(hold.input.value) })
        }, '套用到主機')),
      s.notice ? h('p', { className: 'field-hint' }, s.notice) : null
    )
  }
  return h(
    'div',
    null,
    h('div', { className: 'row', style: 'gap:10px;align-items:center;justify-content:space-between' },
      h('span', { className: 'text-sm' }, `正在觀看 ${formatCode(s.code)}${s.canEdit ? ' · 可變更設定' : ' · 僅觀看'}`),
      h('button', { className: 'btn btn-danger-ghost btn-sm', onclick: () => void viewer.leave() }, '離開')),
    s.error ? h('p', { className: 'field-hint text-warning' }, s.error) : null,
    liveView(s.live, s.updatedAt),
    editor
  )
}

export default {
  activate(ctx) {
    if (!ctx.liveShare || typeof ctx.registerPanel !== 'function') {
      throw new Error('即時分享需要 App 1.2.0-beta.16 以上')
    }
    // Sessions outlive the panel: leaving Settings must not stop a share or a viewing session.
    const host = createHost(ctx.liveShare)
    const viewer = createViewer(ctx.liveShare)
    const keep = { code: '', name: '' }
    host.onChange((s) => ctx.log(`host ${s.status}${s.error ? `: ${s.error}` : ''}`))

    ctx.registerPanel({
      mount(el) {
        const hostBox = h('div')
        const viewerBox = h('div')
        const render = () => {
          // Keep the viewer editor stable while the user is typing in it.
          const active = document.activeElement
          const typing = active && viewerBox.contains(active) && active.tagName === 'INPUT'
          hostBox.replaceChildren(renderHost(host))
          if (!typing) viewerBox.replaceChildren(renderViewer(viewer, keep))
        }
        el.append(
          h('hr', { className: 'my-4 border-0 border-t border-border' }),
          h('p', { className: 'text-sm', style: 'font-weight:600' }, '分享這台裝置'),
          hostBox,
          h('hr', { className: 'my-4 border-0 border-t border-border' }),
          h('p', { className: 'text-sm', style: 'font-weight:600' }, '觀看他人的分享'),
          viewerBox
        )
        render()
        const offHost = host.onChange(render)
        const offViewer = viewer.onChange(render)
        const clock = setInterval(render, 1000)
        return () => {
          offHost()
          offViewer()
          clearInterval(clock)
        }
      }
    })
    ctx.log(`live-share activated on app ${ctx.appVersion}`)
  }
}
