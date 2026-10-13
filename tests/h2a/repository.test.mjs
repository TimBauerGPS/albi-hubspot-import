import test from 'node:test'
import assert from 'node:assert/strict'
import { createH2ARepository } from '../../netlify/functions/_h2a/repository.js'

const REVIEW_ID = '00000000-0000-4000-8000-000000000001'
const ACTOR_ID = '00000000-0000-4000-8000-000000000002'
const REVIEW_TIME = '2026-10-12T12:00:00.123456Z'
const reviewRow = { id: REVIEW_ID, company_id: 'company-1', run_id: 'sample-2', portal_id: '123',
  object_type: 'contacts', source_id: '42', reason: 'name_only_candidate', conflict_type: 'contact_match',
  status: 'needs_review', updated_at: REVIEW_TIME }

// The external query boundary is doubled; validation, payloads, filters, and result mapping are real.
function reviewRepositoryFixture(responses = []) {
  const calls = []
  const rpcCalls = []
  const queryResponses = [...responses]
  const repository = createH2ARepository({
    from(table) {
      const call = { table, steps: [] }
      calls.push(call)
      const query = {}
      for (const method of ['select', 'eq', 'neq', 'in', 'gt', 'order', 'limit', 'range', 'or', 'insert', 'update', 'delete']) {
        query[method] = (...args) => { call.steps.push([method, ...args]); return query }
      }
      const finish = () => {
        assert.ok(queryResponses.length, `Unexpected query to ${table}`)
        return queryResponses.shift()
      }
      query.single = async () => finish()
      query.maybeSingle = async () => finish()
      query.then = (resolve, reject) => Promise.resolve().then(finish).then(resolve, reject)
      return query
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args })
      assert.ok(queryResponses.length, 'Unexpected RPC')
      return queryResponses.shift()
    },
  })
  return { repository, calls, rpcCalls }
}
const data = value => ({ data: value, error: null })
const equalityFilters = call => call.steps.filter(step => step[0] === 'eq').map(step => step.slice(1))

const RESOLUTION_ID = '00000000-0000-4000-8000-000000000003'
const OWNER_ID = '00000000-0000-4000-8000-000000000004'
const resolutionRow = { id: RESOLUTION_ID, company_id: 'company-1', run_id: 'sample-2', review_id: REVIEW_ID,
  portal_id: '123', object_type: 'contacts', source_id: '42', action: 'create_albi', status: 'pending',
  decision: { action: 'create_albi' }, execution_phase: null, lease_owner: null }

test('review resolution RPCs use exact signatures and normalize decisions and audit details', async () => {
  const { repository, rpcCalls } = reviewRepositoryFixture([data({ resolution: resolutionRow, created: false }),
    data({ resolution: { ...resolutionRow, status: 'applying', execution_phase: 'waiting_on_albi', lease_owner: OWNER_ID } }),
    data({ resolution: { ...resolutionRow, status: 'waiting_on_albi' } }), data({ choice: { hubspot_company_id: '20' } })])
  const created = await repository.createReviewResolution('company-1', { runId: 'sample-2', reviewId: REVIEW_ID,
    portalId: '123', objectType: 'contacts', sourceId: '42', expectedUpdatedAt: REVIEW_TIME,
    decision: { action: 'resolve_fields', fieldChoices: { phoneNumber: 'hubspot', email: 'albi' } },
    clientRequestId: RESOLUTION_ID, actorId: ACTOR_ID })
  assert.equal(created.created, false)
  assert.equal(rpcCalls[0].name, 'h2a_create_review_resolution')
  assert.deepEqual(rpcCalls[0].args, { p_company_id: 'company-1', p_run_id: 'sample-2', p_review_id: REVIEW_ID,
    p_portal_id: '123', p_object_type: 'contacts', p_source_id: '42', p_action: 'resolve_fields',
    p_expected_review_updated_at: REVIEW_TIME,
    p_decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } },
    p_decision_hash: '949cec54ac94767f4aeb692bb844c25d7f8d7e656772c5f0785cfb965357deb7',
    p_client_request_id: RESOLUTION_ID, p_actor_id: ACTOR_ID })
  const claimed = await repository.claimReviewResolution('company-1', RESOLUTION_ID, OWNER_ID, ACTOR_ID, 120)
  assert.equal(claimed.resolution.execution_phase, 'waiting_on_albi')
  assert.equal(claimed.resolution.lease_owner, OWNER_ID)
  assert.deepEqual(rpcCalls[1], { name: 'h2a_claim_review_resolution', args: {
    p_company_id: 'company-1', p_resolution_id: RESOLUTION_ID, p_owner_token: OWNER_ID, p_actor_id: ACTOR_ID, p_ttl_seconds: 120,
  } })
  await repository.finishReviewResolution('company-1', RESOLUTION_ID, OWNER_ID, { actorId: ACTOR_ID,
    status: 'waiting_on_albi', eventType: 'failed', details: { code: 'timeout', message: 'secret' }, providerOutcomeCode: 'timeout' })
  assert.deepEqual(rpcCalls[2], { name: 'h2a_finish_review_resolution', args: {
    p_company_id: 'company-1', p_resolution_id: RESOLUTION_ID, p_owner_token: OWNER_ID, p_actor_id: ACTOR_ID,
    p_status: 'waiting_on_albi', p_event_type: 'failed', p_event_details: { code: 'timeout' }, p_provider_outcome_code: 'timeout',
  } })
  await repository.upsertContactOrganizationChoice('company-1', { portalId: '123', contactId: '42', organizationSourceId: '20', actorId: ACTOR_ID })
  assert.deepEqual(rpcCalls[3], { name: 'h2a_upsert_contact_organization_choice', args: {
    p_company_id: 'company-1', p_portal_id: '123', p_hubspot_contact_id: '42', p_hubspot_company_id: '20', p_actor_id: ACTOR_ID,
  } })
})

