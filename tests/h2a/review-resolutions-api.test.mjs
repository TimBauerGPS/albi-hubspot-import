import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { H2AReviewError } from '../../netlify/functions/_h2a/reviewService.js'

const path = '../../netlify/functions/h2a-dry-run-review-resolutions.js'
const api = existsSync(new URL(path, import.meta.url)) ? await import(path) : {}
const reviewId = '00000000-0000-4000-8000-000000000001'
const resolutionId = '00000000-0000-4000-8000-000000000002'
const clientRequestId = '00000000-0000-4000-8000-000000000003'
const actorId = '00000000-0000-4000-8000-000000000004'
const stamp = '2026-10-14T10:00:00.123456Z'
const input = { companyId: 'company-a', reviewId, expectedUpdatedAt: stamp, clientRequestId, action: 'create_albi' }
function fixture({ role = 'admin', superAdmin = false, mode = 'admins', appAccess = true } = {}) {
  const calls = []
  const row = { id: resolutionId, company_id: 'company-a', run_id: resolutionId, review_id: reviewId, portal_id: '123',
    source_id: '10', object_type: 'contacts', action: 'create_albi', decision: { action: 'create_albi', token: 'secret' },
    status: 'completed', expected_review_updated_at: stamp, created_by: actorId, created_at: stamp, updated_at: stamp,
    lease_owner: 'secret', provider_response: 'secret' }
  const events = Array.from({ length: 110 }, () => ({ id: resolutionId, actor_id: actorId, event_type: 'completed',
    created_at: stamp, sanitized_details: { code: 'completed', message: 'secret', executionContext: { secret: 'secret' } } }))
  const tables = { user_app_access: appAccess ? [{ user_id: actorId, app_name: 'albi-hubspot-import' }] : [],
    super_admins: superAdmin ? [{ user_id: actorId }] : [],
    company_members: [{ user_id: actorId, company_id: 'company-a', role }], companies: [{ id: 'company-a', name: 'A' }, { id: 'company-b', name: 'B' }] }
  const supabase = { auth: { getUser: async token => { calls.push('auth'); return { data: { user: token === 'valid' ? { id: actorId } : null } } } },
    from(table) {
      const filters = [], builder = { select() { return builder }, eq(k, v) { filters.push([k, v]); return builder },
        async maybeSingle() { calls.push(table); return { data: tables[table].find(row => filters.every(([k, v]) => row[k] === v)) ?? null } } }
      return builder
    } }
  const repository = {
    getCredentials: async () => ({ updated_at: '2026-10-01T00:00:00Z' }),
    getConfig: async company => { calls.push(['config', company]); return { portal_id: '123', initial_start_locked_at: stamp } },
    getLatestCompletedSampleDryRun: async company => { calls.push(['sample', company]); return { id: resolutionId, review_capture_version: 1 } },
    getCurrentReviewSample: async () => ({ id: resolutionId, review_capture_version: 1 }),
    getDryRunReview: async (...args) => { calls.push(['review', ...args]); return args[2] === reviewId ? { id: reviewId, object_type: 'contacts', portal_id: '123', source_id: '10', updated_at: stamp } : null },
    getCurrentReviewResolution: async (...args) => { calls.push(['resolution', ...args]); return row },
    listReviewResolutionEvents: async (...args) => { calls.push(['events', ...args]); return events },
    createReviewResolution: async (company, decision) => { calls.push(['create', company, decision]); return { resolution: row, created: false } },
    claimReviewResolution() { throw Error('completed replay cannot claim') }, finishReviewResolution() {}, appendReviewResolutionEvent() {},
    saveMapping() {}, upsertContactOrganizationChoice() {},
  }
  const options = { supabase, repository, env: { H2A_REVIEW_RESOLUTION_MODE: mode },
    makeClients: async () => { calls.push('clients'); throw Error('secret provider error') } }
  const request = async (body = input, { method = 'POST', token = 'valid', query } = {}) => {
    assert.equal(typeof api.createReviewResolutionHandler, 'function', 'resolution endpoint must exist')
    return api.createReviewResolutionHandler(options)({ httpMethod: method, headers: { Authorization: `Bearer ${token}` },
      queryStringParameters: query, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  }
  return { request, options, repository, row, events, calls }
}

test('rollout modes fail closed and enforce the exact admin matrix', () => {
  assert.equal(typeof api.canResolve, 'function', 'rollout gate must exist')
  assert.equal(api.canResolve({ mode: 'disabled', isAdmin: true, isSuperAdmin: true }), false)
  assert.equal(api.canResolve({ mode: 'super_admin', isAdmin: true, isSuperAdmin: false }), false)
  assert.equal(api.canResolve({ mode: 'super_admin', isSuperAdmin: true }), true)
  assert.equal(api.canResolve({ mode: 'admins', isAdmin: true }), true)
  for (const mode of [undefined, '', 'ADMIN', 'secret', true]) assert.equal(api.canResolve({ mode, isSuperAdmin: true, isAdmin: true }), false)
})
for (const [label, settings, body, request, status] of [
  ['session', {}, input, { token: 'invalid' }, 401],
  ['member', { role: 'member' }, input, {}, 403],
  ['cross company', {}, { ...input, companyId: 'company-b' }, {}, 403],
  ['disabled', { mode: 'disabled' }, input, {}, 409],
  ['unknown mode', { mode: 'secret' }, input, {}, 409],
  ['missing mode', { mode: null }, input, {}, 409],
  ['super admin only', { mode: 'super_admin' }, input, {}, 403],
]) test(`${label} stops POST before resolution storage or credentials`, async () => {
  const f = fixture(settings), result = await f.request(body, request)
  assert.equal(result.statusCode, status)
  assert.equal(f.calls.some(call => Array.isArray(call)), false)
  assert.equal(f.calls.includes('clients'), false)
  assert.equal(result.body.includes('secret'), false)
})
test('super admin selected company is resolved by existing authorization', async () => {
  const f = fixture({ superAdmin: true, mode: 'super_admin' })
  f.row.company_id = 'company-b'
  const result = await f.request({ ...input, companyId: 'company-b' })
  assert.equal(result.statusCode, 200)
  assert.equal(f.calls.find(call => call[0] === 'create')[1], 'company-b')
})
for (const settings of [{ appAccess: false }, { appAccess: false, superAdmin: true, mode: 'super_admin' }]) {
  test('revoked app access blocks resolution before credentials for every admin tier', async () => {
    const f = fixture(settings)
    const result = await f.request()
    assert.equal(result.statusCode, 403)
    assert.equal(f.calls.some(call => Array.isArray(call)), false)
    assert.equal(f.calls.includes('clients'), false)
  })
}
for (const change of [{ reviewId: 'bad' }, { clientRequestId: 'bad' }, { expectedUpdatedAt: '2026-02-30T10:00:00Z' },
  { expectedUpdatedAt: '2026-10-14T24:00:00Z' },
  { expectedUpdatedAt: 'tomorrow' }, { action: 'delete' }, { action: 'resolve_fields', fieldChoices: { email: 'secret' } },
  { action: 'link_existing', candidateId: 'url' }, { action: 'choose_organization', organizationSourceId: 12 },
  { action: 'link_existing', candidateId: '12', approveManyToOne: 'yes' },
  { action: 'force_create_albi', ignoredCandidateIds: [] },
  { action: 'force_create_albi', ignoredCandidateIds: ['22', '22'] },
  { action: 'choose_organization', organizationSourceId: '12', addHubSpotAssociation: 'yes' },
  { action: 'create_albi', candidateId: '12' }, { sourceId: '12' }, { runId: resolutionId }, { portalId: '123' },
  { albiCompanyId: '123' }, { credentials: 'secret' }, { values: { email: 'private@example.com' } }, { url: 'https://example.com' },
  { decision: { action: 'create_albi' } }, { companyId: {} }]) test(`strict POST rejects ${JSON.stringify(change)}`, async () => {
  const f = fixture(), response = await f.request({ ...input, ...change })
  assert.equal(response.statusCode, 400)
  assert.equal(f.calls.length, 0)
  assert.equal(response.body.includes('secret'), false)
})
test('missing app access also blocks read-only resolution history before storage', async () => {
  const f = fixture({ appAccess: false, role: 'member' })
  const result = await f.request(undefined, { method: 'GET', query: { companyId: 'company-a', reviewId } })
  assert.equal(result.statusCode, 403)
  assert.equal(f.calls.some(call => Array.isArray(call)), false)
})

test('all accepted action inputs are normalized before passing server actor and company to execution', async () => {
  for (const decision of [{ action: 'resolve_fields', fieldChoices: { phoneNumber: 'hubspot', email: 'albi' } },
    { action: 'link_existing', candidateId: '22', approveManyToOne: true },
    { action: 'force_create_albi', ignoredCandidateIds: ['23', '22'] },
    { action: 'choose_organization', organizationSourceId: '33', addHubSpotAssociation: false }]) {
    const f = fixture()
    let received
    f.options.executeResolution = async (_deps, args) => { received = args; return { resolution: f.row } }
    assert.equal((await f.request({ ...input, ...decision })).statusCode, 200)
    assert.deepEqual(received.decision, decision.action === 'force_create_albi'
      ? { ...decision, ignoredCandidateIds: ['22', '23'] } : decision)
    assert.equal(received.companyId, 'company-a')
    assert.equal(received.actorId, actorId)
    assert.equal(Object.hasOwn(received, 'action'), false)
  }
})

test('provider composition verifies trusted portal before obtaining any write capability', async () => {
  const f = fixture()
  let reads = 0, writes = 0
  const clients = { hubspot: { getAccountInfo: async () => { reads++; return { portalId: '999' } } }, albi: {} }
  for (const name of ['updateContact', 'updateCompany', 'addContactCompanyAssociation']) {
    Object.defineProperty(clients.hubspot, name, { get() { writes++; throw Error('secret write getter') } })
  }
  f.options.makeClients = async () => clients
  f.options.executeResolution = async (deps, args) => {
    assert.equal(args.companyId, 'company-a')
    await deps.getResolutionClients('browser-company', { portal_id: '123' })
  }
  const result = await f.request()
  assert.equal(result.statusCode, 500)
  assert.equal(reads, 1)
  assert.equal(writes, 0)
  assert.equal(result.body.includes('secret'), false)
})
test('selector ambiguity and GET unknown fields cannot reach repository', async () => {
  const f = fixture()
  for (const args of [{ query: { companyId: 'company-b' } }, { method: 'GET', query: { reviewId, runId: resolutionId } },
    { method: 'GET', query: { companyId: 'company-a' } }, { method: 'GET', query: { reviewId: {} } }]) {
    assert.equal((await f.request(input, args)).statusCode, 400)
  }
  assert.equal(f.calls.length, 0)
})
test('completed idempotent replay uses the execution service without provider credentials', async () => {
  const f = fixture()
  f.row.decision = { action: 'create_albi' }
  const first = await f.request(), again = await f.request()
  assert.equal(first.statusCode, 200)
  assert.deepEqual(JSON.parse(first.body), JSON.parse(again.body))
  const persisted = f.calls.find(call => call[0] === 'create')[2]
  assert.equal(persisted.clientRequestId, clientRequestId)
  assert.equal(persisted.actorId, actorId)
  assert.deepEqual(persisted.decision, { action: 'create_albi' })
  assert.equal(f.calls.includes('clients'), false)
  assert.equal(first.body.includes('secret'), false)
})
test('member GET projects current tenant intent and caps events without providers', async () => {
  const f = fixture({ role: 'member' })
  const result = await f.request(undefined, { method: 'GET', query: { companyId: 'company-a', reviewId } })
  assert.equal(result.statusCode, 200)
  const body = JSON.parse(result.body)
  assert.equal(body.resolution.id, resolutionId)
  assert.equal(body.resolution.events.length, 100)
  assert.equal(body.resolutionCapability.canResolve, false)
  assert.equal(result.body.includes('secret'), false)
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.deepEqual(f.calls.find(call => call[0] === 'resolution'), ['resolution', 'company-a', reviewId])
  assert.equal(f.calls.includes('clients'), false)
})
test('stale, validation and unexpected execution failures use fixed responses', async () => {
  for (const [error, status, message] of [[new H2AReviewError(409, 'secret stale details'), 409, 'This sample review changed. Refresh and confirm the resolution again.'],
    [new TypeError('secret validation'), 400, 'Invalid resolution decision.'], [new Error('secret provider response'), 500, 'Unable to resolve this sample review.']]) {
    const f = fixture()
    f.options.executeResolution = async () => { throw error }
    const response = await f.request()
    assert.equal(response.statusCode, status)
    assert.equal(JSON.parse(response.body).error, message)
    assert.equal(response.body.includes('secret'), false)
  }
})
test('durable authorization failure has fixed actionable copy', async () => {
  const f = fixture()
  f.row.status = 'failed'; f.row.provider_outcome_code = 'authorization_rejected'
  f.options.executeResolution = async () => ({ resolution: f.row })
  const response = await f.request()
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).message, 'Authentication or write scope rejected')
  assert.equal(response.body.includes('secret'), false)
})

