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
      const isNew = !row
      const previousState = row?.state ?? null
      const previous = row ? { state: row.state, last_attempt_at: row.last_attempt_at, next_attempt_at: row.next_attempt_at } : null
      if (row) {
        const retryDue = row.state === 'failed' && row.next_attempt_at && Date.parse(row.next_attempt_at) <= Date.parse(input.now)
        const staleReserved = row.state === 'reserved' && row.last_attempt_at && Date.parse(row.last_attempt_at) <= Date.parse(input.staleBefore)
        if (row.state === 'delivered' || row.state === 'reconciled' || (!retryDue && !staleReserved)) {
          return { acquired: false, row, isNew: false, previousState }
        }
      }
      const attemptCount = (row?.attempt_count ?? 0) + 1
      row = { ...row, ...input, id: row?.id ?? 'delivery-1', state: 'reserved', attempt_count: attemptCount,
        version: attemptCount, last_attempt_at: input.now, next_attempt_at: null }
      return { acquired: true, row, isNew, previousState, previous }
    },
    async transition(input) {
      calls.push(['transition', input])
      if (row?.id !== input.id || row.version !== input.expectedVersion ||
        String(row.attempt_count) !== input.attemptToken || row.state !== 'reserved') return { updated: false, row }
      row = { ...row, ...input.patch, version: row.version + 1 }
      return { updated: true, row }
    },
    current: () => row,
  }
}

test('reserves full identity before create and duplicate returns current disposition', async () => {
  const store = storeHarness()
  let reads = 0
  const reserved = await reserveDelivery({ identity, store, now: () => '2026-10-01T00:00:00Z',
    albi: { async listActivities() { reads++; return { records: [] } } } })
  assert.equal(reserved.disposition, 'reserved')
  assert.equal(reserved.safeToCreate, true)
  assert.equal(reserved.reconciledBeforeCreate, false)
  assert.equal(reads, 0, 'new reservations must not reconcile')
  assert.deepEqual(Object.fromEntries(Object.entries(reserved.identity).filter(([key]) => key !== 'key')), identity)
  const duplicate = await reserveDelivery({ identity, store, now: '2026-10-01T00:00:01Z' })
  assert.equal(duplicate.disposition, 'in_progress')
  assert.equal(store.calls.filter(([op]) => op === 'reserve').length, 2)
})

test('terminal duplicate reservations remain terminal and do not grant a create attempt', async () => {
  const store = storeHarness({ id: 'delivery-1', state: 'delivered', attempt_count: 1, version: 1, albi_activity_id: '501' })
  const duplicate = await reserveDelivery({ identity, store })
  assert.equal(duplicate.disposition, 'delivered')
  assert.equal(duplicate.id, 'delivery-1')
})

test('reconciles uncertain create by exact native source ID or exact marker line', async () => {
  for (const mode of ['native', 'marker']) {
    const store = storeHarness()
    const reservation = await reserveDelivery({ identity, store })
    const calls = []
    const albi = { async listActivities(query) {
      calls.push(query)
      return { records: [{ id: '501', source: mode === 'native' ? 'hubspot' : null,
        sourceId: mode === 'native' ? '42' : null, notes: 'Activity notes\nSource: HubSpot email 42\nmore text' }], cursor: null }
    } }
    const result = await reconcileDelivery({ reservation, store, albi, nativeExternalIdSupported: mode === 'native' })
    assert.equal(result.disposition, 'reconciled')
    assert.equal(store.current().state, 'reconciled')
    assert.equal(calls.length, 1)
  }
})

test('uncertain post-write crash reconciles existing marker as terminal success', async () => {
  const store = storeHarness()
  const reservation = await reserveDelivery({ identity, store })
  const result = await completeDelivery({ reservation, store,
    error: { category: 'transient', code: 'timeout' },
    albi: { async listActivities() { return { records: [{ id: '501', notes: 'Source: HubSpot email 42' }], cursor: null } } },
    now: () => '2026-10-01T00:00:01Z' })
  assert.equal(result.disposition, 'reconciled')
  assert.equal(store.current().albi_activity_id, '501')
})

test('uncertain write with no match schedules bounded retry and locks reconciliation to the target', async () => {
  const store = storeHarness()
  const reservation = await reserveDelivery({ identity, store })
  let query
  const result = await completeDelivery({ reservation, store, error: { category: 'transient', code: 'timeout' },
    albi: { async listActivities(input) { query = input; return { records: [] } } },
    reconcileQuery: { contactId: 'wrong-tenant-target', page: 2 }, now: () => '2026-10-01T00:00:00Z' })
  assert.deepEqual(query, { contactId: '99', page: 1 })
  assert.equal(result.disposition, 'retry_scheduled')
  assert.equal(store.current().next_attempt_at, '2026-10-01T00:00:30.000Z')
})