test('resolution reads and audit inserts always scope company and apply fixed ordering and caps', async () => {
  const event = { id: RESOLUTION_ID, actor_id: ACTOR_ID, event_type: 'failed', created_at: REVIEW_TIME,
    sanitized_details: { code: 'timeout', raw: 'secret' } }
  const { repository, calls } = reviewRepositoryFixture([data(resolutionRow), data(resolutionRow), data([event]), data(event), data({ hubspot_company_id: '20' })])
  assert.deepEqual(await repository.getReviewResolution('company-1', RESOLUTION_ID), resolutionRow)
  assert.deepEqual(await repository.getCurrentReviewResolution('company-1', REVIEW_ID), resolutionRow)
  assert.deepEqual(equalityFilters(calls[0]), [['company_id', 'company-1'], ['id', RESOLUTION_ID]])
  assert.deepEqual(equalityFilters(calls[1]), [['company_id', 'company-1'], ['review_id', REVIEW_ID]])
  assert.deepEqual(calls[1].steps.filter(step => step[0] === 'order'), [
    ['order', 'created_at', { ascending: false }], ['order', 'id', { ascending: false }],
  ])
  assert.deepEqual(calls[1].steps.find(step => step[0] === 'limit'), ['limit', 1])
  const events = await repository.listReviewResolutionEvents('company-1', RESOLUTION_ID)
  assert.deepEqual(events[0].sanitized_details, { code: 'timeout' })
  assert.deepEqual(equalityFilters(calls[2]), [['company_id', 'company-1'], ['resolution_id', RESOLUTION_ID]])
  assert.deepEqual(calls[2].steps.filter(step => step[0] === 'order'), [
    ['order', 'created_at', { ascending: true }], ['order', 'id', { ascending: true }],
  ])
  assert.deepEqual(calls[2].steps.find(step => step[0] === 'limit'), ['limit', 100])
  await repository.appendReviewResolutionEvent('company-1', RESOLUTION_ID,
    { actorId: ACTOR_ID, eventType: 'failed', details: { code: 'timeout', apiKey: 'secret' }, now: REVIEW_TIME })
  assert.deepEqual(calls[3].steps[0], ['insert', { company_id: 'company-1', resolution_id: RESOLUTION_ID,
    actor_id: ACTOR_ID, event_type: 'failed', sanitized_details: { code: 'timeout' }, created_at: REVIEW_TIME }])
  assert.deepEqual(equalityFilters(calls[3]), [['company_id', 'company-1']])
  await repository.getContactOrganizationChoice('company-1', '123', '42')
  assert.deepEqual(equalityFilters(calls[4]), [['company_id', 'company-1'], ['portal_id', '123'], ['hubspot_contact_id', '42']])
  for (const call of calls) {
    const select = call.steps.find(step => step[0] === 'select')
    assert.ok(select); assert.equal(select[1].includes('*'), false)
  }
})

test('resolution repository rejects missing scope and invalid mutation inputs before touching storage', async () => {
  const { repository, calls, rpcCalls } = reviewRepositoryFixture()
  for (const call of [() => repository.createReviewResolution('', {}), () => repository.getReviewResolution('', RESOLUTION_ID),
    () => repository.getCurrentReviewResolution('', REVIEW_ID), () => repository.claimReviewResolution('', RESOLUTION_ID, OWNER_ID, ACTOR_ID),
    () => repository.finishReviewResolution('', RESOLUTION_ID, OWNER_ID, {}), () => repository.listReviewResolutionEvents('', RESOLUTION_ID),
    () => repository.appendReviewResolutionEvent('', RESOLUTION_ID, {}), () => repository.getContactOrganizationChoice('', '123', '42'),
    () => repository.upsertContactOrganizationChoice('', {}),
    () => repository.claimReviewResolution('company-1', RESOLUTION_ID, OWNER_ID, ACTOR_ID, 3601),
    () => repository.claimReviewResolution('company-1', RESOLUTION_ID, 'owner-secret', ACTOR_ID, 120),
    () => repository.finishReviewResolution('company-1', RESOLUTION_ID, OWNER_ID, { actorId: ACTOR_ID, status: 'failed', eventType: 'failed', providerOutcomeCode: 'provider_secret' }),
    () => repository.appendReviewResolutionEvent('company-1', RESOLUTION_ID, { actorId: ACTOR_ID, eventType: 'unknown' }),
    () => repository.upsertContactOrganizationChoice('company-1', { portalId: '123', contactId: '42', organizationSourceId: 'secret', actorId: ACTOR_ID }),
  ]) await assert.rejects(call, TypeError)
  assert.equal(calls.length, 0); assert.equal(rpcCalls.length, 0)
})

test('resolution RPC errors expose only fixed error codes and fixed transport failure text', async () => {
  for (const response of [data({ error: 'lease_lost', message: 'secret' }), data({ error: 'provider-secret' }),
    { error: { message: 'secret', code: '08006' } }, data(null), data({ resolution: [], raw: 'secret' })]) {
    const { repository } = reviewRepositoryFixture([response])
    if (response.data?.error === 'lease_lost') {
      assert.deepEqual(await repository.claimReviewResolution('company-1', RESOLUTION_ID, OWNER_ID, ACTOR_ID), { error: 'lease_lost' })
    } else await assert.rejects(() => repository.claimReviewResolution('company-1', RESOLUTION_ID, OWNER_ID, ACTOR_ID),
      error => error.message === 'Review resolution storage failed')
  }
})

test('resolution storage rejects malformed success rows rather than accepting a missing durable identity', async () => {
  for (const response of [data({ resolution: {} }), data({ resolution: { id: 'provider-secret' } })]) {
    const { repository } = reviewRepositoryFixture([response])
    await assert.rejects(() => repository.claimReviewResolution('company-1', RESOLUTION_ID, OWNER_ID, ACTOR_ID),
      error => error.message === 'Review resolution storage failed')
  }
})

test('resolution reads strip unselected columns and retain only a capped sanitized audit history', async () => {
  const event = { id: RESOLUTION_ID, company_id: 'company-1', resolution_id: RESOLUTION_ID,
    actor_id: ACTOR_ID, event_type: 'failed', created_at: REVIEW_TIME, token: 'secret', sanitized_details: { code: 'timeout', raw: 'secret' } }
  const { repository } = reviewRepositoryFixture([data({ ...resolutionRow, token: 'secret' }),
    data(Array.from({ length: 150 }, () => event)), data(null)])
  assert.equal((await repository.getReviewResolution('company-1', RESOLUTION_ID)).token, undefined)
  const events = await repository.listReviewResolutionEvents('company-1', RESOLUTION_ID)
  assert.equal(events.length, 100); assert.equal(events[0].token, undefined)
  assert.deepEqual(events[0].sanitized_details, { code: 'timeout' })
  assert.equal(await repository.getCurrentReviewResolution('company-1', REVIEW_ID), null)
})

test('latest completed bounded sample includes historical metadata but repeats tenant cutoff and deterministic ordering', async () => {
  const run = { id: 'historical', review_capture_version: null }
  const { repository, calls } = reviewRepositoryFixture([data(run)])
  assert.deepEqual(await repository.getLatestCompletedSampleDryRun('company-1', '2026-10-01T00:00:00Z'), run)
  assert.deepEqual(calls[0].steps[0], ['select', 'id,created_at,finished_at,review_capture_version,sample_limit_per_type,status'])
  assert.deepEqual(equalityFilters(calls[0]), [['company_id', 'company-1'], ['mode', 'dry_run'], ['status', 'completed'], ['sample_limit_per_type', 10]])
  assert.deepEqual(calls[0].steps.filter(step => step[0] === 'gt'), [['gt', 'created_at', '2026-10-01T00:00:00Z']])
  assert.deepEqual(calls[0].steps.filter(step => step[0] === 'order'), [['order', 'created_at', { ascending: false }], ['order', 'id', { ascending: false }]])
  assert.deepEqual(calls[0].steps.find(step => step[0] === 'limit'), ['limit', 1])
})

