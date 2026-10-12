import test from 'node:test'
import assert from 'node:assert/strict'
import { createDryRunReviewHandler } from '../../netlify/functions/h2a-dry-run-reviews.js'
import { H2AAuthError } from '../../netlify/functions/_h2a/auth.js'

const reviewId = '00000000-0000-4000-8000-000000000001'
const stamp = '2026-10-12T10:00:00.123456Z'
function fixture() {
  const calls = []
  const row = { id: reviewId, run_id: 'server-run', object_type: 'contacts', source_id: '10', portal_id: '123',
    reason: 'name_only_candidate', conflict_type: 'contact_match', status: 'needs_review', created_at: stamp, updated_at: stamp,
    source_snapshot: { firstName: 'A', lastName: 'Person', email: 'a@example.com', apiKey: 'secret', notes: 'secret' },
    candidate_snapshots: [{ id: '20', firstName: 'A', authorization: 'secret' }] }
  const repository = {
    getConfig: async company => { calls.push(['config', company]); return { initial_start_locked_at: '2026-10-01T00:00:00Z', portal_id: '123' } },
    getCurrentReviewSample: async (...args) => { calls.push(['sample', ...args]); return { id: 'server-run', review_capture_version: 1, created_at: stamp, finished_at: stamp } },
    getLatestCompletedSampleDryRun: async (...args) => { calls.push(['latest', ...args]); return { id: 'server-run', review_capture_version: 1, created_at: stamp, finished_at: stamp } },
    countDryRunReviews: async (...args) => { calls.push(['count', ...args]); return args[2] == null || args[2] === 'needs_review' ? 1 : 0 },
    hasCleanReviewSampleDryRun: async () => false,
    listDryRunReviews: async (...args) => { calls.push(['list', ...args]); return { items: [row], hasMore: true } },
    getDryRunReview: async (...args) => { calls.push(['detail', ...args]); return args[2] === reviewId ? row : null },
    listDryRunReviewEvents: async (...args) => { calls.push(['events', ...args]); return [{ event_type: 'recheck_failed', sanitized_details: { category: 'auth', code: 'operation_failed', message: 'secret' } }] },
    appendDryRunReviewEvent: async () => ({ id: 'event' }),
    getMappings: async () => ({ contacts: [], organizations: [], options: [] }),
    applyDryRunRecheck: async () => ({ review: { ...row, status: 'no_longer_in_scope', recheck_outcome: 'source_missing' } }),
  }
  const options = { repository, requireRequest: async (_event, auth) => { calls.push(['auth', auth]); return { companyId: 'authorized-company', userId: '00000000-0000-4000-8000-000000000002' } },
    makeClients: async company => { calls.push(['clients', company]); return { hubspot: { getContacts: async () => [], getCompanies: async () => [], getAssociations: async () => [] }, albi: { listContacts: async () => {}, listOrganizations: async () => {} } } } }
  return { calls, row, repository, options, handler: createDryRunReviewHandler(options) }
}
const get = query => ({ httpMethod: 'GET', queryStringParameters: query })

test('review list requires admin and every read uses the server-authorized company and current run', async () => {
  const f = fixture()
  const response = await f.handler(get({ companyId: 'selected-company', limit: '25', status: 'needs_review', objectType: 'contacts', reason: 'name_only_candidate' }))
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.equal(f.calls[0][1].requireAdmin, true)
  assert.equal(f.calls[0][1].requestedCompanyId, 'selected-company')
  assert.deepEqual(f.calls.find(call => call[0] === 'sample'), ['sample', 'authorized-company', '2026-10-01T00:00:00Z'])
  assert.deepEqual(f.calls.find(call => call[0] === 'list').slice(1, 3), ['authorized-company', 'server-run'])
  const body = JSON.parse(response.body)
  assert.deepEqual(body.progress, { total: 1, needsReview: 1, cleared: 0, noLongerInScope: 0, fullDryRunReady: false })
  assert.equal(body.sample.historical, false)
  assert.equal(body.items[0].displayName, 'A Person')
  assert.equal(JSON.stringify(body).includes('secret'), false)
  assert.deepEqual(JSON.parse(Buffer.from(body.nextCursor, 'base64url').toString()), { createdAt: stamp, id: reviewId })
})

