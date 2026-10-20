import test from 'node:test'
import assert from 'node:assert/strict'
import { createDryRunReviewHandler } from '../../netlify/functions/h2a-dry-run-reviews.js'
import { H2AAuthError } from '../../netlify/functions/_h2a/auth.js'
import { presentSampleReviewItem } from '../../src/features/hubspotToAlbi/sampleReview.js'

const reviewId = '00000000-0000-4000-8000-000000000001'
const stamp = '2026-10-12T10:00:00.123456Z'
function fixture() {
  const calls = []
  const row = { id: reviewId, run_id: 'server-run', object_type: 'contacts', source_id: '10', portal_id: '123',
    reason: 'name_only_candidate', conflict_type: 'contact_match', status: 'needs_review', created_at: stamp, updated_at: stamp,
    source_snapshot: { firstName: 'A', lastName: 'Person', email: 'a@example.com', apiKey: 'secret', notes: 'secret' },
    candidate_snapshots: [{ id: '20', firstName: 'A', authorization: 'secret' }] }
  const repository = {
    getCredentials: async () => ({ updated_at: '2026-10-01T00:00:00Z' }),
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
  const options = { repository, requireRequest: async (_event, auth) => { calls.push(['auth', auth]); return { companyId: 'authorized-company', userId: '00000000-0000-4000-8000-000000000002', role: 'admin', isSuperAdmin: false } },
    makeClients: async company => { calls.push(['clients', company]); return { hubspot: { getContacts: async () => [], getCompanies: async () => [], getAssociations: async () => [] }, albi: { listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }), listContacts: async () => {}, listOrganizations: async () => {} } } } }
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

test('review list exposes only the allowlisted current resolution status', async () => {
  const f = fixture()
  f.repository.getCurrentReviewResolution = async () => ({ status: 'waiting_on_albi', provider_outcome_code: 'secret', lease_owner: 'secret' })
  const response = await f.handler(get({}))
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).items[0].resolutionStatus, 'waiting_on_albi')
  assert.equal(response.body.includes('secret'), false)
})

test('detail exposes allowlisted snapshots and projected events under current run only', async () => {
  const f = fixture()
  const response = await f.handler(get({ companyId: 'selected-company', reviewId }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(f.calls.find(call => call[0] === 'detail'), ['detail', 'authorized-company', 'server-run', reviewId])
  assert.equal(JSON.parse(response.body).item.sourceSnapshot.email, 'a@example.com')
  assert.equal(JSON.stringify(response).includes('secret'), false)
  assert.equal(JSON.parse(response.body).item.events[0].details.category, 'auth')
  assert.equal(JSON.parse(response.body).item.portalId, '123')
  assert.deepEqual(JSON.parse(response.body).item.resolutionCapability,
    { enabled: false, mode: 'disabled', canResolve: false, hubspotWrites: 'verified_when_first_used' })
  assert.equal(JSON.parse(response.body).item.resolution, null)
})

test('review detail mode and durable HubSpot outcomes determine safe capability', async () => {
  const f = fixture()
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', role: 'admin', isSuperAdmin: false })
  f.repository.getCurrentReviewResolution = async () => ({ id: reviewId, action: 'resolve_fields', status: 'completed',
    provider_outcome_code: 'completed', company_id: 'authorized-company', portal_id: '123' })
  f.repository.listReviewResolutionEvents = async () => [{ event_type: 'provider_applied', created_at: stamp, sanitized_details: { code: 'provider_applied', message: 'secret' } }]
  const result = await createDryRunReviewHandler(f.options)(get({ reviewId }))
  assert.equal(result.statusCode, 200)
  assert.deepEqual(JSON.parse(result.body).item.resolutionCapability,
    { enabled: true, mode: 'admins', canResolve: true, hubspotWrites: 'available' })
  assert.equal(result.body.includes('secret'), false)
  assert.equal(f.calls.some(call => call[0] === 'clients'), true)
})

test('detail returns safe JSON when advisory provider evidence exceeds its deadline', async () => {
  const f = fixture()
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.detailDeadlineMs = 5
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', role: 'admin', isSuperAdmin: false })
  f.row.source_snapshot = { id: '10', firstName: 'A', lastName: 'Person', email: 'a@example.com' }
  f.options.makeClients = async () => ({ hubspot: {
    getContacts: async () => new Promise(() => {}),
    getCompanies: async () => [],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: [] }],
  }, albi: {
    listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }),
    listContacts: async () => new Promise(() => {}),
    listOrganizations: async () => new Promise(() => {}),
  } })

  const response = await Promise.race([
    createDryRunReviewHandler(f.options)(get({ reviewId })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('detail did not honor its advisory deadline')), 100)),
  ])

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Content-Type'], 'application/json')
  const item = JSON.parse(response.body).item
  assert.deepEqual(item.forceCreateReadiness, { eligible: false, ready: false })
  assert.equal(item.resolutionCapability.canResolve, true)
})

