import test from 'node:test'
import assert from 'node:assert/strict'
import { recheckDryRunReview } from '../../netlify/functions/_h2a/reviewService.js'

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
