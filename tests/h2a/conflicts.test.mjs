import assert from 'node:assert/strict'
import test from 'node:test'
import { listConflicts, resolveConflict } from '../../netlify/functions/_h2a/conflicts.js'
import { createConflictListHandler } from '../../netlify/functions/h2a-conflicts.js'
import { createConflictResolveHandler } from '../../netlify/functions/h2a-conflict-resolve.js'
import { H2AAuthError } from '../../netlify/functions/_h2a/auth.js'
import { dispatchPendingConflictResumes } from '../../netlify/functions/_h2a/conflicts.js'

const updatedAt = '2026-10-04T18:00:00.000Z'
const conflict = {
  id: 'conflict-1', company_id: 'company-1', portal_id: 'portal-1', object_type: 'contacts', source_id: 'hs-42',
  conflict_type: 'contact_match', reason: 'multiple_candidates', match_evidence: { email: 'x@example.com' },
  source_snapshot: { id: 'hs-42', firstname: 'Ada', email: 'x@example.com', apiKey: 'must-not-leak' },
  candidate_snapshots: [{ id: 'albi-8', firstName: 'Ada', ciphertext: 'must-not-leak' }],
  proposed_changes: { updates: { city: 'Oakland' }, conflicts: { phone: { hubspot: '555-111-2222', albi: '555-333-4444' } } },
  status: 'open', run_id: 'run-1', activity_delivery_id: 'delivery-1', activity_object_type: 'calls', activity_id: 'activity-9',
  created_at: updatedAt, updated_at: updatedAt,
}

function serviceDeps(overrides = {}) {
  const calls = { listed: [], resolved: [], dispatched: [] }
  const result = { conflict, event: { id: 'event-1' }, resume: { id: 'resume-1', company_id: 'company-1', status: 'pending' }, replayed: false }
  const repository = {
    async listConflicts(companyId, options) { calls.listed.push([companyId, options]); return { items: [conflict], hasMore: false } },
    async listConflictEvents(companyId, ids) { calls.listed.push([companyId, ids]); return [{ id: 'event-1', company_id: companyId, conflict_id: ids[0], event_type: 'resolved', actor_id: 'user-1', created_at: updatedAt, sanitized_details: { apiAction: 'link_existing' } }] },
    async resolveConflict(companyId, input) { calls.resolved.push([companyId, input]); return result },
    async markConflictResumeAttempt(companyId, resumeId, accepted, errorCode) { calls.listed.push(['attempt', companyId, resumeId, accepted, errorCode]) },
    async claimConflictResume(companyId, resumeId) { calls.listed.push(['claim', companyId, resumeId]); return result.resume },
    async finishConflictResume(companyId, resumeId, _ownerToken, accepted, errorCode) {
      calls.listed.push(['attempt', companyId, resumeId, accepted, errorCode])
      return true
    },
  }
  return {
    calls, result,
    deps: { repository, dispatchResume: async resume => { calls.dispatched.push(resume); return true }, now: () => new Date(updatedAt), ...overrides },
  }
}

test('conflict listing validates a stable cursor, scopes all reads by company, and strips secret-like snapshot fields', async () => {
  const { deps, calls } = serviceDeps()
  const cursorId = '00000000-0000-4000-8000-000000000000'
  const page = await listConflicts({ repository: deps.repository, companyId: 'company-1', limit: 10,
    cursor: { createdAt: updatedAt, id: cursorId } })
  assert.deepEqual(calls.listed[0], ['company-1', { limit: 11, before: { createdAt: updatedAt, id: cursorId } }])
  assert.equal(page.items[0].source_snapshot.apiKey, undefined)
  assert.equal(page.items[0].candidate_snapshots[0].ciphertext, undefined)
  assert.equal(page.items[0].company_id, undefined)
  assert.equal(page.items[0].audit[0].actor_id, 'user-1')
  await assert.rejects(() => listConflicts({ repository: deps.repository, companyId: 'company-1', cursor: 'not-a-cursor' }), /cursor/i)
  await assert.rejects(() => listConflicts({ repository: deps.repository, companyId: 'company-1',
    cursor: { createdAt: '2026-02-30T00:00:00.000Z', id: cursorId } }), /timestamp/i)
})