test('detail projects organization choices only after live server association reads', async () => {
  const f = fixture()
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', role: 'admin', isSuperAdmin: false })
  f.row.reason = 'organization_unresolved'
  f.repository.getMappings = async () => ({ contacts: [{ portal_id: '123', hubspot_id: '10', albi_contact_id: '20' }],
    organizations: [{ portal_id: '123', hubspot_id: '30', albi_organization_id: '40' }], options: [] })
  f.options.makeClients = async () => ({ hubspot: {
    getContacts: async () => [{ id: '10', properties: {} }], getCompanies: async () => [{ id: '30', properties: {} }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: ['30'] }],
  }, albi: {
    listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }),
    listContacts: async () => ({ records: [{ id: '20', organizationId: '50' }], cursor: null }),
    listOrganizations: async () => ({ records: [{ id: '40' }], cursor: null }),
  } })
  const body = JSON.parse((await createDryRunReviewHandler(f.options)(get({ reviewId }))).body)
  assert.deepEqual(body.item.organizationOptions[0], { sourceId: '30', targetId: '40', contactTargetId: '20',
    currentOrganizationTargetId: '50', associated: true,
    contactUrl: 'https://app.albiware.com/Relationships/Contact/20',
    organizationUrl: 'https://app.albiware.com/Relationships/Organization/40' })
})

test('reviewable no-match detail reaches a create decision only through fresh server evidence and presentation', async () => {
  const f = fixture()
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', role: 'admin', isSuperAdmin: false })
  f.row.reason = 'no_match'; f.row.candidate_snapshots = []; f.row.recheck_outcome = null
  f.row.source_snapshot = { id: '10', firstName: 'A', lastName: 'Person', email: 'a@example.com' }
  f.repository.getMappings = async () => ({ contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type',
    albi_id: '12', confirmed: true }] })
  f.options.makeClients = async () => ({ hubspot: {
    getContacts: async () => [{ id: '10', properties: { firstname: 'A', lastname: 'Person', email: 'a@example.com' } }],
    getCompanies: async () => [],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: [] }],
  }, albi: {
    listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }),
    listContacts: async () => ({ records: [], cursor: null }),
    listOrganizations: async () => ({ records: [], cursor: null }),
  } })
  const response = await createDryRunReviewHandler(f.options)(get({ reviewId }))
  assert.equal(response.statusCode, 200)
  const item = JSON.parse(response.body).item
  assert.equal(item.status, 'needs_review')
  assert.deepEqual(item.createReadiness, { ready: true, referralSources: [{ id: '5', label: 'Network' }] })
  assert.equal(presentSampleReviewItem(item).actions.includes('create_albi'), true)
})

