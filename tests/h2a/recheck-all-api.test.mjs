import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecheckAllHandler } from '../../netlify/functions/h2a-dry-run-review-recheck-all.js'

const batchId = '00000000-0000-4000-8000-0000000000b1'
const actorId = '00000000-0000-4000-8000-000000000002'
const stamp = '2026-10-12T12:00:00.000Z'
const batchRow = { id: batchId, company_id: 'authorized-company', run_id: 'server-run', requested_by: actorId, status: 'queued',
  total: 0, done: 0, cleared: 0, still_needs_review: 0, no_longer_in_scope: 0, stale: 0, failed: 0, error_code: null,
  heartbeat_at: stamp, started_at: null, finished_at: null, created_at: stamp, updated_at: stamp }

function fixture({ sample = { id: 'server-run', review_capture_version: 1 }, create, background = false } = {}) {
  const calls = [], dispatched = [], finished = []
  const repository = {
    getConfig: async () => ({ initial_start_locked_at: '2026-10-01T00:00:00Z', portal_id: '123' }),
    getCurrentReviewSample: async () => sample,
    getLatestCompletedSampleDryRun: async () => sample,
    getDryRunReview: async () => null,
    listDryRunReviews: async () => ({ items: [], hasMore: false }),
    appendDryRunReviewEvent: async () => ({ id: 'event' }),
    getMappings: async () => ({ contacts: [], organizations: [], options: [] }),
    applyDryRunRecheck: async () => { throw Error('unexpected apply') },
    createReviewRecheckBatch: async (company, input) => { calls.push(['create', company, input]); return create ?? { batch: batchRow } },
    getLatestReviewRecheckBatch: async (company, kind) => { calls.push(['latest', company, kind]); return { ...batchRow, status: 'running', total: 4, done: 1, cleared: 1 } },
    claimReviewRecheckBatch: async (company, id) => { calls.push(['claim', company, id]); return { ...batchRow, status: 'running' } },
    updateReviewRecheckBatch: async () => true,
    finishReviewRecheckBatch: async (company, id, patch) => { finished.push([company, id, patch]); return true },
  }
  const options = { repository, now: () => new Date(stamp),
    requireRequest: async (_event, auth) => { calls.push(['auth', auth]); return { companyId: 'authorized-company', userId: actorId } },
    dispatch: async payload => { dispatched.push(payload) },
    makeClients: async () => { throw Error('providers must not be read') } }
  return { calls, dispatched, finished, repository, options, handler: createRecheckAllHandler(options, { background }) }
}
const post = body => ({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify(body) })

test('start requires admin, creates one batch for the server-selected sample, and dispatches it by identity', async () => {
  const f = fixture()
  const response = await f.handler(post({ companyId: 'selected-company' }))
  assert.equal(response.statusCode, 202)
  assert.equal(f.calls[0][1].requireAdmin, true)
  assert.equal(f.calls[0][1].requestedCompanyId, 'selected-company')
  const [, company, input] = f.calls.find(call => call[0] === 'create')
  assert.equal(company, 'authorized-company')
  assert.deepEqual(input, { kind: 'sample', runId: 'server-run', reviewIds: null, actorId, now: stamp, staleBefore: '2026-10-12T11:44:00.000Z' })
  assert.deepEqual(f.dispatched, [{ companyId: 'authorized-company', batchId }])
  const body = JSON.parse(response.body)
  assert.equal(body.status, 'queued')
  assert.deepEqual(body.batch, { id: batchId, kind: 'sample', targeted: false, status: 'queued', total: 0, done: 0, cleared: 0, stillNeedsReview: 0,
    noLongerInScope: 0, stale: 0, failed: 0, errorCode: null, createdAt: stamp, startedAt: null, finishedAt: null })
  assert.equal(response.body.includes('server-run'), false)
})

test('a concurrent start returns the active batch without dispatching another', async () => {
  const f = fixture({ create: { error: 'active', batch: { ...batchRow, status: 'running', total: 5, done: 2 } } })
  const response = await f.handler(post({}))
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.status, 'already_running')
  assert.equal(body.batch.done, 2)
  assert.equal(f.dispatched.length, 0)
})

test('start without a current sample is refused before creating a batch', async () => {
  const f = fixture({ sample: null })
  const response = await f.handler(post({}))
  assert.equal(response.statusCode, 409)
  assert.equal(f.calls.some(call => call[0] === 'create'), false)
})

test('a failed dispatch fails the queued batch so a new one can start', async () => {
  const f = fixture()
  f.options.dispatch = async () => { throw Error('transport secret') }
  const response = await createRecheckAllHandler(f.options)(post({}))
  assert.equal(response.statusCode, 502)
  assert.equal(response.body.includes('secret'), false)
  assert.equal(f.finished.length, 1)
  assert.equal(f.finished[0][2].status, 'failed')
  assert.equal(f.finished[0][2].errorCode, 'dispatch_failed')
  assert.equal(f.finished[0][2].fromStatus, 'queued')
})

test('status returns the latest batch projection for the authorized company', async () => {
  const f = fixture()
  const response = await f.handler({ httpMethod: 'GET', queryStringParameters: { companyId: 'selected-company' } })
  assert.equal(response.statusCode, 200)
  assert.equal(f.calls[0][1].requireAdmin, true)
  assert.deepEqual(f.calls.find(call => call[0] === 'latest'), ['latest', 'authorized-company', 'sample'])
  const body = JSON.parse(response.body)
  assert.equal(body.batch.status, 'running')
  assert.equal(body.batch.done, 1)
  assert.equal(body.batch.total, 4)
})