test('new credentials invalidate earlier detail write evidence without decrypting it', async () => {
  const f = fixture()
  f.row.action = 'resolve_fields'; f.row.provider_outcome_code = 'provider_applied'
  f.events.splice(0, f.events.length, { event_type: 'provider_applied', created_at: stamp })
  f.repository.getCredentials = async companyId => {
    assert.equal(companyId, 'company-a')
    return { updated_at: '2026-10-14T11:00:00Z', hubspot_envelope: { ciphertext: 'secret' } }
  }
  const result = await f.request(undefined, { method: 'GET', query: { reviewId } })
  assert.equal(JSON.parse(result.body).resolutionCapability.hubspotWrites, 'verified_when_first_used')
  assert.equal(result.body.includes('secret'), false)
})

test('completed POST replay cannot claim write readiness under a replacement credential', async () => {
  const f = fixture()
  f.row.action = 'resolve_fields'; f.row.provider_outcome_code = 'provider_applied'
  f.repository.getCredentials = async () => ({ updated_at: '2026-10-14T11:00:00Z' })
  const result = await f.request()
  assert.equal(result.statusCode, 200)
  assert.equal(JSON.parse(result.body).resolutionCapability.hubspotWrites, 'verified_when_first_used')
})

test('missing current credential metadata cannot claim write readiness on GET or POST', async () => {
  const f = fixture()
  f.row.action = 'resolve_fields'; f.row.provider_outcome_code = 'provider_applied'
  f.repository.getCredentials = async () => null
  for (const args of [{}, { method: 'GET', query: { reviewId } }]) {
    const result = await f.request(input, args)
    assert.equal(result.statusCode, 200)
    assert.equal(JSON.parse(result.body).resolutionCapability.hubspotWrites, 'verified_when_first_used')
  }
})