test('name-only detail offers audited separate creation without enumerating Albi contacts', async () => {
  const f = fixture()
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', role: 'admin', isSuperAdmin: false })
  f.row.source_snapshot = { id: '10', firstName: 'A', lastName: 'Person', email: 'a@example.com' }
  f.repository.getMappings = async () => ({ contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type',
    source_key: 'default', albi_id: '12', confirmed: true }] })
  f.options.makeClients = async () => ({ hubspot: {
    getContacts: async () => [{ id: '10', properties: { firstname: 'A', lastname: 'Person', email: 'a@example.com' } }],
    getCompanies: async () => [],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: [] }],
  }, albi: {
    listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }),
    listContacts: async () => { throw Error('must not enumerate Albi contacts') },
    listOrganizations: async () => { throw Error('must not enumerate Albi organizations') },
  } })

  const response = await createDryRunReviewHandler(f.options)(get({ reviewId }))

  assert.equal(response.statusCode, 200)
  const item = JSON.parse(response.body).item
  assert.deepEqual(item.forceCreateReadiness, { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }] })
})

test('source correction and safe-to-create recheck expose authorized create while other cleared states remain closed', async () => {
  const f = fixture()
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', role: 'admin', isSuperAdmin: false })
  f.row.reason = 'missing_required_name'; f.row.status = 'cleared'; f.row.recheck_outcome = 'safe_to_create'
  f.row.candidate_snapshots = []; f.row.source_snapshot = { id: '10', firstName: 'A', lastName: 'Person' }
  f.repository.getMappings = async () => ({ contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type',
    source_key: 'default', albi_id: '12', confirmed: true }] })
  f.options.makeClients = async () => ({ hubspot: {
    getContacts: async () => [{ id: '10', properties: { firstname: 'A', lastname: 'Person' } }], getCompanies: async () => [],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: [] }],
  }, albi: { listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }), listContacts: async () => ({ records: [], cursor: null }), listOrganizations: async () => ({ records: [], cursor: null }) } })
  const item = JSON.parse((await f.handler(get({ reviewId }))).body).item
  assert.equal(item.createReadiness.ready, true)
  assert.deepEqual(presentSampleReviewItem(item).actions, ['create_albi'])
  f.row.recheck_outcome = 'safe_to_link'
  const blocked = JSON.parse((await f.handler(get({ reviewId }))).body).item
  assert.equal(blocked.createReadiness.ready, false)
  assert.deepEqual(presentSampleReviewItem(blocked).actions, [])
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

test('production recheck composition exposes the scoped choice and reconciliation without provider mutation capabilities', async () => {
  const f = fixture()
  f.row.reason = 'multiple_associated_organizations'; f.row.conflict_type = 'association'
  Object.assign(f.repository, {
    getContactOrganizationChoice: async (...args) => {
      assert.deepEqual(args, ['authorized-company', '123', '10'])
      return { company_id: 'authorized-company', portal_id: '123', hubspot_contact_id: '10', hubspot_company_id: '11' }
    },
    getCurrentReviewResolution: async () => null,
    claimReviewResolution: async () => { throw Error('no resolution to claim') },
    finishReviewResolution: async () => { throw Error('no resolution to finish') },
    applyDryRunRecheck: async (_company, payload) => ({ review: { ...f.row, status: payload.status, recheck_outcome: payload.outcome } }),
  })
  f.options.makeClients = async () => {
    const hubspot = {
      getContacts: async () => [{ id: '10', properties: { firstname: 'A', lastname: 'Person', email: 'a@example.com' } }],
      getCompanies: async () => [{ id: '11', properties: { name: 'Allied', domain: 'allied.example' } }],
      getOwnerId: async () => null,
      getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: ['11', '12'] }],
    }
    const albi = {
      listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }),
      listContacts: async () => ({ records: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', organizationId: '30' }], cursor: null }),
      listOrganizations: async () => ({ records: [{ id: '30', name: 'Allied', domain: 'allied.example' }], cursor: null }),
    }
    for (const object of [hubspot, albi, f.repository]) for (const name of ['removeAssociation', 'removeContactCompanyAssociation', 'updateAlbiContact', 'associateContact']) {
      Object.defineProperty(object, name, { get() { throw Error(`Forbidden capability: ${name}`) } })
    }
    return { hubspot, albi }
  }
  const response = await createDryRunReviewHandler(f.options)({ httpMethod: 'POST', body: JSON.stringify({ reviewId, expectedUpdatedAt: stamp }) })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).item.recheckOutcome, 'safe_to_link')
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