test('successful create is fenced by reservation attempt version', async () => {
  const store = storeHarness()
  const reservation = await reserveDelivery({ identity, store })
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
    const reservation = await reserveDelivery({ identity, store })
    const result = await completeDelivery({ reservation, store, error: { category, code: 'safe_code' },
      retryAt: () => '2026-10-01T00:05:00Z' })
    assert.equal(result.disposition, expectedDisposition)
    assert.equal(store.current().state, expectedState)
    if (category === 'transient') assert.equal(store.current().next_attempt_at, '2026-10-01T00:05:00Z')
    else {
      assert.equal(store.current().next_attempt_at, null)
      assert.equal((await reserveDelivery({ identity, store, now: '2026-10-02T00:00:00Z' })).disposition, 'failed')
    }
  }
})

test('stale attempt cannot complete after a later reservation claims the row', async () => {
  const store = storeHarness()
  const first = await reserveDelivery({ identity, store, now: '2026-10-01T00:00:00Z' })
  store.current().last_attempt_at = '2026-10-01T00:00:00Z'
  let found = false
  const second = await reserveDelivery({ identity, store, now: '2026-10-01T00:10:00Z',
    albi: { async listActivities() { found = true; return { records: [], cursor: null } } } })
  assert.equal(found, true)
  assert.equal(second.reconciledBeforeCreate, true)
  const stale = await completeDelivery({ reservation: first, store, result: { id: 'bad' } })
  assert.equal(stale.disposition, 'stale_attempt')
  assert.equal(store.current().attempt_count, second.attemptCount)
})

test('a second worker reclaims stale post-write reservation, paginates recovery, and never creates twice', async () => {
  const store = storeHarness()
  let firstCreates = 0, secondCreates = 0
  const first = await reserveDelivery({ identity, store, now: '2026-10-01T00:00:00Z' })
  assert.equal(first.safeToCreate, true)
  // Simulate Albi accepting the write, then the first process crashing before completeDelivery.
  firstCreates++
  store.current().last_attempt_at = '2026-10-01T00:00:00Z'
  const second = await reserveDelivery({ identity, store, now: '2026-10-01T00:10:00Z', albi: {
    async listActivities({ page, contactId }) {
      assert.equal(contactId, '99')
      if (page === 1) return { records: [], cursor: '2' }
      return { records: [{ id: '501', notes: 'Logged email\nSource: HubSpot email 42' }], cursor: null }
    },
  } })
  if (second.safeToCreate) secondCreates++
  assert.equal(second.disposition, 'reconciled')
  assert.equal(store.current().state, 'reconciled')
  assert.equal(firstCreates, 1)
  assert.equal(secondCreates, 0)
})

test('marker matching is exact so activity 42 never reconciles activity 420', async () => {
  const store = storeHarness()
  const reservation = await reserveDelivery({ identity, store })
  const result = await reconcileDelivery({ reservation, store, albi: { async listActivities() {
    return { records: [{ id: 'wrong', notes: 'Source: HubSpot email 420' }], cursor: null }
  } } })
  assert.equal(result.disposition, 'not_found')
})

test('native IDs require the verified HubSpot source label and reconciliation page limits fail closed', async () => {
  const store = storeHarness()
  const reservation = await reserveDelivery({ identity, store })
  const wrongSource = await reconcileDelivery({ reservation, store, nativeExternalIdSupported: true,
    albi: { async listActivities() { return { records: [{ id: 'wrong', source: 'other', sourceId: '42' }], cursor: null } } } })
  assert.equal(wrongSource.disposition, 'not_found')
  await assert.rejects(reconcileDelivery({ reservation, store, maxPages: 2,
    albi: { async listActivities({ page }) { return { records: [], cursor: String(Number(page) + 1) } } } }), /page limit/u)
})

test('failed retry reservation is unavailable before next_attempt_at and reconciles when due', async () => {
  const store = storeHarness({ id: 'delivery-1', state: 'failed', attempt_count: 1,
    next_attempt_at: '2026-10-01T00:05:00Z', last_attempt_at: '2026-10-01T00:00:00Z' })
  const early = await reserveDelivery({ identity, store, now: '2026-10-01T00:04:59Z' })
  assert.equal(early.disposition, 'retry_scheduled')
  let reads = 0
  const due = await reserveDelivery({ identity, store, now: '2026-10-01T00:05:00Z', albi: {
    async listActivities() { reads++; return { records: [], cursor: null } },
  } })
  assert.equal(due.safeToCreate, true)
  assert.equal(due.reconciledBeforeCreate, true)
  assert.equal(reads, 1)
})
