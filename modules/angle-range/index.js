// angle-range: let the user measure their own knee angles and keep them as dated records.
//
// 舒適角度 (comfort): within it there is no pain or only mild pain.
// 極限範圍 (limit, optional): very painful but still reachable.
// Every person differs, so there are no defaults. The app uses the latest record during
// sessions: beyond comfort → on-screen hint; beyond limit → on-screen warning. Records are
// personal data kept in the app database (not tied to any action) so the trend can be followed.
//
// Needs ctx.angleRange.

const MAX_LISTED = 6

const round = (v) => Math.round(v)

/** Measurement flow state machine, separate from the DOM so it can be tested in node. */
export function createMeasurement(api) {
  const s = {
    step: 'comfort', // comfort | limit | review | saving
    comfort: null,
    limit: null,
    note: '',
    error: null,
    savedAt: null,
    records: [],
    live: null,
    peak: null
  }
  const listeners = new Set()
  const emit = () => listeners.forEach((fn) => fn(s))

  function kneeNow() {
    const live = s.live
    if (!live || !live.angles || !(live.connected || live.demo)) return null
    return round(live.angles.knee)
  }

  return {
    state: s,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    kneeNow,
    setLive(live) {
      s.live = live
      const k = kneeNow()
      if (k != null && (s.step === 'comfort' || s.step === 'limit')) s.peak = s.peak == null ? k : Math.max(s.peak, k)
      emit()
    },
    async refresh() {
      s.records = await api.list()
      emit()
    },
    recordComfort() {
      const k = kneeNow()
      if (k == null) {
        s.error = '沒有即時角度:請先連線裝置(或啟用示範模式)。'
        emit()
        return
      }
      s.comfort = k
      s.step = 'limit'
      s.peak = k
      s.error = null
      emit()
    },
    recordLimit() {
      const k = kneeNow()
      if (k == null) {
        s.error = '沒有即時角度:請先連線裝置(或啟用示範模式)。'
        emit()
        return
      }
      if (k < s.comfort) {
        s.error = `極限範圍不能小於舒適角度(${s.comfort}°)。請繼續彎到更大的角度再記錄,或略過。`
        emit()
        return
      }
      s.limit = k
      s.step = 'review'
      s.error = null
      emit()
    },
    skipLimit() {
      s.limit = null
      s.step = 'review'
      s.error = null
      emit()
    },
    edit(field, value) {
      if (field === 'note') s.note = String(value)
      else {
        const n = value === '' || value == null ? null : Number(value)
        s[field] = n != null && Number.isFinite(n) ? n : null
      }
      emit()
    },
    restart() {
      s.step = 'comfort'
      s.comfort = null
      s.limit = null
      s.note = ''
      s.error = null
      s.peak = null
      emit()
    },
    async save() {
      if (s.comfort == null) {
        s.error = '請先記錄舒適角度。'
        emit()
        return
      }
      if (s.limit != null && s.limit < s.comfort) {
        s.error = '極限範圍不能小於舒適角度。'
        emit()
        return
      }
      s.step = 'saving'
      emit()
      try {
        const saved = await api.add({ comfortAngle: s.comfort, limitAngle: s.limit, note: s.note.trim() || null })
        s.savedAt = saved.measuredAt
        s.records = await api.list()
        s.step = 'comfort'
        s.comfort = null
        s.limit = null
        s.note = ''
        s.peak = null
        s.error = null
      } catch (err) {
        s.step = 'review'
        s.error = `儲存失敗:${err instanceof Error ? err.message : String(err)}`
      }
      emit()
    },
    async remove(id) {
      try {
        await api.remove(id)
        s.records = await api.list()
        s.error = null
      } catch (err) {
        s.error = `刪除失敗:${err instanceof Error ? err.message : String(err)}`
      }
      emit()
    }
  }
}

/** "+5°" / "−3°" / "" relative to the previous (older) record. */
export function trend(current, previous) {
  if (previous == null || current == null) return ''
  const d = round(current - previous)
  return d === 0 ? '(持平)' : d > 0 ? `(+${d}°)` : `(−${-d}°)`
}

// ── DOM rendering (no framework; uses the app's CSS classes) ──

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