function prepareFixture({ companies = ['30'], mapped = false, existing = null } = {}) {
  const f = fixture(), recorded = []
  f.repository.getMappings = async () => ({ contacts: [], options: [],
    organizations: mapped ? [{ portal_id: '123', hubspot_id: '30', albi_organization_id: '40' }] : [] })
  f.repository.findDryRunReviewBySource = async (...args) => { f.calls.push(['find', ...args]); return existing }
  f.repository.recordDryRunReview = async (...args) => { recorded.push(args); return { id: '00000000-0000-4000-8000-0000000000bb' } }
  f.options.makeClients = async () => ({ hubspot: {
    getContacts: async () => [], getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: companies }],
    getCompanies: async ids => [{ id: ids[0], properties: { name: 'Acme', domain: 'acme.example', apiKey: 'secret' } }] }, albi: {} })
  f.handler = createDryRunReviewHandler(f.options)
  return { ...f, recorded }
}
const prepare = (f, extra = {}) => f.handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'selected', reviewId, expectedUpdatedAt: stamp, prepareOrganization: true, ...extra }) })

test('preparing an organization captures its own review in the current run exactly once', async () => {
  const f = prepareFixture()
  const response = await prepare(f)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).organization, { sourceId: '30', reviewId: '00000000-0000-4000-8000-0000000000bb', mapped: false })
  assert.equal(f.recorded.length, 1)
  const [company, input] = f.recorded[0]
  assert.equal(company, 'authorized-company')
  assert.deepEqual([input.run_id, input.portal_id, input.object_type, input.source_id, input.reason, input.conflict_type],
    ['server-run', '123', 'companies', '30', 'no_match', 'organization_match'])
  assert.deepEqual(input.candidate_snapshots, [])
  assert.equal(JSON.stringify(input).includes('secret'), false)
})

test('preparing an organization reuses an existing review and never records a duplicate', async () => {
  const f = prepareFixture({ existing: { id: '00000000-0000-4000-8000-0000000000cc' } })
  const body = JSON.parse((await prepare(f)).body)
  assert.deepEqual(body.organization, { sourceId: '30', reviewId: '00000000-0000-4000-8000-0000000000cc', mapped: false })
  assert.equal(f.recorded.length, 0)
})

test('an already mapped organization needs no preparation', async () => {
  const f = prepareFixture({ mapped: true })
  assert.deepEqual(JSON.parse((await prepare(f)).body).organization, { sourceId: '30', reviewId: null, mapped: true })
  assert.equal(f.recorded.length, 0)
})

test('preparing refuses stale reviews, non-contacts and anything but exactly one associated organization', async () => {
  for (const [f, extra, status] of [[prepareFixture({ companies: [] }), {}, 409], [prepareFixture({ companies: ['30', '31'] }), {}, 409],
    [prepareFixture(), { expectedUpdatedAt: '2026-10-12T10:00:01.000000Z' }, 409], [prepareFixture(), { reviewId: '00000000-0000-4000-8000-0000000000ee' }, 404],
    [prepareFixture(), { prepareOrganization: 'yes' }, 400]]) {
    const response = await prepare(f, extra)
    assert.equal(response.statusCode, status)
    assert.equal(f.recorded.length, 0)
  }
  const f = prepareFixture(); f.row.object_type = 'companies'
  assert.equal((await prepare(f)).statusCode, 409)
  assert.equal(f.recorded.length, 0)
})