for (const [code, eventType, expected] of [['provider_applied', 'provider_applied', 'available'],
  ['authorization_rejected', 'failed', 'rejected']]) {
  test(`a later claim/recheck timestamp cannot refresh old ${code} credential evidence`, async () => {
    const f = fixture()
    Object.assign(f.row, { action: 'resolve_fields', updated_at: '2026-10-14T12:00:00Z', provider_outcome_code: code })
    f.events.splice(0, f.events.length,
      { event_type: eventType, created_at: '2026-10-14T10:00:00Z', sanitized_details: { code, message: 'secret' } },
      { event_type: 'claimed', created_at: '2026-10-14T12:00:00Z', sanitized_details: { executionContext: { providerOperation: 'secret' } } },
      { event_type: 'recheck_requested', created_at: '2026-10-14T12:01:00Z', sanitized_details: { code: 'recheck_requested' } })
    f.repository.getCredentials = async () => ({ updated_at: '2026-10-14T11:00:00Z' })
    f.options.executeResolution = async () => ({ resolution: f.row })
    for (const args of [{}, { method: 'GET', query: { companyId: 'company-a', reviewId } }]) {
      const result = await f.request(input, args)
      assert.equal(result.statusCode, 200)
      assert.equal(JSON.parse(result.body).resolutionCapability.hubspotWrites, 'verified_when_first_used')
      assert.equal(result.body.includes('secret'), false)
    }
  })
  test(`fresh durable ${code} event supplies readiness independently of lifecycle row timestamp`, async () => {
    const f = fixture()
    Object.assign(f.row, { action: 'resolve_fields', updated_at: '2026-10-14T10:00:00Z', provider_outcome_code: code })
    f.events.splice(0, f.events.length, { event_type: eventType, created_at: '2026-10-14T12:00:00Z', sanitized_details: { code } })
    f.repository.getCredentials = async () => ({ updated_at: '2026-10-14T11:00:00Z' })
    const result = await f.request(input, { method: 'GET', query: { reviewId } })
    assert.equal(result.statusCode, 200)
    assert.equal(JSON.parse(result.body).resolutionCapability.hubspotWrites, expected)
  })
}

