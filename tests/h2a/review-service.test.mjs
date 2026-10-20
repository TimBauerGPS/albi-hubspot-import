import test from 'node:test'
import assert from 'node:assert/strict'
import { recheckDryRunReview } from '../../netlify/functions/_h2a/reviewService.js'
import * as reviewService from '../../netlify/functions/_h2a/reviewService.js'
import { readOnlyH2ACapabilities } from '../../netlify/functions/_h2a/providerClients.js'
import { liveCloseStore } from './live-close-fixture.mjs'

const reviewId = '00000000-0000-4000-8000-000000000001'
const actorId = '00000000-0000-4000-8000-000000000002'
const stamp = '2026-10-12T10:00:00.123456Z'
const input = { companyId: 'tenant-1', reviewId, actorId, expectedUpdatedAt: stamp }
function fixture({ objectType = 'contacts', source, contacts = [], organizations = [], options = [] } = {}) {
  const calls = [], events = [], applied = []
  const row = { id: reviewId, run_id: 'current-run', portal_id: '123', object_type: objectType, source_id: '10',
    reason: 'name_only_candidate', conflict_type: objectType === 'contacts' ? 'contact_match' : 'organization_match',
    status: 'needs_review', updated_at: stamp, source_snapshot: { id: '10', apiKey: 'secret' } }
  const sourceRecord = source === undefined ? { id: '10', properties: { firstname: 'A', lastname: 'Person', email: 'a@example.com' } } : source
  const repository = {
    getConfig: async company => { calls.push(['config', company]); return { initial_start_locked_at: '2026-10-01T00:00:00Z', portal_id: '123' } },
    getCurrentReviewSample: async (company, after) => { calls.push(['sample', company, after]); return { id: 'current-run', review_capture_version: 1 } },
    getLatestCompletedSampleDryRun: async () => ({ id: 'current-run', review_capture_version: 1 }),
    getDryRunReview: async (...args) => { calls.push(['row', ...args]); return row },
    appendDryRunReviewEvent: async (...args) => { calls.push(['event', args[3].eventType]); events.push(args); return { id: 'event' } },
    getMappings: async company => { calls.push(['mappings', company]); return { contacts: [], organizations: [], options } },
    applyDryRunRecheck: async (company, payload) => { applied.push([company, payload]); return { review: { ...row, status: payload.status, recheck_outcome: payload.outcome } } },
  }
  const hubspotRead = {
    getContacts: async ids => { calls.push(['contacts', ids]); return sourceRecord === null ? [] : [sourceRecord] },
    getCompanies: async ids => { calls.push(['companies', ids]); return sourceRecord === null ? [] : [sourceRecord] },
    getAssociations: async args => { calls.push(['associations', args]); return [{ fromId: '10', toObjectType: 'companies', toIds: [] }] },
  }
  const albiRead = {
    listContacts: async args => { calls.push(['albiContacts', args]); return { records: contacts, cursor: null } },
    listOrganizations: async args => { calls.push(['albiOrganizations', args]); return { records: organizations, cursor: null } },
  }
  for (const object of [repository, hubspotRead, albiRead]) for (const name of ['createContact', 'createOrganization', 'updateContact', 'updateOrganization', 'associateContact', 'saveMapping', 'saveCursor', 'dispatch', 'reserveDelivery', 'recordConflict', 'finishRun']) {
    Object.defineProperty(object, name, { get() { throw Error(`Mutation capability accessed: ${name}`) } })
  }
  return { deps: { repository, hubspotRead, albiRead, now: () => new Date('2026-10-12T12:00:00Z'), sleep: async () => {} }, row, calls, events, applied }
}