test('contact detail shows the live HubSpot organization association by name, or null when unreadable', async () => {
  const f = fixture()
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', role: 'admin', isSuperAdmin: false })
  f.repository.getMappings = async () => ({ contacts: [], organizations: [], options: [] })
  f.options.makeClients = async () => ({ hubspot: {
    getContacts: async () => [], getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: ['30', '31'] }],
    getCompanies: async ids => [{ id: ids[0], properties: { name: ids[0] === '30' ? 'Lido House' : 'Other Co', apiKey: 'secret' } }] }, albi: {
    listContacts: async () => ({ records: [], cursor: null }), listOrganizations: async () => ({ records: [], cursor: null }) } })
  const body = JSON.parse((await createDryRunReviewHandler(f.options)(get({ reviewId }))).body)
  assert.deepEqual(body.item.hubspotOrganizations, [{ sourceId: '30', name: 'Lido House' }, { sourceId: '31', name: 'Other Co' }])
  assert.equal(JSON.stringify(body).includes('secret'), false)
  f.options.makeClients = async () => ({ hubspot: { getAssociations: async () => { throw new Error('down') } }, albi: {} })
  assert.equal(JSON.parse((await createDryRunReviewHandler(f.options)(get({ reviewId }))).body).item.hubspotOrganizations, null)
  const none = fixture()
  none.options.env = f.options.env; none.options.requireRequest = f.options.requireRequest
  none.options.makeClients = async () => ({ hubspot: { getAssociations: async () => [{ fromId: '10', toObjectType: 'companies', toIds: [] }] }, albi: {} })
  assert.deepEqual(JSON.parse((await createDryRunReviewHandler(none.options)(get({ reviewId }))).body).item.hubspotOrganizations, [])
})

function mergedFixture({ existing = null } = {}) {
  const f = fixture(), recorded = []
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', role: 'admin', isSuperAdmin: false, userId: '00000000-0000-4000-8000-000000000002' })
  f.repository.findDryRunReviewBySource = async (...args) => { f.calls.push(['find', ...args]); return existing }
  f.repository.recordDryRunReview = async (...args) => { recorded.push(args); return { id: '00000000-0000-4000-8000-0000000000ee' } }
  f.options.makeClients = async () => ({ hubspot: {
    getMergedInto: async (type, id) => type === 'contacts' && id === '10' ? '77' : null,
    getContact: async id => id === '77' ? { id: '77', properties: { firstname: 'Jaime', lastname: 'Talmi', email: 'jtalmi@example.com', apiKey: 'secret' } } : null,
    getContacts: async () => [], getAssociations: async ({ objectIds }) => [{ fromId: objectIds[0], toObjectType: 'companies', toIds: objectIds[0] === '77' ? ['30'] : [] }],
    getCompanies: async ids => [{ id: ids[0], properties: { name: 'Cushman & Wakefield' } }] },
  albi: { listContacts: async () => ({ records: [], cursor: null }), listOrganizations: async () => ({ records: [], cursor: null }) } })
  f.handler = createDryRunReviewHandler(f.options)
  return { ...f, recorded }
}

test('detail of a merged-away HubSpot source names the surviving record and its organization', async () => {
  const f = mergedFixture()
  const item = JSON.parse((await f.handler(get({ reviewId }))).body).item
  assert.deepEqual(item.mergedInto, { sourceId: '77', reviewId: null })
  assert.deepEqual(item.hubspotOrganizations, [{ sourceId: '30', name: 'Cushman & Wakefield' }])
})

test('the surviving record of a merge gets its own captured review once', async () => {
  const f = mergedFixture()
  const response = await f.handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'selected', reviewId, expectedUpdatedAt: stamp, prepareMergedSurvivor: true }) })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).survivor, { sourceId: '77', reviewId: '00000000-0000-4000-8000-0000000000ee' })
  const [, captured] = f.recorded[0]
  assert.deepEqual([captured.object_type, captured.source_id, captured.reason, captured.conflict_type, captured.run_id],
    ['contacts', '77', 'no_match', 'contact_match', 'server-run'])
  assert.equal(JSON.stringify(captured).includes('secret'), false)
  const reuse = mergedFixture({ existing: { id: '00000000-0000-4000-8000-0000000000ff' } })
  const again = JSON.parse((await reuse.handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'selected', reviewId, expectedUpdatedAt: stamp, prepareMergedSurvivor: true }) })).body)
  assert.deepEqual(again.survivor, { sourceId: '77', reviewId: '00000000-0000-4000-8000-0000000000ff' })
  assert.equal(reuse.recorded.length, 0)
  const notMerged = mergedFixture(); notMerged.row.source_id = '11'
  assert.equal((await notMerged.handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'selected', reviewId, expectedUpdatedAt: stamp, prepareMergedSurvivor: true }) })).statusCode, 409)
})