test('start rejects unsupported fields', async () => {
  const f = fixture()
  const response = await f.handler(post({ companyId: 'c', batchId }))
  assert.equal(response.statusCode, 400)
  assert.equal(f.calls.some(call => call[0] === 'create'), false)
})

test('background requires internal credentials and runs only the named batch', async () => {
  const f = fixture({ background: true })
  const response = await f.handler(post({ companyId: 'authorized-company', batchId }))
  assert.equal(response.statusCode, 200)
  assert.equal(f.calls[0][1].internalJob, true)
  assert.equal(f.calls[0][1].requireAdmin, false)
  assert.deepEqual(f.calls.find(call => call[0] === 'claim'), ['claim', 'authorized-company', batchId])
  assert.equal(f.finished.at(-1)[2].status, 'completed')
})

test('background rejects a malformed batch identity before touching storage', async () => {
  const f = fixture({ background: true })
  const response = await f.handler(post({ companyId: 'authorized-company', batchId: 'nope' }))
  assert.equal(response.statusCode, 400)
  assert.equal(f.calls.some(call => call[0] === 'claim'), false)
})

test('background turns an unexpected crash into a failed batch', async () => {
  const f = fixture({ background: true })
  f.repository.listDryRunReviews = async () => { throw Error('db secret') }
  const response = await f.handler(post({ companyId: 'authorized-company', batchId }))
  assert.equal(response.statusCode, 200)
  assert.equal(f.finished.at(-1)[2].status, 'failed')
  assert.equal(JSON.stringify(f.finished).includes('secret'), false)
})

const ids = n => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)

test('a live batch starts without a sample and carries no run', async () => {
  const f = fixture({ sample: null })
  const response = await f.handler(post({ companyId: 'selected-company', kind: 'live' }))
  assert.equal(response.statusCode, 202)
  const [, company, input] = f.calls.find(call => call[0] === 'create')
  assert.equal(company, 'authorized-company')
  assert.deepEqual(input, { kind: 'live', runId: null, reviewIds: null, actorId, now: stamp, staleBefore: '2026-10-12T11:44:00.000Z' })
  assert.deepEqual(f.dispatched, [{ companyId: 'authorized-company', batchId }])
})

test('a targeted batch carries its deduplicated review ids, at most 200', async () => {
  const f = fixture()
  const [a, b] = ids(2)
  const response = await f.handler(post({ kind: 'sample', reviewIds: [a, b, a] }))
  assert.equal(response.statusCode, 202)
  assert.deepEqual(f.calls.find(call => call[0] === 'create')[2].reviewIds, [a, b])
  for (const reviewIds of [ids(201), [], ['not-a-uuid'], 'x', [a, 7]]) {
    const refused = fixture()
    const result = await refused.handler(post({ kind: 'live', reviewIds }))
    assert.equal(result.statusCode, 400, JSON.stringify(reviewIds).slice(0, 40))
    assert.equal(refused.calls.some(call => call[0] === 'create'), false)
  }
  const accepted = fixture()
  assert.equal((await accepted.handler(post({ kind: 'live', reviewIds: ids(200) }))).statusCode, 202)
  const badKind = fixture()
  assert.equal((await badKind.handler(post({ kind: 'all' }))).statusCode, 400)
})

test('status reads the latest batch of the requested kind', async () => {
  const f = fixture()
  const response = await f.handler({ httpMethod: 'GET', queryStringParameters: { companyId: 'selected-company', kind: 'live' } })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(f.calls.find(call => call[0] === 'latest'), ['latest', 'authorized-company', 'live'])
  assert.equal(JSON.parse(response.body).batch.kind, 'sample')
  const bad = fixture()
  assert.equal((await bad.handler({ httpMethod: 'GET', queryStringParameters: { kind: 'other' } })).statusCode, 400)
})

test('the background run can close live rows and deliver their resumes', async () => {
  const f = fixture({ background: true })
  const closes = []
  f.repository.claimReviewRecheckBatch = async () => ({ ...batchRow, run_id: null, review_kind: 'live', review_ids: null, status: 'running' })
  f.repository.getReview = async () => ({ id: ids(1)[0], review_kind: 'live', status: 'needs_review', object_type: 'contacts',
    portal_id: '123', source_id: '10', run_id: 'live-run', reason: 'name_only_candidate', conflict_type: 'contact_match', updated_at: stamp })
  f.repository.listDryRunReviews = async (_company, runId, filters) => ({ items: runId === null && filters.kind === 'live'
    ? [{ id: ids(1)[0], object_type: 'contacts', updated_at: stamp, status: 'needs_review', triage_bucket: 'decision', triage_details: {} }] : [], hasMore: false })
  f.repository.getCurrentReviewResolution = async () => ({ id: 'r', action: 'link_existing', status: 'completed', created_by: actorId })
  f.repository.claimReviewResolution = async () => null
  f.repository.finishReviewResolution = async () => null
  f.repository.getContactOrganizationChoice = async () => null
  f.repository.closeLiveReview = async (company, args) => { closes.push([company, args]); return { closedConflictIds: [], resumeIds: [], replayed: false } }
  const noHubSpotRead = async () => { throw Error('a stranded row is settled without provider reads') }
  f.options.makeClients = async () => ({ hubspot: { getContacts: noHubSpotRead, getCompanies: noHubSpotRead, getAssociations: noHubSpotRead }, albi: { listContacts: async () => ({ records: [], cursor: null }),
    listOrganizations: async () => ({ records: [], cursor: null }) } })
  const response = await f.handler(post({ companyId: 'authorized-company', batchId }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(closes.map(([company, args]) => [company, args.outcome, args.resolutionAction]), [['authorized-company', 'resolved', 'link_existing']])
  assert.equal(f.finished.at(-1)[2].status, 'completed')
})