test('recheck repository adapter exposes only frozen diagnostic capabilities without accessing mutation or credential getters', async () => {
  const f = fixture({ source: null })
  const repository = f.deps.repository
  for (const name of ['getCredentials', 'deliveryStore', 'recordItem', 'saveRunCheckpoint', 'queueRun', 'finishRunTotals']) {
    Object.defineProperty(repository, name, { enumerable: true, get() { throw Error(`Forbidden capability getter: ${name}`) } })
  }
  const adapter = reviewService.createReviewRepositoryCapabilities(repository)
  assert.deepEqual(Object.keys(adapter).sort(), [
    'getConfig', 'getLatestCompletedSampleDryRun', 'getCurrentReviewSample', 'getDryRunReview',
    'getMappings', 'appendDryRunReviewEvent', 'applyDryRunRecheck',
  ].sort())
  assert.equal(Object.isFrozen(adapter), true)
  for (const name of ['saveCursor', 'saveMapping', 'recordConflict', 'deliveryStore', 'recordItem', 'finishRun',
    'getCredentials', 'saveRunCheckpoint', 'queueRun', 'finishRunTotals', 'countDryRunReviews', 'hasCleanReviewSampleDryRun']) {
    assert.equal(name in adapter, false)
  }
  assert.throws(() => { adapter.saveMapping = () => {} }, TypeError)
  await recheckDryRunReview({ ...f.deps, repository: adapter }, input)
  assert.equal(f.applied[0][1].outcome, 'source_missing')
})

test('recheck repository adapter preserves required repository receiver binding', async () => {
  const f = fixture()
  const repository = f.deps.repository
  repository.getConfig = async function (companyId) {
    assert.equal(this, repository)
    assert.equal(companyId, 'tenant-1')
    return { portal_id: '123', initial_start_locked_at: '2026-10-01T00:00:00Z' }
  }
  const adapter = reviewService.createReviewRepositoryCapabilities(repository)
  await adapter.getConfig('tenant-1')
})

test('safe exact contact link clears only diagnostic state and preserves original nonblank classification', async () => {
  const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', apiKey: 'secret' }] })
  const result = await recheckDryRunReview(f.deps, input)
  assert.equal(result.review.status, 'cleared')
  const [company, payload] = f.applied[0]
  assert.equal(company, 'tenant-1')
  assert.equal(payload.runId, 'current-run')
  assert.equal(payload.expectedUpdatedAt, stamp)
  assert.equal(payload.outcome, 'safe_to_link')
  assert.equal(payload.reason, 'name_only_candidate')
  assert.equal(payload.conflictType, 'contact_match')
  assert.deepEqual(payload.matchEvidence, { evidence: ['email'] })
  assert.equal(JSON.stringify(payload).includes('secret'), false)
  assert.ok(f.calls.findIndex(call => call[0] === 'event') < f.calls.findIndex(call => call[0] === 'contacts'))
  assert.deepEqual(f.calls.find(call => call[0] === 'contacts'), ['contacts', ['10']])
})

test('contact recheck prefers the direct current record over the bulk snapshot path', async () => {
  const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'fresh@example.com' }] })
  f.row.source_snapshot = { id: '10', firstName: 'A', lastName: 'Person', email: 'old@example.com' }
  f.deps.hubspotRead.getContacts = async ids => {
    f.calls.push(['contacts', ids])
    return [{ id: '10', properties: { firstname: 'A', lastname: 'Person', email: 'old@example.com' } }]
  }
  f.deps.hubspotRead.getContact = async id => {
    f.calls.push(['contact', id])
    return { id: '10', properties: { firstname: 'A', lastname: 'Person', email: 'fresh@example.com' } }
  }
  await recheckDryRunReview(f.deps, input)
  assert.deepEqual(f.applied[0][1].sourceSnapshot, {
    id: '10', firstName: 'A', lastName: 'Person', email: 'fresh@example.com',
  })
  assert.deepEqual(f.calls.find(call => call[0] === 'contact'), ['contact', '10'])
  assert.equal(f.calls.some(call => call[0] === 'contacts'), false)
})

test('legacy read capability keeps malformed batch responses fail-closed', async () => {
  const f = fixture()
  const capabilities = readOnlyH2ACapabilities({
    hubspot: {
      getContacts: async () => ({}), getCompanies: async () => [], getAssociations: async () => [],
    },
    albi: {
      listContacts: async () => ({ records: [], cursor: null }),
      listOrganizations: async () => ({ records: [], cursor: null }),
    },
  })
  await assert.rejects(recheckDryRunReview({ ...f.deps, ...capabilities }, input), error => error.statusCode === 502)
  assert.equal(f.applied.length, 0)
})

test('confirmed contact default clears a safe create without creating a provider record', async () => {
  const f = fixture({ options: [{ mapping_kind: 'default_contact_type', albi_id: '7', confirmed: true }] })
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'safe_to_create')
})

test('unresolved identity refreshes allowlisted snapshots and remains open', async () => {
  const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', authorization: 'secret' }] })
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'still_needs_review')
  assert.equal(f.applied[0][1].status, 'needs_review')
  assert.equal(f.applied[0][1].reason, 'name_only_candidate')
  assert.equal(JSON.stringify(f.applied).includes('secret'), false)
})