test('conflict listing bounds page sizes and produces the next tuple cursor', async () => {
  const { deps } = serviceDeps()
  deps.repository.listConflicts = async (_companyId, options) => ({ items: Array.from({ length: options.limit }, (_, i) => ({
    ...conflict, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, created_at: updatedAt,
  })), hasMore: true })
  const page = await listConflicts({ repository: deps.repository, companyId: 'company-1', limit: 10000 })
  assert.equal(page.items.length, 100)
  assert.deepEqual(page.nextCursor, { createdAt: updatedAt, id: '00000000-0000-4000-8000-000000000099' })
})

test('identity link requires explicit target and explicit many-to-one approval when required', async () => {
  const { deps, calls, result } = serviceDeps()
  await assert.rejects(() => resolveConflict(deps, { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1',
    expectedUpdatedAt: updatedAt, action: 'link_existing' }), /target/i)
  result.error = 'many_to_one_required'
  await assert.rejects(() => resolveConflict(deps, { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1',
    expectedUpdatedAt: updatedAt, action: 'link_existing', targetId: 'albi-8' }), error => error.statusCode === 409)
  assert.equal(calls.dispatched.length, 0)
  delete result.error
  await resolveConflict(deps, { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1', expectedUpdatedAt: updatedAt,
    action: 'link_existing', targetId: 'albi-8', approveManyToOne: true })
  assert.equal(calls.resolved.at(-1)[1].approveManyToOne, true)
  assert.equal(calls.dispatched.length, 1)
})