test('outcome code without a matching durable event never establishes readiness', async () => {
  const f = fixture()
  f.row.action = 'resolve_fields'
  f.events.length = 0
  for (const code of ['provider_applied', 'authorization_rejected']) {
    f.row.provider_outcome_code = code
    const result = await f.request(input, { method: 'GET', query: { reviewId } })
    assert.equal(JSON.parse(result.body).resolutionCapability.hubspotWrites, 'verified_when_first_used')
  }
})

test('GET derives the live kind from the row and skips the sample gate', async () => {
  const f = fixture()
  f.repository.getCurrentReviewSample = async () => null
  f.repository.getReview = async (...args) => { f.calls.push(['live', ...args]); return { id: reviewId, review_kind: 'live', run_id: 'live-run',
    object_type: 'contacts', portal_id: '123', source_id: '10', status: 'needs_review', updated_at: stamp } }
  const result = await f.request(undefined, { method: 'GET', query: { companyId: 'company-a', reviewId } })
  assert.equal(result.statusCode, 200)
  assert.equal(JSON.parse(result.body).resolution.id, resolutionId)
  assert.equal(f.calls.some(call => call[0] === 'review'), false)
})

test('skip_live is accepted as a decision and rejected with 400 on a sample row', async () => {
  const f = fixture()
  let received
  f.options.executeResolution = async (_deps, args) => { received = args; return { resolution: f.row } }
  assert.equal((await f.request({ companyId: 'company-a', reviewId, expectedUpdatedAt: stamp, clientRequestId, action: 'skip_live' })).statusCode, 200)
  assert.deepEqual(received.decision, { action: 'skip_live' })
  assert.equal((await f.request({ companyId: 'company-a', reviewId, expectedUpdatedAt: stamp, clientRequestId, action: 'skip_live', candidateId: '1' })).statusCode, 400)
  const sample = fixture()
  const refused = await sample.request({ companyId: 'company-a', reviewId, expectedUpdatedAt: stamp, clientRequestId, action: 'skip_live' })
  assert.equal(refused.statusCode, 400)
  assert.equal(sample.calls.some(call => call[0] === 'create'), false)
})