for (const objectType of ['contacts', 'companies']) test(`only successful exact empty ${objectType} batch confirms absence`, async () => {
  const f = fixture({ objectType, source: null })
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].status, 'no_longer_in_scope')
  assert.equal(f.applied[0][1].outcome, 'source_missing')
  assert.deepEqual(f.applied[0][1].sourceSnapshot, { id: '10' })
  assert.equal(f.calls.some(call => call[0].startsWith('albi') || call[0] === 'associations'), false)
})

for (const [category, code] of [['auth', 'operation_failed'], ['permission', 'operation_failed'], ['validation', 'operation_failed'],
  ['transient', 'operation_failed'], ['rate_limit', 'operation_failed'], ['permanent', 'malformed_response'], ['transient', 'timeout'], ['transient', 'network']]) {
  test(`provider ${category}/${code} preserves row and records fixed failed audit details`, async () => {
    const f = fixture()
    const before = structuredClone(f.row)
    let reads = 0
    f.deps.hubspotRead.getContacts = async () => { reads++; throw Object.assign(new Error('token secret provider body'), { category, code }) }
    await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === 502 && error.message === 'Unable to recheck this sample review.')
    assert.deepEqual(f.row, before)
    assert.equal(f.applied.length, 0)
    assert.deepEqual(f.events.map(event => event[3].eventType), ['recheck_started', 'recheck_failed'])
    assert.deepEqual(f.events[1][3].details, { category, code })
    assert.equal(JSON.stringify(f.events).includes('secret'), false)
    assert.equal(reads, ['transient', 'rate_limit'].includes(category) ? 3 : 1)
  })
}

test('stale version rejects before events, credential construction or provider access', async () => {
  const f = fixture()
  f.deps.getReadClients = async () => { throw Error('credential access') }
  await assert.rejects(recheckDryRunReview(f.deps, { ...input, expectedUpdatedAt: '2026-10-12T09:00:00Z' }), error => error.statusCode === 409)
  assert.equal(f.events.length, 0)
  assert.equal(f.calls.some(call => ['contacts', 'companies', 'associations'].includes(call[0])), false)
})

for (const invalid of [undefined, {}, [{ id: '11', properties: {} }], [{ id: '10' }], [{ id: '10', properties: {} }, { id: '10', properties: {} }]]) {
  test(`malformed or nonexact batch ${JSON.stringify(invalid)} never becomes source absence`, async () => {
    const f = fixture()
    f.deps.hubspotRead.getContacts = async () => invalid
    await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === 502)
    assert.equal(f.applied.length, 0)
    assert.deepEqual(f.events[1][3].details, { category: 'permanent', code: 'malformed_response' })
  })
}

test('malformed association responses fail closed before evaluating a false unassociated contact', async () => {
  const f = fixture()
  f.deps.hubspotRead.getAssociations = async () => []
  await assert.rejects(recheckDryRunReview(f.deps, input))
  assert.equal(f.applied.length, 0)
})

test('repeated Albi cursor fails with sanitized pagination audit', async () => {
  const f = fixture()
  let pages = 0
  f.deps.albiRead.listContacts = async () => { pages++; return { records: [], cursor: '1' } }
  await assert.rejects(recheckDryRunReview(f.deps, input))
  assert.equal(pages, 1)
  assert.deepEqual(f.events[1][3].details, { category: 'permanent', code: 'pagination_loop' })
})

test('Albi pagination stops after at most 1000 pages', async () => {
  const f = fixture()
  let pages = 0
  f.deps.albiRead.listContacts = async ({ cursor }) => { pages++; return { records: [], cursor: String(Number(cursor) + 1) } }
  await assert.rejects(recheckDryRunReview(f.deps, input))
  assert.equal(pages, 1000)
  assert.equal(f.applied.length, 0)
})

test('deadline prevents any read starting after sixty seconds', async () => {
  const f = fixture()
  let clock = 0
  f.deps.clockMs = () => clock
  f.deps.hubspotRead.getContacts = async () => { clock = 60001; return [{ id: '10', properties: {} }] }
  await assert.rejects(recheckDryRunReview(f.deps, input))
  assert.equal(f.calls.some(call => call[0] === 'associations'), false)
  assert.deepEqual(f.events[1][3].details, { category: 'transient', code: 'timeout' })
})