test('full dry-run readiness selects a fresh completed version-one bounded sample and counts all rows', async () => {
  const { repository, calls } = reviewRepositoryFixture([data({ id: 'sample-2', review_capture_version: 1 }),
    { count: 0, error: null }, data({ id: 'sample-2', review_capture_version: 1 })])
  assert.equal(await repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), true)
  assert.deepEqual(equalityFilters(calls[0]), [['company_id', 'company-1'], ['mode', 'dry_run'],
    ['status', 'completed'], ['sample_limit_per_type', 10]])
  assert.ok(calls[0].steps.some(step => step[0] === 'gt' && step[1] === 'created_at' && step[2] === '2026-10-01T00:00:00Z'))
  assert.deepEqual(calls[0].steps.filter(step => step[0] === 'order'), [
    ['order', 'created_at', { ascending: false }], ['order', 'id', { ascending: false }],
  ])
  assert.deepEqual(calls[0].steps.find(step => step[0] === 'limit'), ['limit', 1])
  assert.deepEqual(equalityFilters(calls[1]), [['company_id', 'company-1'], ['run_id', 'sample-2']])
  assert.deepEqual(calls[1].steps[0], ['select', 'id', { count: 'exact', head: true }])
  assert.deepEqual(calls[2], calls[0])
})

test('replacement completion and pruning cannot turn the former sample into clean readiness', async () => {
  // A had review rows. B completes with its own review rows and prunes A before A's count.
  const { repository, calls } = reviewRepositoryFixture([data({ id: 'sample-A', review_capture_version: 1 }),
    { count: 0, error: null }, data({ id: 'sample-B', review_capture_version: 1 })])
  assert.equal(await repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), false)
  assert.deepEqual(equalityFilters(calls[1]), [['company_id', 'company-1'], ['run_id', 'sample-A']])
  assert.deepEqual(calls[2], calls[0])
})

test('latest historical bounded sample cannot reuse an older version-one clean sample', async () => {
  const { repository, calls } = reviewRepositoryFixture()
  repository.getLatestCompletedSampleDryRun = async () => ({ id: 'new-historical', review_capture_version: null })
  repository.getCurrentReviewSample = async () => ({ id: 'older-clean', review_capture_version: 1 })
  repository.countDryRunReviews = async () => 0
  assert.equal(await repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), false)
  assert.equal(calls.length, 0)
})

test('zero-row readiness requires the same version-one sample to remain current', async () => {
  for (const current of [null, { id: 'sample-2', review_capture_version: null }]) {
    const { repository } = reviewRepositoryFixture([data({ id: 'sample-2', review_capture_version: 1 }),
      { count: 0, error: null }, data(current)])
    assert.equal(await repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), false)
  }
})

test('readiness remains fail-closed on both count and current-sample revalidation query failures', async () => {
  const failure = { code: '08006' }
  for (const responses of [
    [data({ id: 'sample-2', review_capture_version: 1 }), { error: failure }],
    [data({ id: 'sample-2', review_capture_version: 1 }), { count: 0, error: null }, { error: failure }],
  ]) {
    const { repository } = reviewRepositoryFixture(responses)
    await assert.rejects(() => repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), error => error === failure)
  }
})

test('cleared and no-longer-in-scope rows still block their old sample from unlocking full history', async () => {
  const { repository, calls } = reviewRepositoryFixture([data({ id: 'sample-1', review_capture_version: 1 }), { count: 3, error: null }])
  assert.equal(await repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), false)
  assert.equal(equalityFilters(calls[1]).some(([key]) => key === 'status'), false)
  assert.equal(calls.length, 2)
})

test('missing and historical samples never satisfy clean review readiness', async () => {
  for (const run of [null, { id: 'old-sample', review_capture_version: null }]) {
    const { repository, calls } = reviewRepositoryFixture([data(run)])
    assert.equal(await repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), false)
    assert.equal(calls.length, 1)
  }
})

test('review counts fail closed on errors and malformed counts and allow only fixed status filters', async () => {
  for (const count of [null, undefined, -1, 1.5, '0']) {
    const { repository } = reviewRepositoryFixture([{ count, error: null }])
    await assert.rejects(() => repository.countDryRunReviews('company-1', 'sample-2'), /Invalid review count/)
  }
  const failure = { code: '08006' }
  const { repository } = reviewRepositoryFixture([{ error: failure }])
  await assert.rejects(() => repository.countDryRunReviews('company-1', 'sample-2'), error => error === failure)
  const filtered = reviewRepositoryFixture([{ count: 2, error: null }])
  assert.equal(await filtered.repository.countDryRunReviews('company-1', 'sample-2', 'cleared'), 2)
  assert.deepEqual(equalityFilters(filtered.calls[0]), [['company_id', 'company-1'], ['run_id', 'sample-2'], ['status', 'cleared']])
  await assert.rejects(() => filtered.repository.countDryRunReviews('company-1', 'sample-2', 'anything'), /Invalid review status/)
})

test('review list binds company and server-selected run, validates filters, and emits newest-first keyset pagination', async () => {
  const second = { ...reviewRow, id: ACTOR_ID }
  const { repository, calls } = reviewRepositoryFixture([data([reviewRow, second])])
  const result = await repository.listDryRunReviews('company-1', 'sample-2', { limit: 1,
    before: { createdAt: '2026-10-12T12:00:00.000Z', id: REVIEW_ID },
    status: 'needs_review', objectType: 'contacts', reason: 'name_only_candidate' })
  assert.deepEqual(result, { items: [reviewRow], hasMore: true })
  assert.deepEqual(equalityFilters(calls[0]), [['company_id', 'company-1'], ['run_id', 'sample-2'],
    ['status', 'needs_review'], ['object_type', 'contacts'], ['reason', 'name_only_candidate']])
  assert.deepEqual(calls[0].steps.filter(step => step[0] === 'order'), [
    ['order', 'created_at', { ascending: false }], ['order', 'id', { ascending: false }],
  ])
  assert.deepEqual(calls[0].steps.find(step => step[0] === 'limit'), ['limit', 2])
  assert.deepEqual(calls[0].steps.find(step => step[0] === 'or'), ['or',
    `created_at.lt.2026-10-12T12:00:00.000Z,and(created_at.eq.2026-10-12T12:00:00.000Z,id.lt.${REVIEW_ID})`])
})

test('review list rejects unsupported filters and injectable decoded boundaries before querying', async () => {
  const { repository, calls } = reviewRepositoryFixture()
  for (const options of [{ status: 'open' }, { objectType: 'emails' }, { reason: 'secret' }, { limit: 0 }, { limit: 101 },
    { limit: 2.5 }, { before: { createdAt: '2026-10-12T12:00:00Z),id.gt.any', id: REVIEW_ID } },
    { before: { createdAt: '2026-10-12T12:00:00Z', id: `${REVIEW_ID},id.gt.any` } }]) {
    await assert.rejects(() => repository.listDryRunReviews('company-1', 'sample-2', options), TypeError)
  }
  assert.equal(calls.length, 0)
})