test('the write endpoint wires resume dispatch and live close capabilities into execution', async () => {
  const f = fixture()
  let deps
  f.options.dispatchResume = async () => true
  f.options.executeResolution = async received => { deps = received; return { resolution: f.row } }
  assert.equal((await f.request({ ...input, action: 'skip_live' })).statusCode, 200)
  assert.equal(deps.dispatchResume, f.options.dispatchResume)
})

const orgReviewId = '00000000-0000-4000-8000-0000000000a1'
const orgFirst = { companyId: 'company-a', op: 'create_with_organization', reviewId, expectedUpdatedAt: stamp, clientRequestId,
  organizationReviewId: orgReviewId, organizationExpectedUpdatedAt: stamp, referralSourceId: '5' }

test('create_with_organization runs the org-first service with one referral source and returns both steps', async () => {
  const f = fixture(); let received
  f.options.executeOrganizationFirst = async (deps, args) => { received = args; return { organization: { resolution: f.row }, contact: { resolution: f.row } } }
  const result = await f.request(orgFirst)
  assert.equal(result.statusCode, 200)
  assert.deepEqual(received, { companyId: 'company-a', actorId, contactReviewId: reviewId, contactExpectedUpdatedAt: stamp,
    organizationReviewId: orgReviewId, organizationExpectedUpdatedAt: stamp, referralSourceId: '5', clientRequestId })
  const body = JSON.parse(result.body)
  assert.equal(body.organization.resolution.id, resolutionId)
  assert.equal(body.contact.resolution.id, resolutionId)
})