for (const [code, status] of [['stale', 409], ['superseded', 409], ['not_found', 404]]) test(`atomic ${code} result maps to typed ${status} without failed provider event`, async () => {
  const f = fixture({ source: null })
  f.deps.repository.applyDryRunRecheck = async () => ({ error: code, message: 'secret' })
  await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === status && !error.message.includes('secret'))
  assert.deepEqual(f.events.map(event => event[3].eventType), ['recheck_started'])
})

test('company links evaluate with current organization data only', async () => {
  const f = fixture({ objectType: 'companies', source: { id: '10', properties: { name: 'Allied', domain: 'allied.example' } },
    organizations: [{ id: '20', name: 'Allied', domain: 'allied.example' }] })
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'safe_to_link')
  assert.equal(f.calls.some(call => call[0] === 'albiContacts'), false)
})

test('latest historical replacement during provider reads blocks apply and terminal audit', async () => {
  const f = fixture({ source: null })
  let replacementCompleted = false
  f.deps.repository.getLatestCompletedSampleDryRun = async () => !replacementCompleted
    ? { id: 'current-run', review_capture_version: 1 } : { id: 'new-historical-run', review_capture_version: null }
  f.deps.hubspotRead.getContacts = async () => { replacementCompleted = true; return [] }
  await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === 409 && error.message === 'This sample review is no longer current. Refresh before rechecking.')
  assert.equal(f.applied.length, 0)
  assert.deepEqual(f.events.map(event => event[3].eventType), ['recheck_started'])
})

test('sample superseded between row read and credential access starts no event or provider call', async () => {
  const f = fixture()
  let latestReads = 0
  f.deps.repository.getLatestCompletedSampleDryRun = async () => ++latestReads === 1
    ? { id: 'current-run', review_capture_version: 1 } : { id: 'new-run', review_capture_version: 1 }
  await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === 409)
  assert.equal(f.events.length, 0)
  assert.equal(f.calls.some(call => call[0] === 'contacts'), false)
})

test('current portal mapping wins over another portal with the same HubSpot source ID', async () => {
  const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com' }] })
  f.deps.repository.getMappings = async () => ({ contacts: [
    { portal_id: 'other', hubspot_id: '10', albi_contact_id: '99' },
    { portal_id: '123', hubspot_id: '10', albi_contact_id: '20' },
  ], organizations: [], options: [] })
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'safe_to_link')
  assert.deepEqual(f.applied[0][1].matchEvidence, { evidence: ['existing_mapping'] })
})

test('contact organization context evaluates current exact company and its full target identity', async () => {
  const targetId = '7'.repeat(501)
  const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', organizationId: targetId }],
    organizations: [{ id: targetId, name: 'Allied', domain: 'allied.example', organizationTypeIds: ['7'] }] })
  f.deps.hubspotRead.getAssociations = async () => [{ fromId: '10', toObjectType: 'companies', toIds: ['11'] }]
  f.deps.hubspotRead.getCompanies = async ids => { assert.deepEqual(ids, ['11']); return [{ id: '11', properties: { name: 'Allied', domain: 'allied.example' } }] }
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'safe_to_link')
})

test('ambiguous HubSpot organizations remain an association review', async () => {
  const f = fixture()
  f.deps.hubspotRead.getAssociations = async () => [{ fromId: '10', toObjectType: 'companies', toIds: ['11', '12'] }]
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].reason, 'multiple_associated_organizations')
  assert.equal(f.applied[0][1].conflictType, 'association')
})

function reviewedOrganizationFixture() {
  const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', organizationId: '30' }],
    organizations: [{ id: '30', name: 'Allied', domain: 'allied.example' }] })
  f.row.reason = 'multiple_associated_organizations'; f.row.conflict_type = 'association'
  f.choice = { company_id: 'tenant-1', portal_id: '123', hubspot_contact_id: '10', hubspot_company_id: '11' }
  f.associatedIds = ['11', '12']
  f.deps.repository.getContactOrganizationChoice = async (...args) => {
    assert.deepEqual(args, ['tenant-1', '123', '10'])
    return f.choice
  }
  f.deps.hubspotRead.getAssociations = async () => [{ fromId: '10', toObjectType: 'companies', toIds: f.associatedIds }]
  f.deps.hubspotRead.getCompanies = async ids => ids.map(id => ({ id, properties: { name: 'Allied', domain: 'allied.example' } }))
  for (const object of [f.deps.hubspotRead, f.deps.albiRead]) for (const name of ['removeAssociation', 'removeContactCompanyAssociation', 'updateAlbiContact']) {
    Object.defineProperty(object, name, { get() { throw Error(`Forbidden capability: ${name}`) } })
  }
  return f
}