test('review detail and audit reads verify the review under company, run, and review identity', async () => {
  const { repository, calls } = reviewRepositoryFixture([data(reviewRow), data(reviewRow), data([{ id: 'event-1' }])])
  assert.deepEqual(await repository.getDryRunReview('company-1', 'sample-2', REVIEW_ID), reviewRow)
  assert.deepEqual(await repository.listDryRunReviewEvents('company-1', 'sample-2', REVIEW_ID), [{ id: 'event-1' }])
  for (const call of calls.slice(0, 2)) {
    assert.deepEqual(equalityFilters(call), [['company_id', 'company-1'], ['run_id', 'sample-2'], ['id', REVIEW_ID]])
  }
  assert.deepEqual(equalityFilters(calls[2]), [['company_id', 'company-1'], ['review_id', REVIEW_ID]])
  assert.deepEqual(calls[2].steps.filter(step => step[0] === 'order'), [
    ['order', 'created_at', { ascending: true }], ['order', 'id', { ascending: true }],
  ])
  const missing = reviewRepositoryFixture([data(null)])
  assert.deepEqual(await missing.repository.listDryRunReviewEvents('company-1', 'other-run', REVIEW_ID), [])
  assert.equal(missing.calls.length, 1)
})

test('capture builds a positive-allowlist payload and records one fixed captured event after initial insertion', async () => {
  const { repository, calls } = reviewRepositoryFixture([data(reviewRow), data(reviewRow), data({ id: 'event-1' })])
  const captured = await repository.recordDryRunReview('company-1', { ...reviewRow, company_id: 'other-company',
    status: 'cleared', recheck_outcome: 'safe_to_link', apiKey: 'secret',
    source_snapshot: { id: '42', email: 'a@example.com', notes: 'body', apiKey: 'secret' },
    candidate_snapshots: Array.from({ length: 11 }, (_, i) => ({ id: String(i), email: `a${i}@example.com`, apiKey: 'secret' })),
    match_evidence: { evidence: ['email', 'authorization'], apiKey: 'secret' },
    proposed_changes: { updates: { city: 'Town', notes: 'body' }, authorization: 'secret' },
  })
  assert.equal(captured.id, REVIEW_ID)
  const inserted = calls[0].steps.find(step => step[0] === 'insert')[1]
  assert.deepEqual(Object.keys(inserted).sort(), ['candidate_snapshots', 'company_id', 'conflict_type', 'match_evidence',
    'object_type', 'portal_id', 'proposed_changes', 'reason', 'run_id', 'source_id', 'source_snapshot', 'status'].sort())
  assert.equal(inserted.company_id, 'company-1')
  assert.equal(inserted.status, 'needs_review')
  assert.equal(inserted.candidate_snapshots.length, 10)
  assert.deepEqual(inserted.source_snapshot, { id: '42', email: 'a@example.com' })
  assert.deepEqual(inserted.match_evidence, { evidence: ['email'] })
  assert.deepEqual(inserted.proposed_changes, { updates: { city: 'Town' }, conflicts: {}, unchanged: [] })
  assert.equal(JSON.stringify(inserted).includes('secret'), false)
  const event = calls[2].steps.find(step => step[0] === 'insert')[1]
  assert.equal(event.company_id, 'company-1')
  assert.equal(event.review_id, REVIEW_ID)
  assert.equal(event.event_type, 'captured')
  assert.equal(event.reason, 'name_only_candidate')
  assert.equal(event.actor_id, null)
  assert.deepEqual(event.sanitized_details, {})
})

test('unique capture replay updates the same tenant/run/source identity and ensures its captured event', async () => {
  const { repository, calls } = reviewRepositoryFixture([{ error: { code: '23505' } }, data(reviewRow), data(reviewRow),
    data(reviewRow), { error: { code: '23505', message: 'duplicate key value violates unique constraint "h2a_dry_review_events_captured_once_idx"' } }])
  assert.deepEqual(await repository.recordDryRunReview('company-1', reviewRow), reviewRow)
  assert.deepEqual(equalityFilters(calls[1]), [['company_id', 'company-1'], ['run_id', 'sample-2'],
    ['portal_id', '123'], ['object_type', 'contacts'], ['source_id', '42']])
  assert.deepEqual(equalityFilters(calls[2]), [['company_id', 'company-1'], ['run_id', 'sample-2'],
    ['portal_id', '123'], ['object_type', 'contacts'], ['source_id', '42'], ['id', REVIEW_ID]])
  assert.equal(calls.filter(call => call.table === 'h2a_dry_run_review_events').length, 1)
  assert.equal(calls[4].steps.find(step => step[0] === 'insert')[1].event_type, 'captured')
})

// State lives at the external database boundary; repository capture/replay and
// retry run unmodified. The index behavior is separately pinned in SQL.
function durableCaptureFixture({ eventFailure = false, delayedEventFailure = null } = {}) {
  let stored = null, failEvent = eventFailure, delayedFailure = delayedEventFailure
  const events = [], deletes = [], calls = []
  const repository = createH2ARepository({
    from(table) {
      const filters = [], query = {}; let operation = 'read', payload
      const call = { table, filters }; calls.push(call)
      for (const method of ['select', 'eq']) query[method] = (...args) => { if (method === 'eq') filters.push(args); return query }
      for (const method of ['insert', 'update', 'delete']) query[method] = value => { operation = method; payload = value; return query }
      const finish = () => {
        if (table === 'h2a_dry_run_review_events') {
          assert.equal(operation, 'insert')
          assert.equal(payload.company_id, 'company-1'); assert.equal(payload.review_id, REVIEW_ID)
          if (delayedFailure) { const pending = delayedFailure; delayedFailure = null; pending.started(); return pending.promise }
          if (failEvent) { failEvent = false; return { error: { code: '08006', message: 'event provider secret' } } }
          if (events.length) return { error: { code: '23505', constraint: 'h2a_dry_review_events_captured_once_idx' } }
          events.push({ id: 'event-1', ...payload }); return data(events[0])
        }
        assert.equal(table, 'h2a_dry_run_reviews')
        if (operation === 'insert') {
          if (stored) return { error: { code: '23505' } }
          stored = { ...payload, id: REVIEW_ID }; return data(stored)
        }
        assert.ok(filters.some(([key, value]) => key === 'company_id' && value === 'company-1'))
        assert.ok(filters.some(([key, value]) => key === 'run_id' && value === 'sample-2'))
        if (operation === 'update') { stored = { ...stored, ...payload }; return data(stored) }
        if (operation === 'delete') {
          deletes.push(filters)
          stored = null; events.length = 0; return data(null)
        }
        return data(stored)
      }
      query.single = async () => finish(); query.maybeSingle = async () => finish()
      query.then = (resolve, reject) => Promise.resolve().then(finish).then(resolve, reject)
      return query
    }, rpc: async () => { throw Error('Capture must not invoke RPC') },
  })
  return { repository, events, deletes, calls, row: () => stored }
}