test('create_with_organization reports an organization failure without a contact and rejects bad input', async () => {
  const f = fixture()
  f.options.executeOrganizationFirst = async () => ({ organization: { error: new H2AReviewError(409, 'x') }, contact: null })
  const failed = await f.request(orgFirst)
  assert.equal(failed.statusCode, 409)
  for (const bad of [{ ...orgFirst, referralSourceId: undefined }, { ...orgFirst, referralSourceId: 'abc' },
    { ...orgFirst, organizationReviewId: 'nope' }, { ...orgFirst, organizationExpectedUpdatedAt: 'nope' }]) {
    assert.equal((await fixture().request(bad)).statusCode, 400)
  }
  const member = fixture({ role: 'member' })
  assert.equal((await member.request(orgFirst)).statusCode, 403)
})

test('create_with_organization surfaces a contact error beside the organization result', async () => {
  const f = fixture()
  f.options.executeOrganizationFirst = async () => ({ organization: { resolution: f.row }, contact: { error: new H2AReviewError(409, 'secret') } })
  const result = await f.request(orgFirst)
  assert.equal(result.statusCode, 200)
  const body = JSON.parse(result.body)
  assert.equal(body.organization.resolution.id, resolutionId)
  assert.equal(body.contact.error.includes('Retry'), true)
  assert.equal(body.contact.status, 409)
  assert.equal(result.body.includes('secret'), false)
})

const bulkItem = (extra = {}) => ({ reviewId, candidateId: '77', expectedUpdatedAt: stamp, clientRequestId, ...extra })
const bulk = (items = [bulkItem()]) => ({ companyId: 'company-a', op: 'bulk_link', items })

test('bulk_link runs the bulk service for admins and returns only per-item outcomes', async () => {
  const f = fixture(); let received
  f.options.executeBulkLink = async (_deps, args) => { received = args; return { results: [{ reviewId, status: 'skipped', reason: 'changed', secret: 'x' }] } }
  const result = await f.request(bulk())
  assert.equal(result.statusCode, 200)
  assert.deepEqual(received, { companyId: 'company-a', actorId, items: [bulkItem()] })
  assert.deepEqual(JSON.parse(result.body), { results: [{ reviewId, status: 'skipped', reason: 'changed' }] })
})

test('bulk_link validates items, allowlists fields, and is admin-only', async () => {
  const f = () => { const x = fixture(); x.options.executeBulkLink = async () => { throw Error('must not run') }; return x }
  const bad = [bulk([]), bulk(Array.from({ length: 26 }, () => bulkItem())), bulk([bulkItem({ reviewId: 'nope' })]),
    bulk([bulkItem({ clientRequestId: 'nope' })]), bulk([bulkItem({ expectedUpdatedAt: 'nope' })]), bulk([bulkItem({ candidateId: 'a b' })]),
    bulk([bulkItem({ approveManyToOne: true })]), { ...bulk(), extra: 1 }, { ...bulk(), items: 'x' }]
  for (const body of bad) assert.equal((await f().request(body)).statusCode, 400, JSON.stringify(body).slice(0, 80))
  assert.equal((await fixture({ role: 'member' }).request(bulk())).statusCode, 403)
})

test('a live row\'s 409 keeps kind-neutral copy instead of the sample review fallback', async () => {
  const live = 'This record changed. Refresh and confirm the resolution again.'
  const passed = fixture()
  passed.options.executeResolution = async () => { throw new H2AReviewError(409, live) }
  assert.equal(JSON.parse((await passed.request()).body).error, live)
  const other = fixture()
  other.options.executeResolution = async () => { throw Object.assign(new H2AReviewError(409, 'secret live details'), { reviewKind: 'live' }) }
  const response = await other.request()
  assert.equal(response.statusCode, 409)
  assert.equal(JSON.parse(response.body).error, live)
  assert.equal(response.body.includes('secret'), false)
})