const liveRow = extra => ({ id: reviewId, run_id: 'live-run', review_kind: 'live', object_type: 'contacts', source_id: '10', portal_id: '123',
  reason: 'name_only_candidate', conflict_type: 'contact_match', status: 'needs_review', created_at: stamp, updated_at: stamp,
  source_snapshot: { firstName: 'A', lastName: 'Person', email: 'a@example.com' }, candidate_snapshots: [], triage_bucket: 'quick',
  triage_details: { quickKind: 'link' }, ...extra })

test('live list filters by kind and bucket, returns bucket counts and omits sample-only parts', async () => {
  const f = fixture()
  const counts = { quick: 1, todo: 0, decision: 2, blocked: 0, done: 4 }
  f.repository.listDryRunReviews = async (...args) => { f.calls.push(['list', ...args]); return { items: [liveRow()], hasMore: false, bucketCounts: counts } }
  const response = await f.handler(get({ companyId: 'selected-company', kind: 'live', bucket: 'quick' }))
  assert.equal(response.statusCode, 200)
  const [, company, runId, filters] = f.calls.find(call => call[0] === 'list')
  assert.deepEqual([company, runId, filters.kind, filters.bucket, filters.includeCounts], ['authorized-company', null, 'live', 'quick', true])
  const body = JSON.parse(response.body)
  assert.deepEqual(body.bucketCounts, counts)
  assert.equal(Object.hasOwn(body, 'sample'), false)
  assert.equal(Object.hasOwn(body, 'progress'), false)
  assert.equal(body.items[0].reviewKind, 'live')
  assert.equal(f.calls.some(call => ['sample', 'latest', 'count'].includes(call[0])), false)
})

test('sample list passes its kind and bucket and returns bucket counts', async () => {
  const f = fixture()
  f.repository.listDryRunReviews = async (...args) => { f.calls.push(['list', ...args]); return { items: [f.row], hasMore: false, bucketCounts: { quick: 0, todo: 1, decision: 0, blocked: 0, done: 0 } } }
  const response = await f.handler(get({ bucket: 'todo' }))
  assert.equal(response.statusCode, 200)
  const filters = f.calls.find(call => call[0] === 'list')[3]
  assert.deepEqual([filters.kind, filters.bucket, filters.includeCounts], ['sample', 'todo', true])
  const body = JSON.parse(response.body)
  assert.equal(body.bucketCounts.todo, 1)
  assert.equal(body.progress.fullDryRunReady, false)
  assert.equal(body.items[0].reviewKind, 'sample')
})

test('unknown kind or bucket filters are rejected before any read', async () => {
  for (const query of [{ kind: 'all' }, { bucket: 'later' }, { kind: 'live', reviewId: 'not-a-uuid' }]) {
    const f = fixture()
    const response = await f.handler(get(query))
    assert.equal(response.statusCode, 400)
    assert.equal(f.calls.some(call => call[0] === 'list'), false)
  }
})

test('live detail loads by review id without the sample gate', async () => {
  const f = fixture()
  f.repository.getCurrentReviewSample = async () => null
  f.repository.getReview = async (...args) => { f.calls.push(['review', ...args]); return liveRow() }
  const response = await f.handler(get({ reviewId }))
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.item.reviewKind, 'live')
  assert.deepEqual(f.calls.find(call => call[0] === 'events'), ['events', 'authorized-company', 'live-run', reviewId])
  assert.equal(f.calls.some(call => call[0] === 'detail'), false)
})

test('live detail from another portal is not found', async () => {
  const f = fixture()
  f.repository.getReview = async () => liveRow({ portal_id: '999' })
  const response = await f.handler(get({ reviewId }))
  assert.equal(response.statusCode, 404)
})

