import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createViewer, normalizeCode, formatCode } from '../modules/live-share/index.js'

const flush = () => new Promise((r) => setImmediate(r))

function fakeApi({ telemetryEnabled = true, respond }) {
  const calls = []
  const applied = []
  let listener = null
  return {
    calls,
    applied,
    fire: () => listener?.(),
    api: {
      snapshot: () => ({ reps: 1 }),
      subscribe: (fn) => ((listener = fn), () => (listener = null)),
      telemetry: async () => ({ enabled: telemetryEnabled, runId: 'run-1', endpoint: 'x' }),
      request: async (req) => (calls.push(req), respond(req)),
      applyParams: (p) => (applied.push(p), { ok: true })
    }
  }
}

// Manual clock so the push loop is deterministic.
function clock() {
  let t = 0
  const timers = []
  return {
    now: () => t,
    setTimer: (fn, ms) => (timers.push({ fn, at: t + ms }), timers.length),
    clearTimer: () => {},
    async advance(ms) {
      t += ms
      for (const timer of timers.splice(0)) if (timer.at <= t) timer.fn(); else timers.push(timer)
      await flush()
    }
  }
}

test('share codes are normalized and formatted', () => {
  assert.equal(normalizeCode(' ab12-cd34 '), 'AB12CD34')
  assert.equal(normalizeCode('AB12CD3'), null)
  assert.equal(normalizeCode('AB12CD3I'), null) // I is not in the alphabet
  assert.equal(formatCode('AB12CD34'), 'AB12-CD34')
})

test('host refuses to share without live telemetry and never calls the server', async () => {
  const f = fakeApi({ telemetryEnabled: false, respond: () => ({ status: 200, body: {} }) })
  const host = createHost(f.api)
  await host.start()
  assert.equal(host.state.status, 'idle')
  assert.match(host.state.error, /遙測/)
  assert.equal(f.calls.length, 0)
})

test('host pushes state, applies queued commands and reports the result', async () => {
  const c = clock()
  let pushes = 0
  const f = fakeApi({
    respond: (req) => {
      if (req.path === '/v1/share') return { status: 200, body: { code: 'AB12CD34', hostToken: 'h' } }
      if (req.path.endsWith('/state')) {
        pushes++
        return {
          status: 200,
          body: {
            viewers: [{ id: 'v1', name: 'PC', canEdit: true }],
            commands: pushes === 1 ? [{ id: 'c1', type: 'setParams', params: { targetAngle: 70 }, viewerName: 'PC' }] : []
          }
        }
      }
      return { status: 404, body: {} }
    }
  })
  const host = createHost(f.api, c)
  await host.start()
  assert.equal(host.state.status, 'sharing')
  assert.deepEqual(f.calls[0].body, { runId: 'run-1' })
  await c.advance(250)
  assert.equal(pushes, 1)
  assert.equal(f.calls[1].token, 'h')
  assert.deepEqual(f.applied, [{ targetAngle: 70 }])
  assert.equal(host.state.lastCommand.ok, true)
  // The outcome is pushed on the next tick even without a new snapshot.
  await c.advance(250)
  assert.equal(pushes, 2)
  assert.equal(f.calls[2].body.state.lastCommand.id, 'c1')
})

test('host ends the share when the server closes it', async () => {
  const c = clock()
  const f = fakeApi({
    respond: (req) =>
      req.path === '/v1/share'
        ? { status: 200, body: { code: 'AB12CD34', hostToken: 'h' } }
        : { status: 409, body: { error: 'telemetry run is no longer live; share closed' } }
  })
  const host = createHost(f.api, c)
  await host.start()
  await c.advance(250)
  assert.equal(host.state.status, 'ended')
  assert.match(host.state.error, /no longer live/)
})

test('viewer joins, follows state, and stops when removed', async () => {
  let polls = 0
  const f = fakeApi({
    respond: async (req) => {
      if (req.path.endsWith('/join')) return { status: 200, body: { viewerToken: 'v', viewerId: 'id' } }
      if (req.path.includes('/state?after=')) {
        polls++
        if (polls === 1) return { status: 200, body: { version: 1, state: { reps: 2 }, canEdit: false, updatedAt: 't' } }
        return { status: 401, body: { error: 'viewer token required' } }
      }
      return { status: 404, body: {} }
    }
  })
  const viewer = createViewer(f.api)
  await viewer.join('ab12-cd34', 'PC')
  await flush()
  await flush()
  assert.equal(viewer.state.status, 'ended')
  assert.deepEqual(viewer.state.live, { reps: 2 })
  assert.match(viewer.state.error, /移出/)
  assert.equal(f.calls[1].path, '/v1/share/AB12CD34/state?after=0')
  assert.equal(f.calls[2].path, '/v1/share/AB12CD34/state?after=1')
})

test('viewer rejects a malformed code without calling the server', async () => {
  const f = fakeApi({ respond: () => ({ status: 200, body: {} }) })
  const viewer = createViewer(f.api)
  await viewer.join('nope', 'x')
  assert.equal(f.calls.length, 0)
  assert.match(viewer.state.error, /8 個英數字/)
})
