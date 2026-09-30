import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMeasurement, trend } from '../modules/angle-range/index.js'

function fakeApi() {
  const records = []
  let id = 0
  return {
    records,
    list: async () => [...records].reverse(),
    add: async (input) => {
      const r = { id: ++id, measuredAt: `2026-09-27T0${id}:00:00Z`, metric: 'kneeAngle', ...input }
      records.push(r)
      return r
    },
    remove: async (rid) => {
      const i = records.findIndex((r) => r.id === rid)
      if (i >= 0) records.splice(i, 1)
    }
  }
}
const live = (knee, extra = {}) => ({ connected: true, demo: false, angles: { knee }, session: { running: false }, ...extra })

test('records comfort then limit from the live knee angle and saves both', async () => {
  const api = fakeApi()
  const m = createMeasurement(api)
  m.setLive(live(92.4))
  m.recordComfort()
  assert.equal(m.state.comfort, 92)
  assert.equal(m.state.step, 'limit')
  m.setLive(live(118.6))
  m.recordLimit()
  assert.equal(m.state.limit, 119)
  await m.save()
  assert.deepEqual(api.records.map((r) => [r.comfortAngle, r.limitAngle]), [[92, 119]])
  assert.equal(m.state.step, 'comfort')
})

test('limit is optional and cannot be below comfort', async () => {
  const api = fakeApi()
  const m = createMeasurement(api)
  m.setLive(live(100))
  m.recordComfort()
  m.setLive(live(90))
  m.recordLimit()
  assert.equal(m.state.step, 'limit')
  assert.match(m.state.error, /不能小於舒適角度/)
  m.skipLimit()
  await m.save()
  assert.equal(api.records[0].limitAngle, null)
})

test('no live angle (disconnected) means nothing is recorded', () => {
  const m = createMeasurement(fakeApi())
  m.setLive(live(80, { connected: false }))
  m.recordComfort()
  assert.equal(m.state.comfort, null)
  assert.match(m.state.error, /連線/)
})

test('a failed save keeps the values for another try', async () => {
  const api = fakeApi()
  api.add = async () => {
    throw new Error('療程進行中無法變更角度範圍')
  }
  const m = createMeasurement(api)
  m.setLive(live(95))
  m.recordComfort()
  m.skipLimit()
  await m.save()
  assert.equal(m.state.step, 'review')
  assert.equal(m.state.comfort, 95)
  assert.match(m.state.error, /療程進行中/)
})

test('trend shows change against the previous record', () => {
  assert.equal(trend(100, 95), '(+5°)')
  assert.equal(trend(90, 95), '(−5°)')
  assert.equal(trend(95, 95), '(持平)')
  assert.equal(trend(95, undefined), '')
})