test('reviewed recheck keeps both direct associations and clears using the selected current company', async () => {
  const f = reviewedOrganizationFixture()
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'safe_to_link')
  assert.deepEqual(f.associatedIds, ['11', '12'])
})

for (const invalid of ['missing', 'deleted', 'cross-tenant', 'wrong portal', 'wrong contact', 'no longer associated']) {
  test(`reviewed recheck ignores ${invalid} choice and retains ordinary ambiguity`, async () => {
    const f = reviewedOrganizationFixture()
    if (invalid === 'missing') f.deps.hubspotRead.getCompanies = async () => []
    if (invalid === 'deleted') f.deps.hubspotRead.getCompanies = async () => [{ id: '11', archived: true, properties: {} }]
    if (invalid === 'cross-tenant') f.choice.company_id = 'other'
    if (invalid === 'wrong portal') f.choice.portal_id = '456'
    if (invalid === 'wrong contact') f.choice.hubspot_contact_id = '99'
    if (invalid === 'no longer associated') f.choice.hubspot_company_id = '13'
    await recheckDryRunReview(f.deps, input)
    assert.equal(f.applied[0][1].outcome, 'still_needs_review')
    assert.equal(f.applied[0][1].reason, 'multiple_associated_organizations')
  })
}

test('saved association addition becomes eligible only when the next direct association read includes it', async () => {
  const f = reviewedOrganizationFixture()
  f.choice.hubspot_company_id = '13'
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].reason, 'multiple_associated_organizations')
  f.associatedIds.push('13')
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[1][1].outcome, 'safe_to_link')
  assert.deepEqual(f.associatedIds, ['11', '12', '13'])
})

test('reviewed company requiring field review cannot clear an otherwise exact contact link', async () => {
  const f = reviewedOrganizationFixture()
  f.deps.albiRead.listOrganizations = async () => ({ records: [{ id: '30', name: 'Other', domain: 'allied.example' }], cursor: null })
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'still_needs_review')
  assert.equal(f.applied[0][1].reason, 'organization_unresolved')
})

for (const existing of [true, false]) test(`reviewed company needing creation ${existing ? 'cannot clear an existing contact' : 'permits a new contact'}`, async () => {
  const f = reviewedOrganizationFixture()
  f.deps.repository.getMappings = async () => ({ contacts: [], organizations: [], options: [
    { mapping_kind: 'default_organization_type', source_key: 'default', albi_id: '8', confirmed: true },
    { mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '7', confirmed: true },
  ] })
  f.deps.albiRead.listOrganizations = async () => ({ records: [], cursor: null })
  if (!existing) f.deps.albiRead.listContacts = async () => ({ records: [], cursor: null })
  await recheckDryRunReview(f.deps, input)
  const payload = f.applied[0][1]
  assert.equal(payload.outcome, existing ? 'still_needs_review' : 'safe_to_create')
  assert.equal(payload.status, existing ? 'needs_review' : 'cleared')
  if (existing) assert.equal(payload.reason, 'albi_contact_association_contract_unverified')
  assert.deepEqual(f.associatedIds, ['11', '12'])
})