test('detail exposes allowlisted snapshots and projected events under current run only', async () => {
  const f = fixture()
  const response = await f.handler(get({ companyId: 'selected-company', reviewId }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(f.calls.find(call => call[0] === 'detail'), ['detail', 'authorized-company', 'server-run', reviewId])
  assert.equal(JSON.parse(response.body).item.sourceSnapshot.email, 'a@example.com')
  assert.equal(JSON.stringify(response).includes('secret'), false)
  assert.equal(JSON.parse(response.body).item.events[0].details.category, 'auth')
})

test('missing and cross-tenant detail is a fixed non-enumerating 404', async () => {
  const f = fixture()
  const response = await f.handler(get({ reviewId: '00000000-0000-4000-8000-000000000099' }))
  assert.equal(response.statusCode, 404)
  assert.deepEqual(JSON.parse(response.body), { error: 'Sample review item not found.' })
})

for (const cursor of ['!', 'A'.repeat(1025), Buffer.from(JSON.stringify({ createdAt: stamp, id: 'invalid' })).toString('base64url'),
  Buffer.from(JSON.stringify({ createdAt: 'invalid', id: reviewId })).toString('base64url')]) {
  test('malformed cursor rejects with fixed validation before repository access', async () => {
    const f = fixture()
    const response = await f.handler(get({ cursor }))
    assert.equal(response.statusCode, 400)
    assert.equal(JSON.parse(response.body).error, 'Invalid sample review cursor.')
    assert.equal(f.calls.length, 0)
  })
}
for (const limit of ['0', '101', '-1', '1.5', 'abc']) test(`invalid page size ${limit} rejects`, async () => {
  const f = fixture()
  const response = await f.handler(get({ limit }))
  assert.equal(response.statusCode, 400)
  assert.equal(JSON.parse(response.body).error, 'Sample review page size must be between 1 and 100.')
})

for (const query of [{ status: 'open' }, { objectType: 'notes' }, { reason: 'secret' }, { companyId: 'a', company_id: 'b' },
  { reviewId, limit: '25' }, { runId: 'browser-run' }, { sourceId: 'browser-source' }]) test(`unsupported selectors reject ${JSON.stringify(query)}`, async () => {
  const f = fixture()
  assert.equal((await f.handler(get(query))).statusCode, 400)
  assert.equal(f.calls.length, 0)
})

for (const statusCode of [401, 403]) test(`authorization ${statusCode} stops before repository reads`, async () => {
  const f = fixture()
  f.options.requireRequest = async () => { throw new H2AAuthError(statusCode, statusCode === 403 ? 'Administrator access is required.' : 'Authentication required.') }
  const response = await createDryRunReviewHandler(f.options)(get({}))
  assert.equal(response.statusCode, statusCode)
  assert.equal(f.calls.length, 0)
})

test('repository failures return a fixed no-store 500', async () => {
  const f = fixture()
  f.repository.getConfig = async () => { throw Error('secret database text') }
  const response = await f.handler(get({}))
  assert.equal(response.statusCode, 500)
  assert.deepEqual(JSON.parse(response.body), { error: 'Unable to load sample reviews.' })
  assert.equal(response.headers['Cache-Control'], 'no-store')
})

test('no initial lock never queries an unbounded current sample', async () => {
  const f = fixture()
  f.repository.getConfig = async () => ({})
  const response = await f.handler(get({}))
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).sample, null)
  assert.equal(JSON.parse(response.body).progress.fullDryRunReady, false)
  assert.equal(f.calls.some(call => call[0] === 'sample'), false)
})

test('recheck responds with safe detail and diagnostic progress without changing sample totals', async () => {
  const f = fixture()
  const response = await f.handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'selected-company', reviewId, expectedUpdatedAt: stamp }) })
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.item.status, 'no_longer_in_scope')
  assert.equal(body.progress.fullDryRunReady, false)
  assert.equal(JSON.stringify(body).includes('secret'), false)
  assert.deepEqual(f.calls.find(call => call[0] === 'clients'), ['clients', 'authorized-company'])
})

