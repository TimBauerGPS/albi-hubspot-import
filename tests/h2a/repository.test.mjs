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

test('saveMapping uses the atomic tenant RPC and returns its same-target replay row without table upsert', async () => {
  const calls = []
  const mapping = { company_id: 'company-1', portal_id: '123', hubspot_id: '42', albi_contact_id: '7', match_method: 'automatic' }
  const repository = createH2ARepository({ from: () => { throw Error('mapping table access is forbidden') },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: mapping, error: null } } })
  const result = await repository.saveMapping('company-1', 'contact', { portal_id: '123', hubspot_id: '42',
    albi_contact_id: '7', match_method: 'automatic', reviewed_by: null })
  assert.equal(result, mapping)
  assert.deepEqual(calls, [{ name: 'h2a_save_mapping', args: { p_company_id: 'company-1', p_portal_id: '123',
    p_object_type: 'contacts', p_source_id: '42', p_target_id: '7', p_match_method: 'automatic',
    p_reviewed_by: null, p_now: calls[0].args.p_now } }])
  assert.equal(Number.isNaN(Date.parse(calls[0].args.p_now)), false)
})

test('saveMapping rejects a competing source target returned by the atomic RPC', async () => {
  const calls = []
  const repository = createH2ARepository({ from: () => { throw Error('mapping table access is forbidden') },
    rpc: async (name, args) => { calls.push([name, args]); return { data: { error: 'mapping_conflict' }, error: null } } })
  await assert.rejects(() => repository.saveMapping('company-1', 'organization', { portal_id: '123', hubspot_id: '42',
    albi_organization_id: 'different-target', match_method: 'created' }), error => error.code === 'mapping_conflict')
  assert.equal(calls[0][0], 'h2a_save_mapping')
  assert.equal(calls[0][1].p_object_type, 'companies')
})

test('saveMapping rejects unsupported kinds before RPC or table access', async () => {
  let rpcCalls = 0
  const repository = createH2ARepository({ from: () => { throw Error('unexpected table access') },
    rpc: async () => { rpcCalls += 1; return { data: null, error: null } } })
  await assert.rejects(() => repository.saveMapping('company-1', 'deal', { portal_id: '123', hubspot_id: '42' }), /mapping kind/i)
  assert.equal(rpcCalls, 0)
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

test('conflict repository reads use company equality and a timestamp plus UUID keyset', async () => {
  const calls = []
  const query = { select(value) { calls.push(['select', value]); return this }, eq(key, value) { calls.push(['eq', key, value]); return this },
    order(key, options) { calls.push(['order', key, options]); return this }, limit(value) { calls.push(['limit', value]); return this },
    or(value) { calls.push(['or', value]); return this },
    then(resolve) { resolve({ data: [], error: null }) } }
  const repository = createH2ARepository({ from: table => { calls.push(['from', table]); return query }, rpc: async () => ({ data: true }) })
  await repository.listConflicts('company-1', { limit: 26, before: {
    createdAt: '2026-10-01T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000001',
  } })
  assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'company_id' && call[2] === 'company-1'))
  assert.ok(calls.some(call => call[0] === 'or' && call[1].includes('created_at.lt.2026-10-01T00:00:00.000Z') &&
    call[1].includes('id.lt.00000000-0000-4000-8000-000000000001')))
  assert.deepEqual(calls.filter(call => call[0] === 'order').map(call => call[1]), ['created_at', 'id'])
})

test('conflict resolution and resume delivery use company-scoped atomic RPCs', async () => {
  const calls = []
  const repository = createH2ARepository({ from: table => {
    assert.equal(table, 'h2a_conflict_resumes')
    return { select() { return this }, eq(key, value) { calls.push(['filter', key, value]); return this },
      order() { return this }, limit() { return this }, then(resolve) { resolve({ data: [], error: null }) } }
  }, rpc: async (name, args) => { calls.push([name, args]); return { data: name === 'h2a_resolve_conflict'
    ? { conflict: { id: 'f1' }, event: { id: 'e1' }, resume: null, replayed: false } :
      name === 'h2a_claim_conflict_resume' ? { id: 'q1' } : true, error: null } } })
  const result = await repository.resolveConflict('company-1', { conflictId: 'f1', expectedUpdatedAt: '2026-10-01T00:00:00Z',
    actorId: 'user-1', action: 'approve_fields', dbAction: 'approve_hubspot', selectedFields: ['city'],
    approveManyToOne: false, targetId: null, now: '2026-10-01T00:00:00Z' })
  assert.equal(result.conflict.id, 'f1')
  assert.deepEqual(calls[0][1].p_request.selectedFields, ['city'])
  assert.equal(calls[0][1].p_company_id, 'company-1')
  await repository.claimConflictResume('company-1', 'q1', 'owner-1')
  await repository.finishConflictResume('company-1', 'q1', 'owner-1', true)
  assert.deepEqual(calls.filter(call => Array.isArray(call) && call[0] !== 'filter').map(call => call[0]), [
    'h2a_resolve_conflict', 'h2a_claim_conflict_resume', 'h2a_finish_conflict_resume',
  ])
})

test('a terminal run cannot be revived by a delayed background resume', async () => {
  const supabase = { rpc: async () => ({ data: true }), from: () => ({ select() { return this }, eq() { return this },
    maybeSingle: async () => ({ data: { id: 'run1', mode: 'live', status: 'completed' }, error: null }),
    update: () => { throw Error('terminal run was updated') } }) }
  await assert.rejects(() => createH2ARepository(supabase).startRun('company-1', {
    runId: 'run1', mode: 'live', trigger: 'resume',
  }), /Run is not resumable/)
})

test('daily run claim and finish use owner-fenced, retryable service RPCs', async () => {
  const calls = []
  const repository = createH2ARepository({ from: () => { throw Error('table access unexpected') }, rpc: async (name, args) => {
    calls.push([name, args]); return { data: name === 'h2a_claim_daily_run' ? { acquired: true, claim: { id: 'claim-1', attempt_count: 2 } } : true }
  } })
  const claim = await repository.claimDailyRun('company-1', '2026-10-05', 'owner-1', 180)
  assert.deepEqual(claim, { id: 'claim-1', attempt_count: 2, acquired: true })
  assert.equal(await repository.finishDailyRun('company-1', 'claim-1', 'owner-1', false, 'dispatch_failed'), true)
  assert.deepEqual(calls.map(([name, args]) => [name, args.p_company_id]), [
    ['h2a_claim_daily_run', 'company-1'], ['h2a_finish_daily_run', 'company-1'],
  ])
})

test('targeted resume intent and skipped conflict lookups carry explicit tenant predicates', async () => {
  const calls = []
  const query = { select() { return this }, eq(key, value) { calls.push(['eq', key, value]); return this },
    is(key, value) { calls.push(['is', key, value]); return this }, limit() { return this },
    maybeSingle: async () => ({ data: null, error: null }) }
  const repository = createH2ARepository({ from: table => { calls.push(['from', table]); return query }, rpc: async () => ({ data: true }) })
  await repository.getConflictResume('company-1', 'resume-1')
  assert.equal(await repository.isSkippedItem('company-1', 'portal-1', 'calls', 'activity-1'), false)
  assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'company_id' && call[2] === 'company-1'))
  assert.equal(calls.filter(call => call[0] === 'from').every(call => ['h2a_conflict_resumes', 'h2a_conflicts'].includes(call[1])), true)
})