for (const reason of ['multiple_associated_organizations', 'albi_contact_association_contract_unverified',
  'association_contract_unverified', 'organization_unresolved']) {
  test(`empty direct associations retain the existing ${reason} classification with current safe evidence`, async () => {
    const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', authorization: 'secret' }] })
    f.row.reason = reason; f.row.conflict_type = 'association'
    f.row.candidate_snapshots = [{ id: 'old-candidate' }]
    await recheckDryRunReview(f.deps, input)
    const payload = f.applied[0][1]
    assert.equal(payload.status, 'needs_review'); assert.equal(payload.outcome, 'still_needs_review')
    assert.equal(payload.eventType, 'still_needs_review')
    assert.equal(payload.reason, reason); assert.equal(payload.conflictType, 'association')
    assert.deepEqual(payload.sourceSnapshot, { id: '10', firstName: 'A', lastName: 'Person', email: 'a@example.com' })
    assert.deepEqual(payload.candidateSnapshots, [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com' }])
    assert.deepEqual(payload.matchEvidence, { evidence: ['email'] })
    assert.equal(JSON.stringify(payload).includes('secret'), false)
    assert.equal(f.calls.some(call => call[0] === 'companies' || call[0] === 'albiOrganizations'), false)
  })
}

test('empty direct associations cannot clear an existing association review through a safe create', async () => {
  const f = fixture({ options: [{ mapping_kind: 'default_contact_type', albi_id: '7', confirmed: true }] })
  f.row.reason = 'organization_unresolved'; f.row.conflict_type = 'association'
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'still_needs_review')
  assert.equal(f.applied[0][1].reason, 'organization_unresolved')
})

test('corrected direct association clears the original ambiguity using the shared evaluator', async () => {
  const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', organizationId: '30' }],
    organizations: [{ id: '30', name: 'Allied', domain: 'allied.example' }] })
  f.row.reason = 'multiple_associated_organizations'; f.row.conflict_type = 'association'
  f.deps.hubspotRead.getAssociations = async () => [{ fromId: '10', toObjectType: 'companies', toIds: ['11'] }]
  f.deps.hubspotRead.getCompanies = async () => [{ id: '11', properties: { name: 'Allied', domain: 'allied.example' } }]
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'safe_to_link')
  assert.equal(f.applied[0][1].status, 'cleared')
})

test('a mismatched corrected direct association keeps the current evaluator classification', async () => {
  const f = fixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', organizationId: '40' }],
    organizations: [{ id: '30', name: 'Allied', domain: 'allied.example' }] })
  f.row.reason = 'multiple_associated_organizations'; f.row.conflict_type = 'association'
  f.deps.hubspotRead.getAssociations = async () => [{ fromId: '10', toObjectType: 'companies', toIds: ['11'] }]
  f.deps.hubspotRead.getCompanies = async () => [{ id: '11', properties: { name: 'Allied', domain: 'allied.example' } }]
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'still_needs_review')
  assert.equal(f.applied[0][1].reason, 'albi_contact_association_contract_unverified')
})

test('confirmed missing source still removes an existing association review from scope', async () => {
  const f = fixture({ source: null })
  f.row.reason = 'multiple_associated_organizations'; f.row.conflict_type = 'association'
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.applied[0][1].outcome, 'source_missing')
})

test('a hanging provider respects a shortened deadline and cannot apply later', async () => {
  const f = fixture()
  f.deps.deadlineMs = 5
  let finish
  f.deps.hubspotRead.getContacts = () => new Promise(resolve => { finish = resolve })
  await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === 502)
  finish([])
  await Promise.resolve()
  assert.equal(f.applied.length, 0)
  assert.deepEqual(f.events[1][3].details, { category: 'transient', code: 'timeout' })
})

test('deadline abort signal reaches lazy read capability factory', async () => {
  const f = fixture()
  f.deps.deadlineMs = 5
  let signal
  f.deps.getReadClients = async (_company, _config, context) => { signal = context?.signal; return new Promise(() => {}) }
  await assert.rejects(recheckDryRunReview(f.deps, input))
  assert.equal(signal?.aborted, true)
})

test('malformed known provider field values fail instead of stringifying into an apparent safe create', async () => {
  const f = fixture({ source: { id: '10', properties: { firstname: { secret: 'value' }, lastname: 'Person' } },
    options: [{ mapping_kind: 'default_contact_type', albi_id: '7', confirmed: true }] })
  await assert.rejects(recheckDryRunReview(f.deps, input))
  assert.equal(f.applied.length, 0)
  assert.deepEqual(f.events[1][3].details, { category: 'permanent', code: 'malformed_response' })
})

test('rate limit exceeding the safe retry delay fails without early retries', async () => {
  const f = fixture()
  let reads = 0
  f.deps.hubspotRead.getContacts = async () => { reads++; throw Object.assign(new Error('provider secret'), { category: 'rate_limit', retryAfterMs: 6000 }) }
  await assert.rejects(recheckDryRunReview(f.deps, input))
  assert.equal(reads, 1)
  assert.equal(f.applied.length, 0)
})