test('strict action payloads reject unknown fields, invalid field names, and aliases', async () => {
  const { deps } = serviceDeps()
  const base = { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1', expectedUpdatedAt: updatedAt }
  for (const action of ['approve_hubspot', 'skip', 'link']) {
    await assert.rejects(() => resolveConflict(deps, { ...base, action }), error => error.statusCode === 400)
  }
  await assert.rejects(() => resolveConflict(deps, { ...base, action: 'skip_item', sourceSnapshot: {} }), error => error.statusCode === 400)
  await assert.rejects(() => resolveConflict(deps, { ...base, action: 'approve_fields', fields: ['apiKey'] }), error => error.statusCode === 400)
  await assert.rejects(() => resolveConflict(deps, { ...base, action: 'approve_fields', fields: [] }), error => error.statusCode === 400)
})

test('all five actions map to the exact persistence action and preserve selected fields', async () => {
  const actions = [
    [{ action: 'link_existing', targetId: 'albi-8' }, 'link_existing'],
    [{ action: 'create_new' }, 'create_new'],
    [{ action: 'approve_fields', fields: ['city'] }, 'approve_hubspot'],
    [{ action: 'retain_albi', fields: ['phone'] }, 'retain_albi'],
    [{ action: 'skip_item' }, 'skip'],
  ]
  for (const [payload, dbAction] of actions) {
    const { deps, calls } = serviceDeps()
    await resolveConflict(deps, { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1', expectedUpdatedAt: updatedAt, ...payload })
    assert.equal(calls.resolved[0][1].dbAction, dbAction)
    if (payload.fields) assert.deepEqual(calls.resolved[0][1].selectedFields, payload.fields)
  }
})

test('stale updates and a different resolution return conflict without dispatch', async () => {
  const { deps, result, calls } = serviceDeps()
  result.error = 'stale'
  await assert.rejects(() => resolveConflict(deps, { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1',
    expectedUpdatedAt: updatedAt, action: 'skip_item' }), error => error.statusCode === 409)
  assert.equal(calls.dispatched.length, 0)
})

test('a competing target for an already mapped source is rejected without a second dispatch', async () => {
  const { deps, result, calls } = serviceDeps()
  result.error = 'mapping_conflict'
  await assert.rejects(() => resolveConflict(deps, { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-2',
    expectedUpdatedAt: updatedAt, action: 'link_existing', targetId: 'albi-other' }), error => error.statusCode === 409)
  assert.deepEqual(calls.resolved[0][1].targetId, 'albi-other')
  assert.equal(calls.dispatched.length, 0)
})

test('an exact completed replay reuses its audit result and does not dispatch a second resume', async () => {
  const { deps, result, calls } = serviceDeps()
  const input = { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1', expectedUpdatedAt: updatedAt,
    action: 'link_existing', targetId: 'albi-8' }
  await resolveConflict(deps, input)
  result.replayed = true
  await resolveConflict(deps, input)
  assert.equal(calls.resolved.length, 2)
  assert.equal(calls.dispatched.length, 1)
})

test('a failed targeted dispatch leaves durable retryable intent and returns a recoverable failure', async () => {
  const { deps, calls } = serviceDeps({ dispatchResume: async () => { throw new Error('private transport text') } })
  await assert.rejects(() => resolveConflict(deps, { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1',
    expectedUpdatedAt: updatedAt, action: 'create_new' }), error => error.statusCode === 502 && !/private/.test(error.message))
  assert.ok(calls.listed.some(call => call[0] === 'attempt' && call[3] === false))
})

test('pending dispatch delivery can be retried independently using its stable resume ID', async () => {
  const { deps, calls } = serviceDeps()
  deps.repository.listPendingConflictResumes = async companyId => { assert.equal(companyId, 'company-1'); return [{
    id: 'resume-1', company_id: 'company-1', status: 'pending', source_object_type: 'contacts', source_id: 'hs-42',
    activity_object_type: 'calls', activity_id: 'activity-9',
  }] }
  const results = await dispatchPendingConflictResumes(deps, 'company-1')
  assert.deepEqual(results, [{ resumeId: 'resume-1', accepted: true, pending: false }])
  assert.equal(calls.dispatched[0].id, 'resume-1')
})

test('members may list conflicts while resolution endpoint requests admin authorization', async () => {
  const calls = []
  const listHandler = createConflictListHandler({
    requireRequest: async (_event, options) => { calls.push(options); return { companyId: 'company-1', supabase: {} } },
    repository: { listConflicts: async () => ({ items: [], hasMore: false }), listConflictEvents: async () => [] },
  })
  const listed = await listHandler({ httpMethod: 'GET', queryStringParameters: {} })
  assert.equal(listed.statusCode, 200)
  assert.equal(calls[0].requireAdmin, false)
  const resolveHandler = createConflictResolveHandler({
    requireRequest: async (_event, options) => { calls.push(options); return { companyId: 'company-1', userId: 'user-1', supabase: {} } },
    repository: { resolveConflict: async () => ({ error: 'stale' }) },
  })
  const response = await resolveHandler({ httpMethod: 'POST', body: JSON.stringify({ conflictId: 'conflict-1',
    expectedUpdatedAt: updatedAt, action: 'skip_item' }) })
  assert.equal(response.statusCode, 409)
  assert.equal(calls[1].requireAdmin, true)
  const denied = createConflictResolveHandler({
    requireRequest: async (_event, options) => { assert.equal(options.requireAdmin, true); throw new H2AAuthError(403, 'Admin only.') },
    repository: { resolveConflict: async () => { throw Error('unauthorized mutation') } },
  })
  const deniedResponse = await denied({ httpMethod: 'POST', body: JSON.stringify({ conflictId: 'conflict-1',
    expectedUpdatedAt: updatedAt, action: 'skip_item' }) })
  assert.equal(deniedResponse.statusCode, 403)
})

test('resume intent carries only the resolved tenant and exact blocked source/activity identities', async () => {
  const { deps, calls } = serviceDeps()
  await resolveConflict(deps, { companyId: 'company-1', actorId: 'user-1', conflictId: 'conflict-1', expectedUpdatedAt: updatedAt,
    action: 'link_existing', targetId: 'albi-8' })
  assert.deepEqual(calls.dispatched[0], { id: 'resume-1', company_id: 'company-1', status: 'pending' })
})