test('failed initial captured-event insertion retains its bounded row until retry repairs the audit', async () => {
  const f = durableCaptureFixture({ eventFailure: true })
  await assert.rejects(() => f.repository.recordDryRunReview('company-1', reviewRow),
    error => error.message === 'Review capture event was not recorded')
  assert.ok(f.row()); assert.equal(f.events.length, 0); assert.equal(f.deletes.length, 0)
  const repaired = await f.repository.recordDryRunReview('company-1', reviewRow)
  assert.equal(repaired.id, REVIEW_ID); assert.equal(f.events.length, 1)
  assert.equal(f.events[0].event_type, 'captured')
  await f.repository.recordDryRunReview('company-1', reviewRow)
  assert.equal(f.events.length, 1); assert.equal(f.deletes.length, 0)
})

test('a delayed inserter event failure cannot delete a concurrent replay repair that already succeeded', async () => {
  let releaseFailure, eventStarted
  const started = new Promise(resolve => { eventStarted = resolve })
  const f = durableCaptureFixture({ delayedEventFailure: {
    started: eventStarted, promise: new Promise(resolve => { releaseFailure = resolve }),
  } })
  const inserter = f.repository.recordDryRunReview('company-1', reviewRow)
  const rejected = assert.rejects(inserter, error => error.message === 'Review capture event was not recorded')
  await started
  const replay = await f.repository.recordDryRunReview('company-1', reviewRow)
  assert.equal(replay.id, REVIEW_ID); assert.ok(f.row()); assert.equal(f.events.length, 1)
  releaseFailure({ error: { code: '08006', message: 'event provider secret' } })
  await rejected
  assert.ok(f.row()); assert.equal(f.events.length, 1); assert.equal(f.deletes.length, 0)
  await f.repository.recordDryRunReview('company-1', reviewRow)
  assert.equal(f.events.length, 1)
})

test('concurrent and repeated capture attempts retain one row and one captured audit event', async () => {
  const f = durableCaptureFixture()
  const results = await Promise.all(Array.from({ length: 3 }, () => f.repository.recordDryRunReview('company-1', reviewRow)))
  assert.deepEqual(results.map(result => result.id), [REVIEW_ID, REVIEW_ID, REVIEW_ID])
  assert.equal(f.events.length, 1); assert.equal(f.deletes.length, 0)
  assert.equal(f.calls.filter(call => call.table === 'h2a_dry_run_review_events').length, 3)
})

test('only the captured-event unique index conflict counts as repaired and replay never compensates an existing row', async () => {
  for (const failure of [{ code: '23505', constraint: 'unrelated_index', message: 'provider secret' },
    { code: '23505', message: 'provider secret' }, { code: '08006', constraint: 'h2a_dry_review_events_captured_once_idx' }]) {
    const { repository, calls } = reviewRepositoryFixture([{ error: { code: '23505' } }, data(reviewRow), data(reviewRow),
      data(reviewRow), { error: failure }])
    await assert.rejects(() => repository.recordDryRunReview('company-1', reviewRow),
      error => error.message === 'Review capture event was not recorded')
    assert.equal(calls.some(call => call.steps.some(step => step[0] === 'delete')), false)
  }
})

test('failed captured-event insertion retains the row and propagates only fixed safe failure text', async () => {
  const { repository, calls } = reviewRepositoryFixture([data(reviewRow), data(reviewRow),
    { error: { code: '08006', message: 'event provider secret' } }])
  await assert.rejects(() => repository.recordDryRunReview('company-1', reviewRow),
    error => error.message === 'Review capture event was not recorded')
  assert.equal(calls.length, 3)
  assert.equal(calls.some(call => call.steps.some(step => step[0] === 'delete')), false)
})

test('unique violation without a matching source identity is rejected without updating or recording an event', async () => {
  const failure = { code: '23505' }
  const { repository, calls } = reviewRepositoryFixture([{ error: failure }, data(null)])
  await assert.rejects(() => repository.recordDryRunReview('company-1', reviewRow), error => error === failure)
  assert.equal(calls.length, 2)
})

test('capture rejects unsupported classifications and identities and propagates nonunique database errors', async () => {
  const { repository, calls } = reviewRepositoryFixture()
  for (const patch of [{ object_type: 'calls' }, { reason: 'secret' }, { conflict_type: '' }, { run_id: '' }, { portal_id: '' }, { source_id: '' }]) {
    await assert.rejects(() => repository.recordDryRunReview('company-1', { ...reviewRow, ...patch }), TypeError)
  }
  assert.equal(calls.length, 0)
  const error = { code: '08006', message: 'database unavailable' }
  const failed = reviewRepositoryFixture([{ error }])
  await assert.rejects(() => failed.repository.recordDryRunReview('company-1', reviewRow), value => value === error)
  assert.equal(failed.calls.length, 1)
})

test('audit insertion accepts fixed events, requires actors for rechecks, and sanitizes failure details', async () => {
  const { repository, calls } = reviewRepositoryFixture([data(reviewRow), data({ id: 'event-1' })])
  await repository.appendDryRunReviewEvent('company-1', 'sample-2', REVIEW_ID, { eventType: 'recheck_failed',
    reason: 'transient:timeout', actorId: ACTOR_ID, now: REVIEW_TIME,
    details: { category: 'transient', code: 'timeout', message: 'provider secret', authorization: 'secret' } })
  assert.deepEqual(equalityFilters(calls[0]), [['company_id', 'company-1'], ['run_id', 'sample-2'], ['id', REVIEW_ID]])
  assert.deepEqual(calls[1].steps.find(step => step[0] === 'insert')[1], { company_id: 'company-1', review_id: REVIEW_ID,
    actor_id: ACTOR_ID, event_type: 'recheck_failed', reason: 'transient:timeout',
    sanitized_details: { category: 'transient', code: 'timeout' }, created_at: REVIEW_TIME })
  const invalid = reviewRepositoryFixture()
  for (const input of [{ eventType: 'delete' }, { eventType: 'recheck_started', actorId: null },
    { eventType: 'recheck_started', actorId: 'user-1' }, { eventType: 'captured', reason: 'secret' }]) {
    await assert.rejects(() => invalid.repository.appendDryRunReviewEvent('company-1', 'sample-2', REVIEW_ID, input), TypeError)
  }
  assert.equal(invalid.calls.length, 0)
  const missing = reviewRepositoryFixture([data(null)])
  assert.equal(await missing.repository.appendDryRunReviewEvent('company-1', 'other-run', REVIEW_ID,
    { eventType: 'recheck_started', actorId: ACTOR_ID }), null)
  assert.equal(missing.calls.length, 1)
})

const recheckInput = { runId: 'sample-2', reviewId: REVIEW_ID, expectedUpdatedAt: REVIEW_TIME,
  actorId: ACTOR_ID, status: 'cleared', outcome: 'safe_to_link', reason: 'name_only_candidate', conflictType: 'contact_match',
  sourceSnapshot: { id: '42', email: 'a@example.com', apiKey: 'secret' },
  candidateSnapshots: [{ id: '7', email: 'a@example.com', notes: 'body' }], matchEvidence: ['email', 'secret'],
  proposedChanges: {}, eventType: 'cleared', eventDetails: { outcome: 'safe_to_link', message: 'secret' }, now: '2026-10-12T12:00:01.000Z' }

