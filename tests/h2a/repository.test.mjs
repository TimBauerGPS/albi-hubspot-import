import test from 'node:test'
import assert from 'node:assert/strict'
import { createH2ARepository } from '../../netlify/functions/_h2a/repository.js'

test('run totals count the latest durable outcome for each source-target item', async () => {
  const rows = [
    { id: 'a', object_type: 'calls', source_id: '1', albi_target_type: 'contact', albi_target_id: '7', outcome: 'failed', created_at: '2026-10-01T00:00:00Z' },
    { id: 'b', object_type: 'calls', source_id: '1', albi_target_type: 'contact', albi_target_id: '7', outcome: 'delivered', created_at: '2026-10-01T00:01:00Z' },
    { id: 'c', object_type: 'calls', source_id: '1', albi_target_type: 'contact', albi_target_id: '8', outcome: 'delivered', created_at: '2026-10-01T00:02:00Z' },
  ]
  const filters = []
  const query = { select() { return this }, eq(name, value) { filters.push([name, value]); return this },
    order() { return this }, range() { return this },
    then(resolve) { resolve({ data: rows, error: null }) } }
  const repository = createH2ARepository({ from: () => query, rpc: async () => ({ data: true }) })
  const totals = await repository.totals('company-1', 'run-1')
  assert.equal(totals.delivered, 2)
  assert.equal(totals.failed, 0)
  assert.deepEqual(filters, [['company_id', 'company-1'], ['run_id', 'run-1']])
})

test('delivery repository passes tenant identity to atomic reserve and transition RPCs', async () => {
  const calls = []
  const repository = createH2ARepository({ from: () => { throw Error('table access is unexpected') },
    rpc: async (name, args) => {
      calls.push({ name, args })
      return { data: name === 'h2a_reserve_delivery' ? { acquired: true, is_new: true, delivery: { id: 'd1', attempt_count: 1 } }
        : { updated: true, delivery: { id: 'd1', state: 'delivered' } } }
    } })
  const store = repository.deliveryStore('company-1')
  const reservation = await store.reserve({ identity: { portalId: '123', objectType: 'calls', activityId: '42',
    albiTargetType: 'contact', albiTargetId: '7' }, source_marker: 'Source: HubSpot call 42',
    now: '2026-10-01T00:00:00Z', staleBefore: '2026-09-30T23:55:00Z', retryEligibleAt: '2026-10-01T00:00:00Z' })
  assert.equal(reservation.isNew, true)
  await store.transition({ id: 'd1', expectedVersion: 1, attemptToken: '1', patch: { state: 'delivered' } })
  assert.deepEqual(calls.map(call => [call.name, call.args.p_company_id]), [
    ['h2a_reserve_delivery', 'company-1'], ['h2a_transition_delivery', 'company-1'],
  ])
})

test('totals page through more than the default thousand persisted items', async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => ({ id: String(index), object_type: 'calls', source_id: String(index),
    albi_target_type: 'contact', albi_target_id: '7', outcome: 'delivered', created_at: '2026-10-01T00:00:00Z' }))
  const ranges = []
  const supabase = { rpc: async () => ({ data: true }), from: () => {
    const query = { select() { return this }, eq() { return this }, order() { return this },
      range(start, end) { ranges.push([start, end]); return Promise.resolve({ data: rows.slice(start, end + 1), error: null }) } }
    return query
  } }
  const totals = await createH2ARepository(supabase).totals('company-1', 'run-1')
  assert.equal(totals.delivered, 1001)
  assert.deepEqual(ranges, [[0, 999], [1000, 1999]])
})

test('repeated unresolved item reuses an open tenant conflict', async () => {
  const filters = []
  const existing = { id: 'conflict-1', company_id: 'company-1', status: 'open' }
  const supabase = { rpc: async () => ({ data: true }), from: table => {
    assert.equal(table, 'h2a_conflicts')
    return { select() { return this }, eq(name, value) { filters.push([name, value]); return this },
      maybeSingle: async () => ({ data: existing, error: null }),
      insert: () => { throw Error('duplicate conflict inserted') } }
  } }
  const result = await createH2ARepository(supabase).recordConflict('company-1', {
    portal_id: '123', object_type: 'contacts', source_id: '42', conflict_type: 'contact_match', reason: 'name_only_candidate',
    activity_id: '99', activity_object_type: 'calls',
  })
  assert.equal(result.id, 'conflict-1')
  assert.deepEqual(filters, [ ['company_id', 'company-1'], ['portal_id', '123'], ['object_type', 'contacts'],
    ['source_id', '42'], ['conflict_type', 'contact_match'], ['reason', 'name_only_candidate'],
    ['activity_object_type', 'calls'], ['activity_id', '99'], ['status', 'open'] ])
})

test('a terminal run cannot be revived by a delayed background resume', async () => {
  const supabase = { rpc: async () => ({ data: true }), from: () => ({ select() { return this }, eq() { return this },
    maybeSingle: async () => ({ data: { id: 'run1', mode: 'live', status: 'completed' }, error: null }),
    update: () => { throw Error('terminal run was updated') } }) }
  await assert.rejects(() => createH2ARepository(supabase).startRun('company-1', {
    runId: 'run1', mode: 'live', trigger: 'resume',
  }), /Run is not resumable/)
})
