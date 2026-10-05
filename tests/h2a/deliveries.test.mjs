import assert from 'node:assert/strict'
import test from 'node:test'
import { completeDelivery, reconcileDelivery, reserveDelivery } from '../../netlify/functions/_h2a/deliveries.js'

const identity = { companyId: 'c1', portalId: 'p1', objectType: 'emails', activityId: '42', albiTargetType: 'contact', albiTargetId: '99' }
function storeHarness(existing = null) {
  const calls = []
  let row = existing
  return {
    calls,
    async reserve(input) {
      calls.push(['reserve', input])
      if (row && row.state !== 'failed') return { acquired: false, row }
      const attemptCount = (row?.attempt_count ?? 0) + 1
      row = { ...input, id: row?.id ?? 'delivery-1', state: 'reserved', attempt_count: attemptCount, version: attemptCount }
      return { acquired: true, row }
    },
    async transition(input) {
      calls.push(['transition', input])
      if (row?.id !== input.id || row.version !== input.expectedVersion || row.state !== 'reserved') return { updated: false, row }
      row = { ...row, ...input.patch, version: row.version + 1 }
      return { updated: true, row }
    },
    current: () => row,
  }
}

test('reserves full identity before create and duplicate returns current disposition', async () => {
  const store = storeHarness()
  const reserved = await reserveDelivery({ identity, store, now: () => '2026-10-01T00:00:00Z', createAttemptToken: () => 'attempt-1' })
  assert.equal(reserved.disposition, 'reserved')
  assert.deepEqual(Object.fromEntries(Object.entries(reserved.identity).filter(([key]) => key !== 'key')), identity)
  const duplicate = await reserveDelivery({ identity, store })
  assert.equal(duplicate.disposition, 'in_progress')
  assert.equal(store.calls.filter(([op]) => op === 'reserve').length, 2)
})

test('terminal duplicate reservations remain terminal and do not grant a create attempt', async () => {
  const store = storeHarness({ id: 'delivery-1', state: 'delivered', attempt_count: 1, version: 1, albi_activity_id: '501' })
  const duplicate = await reserveDelivery({ identity, store })
  assert.equal(duplicate.disposition, 'delivered')
  assert.equal(duplicate.id, 'delivery-1')
})

test('reconciles uncertain create by native source ID or deterministic marker before retry', async () => {
  for (const mode of ['native', 'marker']) {
    const store = storeHarness()
    const reservation = await reserveDelivery({ identity, store, createAttemptToken: () => `attempt-${mode}` })
    const calls = []
    const albi = { async listActivities(query) {
      calls.push(query)
      return { records: [{ id: '501', sourceId: mode === 'native' ? '42' : null, notes: '... Source: HubSpot email 42' }] }
    } }
    const result = await reconcileDelivery({ reservation, store, albi, nativeExternalIdSupported: mode === 'native' })
    assert.equal(result.disposition, 'reconciled')
    assert.equal(store.current().state, 'reconciled')
    assert.equal(calls.length, 1)
  }
})

test('uncertain post-write crash reconciles existing marker as terminal success', async () => {
  const store = storeHarness()
  const reservation = await reserveDelivery({ identity, store, createAttemptToken: () => 'attempt-1' })
  const result = await completeDelivery({ reservation, store,
    error: { category: 'transient', code: 'timeout' },
    albi: { async listActivities() { return { records: [{ id: '501', notes: 'Source: HubSpot email 42' }] } } },
    now: () => '2026-10-01T00:00:01Z' })
  assert.equal(result.disposition, 'reconciled')
  assert.equal(store.current().albi_activity_id, '501')
})

test('uncertain write with no match schedules bounded retry and locks reconciliation to the target', async () => {
  const store = storeHarness()
  const reservation = await reserveDelivery({ identity, store, createAttemptToken: () => 'attempt-1' })
  let query
  const result = await completeDelivery({ reservation, store, error: { category: 'transient', code: 'timeout' },
    albi: { async listActivities(input) { query = input; return { records: [] } } },
    reconcileQuery: { contactId: 'wrong-tenant-target', page: 2 }, now: () => '2026-10-01T00:00:00Z' })
  assert.deepEqual(query, { contactId: '99', page: 2 })
  assert.equal(result.disposition, 'retry_scheduled')
  assert.equal(store.current().next_attempt_at, '2026-10-01T00:00:30.000Z')
})

test('successful create is fenced by reservation attempt version', async () => {
  const store = storeHarness()
  const reservation = await reserveDelivery({ identity, store, createAttemptToken: () => 'attempt-1' })
  const result = await completeDelivery({ reservation, store, result: { id: '501' } })
  assert.equal(result.disposition, 'delivered')
  assert.equal(store.current().state, 'delivered')
  assert.equal(store.calls.at(-1)[1].expectedVersion, reservation.version)
})

test('validation failures are terminal while transient failures keep safe backoff metadata', async () => {
  for (const [category, expectedState, expectedDisposition] of [
    ['validation', 'failed', 'failed'], ['transient', 'failed', 'retry_scheduled'],
  ]) {
    const store = storeHarness()
    const reservation = await reserveDelivery({ identity, store, createAttemptToken: () => `attempt-${category}` })
    const result = await completeDelivery({ reservation, store, error: { category, code: 'safe_code' },
      retryAt: () => '2026-10-01T00:05:00Z' })
    assert.equal(result.disposition, expectedDisposition)
    assert.equal(store.current().state, expectedState)
    if (category === 'transient') assert.equal(store.current().next_attempt_at, '2026-10-01T00:05:00Z')
  }
})

test('stale attempt cannot complete after a later reservation claims the row', async () => {
  const store = storeHarness()
  const first = await reserveDelivery({ identity, store, createAttemptToken: () => 'attempt-1' })
  store.current().state = 'failed'
  const second = await reserveDelivery({ identity, store, createAttemptToken: () => 'attempt-2' })
  const stale = await completeDelivery({ reservation: first, store, result: { id: 'bad' } })
  assert.equal(stale.disposition, 'stale_attempt')
  assert.equal(store.current().attempt_count, second.attemptCount)
})