test('atomic recheck forwards the exact CAS timestamp and tenant with allowlisted evidence only', async () => {
  const { repository, rpcCalls } = reviewRepositoryFixture([data(reviewRow), data({ review: { ...reviewRow, status: 'cleared' } })])
  const result = await repository.applyDryRunRecheck('company-1', recheckInput)
  assert.equal(result.review.status, 'cleared')
  assert.deepEqual(rpcCalls, [{ name: 'h2a_apply_dry_run_recheck', args: {
    p_company_id: 'company-1', p_review_id: REVIEW_ID, p_expected_updated_at: REVIEW_TIME, p_actor_id: ACTOR_ID,
    p_status: 'cleared', p_recheck_outcome: 'safe_to_link', p_reason: 'name_only_candidate', p_conflict_type: 'contact_match',
    p_source_snapshot: { id: '42', email: 'a@example.com' }, p_candidate_snapshots: [{ id: '7', email: 'a@example.com' }],
    p_match_evidence: { evidence: ['email'] }, p_proposed_changes: { updates: {}, conflicts: {}, unchanged: [] },
    p_event_type: 'cleared', p_event_details: { outcome: 'safe_to_link' }, p_now: '2026-10-12T12:00:01.000Z',
  } }])
})

test('atomic recheck derives snapshot type from the scoped stored row rather than a caller object type', async () => {
  const organization = { ...reviewRow, object_type: 'companies' }
  const { repository, calls, rpcCalls } = reviewRepositoryFixture([data(organization), data({ review: organization })])
  await repository.applyDryRunRecheck('company-1', { ...recheckInput, objectType: 'contacts',
    sourceSnapshot: { id: '42', name: 'Allied', firstName: 'forbidden contact field' },
    candidateSnapshots: [{ id: '7', name: 'Allied', firstName: 'forbidden contact field' }],
    proposedChanges: { updates: { name: 'Allied', firstName: 'forbidden contact field' } } })
  assert.deepEqual(equalityFilters(calls[0]), [['company_id', 'company-1'], ['run_id', 'sample-2'], ['id', REVIEW_ID]])
  assert.deepEqual(rpcCalls[0].args.p_source_snapshot, { id: '42', name: 'Allied' })
  assert.deepEqual(rpcCalls[0].args.p_candidate_snapshots, [{ id: '7', name: 'Allied' }])
  assert.deepEqual(rpcCalls[0].args.p_proposed_changes, { updates: { name: 'Allied' }, conflicts: {}, unchanged: [] })
})

test('a malformed count refuses full dry-run readiness rather than reporting a clean sample', async () => {
  const { repository } = reviewRepositoryFixture([data({ id: 'sample-2', review_capture_version: 1 }), { count: null, error: null }])
  await assert.rejects(() => repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), /Invalid review count/)
})

test('atomic recheck exposes only stable RPC errors and rejects malformed responses', async () => {
  for (const error of ['not_found', 'stale', 'superseded', 'invalid_recheck']) {
    const { repository } = reviewRepositoryFixture([data(reviewRow), data({ error, message: 'secret' })])
    assert.deepEqual(await repository.applyDryRunRecheck('company-1', recheckInput), { error })
  }
  for (const result of [null, {}, { error: 'secret' }, { review: null }]) {
    const { repository } = reviewRepositoryFixture([data(reviewRow), data(result)])
    await assert.rejects(() => repository.applyDryRunRecheck('company-1', recheckInput), /Invalid review recheck response/)
  }
  const missing = reviewRepositoryFixture([data(null)])
  assert.deepEqual(await missing.repository.applyDryRunRecheck('company-1', recheckInput), { error: 'not_found' })
  assert.equal(missing.rpcCalls.length, 0)
})

test('atomic recheck rejects invalid state, actor, timestamp, and blank safe classification before RPC', async () => {
  const { repository, calls, rpcCalls } = reviewRepositoryFixture()
  for (const patch of [{ status: 'open' }, { outcome: 'write' }, { eventType: 'captured' }, { actorId: null },
    { expectedUpdatedAt: null }, { expectedUpdatedAt: 'invalid' }, { now: null }, { conflictType: '' }, { runId: '' }]) {
    await assert.rejects(() => repository.applyDryRunRecheck('company-1', { ...recheckInput, ...patch }), TypeError)
  }
  assert.equal(calls.length, 0)
  assert.equal(rpcCalls.length, 0)
})

test('superseded review pruning selects only other terminal capable runs and deletes their explicit tenant-scoped IDs', async () => {
  const { repository, calls } = reviewRepositoryFixture([data([{ id: 'old-completed' }, { id: 'old-cancelled' }]), data([{ id: 'old-review' }])])
  assert.deepEqual(await repository.pruneSupersededDryRunReviews('company-1', 'sample-2'), [{ id: 'old-review' }])
  assert.equal(calls[0].table, 'h2a_sync_runs')
  assert.deepEqual(equalityFilters(calls[0]), [['company_id', 'company-1'], ['mode', 'dry_run'],
    ['sample_limit_per_type', 10], ['review_capture_version', 1]])
  assert.deepEqual(calls[0].steps.find(step => step[0] === 'select'), ['select', 'id'])
  assert.deepEqual(calls[0].steps.find(step => step[0] === 'in'), ['in', 'status', ['completed', 'cancelled']])
  assert.deepEqual(calls[0].steps.find(step => step[0] === 'neq'), ['neq', 'id', 'sample-2'])
  assert.deepEqual(calls[1], { table: 'h2a_dry_run_reviews', steps: [ ['delete'],
    ['eq', 'company_id', 'company-1'], ['in', 'run_id', ['old-completed', 'old-cancelled']], ['select', 'id'] ] })
  await assert.rejects(() => repository.pruneSupersededDryRunReviews('company-1', ''), TypeError)
  assert.equal(calls.length, 2)
})

test('review pruning with no eligible terminal sets is a no-op with no delete request', async () => {
  const { repository, calls } = reviewRepositoryFixture([data([])])
  assert.deepEqual(await repository.pruneSupersededDryRunReviews('company-1', 'sample-2'), [])
  assert.deepEqual(calls.map(call => call.table), ['h2a_sync_runs'])
})

test('terminal pruning discovery and deletion errors fail without widening the scope', async () => {
  const error = { code: '08006' }
  const lookup = reviewRepositoryFixture([{ error }])
  await assert.rejects(() => lookup.repository.pruneSupersededDryRunReviews('company-1', 'sample-2'), caught => caught === error)
  assert.equal(lookup.calls.length, 1)
  assert.equal(lookup.calls[0].table, 'h2a_sync_runs')
  const deletion = reviewRepositoryFixture([data([{ id: 'old-completed' }]), { error }])
  await assert.rejects(() => deletion.repository.pruneSupersededDryRunReviews('company-1', 'sample-2'), caught => caught === error)
  assert.equal(deletion.calls.length, 2)
  assert.deepEqual(deletion.calls[1].steps.find(step => step[0] === 'in'), ['in', 'run_id', ['old-completed']])
})