test('missing or unsupported review scope rejects before any event or credential access', async () => {
  for (const row of [null, { object_type: 'notes', updated_at: stamp }]) {
    const f = fixture()
    f.deps.repository.getDryRunReview = async () => row
    await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === 404)
    assert.equal(f.events.length, 0)
    assert.equal(f.calls.some(call => call[0] === 'contacts'), false)
  }
})

test('a reviewed email-match link clears later rechecks whose only differences are phone or address', async () => {
  const albi = { id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', phoneNumber: '555-000-0000', city: 'Old Town' }
  const run = async (resolution, extra = {}) => {
    const f = fixture({ contacts: [albi], source: { id: '10', properties: { firstname: 'A', lastname: 'Person', email: 'a@example.com', phone: '5551112222', city: 'New Town', ...extra } } })
    f.deps.repository.getMappings = async () => ({ contacts: [{ portal_id: '123', hubspot_id: '10', albi_contact_id: '20', match_method: 'reviewed' }], organizations: [], options: [] })
    f.deps.repository.getCurrentReviewResolution = async () => resolution
    await recheckDryRunReview(f.deps, input).catch(() => {})
    return f.applied.at(-1)?.[1]
  }
  const accepted = { review_id: reviewId, action: 'link_existing', status: 'ready_to_recheck',
    decision: { action: 'link_existing', candidateId: '20', approveManyToOne: true, ignoreContactDifferences: true } }
  assert.equal((await run(accepted)).outcome, 'safe_to_link')
  assert.equal((await run(null)).outcome, 'still_needs_review')
  assert.equal((await run(accepted, { jobtitle: 'Engineer' })).outcome, 'still_needs_review')
  assert.equal((await run({ ...accepted, decision: { ...accepted.decision, candidateId: '21' } })).outcome, 'still_needs_review')
})

// Live rows are owned by the live run that captured them; the sample gate never applies to them.
function liveFixture(options = {}) {
  const f = fixture(options)
  Object.assign(f.row, { review_kind: 'live', run_id: 'live-run' })
  const store = liveCloseStore({ review: f.row })
  const triage = []
  f.deps.repository.getReview = async (...args) => { f.calls.push(['review', ...args]); return f.row }
  f.deps.repository.applyDryRunRecheck = async (company, payload) => {
    f.applied.push([company, payload])
    Object.assign(f.row, { status: payload.status, recheck_outcome: payload.outcome, updated_at: '2026-10-12T11:00:00.000000Z' })
    return { review: { ...f.row } }
  }
  f.deps.liveCloseRepository = store.methods
  f.deps.dispatchResume = store.dispatchResume
  f.deps.triageRepository = { setReviewTriage: async (_company, id, next) => { triage.push([id, next]) } }
  return { ...f, store, triage }
}

test('live recheck that now auto-links closes as resolved_by_sync', async () => {
  const f = liveFixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com' }] })
  const result = await recheckDryRunReview(f.deps, input)
  const [, payload] = f.applied[0]
  assert.deepEqual([payload.runId, payload.status, payload.outcome, payload.eventType, payload.kind],
    ['live-run', 'needs_review', 'safe_to_link', 'still_needs_review', 'live'])
  assert.deepEqual(f.store.state.closeCalls.map(call => [call.outcome, call.resolutionAction]), [['resolved_by_sync', null]])
  assert.equal(result.review.status, 'no_longer_in_scope')
  assert.equal(f.store.state.resumes.length, 2)
  assert.deepEqual(f.store.state.dispatched, ['resume-1', 'resume-2'])
  assert.equal(f.calls.some(call => call[0] === 'sample'), false)
})

test('deleted HubSpot source closes as source_missing; merged source stays open', async () => {
  const deleted = liveFixture({ source: null })
  deleted.deps.hubspotRead.getMergedInto = async () => null
  const gone = await recheckDryRunReview(deleted.deps, input)
  assert.equal(deleted.applied[0][1].outcome, 'source_missing')
  assert.deepEqual(deleted.store.state.closeCalls.map(call => [call.outcome, call.resolutionAction]), [['source_missing', 'skip']])
  assert.deepEqual(deleted.store.state.conflicts.map(conflict => conflict.status), ['skipped', 'skipped'])
  assert.equal(deleted.store.state.resumes.length, 0)
  assert.equal(gone.review.status, 'no_longer_in_scope')

  const merged = liveFixture({ source: null })
  merged.deps.hubspotRead.getMergedInto = async (type, id) => type === 'contacts' && id === '10' ? '77' : null
  const open = await recheckDryRunReview(merged.deps, input)
  assert.equal(merged.applied[0][1].status, 'needs_review')
  assert.deepEqual(merged.store.state.closeCalls, [])
  assert.equal(open.review.status, 'needs_review')
  assert.deepEqual(merged.store.state.conflicts.map(conflict => conflict.status), ['open', 'open'])
  assert.deepEqual(merged.triage.at(-1), [reviewId, { bucket: 'blocked', details: { merged: true, mergedIntoSourceId: '77' } }])
})

test('a live recheck that is only safe to create stays open for a reviewer', async () => {
  const f = liveFixture({ options: [{ mapping_kind: 'default_contact_type', albi_id: '7', confirmed: true }] })
  const result = await recheckDryRunReview(f.deps, input)
  assert.deepEqual([f.applied[0][1].status, f.applied[0][1].outcome], ['needs_review', 'safe_to_create'])
  assert.deepEqual(f.store.state.closeCalls, [])
  assert.equal(result.review.status, 'needs_review')
})

test('a closed live row cannot be rechecked and starts no provider read', async () => {
  const f = liveFixture(); f.row.status = 'cleared'
  await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === 409)
  assert.deepEqual(f.applied, [])
  assert.equal(f.calls.some(call => call[0] === 'contacts'), false)
})