test('live detail retries the close of a completed resolution left open', async () => {
  const f = fixture()
  const row = liveRow()
  const closes = []
  f.repository.getReview = async () => row
  f.repository.getCurrentReviewResolution = async () => ({ id: reviewId, company_id: 'authorized-company', portal_id: '123', review_id: reviewId,
    action: 'link_existing', status: 'completed' })
  f.repository.listReviewResolutionEvents = async () => []
  f.repository.closeLiveReview = async (company, args) => { closes.push([company, args]); row.status = 'cleared'; return { closedConflictIds: ['c-1'], resumeIds: [], replayed: false } }
  const response = await f.handler(get({ reviewId }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(closes, [['authorized-company', { reviewId, actorId: '00000000-0000-4000-8000-000000000002', outcome: 'resolved', resolutionAction: 'link_existing' }]])
  assert.equal(JSON.parse(response.body).item.status, 'cleared')
})

test('live recheck responds with detail and no sample progress', async () => {
  const f = fixture()
  const row = liveRow({ candidate_snapshots: [] })
  f.repository.getCurrentReviewSample = async () => null
  f.repository.getReview = async () => row
  f.repository.applyDryRunRecheck = async (_company, payload) => { Object.assign(row, { recheck_outcome: payload.outcome }); return { review: { ...row } } }
  const response = await f.handler({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify({ companyId: 'selected-company', reviewId, expectedUpdatedAt: stamp }) })
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.item.reviewKind, 'live')
  assert.equal(Object.hasOwn(body, 'progress'), false)
})

// Live merge following (spec §11): open the survivor's own open live row; never capture one here.
function liveMergedFixture({ survivorRow = null } = {}) {
  const f = mergedFixture()
  const finds = []
  f.repository.getCurrentReviewSample = async () => null
  f.repository.getReview = async () => liveRow({ triage_bucket: 'blocked', triage_details: { merged: true } })
  f.repository.findOpenLiveReviewBySource = async (...args) => { finds.push(args); return survivorRow }
  f.repository.findDryRunReviewBySource = async () => { throw Error('sample lookup must not run for a live row') }
  f.repository.recordDryRunReview = async () => { throw Error('live merge following must not capture') }
  return { ...f, finds }
}
const prepareSurvivor = f => f.handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'selected', reviewId, expectedUpdatedAt: stamp, prepareMergedSurvivor: true }) })

test('reviewing the surviving record of a live row opens its open live row', async () => {
  const f = liveMergedFixture({ survivorRow: { id: '00000000-0000-4000-8000-0000000000aa', review_kind: 'live', status: 'needs_review' } })
  const response = await prepareSurvivor(f)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).survivor, { sourceId: '77', reviewId: '00000000-0000-4000-8000-0000000000aa' })
  assert.deepEqual(f.finds[0], ['authorized-company', '123', 'contacts', '77'])
  const detail = JSON.parse((await f.handler(get({ reviewId }))).body).item
  assert.deepEqual(detail.mergedInto, { sourceId: '77', reviewId: '00000000-0000-4000-8000-0000000000aa' })
})

test('a live survivor without an open row is a clear waiting state, not an error', async () => {
  const f = liveMergedFixture()
  const response = await prepareSurvivor(f)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).survivor, { sourceId: '77', reviewId: null,
    message: 'The surviving record will appear here when the next sync reaches it.' })
  const detail = JSON.parse((await f.handler(get({ reviewId }))).body).item
  assert.deepEqual(detail.mergedInto, { sourceId: '77', reviewId: null,
    message: 'The surviving record will appear here when the next sync reaches it.' })
  const stale = liveMergedFixture()
  stale.repository.getReview = async () => liveRow({ updated_at: '2026-10-12T11:00:00.000Z' })
  assert.equal((await prepareSurvivor(stale)).statusCode, 409)
})