test('review pruning pages terminal IDs and bounds every deletion request to one hundred IDs', async () => {
  const ids = Array.from({ length: 1005 }, (_, i) => ({ id: `old-${String(i).padStart(4, '0')}` }))
  const { repository, calls } = reviewRepositoryFixture([data(ids.slice(0, 1000)), data(ids.slice(1000)),
    ...Array.from({ length: 11 }, () => data([]))])
  assert.deepEqual(await repository.pruneSupersededDryRunReviews('company-1', 'sample-2'), [])
  assert.deepEqual(calls.filter(call => call.table === 'h2a_sync_runs').map(call => call.steps.find(step => step[0] === 'range')),
    [['range', 0, 999], ['range', 1000, 1999]])
  const deletes = calls.filter(call => call.table === 'h2a_dry_run_reviews')
  assert.deepEqual(deletes.map(call => call.steps.find(step => step[0] === 'in')[2].length),
    [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 5])
  assert.deepEqual(deletes.flatMap(call => call.steps.find(step => step[0] === 'in')[2]), ids.map(row => row.id))
  assert.ok(deletes.every(call => equalityFilters(call)[0][1] === 'company-1'))
})

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

test('dry-run totals use explicit safe fields and ignore proposals outside the exact action allowlist', async () => {
  const rows = [
    { id: 'a', object_type: 'companies', source_id: '1', outcome: 'dry_run', sanitized_details: { proposedAction: 'create_organization' }, created_at: '2026-10-01T00:00:00Z' },
    { id: 'b', object_type: 'contacts', source_id: '2', outcome: 'dry_run', sanitized_details: { proposedAction: 'create_contact' }, created_at: '2026-10-01T00:00:01Z' },
    { id: 'c', object_type: 'contacts', source_id: '3', albi_target_type: 'contact', albi_target_id: '7', outcome: 'dry_run', sanitized_details: { proposedAction: 'link_contact' }, created_at: '2026-10-01T00:00:02Z' },
    { id: 'd', object_type: 'companies', source_id: '4', albi_target_type: 'organization', albi_target_id: '8', outcome: 'dry_run', sanitized_details: { proposedAction: 'link_organization' }, created_at: '2026-10-01T00:00:03Z' },
    { id: 'e', object_type: 'calls', source_id: '5', albi_target_type: 'contact', albi_target_id: '7', outcome: 'dry_run', sanitized_details: { proposedAction: 'deliver_activity' }, created_at: '2026-10-01T00:00:04Z' },
    { id: 'f', object_type: 'calls', source_id: '6', outcome: 'dry_run', sanitized_details: { proposedAction: 'review_conflict' }, created_at: '2026-10-01T00:00:05Z' },
    { id: 'g', object_type: 'calls', source_id: '7', outcome: 'dry_run', sanitized_details: { proposedAction: 'arbitrary_secret_action' }, created_at: '2026-10-01T00:00:06Z' },
    { id: 'h', object_type: 'calls', source_id: '8', outcome: 'dry_run', sanitized_details: { proposedAction: 'constructor' }, created_at: '2026-10-01T00:00:07Z' },
    { id: 'i', object_type: 'emails', source_id: '9', outcome: 'skipped', sanitized_details: { reason: 'not_verified_direct_crm_email' }, created_at: '2026-10-01T00:00:08Z' },
  ]
  const query = { select() { return this }, eq() { return this }, order() { return this }, range() { return this },
    then(resolve) { resolve({ data: rows, error: null }) } }
  const totals = await createH2ARepository({ from: () => query, rpc: async () => ({ data: true }) })
    .totals('company-1', 'run-1', 'dry_run')
  assert.deepEqual(totals, {
    created: 0, updated: 0, linked: 0, delivered: 0, reconciled: 0, skipped: 1, conflict: 0, failed: 0, dry_run: 8,
    would_create_organizations: 1,
    would_create_contacts: 1,
    would_link: 2,
    would_deliver_activities: 1,
    requires_review: 1,
  })
  assert.equal(Object.hasOwn(totals, 'arbitrary_secret_action'), false)
  assert.equal(Object.hasOwn(totals, 'constructor'), false)
})

test('live totals retain their pre-review schema even when rows contain dry-run proposals', async () => {
  const rows = [{ id: 'a', object_type: 'contacts', source_id: '1', outcome: 'dry_run',
    sanitized_details: { proposedAction: 'create_contact' }, created_at: '2026-10-01T00:00:00Z' }]
  const totals = await createH2ARepository({ from: () => ({ select() { return this }, eq() { return this },
    order() { return this }, range() { return this }, then(resolve) { resolve({ data: rows, error: null }) } }),
  rpc: async () => ({ data: true }) }).totals('company-1', 'run-1', 'live')
  assert.deepEqual(totals, {
    created: 0, updated: 0, linked: 0, delivered: 0, reconciled: 0, skipped: 0, conflict: 0, failed: 0, dry_run: 1,
  })
})

test('completed dry runs persist every safe review total at zero when no proposed action was recorded', async () => {
  const rows = [{ id: 'a', object_type: 'calls', source_id: '1', outcome: 'dry_run',
    sanitized_details: { proposedAction: 'unrecognized' }, created_at: '2026-10-01T00:00:00Z' }]
  const totals = await createH2ARepository({ from: () => ({ select() { return this }, eq() { return this },
    order() { return this }, range() { return this }, then(resolve) { resolve({ data: rows, error: null }) } }),
  rpc: async () => ({ data: true }) }).totals('company-1', 'run-1', 'dry_run')
  assert.deepEqual(Object.fromEntries(Object.entries(totals).filter(([key]) => key.startsWith('would_') ||
    key === 'requires_review' || key === 'skipped')), {
    would_create_organizations: 0,
    would_create_contacts: 0,
    would_link: 0,
    would_deliver_activities: 0,
    requires_review: 0,
    skipped: 0,
  })
})

test('queueRun persists the bounded sample limit only on the durable run row', async () => {
  let inserted
  const supabase = { rpc: async () => ({ data: true }), from: table => {
    assert.equal(table, 'h2a_sync_runs')
    return {
      insert(row) { inserted = row; return this },
      select() { return this },
      single: async () => ({ data: { id: 'sample-run', ...inserted }, error: null }),
    }
  } }

  const result = await createH2ARepository(supabase).queueRun('company-1', {
    mode: 'dry_run', trigger: 'manual', requestedBy: 'user-1', sampleLimitPerType: 10, reviewCaptureVersion: 1,
  })

  assert.equal(result.sample_limit_per_type, 10)
  assert.equal(result.review_capture_version, 1)
  assert.equal(inserted.company_id, 'company-1')
  assert.equal(Object.hasOwn(inserted, 'dryRunScope'), false)
})