test('a failed live close leaves the rechecked row open so the next recheck retries', async () => {
  const f = liveFixture({ contacts: [{ id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com' }] })
  f.store.state.failClose = 1
  const first = await recheckDryRunReview(f.deps, input)
  assert.equal(first.review.status, 'needs_review')
  assert.equal(first.review.recheck_outcome, 'safe_to_link')
  const second = await recheckDryRunReview(f.deps, { ...input, expectedUpdatedAt: first.review.updated_at })
  assert.equal(second.review.status, 'no_longer_in_scope')
  assert.equal(f.store.state.resumes.length, 2)
})

test('a link that ignored chosen differences clears later rechecks of contacts and organizations with only those differences', async () => {
  const contact = async (decision, extra = {}) => {
    const albi = { id: '20', firstName: 'A', lastName: 'Person', email: 'a@example.com', jobTitle: 'Tech' }
    const f = fixture({ contacts: [albi], source: { id: '10', properties: { firstname: 'A', lastname: 'Person', email: 'a@example.com', jobtitle: 'Lead', ...extra } } })
    f.deps.repository.getMappings = async () => ({ contacts: [{ portal_id: '123', hubspot_id: '10', albi_contact_id: '20' }], organizations: [], options: [] })
    f.deps.repository.getCurrentReviewResolution = async () => ({ review_id: reviewId, action: 'link_existing', status: 'ready_to_recheck', decision })
    await recheckDryRunReview(f.deps, input).catch(() => {})
    return f.applied.at(-1)?.[1]?.outcome
  }
  const ignoreTitle = { action: 'link_existing', candidateId: '20', ignoredFields: ['jobTitle'] }
  assert.equal(await contact(ignoreTitle), 'safe_to_link')
  assert.equal(await contact(ignoreTitle, { city: 'Elsewhere' }), 'still_needs_review')
  const organization = async decision => {
    const albi = { id: '30', name: 'Acme', phoneNumber: '555-000-0000', organizationTypeIds: ['7'] }
    const f = fixture({ objectType: 'companies', organizations: [albi], options: [{ mapping_kind: 'default_organization_type', source_key: 'default', albi_id: '7', confirmed: true }],
      source: { id: '10', properties: { name: 'Acme', phone: '5551112222' } } })
    f.deps.repository.getMappings = async () => ({ contacts: [], organizations: [{ portal_id: '123', hubspot_id: '10', albi_organization_id: '30' }],
      options: [{ mapping_kind: 'default_organization_type', source_key: 'default', albi_id: '7', confirmed: true }] })
    f.deps.repository.getCurrentReviewResolution = async () => ({ review_id: reviewId, action: 'link_existing', status: 'ready_to_recheck', decision })
    await recheckDryRunReview(f.deps, input).catch(() => {})
    return f.applied.at(-1)?.[1]?.outcome
  }
  assert.equal(await organization({ action: 'link_existing', candidateId: '30', ignoredFields: ['phoneNumber'] }), 'safe_to_link')
  assert.equal(await organization(null), 'still_needs_review')
})
