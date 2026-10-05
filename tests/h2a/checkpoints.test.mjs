import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceCheckpoint, planBackfillWindows } from '../../netlify/functions/_h2a/checkpoints.js'

test('checkpoint advances by timestamp and stable ID only through durable outcomes', () => {
  const result = advanceCheckpoint({ current: { timestamp: '2026-10-01T10:00:00.000Z', objectId: '1' }, items: [
    { timestamp: '2026-10-01T10:00:00.000Z', objectId: '2', resolved: true },
    { timestamp: '2026-10-01T10:00:00.000Z', objectId: '3', resolved: false },
    { timestamp: '2026-10-01T11:00:00.000Z', objectId: '4', resolved: true },
  ] })
  assert.deepEqual(result, { timestamp: '2026-10-01T10:00:00.000Z', objectId: '2' })
})

test('Pacific daily windows have 23 and 25 hour DST days and resume from a checkpoint', () => {
  const spring = planBackfillWindows({ startDate: '2026-03-07', endDate: '2026-03-10', objectType: 'calls' })
  assert.equal((Date.parse(spring[1].endAt) - Date.parse(spring[1].startAt)) / 3600000, 23)
  const fall = planBackfillWindows({ startDate: '2026-10-31', endDate: '2026-11-03', objectType: 'calls' })
  assert.equal((Date.parse(fall[1].endAt) - Date.parse(fall[1].startAt)) / 3600000, 25)
  const resumed = planBackfillWindows({ startDate: '2026-10-31', endDate: '2026-11-03', objectType: 'calls', existingWindows: [
    { ...fall[0], status: 'completed' },
    { ...fall[1], id: 'window-2', status: 'running', checkpoint_timestamp: '2026-11-01T12:00:00.000Z', checkpoint_object_id: '42' },
  ] })
  assert.equal(resumed.length, 2)
  assert.equal(resumed[0].id, 'window-2')
  assert.equal(resumed[0].checkpoint.objectId, '42')
})