test('queueRun rejects capture markers outside the exact bounded version-one dry run before database access', async () => {
  const repository = createH2ARepository({ rpc: async () => ({}), from() { throw Error('database touched') } })
  for (const input of [
    { mode: 'live', sampleLimitPerType: 10, reviewCaptureVersion: 1 },
    { mode: 'backfill', sampleLimitPerType: 10, reviewCaptureVersion: 1 },
    { mode: 'dry_run', sampleLimitPerType: null, reviewCaptureVersion: 1 },
    { mode: 'dry_run', sampleLimitPerType: 9, reviewCaptureVersion: 1 },
    { mode: 'dry_run', sampleLimitPerType: 10, reviewCaptureVersion: 2 },
    { mode: 'dry_run', sampleLimitPerType: 10, reviewCaptureVersion: '1' },
    { mode: 'dry_run', sampleLimitPerType: 10, reviewCaptureVersion: 0 },
  ]) await assert.rejects(() => repository.queueRun('company-1', { trigger: 'manual', ...input }), TypeError)
})

test('queueRun omits a capture marker for historical samples, full dry runs, and live runs', async () => {
  const rows = []
  const repository = createH2ARepository({ rpc: async () => ({}), from() { return {
    insert(row) { rows.push(row); return this }, select() { return this },
    single: async () => ({ data: rows.at(-1), error: null }),
  } } })
  for (const input of [
    { mode: 'dry_run', sampleLimitPerType: 10 },
    { mode: 'dry_run', sampleLimitPerType: null, reviewCaptureVersion: null },
    { mode: 'live', reviewCaptureVersion: null },
  ]) await repository.queueRun('company-1', { trigger: 'manual', ...input })
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => !Object.hasOwn(row, 'review_capture_version')))
})

test('completed sample prerequisite is tenant scoped and newer than the locked start-date decision', async () => {
  const calls = []
  const query = {
    select() { return this },
    eq(key, value) { calls.push(['eq', key, value]); return this },
    gt(key, value) { calls.push(['gt', key, value]); return this },
    order(key, options) { calls.push(['order', key, options]); return this },
    limit(value) { calls.push(['limit', value]); return this },
    maybeSingle: async () => ({ data: { id: 'sample-run' }, error: null }),
  }
  const repository = createH2ARepository({ from: table => {
    calls.push(['from', table])
    return query
  }, rpc: async () => ({ data: true }) })

  assert.equal(await repository.hasCompletedSampleDryRun('company-1', '2026-10-01T00:00:00.000Z'), true)
  assert.deepEqual(calls, [
    ['from', 'h2a_sync_runs'],
    ['eq', 'company_id', 'company-1'],
    ['eq', 'mode', 'dry_run'],
    ['eq', 'status', 'completed'],
    ['eq', 'sample_limit_per_type', 10],
    ['gt', 'created_at', '2026-10-01T00:00:00.000Z'],
    ['order', 'created_at', { ascending: false }],
    ['limit', 1],
  ])
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

test('run resume returns the post-transition row so a concurrent cancellation is visible', async () => {
  const before = { id: 'run1', company_id: 'company-1', mode: 'dry_run', status: 'paused', cancel_requested_at: null }
  const after = { ...before, status: 'running', cancel_requested_at: '2026-10-09T20:00:00.000Z' }
  const supabase = { rpc: async () => ({ data: true }), from: () => {
    let updating = false
    const query = {
      select() { return this },
      eq() { return this },
      in() { return this },
      update() { updating = true; return this },
      maybeSingle: async () => ({ data: before, error: null }),
      single: async () => ({ data: updating ? after : before, error: null }),
    }
    return query
  } }
  const resumed = await createH2ARepository(supabase).startRun('company-1', {
    runId: 'run1', mode: 'dry_run', trigger: 'resume',
  })
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.cancel_requested_at, '2026-10-09T20:00:00.000Z')
})

test('dry-run checkpoints are tenant and run scoped and persist atomically by activity type', async () => {
  const calls = []
  const stored = { company_id: 'company-1', run_id: 'run-1', object_type: 'calls',
    upper_bound: '2026-10-09T20:00:00.001Z', page_after: 'page-2',
    cursor_timestamp: '2026-10-02T12:00:00.000Z', cursor_object_id: '50', processed_count: 4, completed: false }
  const supabase = { rpc: async () => ({ data: true }), from(table) {
    calls.push(['from', table])
    return {
      select() { calls.push(['select']); return this },
      eq(key, value) { calls.push(['eq', key, value]); return this },
      maybeSingle: async () => ({ data: stored, error: null }),
      upsert(row, options) { calls.push(['upsert', row, options]); return this },
      single: async () => ({ data: stored, error: null }),
    }
  } }
  const repository = createH2ARepository(supabase)
  assert.deepEqual(await repository.getRunCheckpoint('company-1', 'run-1', 'calls'), {
    timestamp: '2026-10-02T12:00:00.000Z', objectId: '50',
    upperBound: '2026-10-09T20:00:00.001Z', pageAfter: 'page-2', processedCount: 4, completed: false,
  })
  await repository.saveRunCheckpoint('company-1', 'run-1', 'calls', {
    upperBound: '2026-10-09T20:00:00.001Z', pageAfter: null,
    timestamp: '2026-10-02T12:01:00.000Z', objectId: '51', processedCount: 5, completed: true,
  })
  assert.ok(calls.some(call => call[0] === 'upsert' && call[1].company_id === 'company-1' &&
    call[1].run_id === 'run-1' && call[1].object_type === 'calls' && call[1].completed === true &&
    call[1].processed_count === 5 &&
    call[1].upper_bound === '2026-10-09T20:00:00.001Z' && call[1].page_after === null &&
    call[2].onConflict === 'company_id,run_id,object_type'))
  assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'company_id' && call[2] === 'company-1'))
  assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'run_id' && call[2] === 'run-1'))
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

test('a skipped activity in an old portal does not suppress that ID in a new portal', async () => {
  const oldPortalSkip = { company_id: 'company-1', portal_id: 'old-portal', object_type: 'calls', source_id: 'activity-1',
    activity_object_type: null, activity_id: null, status: 'skipped' }
  const filtersByLookup = []
  const supabase = { from: table => {
    assert.equal(table, 'h2a_conflicts')
    const filters = []
    const query = { select() { return this }, eq(key, value) { filters.push([key, value]); return this },
      is(key, value) { filters.push([key, value]); return this }, limit() { return this },
      maybeSingle: async () => {
        filtersByLookup.push(filters)
        return { data: filters.every(([key, value]) => oldPortalSkip[key] === value) ? oldPortalSkip : null, error: null }
      } }
    return query
  }, rpc: async () => ({ data: true }) }
  const repository = createH2ARepository(supabase)
  assert.equal(await repository.isSkippedItem('company-1', 'new-portal', 'calls', 'activity-1'), false)
  assert.equal(filtersByLookup.length, 2)
  assert.ok(filtersByLookup.every(filters => filters.some(([key, value]) => key === 'portal_id' && value === 'new-portal')))
})