function flow(m) {
  const s = m.state
  const k = m.kneeNow()
  const running = s.live?.session?.running
  const readout = h(
    'div',
    { className: 'row', style: 'gap:18px;align-items:baseline;flex-wrap:wrap' },
    h('div', { className: 'font-mono', style: 'font-size:2.2rem;font-weight:600' }, k == null ? '—' : `${k}°`),
    h('span', { className: 'text-text-muted text-sm' }, k == null ? '尚無即時膝角(請先連線裝置)' : '目前膝關節角度'),
    s.peak != null ? h('span', { className: 'text-text-muted text-sm' }, `本次最大 ${s.peak}°`) : null,
    s.live?.demo ? h('span', { className: 'v3-chip warn' }, '示範資料') : null
  )
  if (running) {
    return h('div', null, readout, h('p', { className: 'field-hint text-warning' }, '療程進行中無法量測或變更角度範圍,請先結束療程。'))
  }
  if (s.step === 'comfort') {
    return h(
      'div',
      null,
      readout,
      h('p', { className: 'text-sm' }, '步驟 1:慢慢彎曲膝蓋。開始感到疼痛或拉筋的感覺時,停住並按下「記錄舒適角度」。'),
      h('button', { className: 'btn btn-primary', disabled: k == null, onclick: () => m.recordComfort() }, '記錄舒適角度')
    )
  }
  if (s.step === 'limit') {
    return h(
      'div',
      null,
      readout,
      h('p', { className: 'text-sm' }, `已記錄舒適角度 ${s.comfort}°。`),
      h('p', { className: 'text-sm' }, '步驟 2(選填):在安全的前提下繼續慢慢彎,到「很痛但還能到達」的角度時按「記錄極限範圍」。不想設定可以略過。'),
      h(
        'div',
        { className: 'row', style: 'gap:8px' },
        h('button', { className: 'btn btn-primary', disabled: k == null, onclick: () => m.recordLimit() }, '記錄極限範圍'),
        h('button', { className: 'btn btn-secondary', onclick: () => m.skipLimit() }, '略過'),
        h('button', { className: 'btn btn-danger-ghost', onclick: () => m.restart() }, '重來')
      )
    )
  }
  const comfortInput = h('input', { type: 'number', min: 0, max: 180, value: String(s.comfort ?? ''), onchange: (e) => m.edit('comfort', e.target.value) })
  const limitInput = h('input', { type: 'number', min: 0, max: 180, placeholder: '未設定', value: s.limit == null ? '' : String(s.limit), onchange: (e) => m.edit('limit', e.target.value) })
  const noteInput = h('input', { maxLength: 200, placeholder: '例如:術後第 3 週、早上量', value: s.note, onchange: (e) => m.edit('note', e.target.value) })
  return h(
    'div',
    null,
    h('p', { className: 'text-sm' }, '步驟 3:確認數值後儲存。之後的療程會以這筆紀錄提示舒適角度與極限範圍。'),
    h(
      'div',
      { className: 'row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' },
      h('div', { className: 'field', style: 'flex:1;min-width:110px' }, h('label', null, '舒適角度 (°)'), comfortInput),
      h('div', { className: 'field', style: 'flex:1;min-width:110px' }, h('label', null, '極限範圍 (°,選填)'), limitInput),
      h('div', { className: 'field', style: 'flex:2;min-width:160px' }, h('label', null, '備註'), noteInput)
    ),
    h(
      'div',
      { className: 'row', style: 'gap:8px;margin-top:8px' },
      h('button', { className: 'btn btn-primary', disabled: s.step === 'saving', onclick: () => void m.save() }, s.step === 'saving' ? '儲存中…' : '儲存紀錄'),
      h('button', { className: 'btn btn-danger-ghost', onclick: () => m.restart() }, '重來')
    )
  )
}

function history(m) {
  const { records } = m.state
  if (records.length === 0) return h('p', { className: 'field-hint' }, '還沒有紀錄。療程中不會有任何角度提示,直到你完成第一次量測。')
  const shown = records.slice(0, MAX_LISTED)
  return h(
    'div',
    null,
    h('ul', { className: 'modules-tips' },
      shown.map((r, i) => {
        const prev = records[i + 1]
        const date = new Date(r.measuredAt).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
        return h(
          'li',
          { className: 'row', style: 'gap:10px;align-items:center;justify-content:space-between' },
          h(
            'span',
            null,
            `${date} · 舒適 ${round(r.comfortAngle)}°${trend(r.comfortAngle, prev?.comfortAngle)} · 極限 ${r.limitAngle == null ? '未設定' : `${round(r.limitAngle)}°${trend(r.limitAngle, prev?.limitAngle)}`}`,
            r.note ? ` · ${r.note}` : '',
            i === 0 ? ' · 目前生效' : ''
          ),
          h('button', { className: 'btn btn-danger-ghost btn-sm', onclick: () => void m.remove(r.id) }, '刪除')
        )
      })
    ),
    records.length > MAX_LISTED ? h('p', { className: 'field-hint' }, `共 ${records.length} 筆,顯示最近 ${MAX_LISTED} 筆。`) : null
  )
}

export default {
  activate(ctx) {
    if (!ctx.angleRange || typeof ctx.registerPanel !== 'function') {
      throw new Error('角度範圍測量需要 App 1.2.0-beta.17 以上')
    }
    const api = ctx.angleRange
    const m = createMeasurement(api)

    ctx.registerPanel({
      mount(el) {
        const flowBox = h('div')
        const historyBox = h('div')
        const errorBox = h('div')
        const render = () => {
          const active = document.activeElement
          // Don't rebuild the review form while the user is typing into it.
          if (!(active && flowBox.contains(active) && active.tagName === 'INPUT')) flowBox.replaceChildren(flow(m))
          historyBox.replaceChildren(history(m))
          errorBox.replaceChildren(m.state.error ? h('p', { className: 'field-hint text-warning' }, m.state.error) : '')
        }
        el.append(
          h('hr', { className: 'my-4 border-0 border-t border-border' }),
          h('p', { className: 'text-text-muted text-sm' }, '舒適角度:在此之內不痛或只有輕微疼痛。極限範圍:很痛但還能到達的角度(選填)。每個人都不一樣,所以沒有預設值。'),
          flowBox,
          errorBox,
          h('p', { className: 'text-sm', style: 'font-weight:600;margin-top:12px' }, '量測紀錄'),
          historyBox
        )
        m.state.live = api.snapshot()
        render()
        const offLive = api.subscribe((live) => m.setLive(live))
        const offChange = m.onChange(render)
        void m.refresh()
        return () => {
          offLive()
          offChange()
        }
      }
    })
    ctx.log(`angle-range activated on app ${ctx.appVersion}`)
  }
}