test('POST rejects browser-controlled provider identifiers and conflicting selectors', async () => {
  const f = fixture()
  for (const extra of [{ sourceId: '11' }, { runId: 'old-run' }, { candidateId: '22' }, { objectType: 'companies' }]) {
    assert.equal((await f.handler({ httpMethod: 'POST', body: JSON.stringify({ reviewId, expectedUpdatedAt: stamp, ...extra }) })).statusCode, 400)
  }
  assert.equal((await f.handler({ httpMethod: 'POST', queryStringParameters: { companyId: 'other' }, body: JSON.stringify({ companyId: 'selected', reviewId, expectedUpdatedAt: stamp }) })).statusCode, 400)
  assert.equal(f.calls.length, 0)
})

test('latest historical sample hides older version-one details and requires a new sample', async () => {
  const f = fixture()
  f.repository.getLatestCompletedSampleDryRun = async () => ({ id: 'historical-run', created_at: stamp, finished_at: stamp, review_capture_version: null })
  const list = await f.handler(get({}))
  const body = JSON.parse(list.body)
  assert.equal(body.sample.historical, true)
  assert.equal(body.sample.id, 'historical-run')
  assert.deepEqual(body.items, [])
  assert.equal(body.progress.fullDryRunReady, false)
  assert.equal(body.message, 'Run a new sample to create detailed review data.')
  assert.equal(f.calls.some(call => call[0] === 'list'), false)
  const detail = await f.handler(get({ reviewId }))
  assert.equal(detail.statusCode, 409)
  assert.equal(JSON.parse(detail.body).error, 'Run a new sample to create detailed review data.')
})

test('read-only handler adapters never access provider mutation getters', async () => {
  const f = fixture()
  const original = f.options.makeClients
  f.options.makeClients = async company => {
    const clients = await original(company)
    for (const object of [clients.hubspot, clients.albi]) for (const method of ['createContact', 'createOrganization', 'updateContact', 'updateOrganization', 'associateContact']) {
      Object.defineProperty(object, method, { enumerable: true, get() { throw Error('mutation getter accessed') } })
    }
    return clients
  }
  assert.equal((await createDryRunReviewHandler(f.options)({ httpMethod: 'POST', body: JSON.stringify({ reviewId, expectedUpdatedAt: stamp }) })).statusCode, 200)
})

test('stale recheck HTTP response is fixed and never decrypts credentials', async () => {
  const f = fixture()
  const response = await f.handler({ httpMethod: 'POST', body: JSON.stringify({ reviewId, expectedUpdatedAt: '2026-10-12T09:00:00Z' }) })
  assert.equal(response.statusCode, 409)
  assert.equal(JSON.parse(response.body).error, 'This sample review changed. Refresh it before rechecking.')
  assert.equal(f.calls.some(call => call[0] === 'clients'), false)
})

test('valid opaque pagination decodes only the exact timestamp and review UUID', async () => {
  const f = fixture()
  const cursor = Buffer.from(JSON.stringify({ createdAt: stamp, id: reviewId })).toString('base64url')
  assert.equal((await f.handler(get({ cursor, limit: '100' }))).statusCode, 200)
  assert.deepEqual(f.calls.find(call => call[0] === 'list')[3].before, { createdAt: stamp, id: reviewId })
  assert.equal(f.calls.find(call => call[0] === 'list')[3].limit, 100)
})

test('zero counts for a pruned sample cannot report readiness after a replacement', async () => {
  const f = fixture()
  f.repository.countDryRunReviews = async () => 0
  f.repository.hasCleanReviewSampleDryRun = async () => true
  let replaced = false
  f.repository.listDryRunReviews = async () => { replaced = true; return { items: [], hasMore: false } }
  f.repository.getLatestCompletedSampleDryRun = async () => ({ id: replaced ? 'replacement' : 'server-run', review_capture_version: 1 })
  const response = await f.handler(get({}))
  assert.equal(JSON.parse(response.body).progress.fullDryRunReady, false)
})