// Conflicts is member-reachable for read-only inspection (the legacy conflicts GET allowed members):
// live list and detail need no admin and write nothing; the sample queue and every POST stay admin-only.
function memberFixture() {
  const f = fixture()
  const writes = []
  f.options.env = { H2A_REVIEW_RESOLUTION_MODE: 'admins' }
  f.options.requireRequest = async (_event, auth) => {
    f.calls.push(['auth', auth])
    if (auth.requireAdmin) throw new H2AAuthError(403, 'Administrator access is required.')
    return { companyId: 'authorized-company', userId: '00000000-0000-4000-8000-000000000003', role: 'member', isSuperAdmin: false }
  }
  const row = liveRow()
  f.repository.getReview = async () => row
  f.repository.listDryRunReviews = async (...args) => { f.calls.push(['list', ...args]); return { items: [row], hasMore: false, bucketCounts: { quick: 1, todo: 0, decision: 0, blocked: 0, done: 0 } } }
  // A completed resolution left open would be closed, and the stale 'quick' bucket refreshed, for an admin.
  f.repository.getCurrentReviewResolution = async () => ({ id: reviewId, company_id: 'authorized-company', portal_id: '123', review_id: reviewId,
    action: 'link_existing', status: 'completed' })
  f.repository.listReviewResolutionEvents = async () => []
  f.repository.setReviewTriage = async (...args) => { writes.push(['triage', ...args]) }
  f.repository.closeLiveReview = async (...args) => { writes.push(['close', ...args]); return { closedConflictIds: [], resumeIds: [], replayed: false } }
  f.repository.appendDryRunReviewEvent = async (...args) => { writes.push(['event', ...args]); return { id: 'event' } }
  return { ...f, writes, liveReview: row }
}

test('a member can read the live list and a live detail, with no writes and no provider reads', async () => {
  const f = memberFixture()
  const list = await f.handler(get({ kind: 'live' }))
  assert.equal(list.statusCode, 200)
  assert.equal(JSON.parse(list.body).items[0].reviewKind, 'live')
  const detail = await f.handler(get({ reviewId }))
  assert.equal(detail.statusCode, 200)
  const item = JSON.parse(detail.body).item
  assert.equal(item.reviewKind, 'live')
  assert.equal(item.resolutionCapability.canResolve, false)
  assert.deepEqual(f.writes, [])
  assert.equal(f.calls.some(call => call[0] === 'clients'), false)
  assert.ok(f.calls.filter(call => call[0] === 'auth').every(call => call[1].requireAdmin === false))
})

test('the same live detail refreshes triage and settles the close for an admin', async () => {
  const f = memberFixture()
  f.options.requireRequest = async () => ({ companyId: 'authorized-company', userId: '00000000-0000-4000-8000-000000000002', role: 'admin', isSuperAdmin: false })
  assert.equal((await f.handler(get({ reviewId }))).statusCode, 200)
  assert.ok(f.writes.some(write => write[0] === 'close'))
})

test('a member cannot read the sample queue or a sample detail, and every POST stays admin-only', async () => {
  const f = memberFixture()
  const list = await f.handler(get({}))
  assert.equal(list.statusCode, 403)
  assert.equal(JSON.parse(list.body).error, 'Administrator access is required.')
  f.repository.getReview = async () => ({ ...f.row, review_kind: 'sample' })
  const detail = await f.handler(get({ reviewId }))
  assert.equal(detail.statusCode, 403)
  assert.equal(f.calls.some(call => ['detail', 'events', 'sample'].includes(call[0])), false)
  f.repository.getReview = async () => f.liveReview
  const post = await f.handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'selected', reviewId, expectedUpdatedAt: stamp }) })
  assert.equal(post.statusCode, 403)
  assert.deepEqual(f.writes, [])
  assert.equal(f.calls.filter(call => call[0] === 'auth').at(-1)[1].requireAdmin, true)
})

test('the live list reads only the configured portal and is empty without one', async () => {
  const f = fixture()
  f.repository.listDryRunReviews = async (...args) => { f.calls.push(['list', ...args]); return { items: [liveRow()], hasMore: false } }
  assert.equal((await f.handler(get({ kind: 'live' }))).statusCode, 200)
  assert.equal(f.calls.find(call => call[0] === 'list')[3].portalId, '123')
  const none = fixture()
  none.repository.getConfig = async () => ({ initial_start_locked_at: '2026-10-01T00:00:00Z', portal_id: null })
  none.repository.listDryRunReviews = async () => { throw Error('no portal means no live rows to list') }
  const response = await none.handler(get({ kind: 'live' }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).items, [])
})
