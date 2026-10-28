import test from 'node:test'
import assert from 'node:assert/strict'
import { executeReviewResolution, executeOrganizationThenContactCreate, reconcileReviewResolution, createReviewResolutionCapabilities,
  createReviewReconciliationCapabilities } from '../../netlify/functions/_h2a/reviewResolutionService.js'
import { recheckDryRunReview, createReviewRepositoryCapabilities } from '../../netlify/functions/_h2a/reviewService.js'
import { ApiError } from '../../netlify/functions/_h2a/http.js'
import { H2AReviewError as H2AReviewErrorForTest } from '../../netlify/functions/_h2a/reviewService.js'
import { liveCloseStore } from './live-close-fixture.mjs'

const stamp = '2026-10-13T12:00:00Z'
const actorId = '00000000-0000-4000-8000-000000000001'
const resolutionId = '00000000-0000-4000-8000-000000000002'
const input = { companyId: 'tenant', reviewId: '00000000-0000-4000-8000-000000000003', actorId,
  expectedUpdatedAt: stamp, clientRequestId: '00000000-0000-4000-8000-000000000004',
  decision: { action: 'resolve_fields', fieldChoices: { email: 'albi' } } }

function fixture() {
  const calls = [], events = [], mappings = { contacts: [], organizations: [], options: [] }
  const source = { id: '42', properties: { firstname: 'A', lastname: 'B', email: 'hs@example.com', phone: '5551112222' } }
  const target = { id: '20', firstName: 'A', lastName: 'B', email: 'albi@example.com', phoneNumber: '5551112222' }
  const row = { id: input.reviewId, company_id: 'tenant', run_id: 'sample', portal_id: '123', object_type: 'contacts', source_id: '42',
    updated_at: stamp, status: 'needs_review', reason: 'nonblank_field_difference', conflict_type: 'contact_fields',
    source_snapshot: { id: '42', firstName: 'A', lastName: 'B', email: 'hs@example.com', phoneNumber: '5551112222' },
    candidate_snapshots: [structuredClone(target)], proposed_changes: { conflicts: { email: { current: 'albi@example.com', proposed: 'hs@example.com' } }, updates: {} } }
  const f = { calls, events, mappings, source, target, row, intent: null, latest: 'sample', associations: [], contacts: [target], organizations: [] }
  const repo = {
    getConfig: async () => ({ portal_id: '123', initial_start_locked_at: stamp }),
    getCurrentReviewSample: async () => ({ id: f.latest, review_capture_version: 1 }),
    getLatestCompletedSampleDryRun: async () => ({ id: f.latest, review_capture_version: 1 }),
    getDryRunReview: async () => row,
    getMappings: async () => mappings,
    getCurrentReviewResolution: async () => f.intent,
    getReviewResolution: async () => f.intent,
    createReviewResolution: async (_company, args) => {
      if (f.intent) return { resolution: structuredClone(f.intent), created: false }
      if (args.expectedUpdatedAt !== row.updated_at) return { error: 'stale' }
      calls.push('intent');
      f.intent = { id: resolutionId, company_id: 'tenant', review_id: row.id, run_id: row.run_id, portal_id: '123', object_type: row.object_type,
        source_id: '42', decision: structuredClone(args.decision), action: args.decision.action, expected_review_updated_at: args.expectedUpdatedAt,
        client_request_id: args.clientRequestId, status: 'pending', execution_phase: null }
      return { resolution: structuredClone(f.intent), created: true }
    },
    claimReviewResolution: async (_company, _id, owner) => {
      calls.push('claim')
      if (f.intent.lease_owner) return { error: 'not_claimable' }
      f.intent.execution_phase = ['waiting_on_albi', 'ready_to_recheck'].includes(f.intent.status) ? f.intent.status : f.intent.execution_phase ?? 'applying'
      f.intent.status = 'applying'; f.intent.lease_owner = owner; f.intent.lease_expires_at = '2099-10-13T12:00:00Z'
      return { resolution: structuredClone(f.intent) }
    },
    finishReviewResolution: async (_company, _id, owner, args) => {
      calls.push('finish')
      assert.equal(owner, f.intent.lease_owner)
      if (f.crashFinish) throw Error('storage unavailable')
      if (f.intent.execution_phase !== 'applying') assert.ok(['waiting_on_albi', 'ready_to_recheck', 'completed', 'superseded'].includes(args.status))
      Object.assign(f.intent, { status: args.status, execution_phase: null, lease_owner: null, provider_outcome_code: args.providerOutcomeCode })
      events.push(args)
      return { resolution: structuredClone(f.intent) }
    },
    appendReviewResolutionEvent: async (_company, _id, args) => { calls.push('context'); events.push(args); return args },
    listReviewResolutionEvents: async () => events.map(args => ({ event_type: args.eventType, sanitized_details: args.details })),
    saveMapping: async (_company, kind, value, options = {}) => {
      f.mappingOptions = structuredClone(options)
      if (f.beforeMapping) f.beforeMapping()
      const rows = mappings[kind === 'contact' ? 'contacts' : 'organizations']
      const key = kind === 'contact' ? 'albi_contact_id' : 'albi_organization_id'
      if (f.enforceOwnership && rows.some(other => other[key] === value[key] &&
        (other.portal_id !== value.portal_id || other.hubspot_id !== value.hubspot_id)) && options.approveManyToOne !== true) {
        throw Object.assign(Error('many-to-one approval required'), { code: 'many_to_one_required' })
      }
      calls.push('mapping'); rows.push(value)
    },
    upsertContactOrganizationChoice: async (_company, args) => { calls.push('choice'); f.choice = { hubspot_company_id: args.organizationSourceId }; return { choice: f.choice } },
    getContactOrganizationChoice: async () => f.choice ?? null,
    appendDryRunReviewEvent: async () => ({ id: 'event' }),
    applyDryRunRecheck: async (_company, args) => { Object.assign(row, { status: args.status, updated_at: '2026-10-13T13:00:00Z' }); return { review: row } },
  }
  const hubspotRead = {
    getContacts: async () => { calls.push('read-source'); return [structuredClone(source)] },
    getCompanies: async ids => [{ id: ids[0], properties: { name: 'Acme', phone: '5552223333' } }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '42', toObjectType: 'companies', toIds: [...f.associations] }],
  }
  const albiRead = {
    listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }),
    listContacts: async () => { calls.push('read-target'); return { records: structuredClone(f.contacts), cursor: null } },
    listOrganizations: async () => ({ records: structuredClone(f.organizations), cursor: null }),
  }
  const hubspotWrite = {
    updateContact: async (id, properties) => {
      assert.equal(f.intent.status, 'applying'); assert.equal(id, '42')
      calls.push(['PATCH', structuredClone(properties)])
      if (f.writeError) throw f.writeError
      Object.assign(source.properties, properties)
      if (f.afterWrite) f.afterWrite()
      return { id, properties }
    },
    updateCompany: async () => { throw Error('unexpected company mutation') },
    addContactCompanyAssociation: async (contactId, companyId) => { calls.push(['PUT', contactId, companyId]); f.associations.push(companyId); return { contactId, companyId } },
  }
  const albiWrite = {
    createContact: async payload => {
      calls.push(['CREATE', structuredClone(payload)])
      if (f.createdTarget) f.contacts.push(f.createdTarget)
      if (f.afterCreate) f.afterCreate()
      if (f.writeError) throw f.writeError
      return { id: f.createdTarget?.id ?? '30' }
    },
    createOrganization: async () => { throw Error('unexpected organization mutation') },
  }
  for (const object of [repo, hubspotRead, albiRead, hubspotWrite, albiWrite]) for (const name of
    ['updateAlbiContact', 'updateAlbiOrganization', 'removeAssociation', 'dispatch', 'saveCursor', 'updateOrganization', 'associateContact']) {
    Object.defineProperty(object, name, { get() { throw Error(`Forbidden getter: ${name}`) } })
  }
  f.deps = { repository: repo, hubspotRead, albiRead, hubspotWrite, albiWrite, now: () => new Date(stamp), sleep: async () => {} }
  return f
}
const mutations = f => f.calls.filter(call => Array.isArray(call))

test('stale review rejects before provider capability construction or getters', async () => {
  const f = fixture(); f.deps.getResolutionClients = () => { throw Error('provider getter touched') }
  await assert.rejects(executeReviewResolution(f.deps, { ...input, expectedUpdatedAt: '2026-10-12T12:00:00Z' }), error => error.statusCode === 409)
  assert.deepEqual(f.calls, [])
})

test('changed provider comparison demands reconfirmation before PATCH', async () => {
  const f = fixture(); f.target.email = 'new@example.com'
  await assert.rejects(executeReviewResolution(f.deps, input), error => error.statusCode === 409)
  assert.deepEqual(mutations(f), [])
})

test('durable intent and lease precede exact PATCH and follow-up provider read', async () => {
  const f = fixture(); const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.deepEqual(mutations(f), [['PATCH', { email: 'albi@example.com' }]])
  assert.ok(f.calls.indexOf('intent') < f.calls.indexOf('claim'))
  assert.ok(f.calls.indexOf('claim') < f.calls.findIndex(Array.isArray))
  assert.ok(f.calls.indexOf('context') > f.calls.indexOf('claim'))
  assert.ok(f.calls.indexOf('context') < f.calls.findIndex(Array.isArray))
  assert.ok(f.calls.lastIndexOf('read-source') > f.calls.findIndex(Array.isArray))
  assert.equal(f.events.at(-1).eventType, 'provider_applied')
})

test('crash after PATCH reconciles its immutable target without repeating the write', async () => {
  const f = fixture(); f.crashFinish = true
  await assert.rejects(executeReviewResolution(f.deps, input))
  assert.equal(f.source.properties.email, 'albi@example.com')
  f.crashFinish = false; f.intent.lease_owner = null
  const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(mutations(f).length, 1)
  assert.equal(f.events.at(-1).eventType, 'provider_reconciled')
})

test('mixed write stores sanitized manual tasks and waits for Albi', async () => {
  const f = fixture(); f.target.phoneNumber = '5552223333'; f.row.candidate_snapshots[0].phoneNumber = '5552223333'
  f.row.proposed_changes.conflicts.phoneNumber = { current: '5552223333', proposed: '5551112222' }
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } } })
  assert.equal(result.resolution.status, 'waiting_on_albi')
  assert.equal(mutations(f).length, 1)
  assert.deepEqual(f.events.at(-1).details.manualTasks, [{ provider: 'albi', objectType: 'contacts', targetId: '20', fields: [{ field: 'phoneNumber', value: '5551112222' }] }])
})

test('manual-only decision performs no provider write and waits', async () => {
  const f = fixture()
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot' } } })
  assert.equal(result.resolution.status, 'waiting_on_albi'); assert.deepEqual(mutations(f), [])
})

test('link saves only reviewed company-scoped mapping, with no dispatch', async () => {
  const f = fixture(); f.row.reason = 'multiple_candidates'; f.row.conflict_type = 'contact_match'
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'link_existing', candidateId: '20' } })
  assert.equal(result.resolution.status, 'ready_to_recheck'); assert.deepEqual(mutations(f), [])
  assert.deepEqual(f.mappings.contacts, [{ portal_id: '123', hubspot_id: '42', albi_contact_id: '20', match_method: 'reviewed', reviewed_by: actorId }])
})

test('narrow capability mapping wrappers bind existing saveMapping without broad writes', async () => {
  const f = fixture(); const caps = createReviewResolutionCapabilities(f.deps.repository)
  assert.equal(Object.isFrozen(caps), true); assert.equal('saveMapping' in caps, false)
  await caps.saveContactMapping('tenant', { portal_id: '123', hubspot_id: '42', albi_contact_id: '20' })
  assert.equal(f.mappings.contacts[0].albi_contact_id, '20')
})

for (const [category, code, outcome] of [
  ['permission', 'operation_failed', 'authorization_rejected'], ['auth', 'operation_failed', 'authorization_rejected'],
  ['validation', 'operation_failed', 'operation_failed'], ['transient', 'operation_failed', 'operation_failed'],
  ['rate_limit', 'operation_failed', 'operation_failed'], ['transient', 'timeout', 'timeout'],
  ['permanent', 'malformed_response', 'malformed_response'],
]) test(`sanitized ${category}/${code} preserves intent after exactly one attempted mutation`, async () => {
  const f = fixture(); f.writeError = Object.assign(new Error('secret token body'), { category, code })
  const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'failed'); assert.equal(result.resolution.provider_outcome_code, outcome)
  assert.equal(mutations(f).length, 1); assert.ok(f.intent)
  assert.equal(JSON.stringify(f.events).includes('secret'), false)
})

test('failed provider validation preserves only its safe HTTP status for diagnosis', async () => {
  const f = fixture()
  f.writeError = Object.assign(new Error('secret provider response body'), {
    category: 'validation', code: 'validation', status: 422,
  })

  const result = await executeReviewResolution(f.deps, input)

  assert.equal(result.resolution.status, 'failed')
  assert.deepEqual(f.events.at(-1).details, {
    category: 'validation', code: 'operation_failed', providerStatus: 422,
  })
  assert.equal(JSON.stringify(f.events).includes('secret'), false)
})

test('failed provider validation records its sanitized reason', async () => {
  const f = fixture()
  f.writeError = Object.assign(new Error('x'), { category: 'validation', code: 'validation', status: 400,
    providerReason: 'body.contactTypeIds: Invalid type' })
  await executeReviewResolution(f.deps, input)
  assert.deepEqual(f.events.at(-1).details, { category: 'validation', code: 'operation_failed', providerStatus: 400,
    providerReason: 'body.contactTypeIds: Invalid type' })
})

function asCreate(f) {
  f.contacts = []; f.row.reason = 'no_match'; f.row.conflict_type = 'contact_match'; f.row.candidate_snapshots = []
  f.mappings.options = [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '12', confirmed: true }]
  f.createdTarget = { id: '30', firstName: 'A', lastName: 'B', email: 'hs@example.com', phoneNumber: '555-111-2222', contactTypeIds: ['12'] }
  return { ...input, decision: { action: 'create_albi', referralSourceId: '5' } }
}

function asForcedCreate(f) {
  f.row.reason = 'name_only_candidate'; f.row.conflict_type = 'contact_match'
  f.mappings.options = [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '12', confirmed: true }]
  f.createdTarget = { id: '30', firstName: 'A', lastName: 'B', email: 'hs@example.com', phoneNumber: '555-111-2222', contactTypeIds: ['12'] }
  return { ...input, decision: { action: 'force_create_albi', ignoredCandidateIds: ['20'], referralSourceId: '5' } }
}

test('forced create ignores the confirmed candidate, maps the receipt, and records a distinct audit outcome', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(result.resolution.provider_outcome_code, 'forced_created')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  assert.equal(f.mappingOptions.forceResolutionId, resolutionId)
  assert.equal(mutations(f).length, 1)
  assert.equal(f.events.at(-1).details.outcome, 'forced_created')
})

test('forced create validates captured candidates without enumerating the Albi tenant', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  f.deps.albiRead.listContacts = async () => { throw Error('must not enumerate Albi contacts') }

  const result = await executeReviewResolution(f.deps, createInput)

  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(result.resolution.provider_outcome_code, 'forced_created')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  assert.equal(mutations(f).length, 1)
})

test('forced contact creation preserves a mapped organization without enumerating Albi records', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  f.associations = ['77']
  f.mappings.organizations.push({ portal_id: '123', hubspot_id: '77', albi_organization_id: '88' })
  f.deps.albiRead.listContacts = async () => { throw Error('must not enumerate Albi contacts') }
  f.deps.albiRead.listOrganizations = async () => { throw Error('must not enumerate Albi organizations') }

  const result = await executeReviewResolution(f.deps, createInput)

  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  assert.deepEqual(mutations(f)[0], ['CREATE', {
    firstName: 'A', lastName: 'B', email: 'hs@example.com', phoneNumber: '555-111-2222',
    contactTypeIds: ['12'], organizationId: '88', referralSourceId: '5', relationshipStatusId: '2',
  }])
})

test('forced contact creation is refused before any Albi write while its organization is unmapped', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  f.associations = ['77']
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'failed')
  assert.equal(mutations(f).length, 0)
})

test('forced create retry reconciles its exact receipt and existing mapping without creating again', async () => {
  const f = fixture(), createInput = asForcedCreate(f); f.crashFinish = true
  await assert.rejects(executeReviewResolution(f.deps, createInput))
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  f.crashFinish = false; f.intent.lease_owner = null
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(result.resolution.provider_outcome_code, 'forced_created')
  assert.equal(mutations(f).length, 1)
  assert.equal(f.events.at(-1).eventType, 'provider_reconciled')
})

test('forced create retries a definitive validation rejection with a freshly rebuilt plan', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  f.writeError = new ApiError('validation', { code: 'operation_failed' })
  const first = await executeReviewResolution(f.deps, createInput)
  assert.equal(first.resolution.status, 'failed')
  assert.equal(mutations(f).length, 1)

  const persisted = f.events.find(event => event.eventType === 'claimed' && event.details?.executionContext)
  persisted.details.executionContext.providerOperation.payload.jobTitle = 'legacy optional field'
  persisted.details.executionContext.verification.create.payload.jobTitle = 'legacy optional field'
  f.writeError = null

  const second = await executeReviewResolution(f.deps, createInput)
  assert.equal(second.resolution.status, 'ready_to_recheck')
  assert.equal(mutations(f).length, 2)
  assert.equal(mutations(f)[1][1].jobTitle, undefined)
})

test('a transient failure after a validation retry is never blindly repeated', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  // Albi rejected it, so nothing was made.
  f.createdTarget = null
  f.writeError = new ApiError('validation', { code: 'operation_failed' })
  await executeReviewResolution(f.deps, createInput)

  f.writeError = new ApiError('transient', { code: 'timeout' })
  const ambiguous = await executeReviewResolution(f.deps, createInput)
  assert.equal(ambiguous.resolution.status, 'failed')
  assert.equal(mutations(f).length, 2)

  f.writeError = null
  const blocked = await executeReviewResolution(f.deps, createInput)
  assert.equal(blocked.resolution.status, 'failed')
  assert.equal(mutations(f).length, 2)
})

test('forced create stops before Albi when a source mapping exists or the decision changes the captured candidate set', async () => {
  const mapped = fixture(), mappedInput = asForcedCreate(mapped)
  mapped.mappings.contacts.push({ portal_id: '123', hubspot_id: '42', albi_contact_id: '20' })
  const mappedResult = await executeReviewResolution(mapped.deps, mappedInput)
  assert.equal(mappedResult.resolution.status, 'failed')
  assert.deepEqual(mutations(mapped), [])
  const changed = fixture(); asForcedCreate(changed)
  const changedResult = await executeReviewResolution(changed.deps, { ...input,
    decision: { action: 'force_create_albi', ignoredCandidateIds: ['21'], referralSourceId: '5' } })
  assert.equal(changedResult.resolution.status, 'failed')
  assert.deepEqual(mutations(changed), [])
})

test('ambiguous create is adopted only by unique production matcher plus exact create context', async () => {
  const f = fixture(), createInput = asCreate(f); f.writeError = new ApiError('transient', { code: 'timeout' })
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  assert.equal(f.events.at(-1).eventType, 'provider_reconciled'); assert.equal(mutations(f).length, 1)
})

test('successful name-only create persists an exact receipt before verification and maps that record', async () => {
  const f = fixture(), createInput = asCreate(f)
  delete f.source.properties.email; delete f.source.properties.phone
  delete f.row.source_snapshot.email; delete f.row.source_snapshot.phoneNumber
  f.row.proposed_changes = { conflicts: {}, updates: {} }
  f.createdTarget = { id: '30', firstName: 'A', lastName: 'B', contactTypeIds: ['12'] }
  f.deps.albiRead.listContacts = async () => {
    if (f.calls.some(call => Array.isArray(call) && call[0] === 'CREATE')) {
      assert.ok(f.events.some(event => event.details?.createReceiptId === '30'))
    }
    return { records: structuredClone(f.contacts), cursor: null }
  }
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  assert.equal(mutations(f).length, 1)
})

test('a create Albi accepted is linked to its receipt id even when Albi lists it late or with a value it changed', async () => {
  for (const listed of [null, { id: '30', firstName: 'A', lastName: 'B', contactTypeIds: ['12'], city: 'CHANGED BY ALBI' }]) {
    const f = fixture(), createInput = asCreate(f)
    delete f.source.properties.email; delete f.source.properties.phone
    delete f.row.source_snapshot.email; delete f.row.source_snapshot.phoneNumber
    f.row.proposed_changes = { conflicts: {}, updates: {} }
    f.createdTarget = { id: '30', firstName: 'A', lastName: 'B', contactTypeIds: ['12'] }
    const before = structuredClone(f.contacts)
    f.deps.albiRead.listContacts = async () => ({ records: f.calls.some(call => Array.isArray(call) && call[0] === 'CREATE')
      ? [...before, ...(listed ? [listed] : [])] : before, cursor: null })
    const result = await executeReviewResolution(f.deps, createInput)
    assert.equal(result.resolution.status, 'ready_to_recheck')
    assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
    assert.equal(mutations(f).length, 1)
  }
})

test('a create retried after an earlier attempt got an Albi receipt links that record instead of creating again', async () => {
  const f = fixture(), createInput = asCreate(f)
  delete f.source.properties.email; delete f.source.properties.phone
  delete f.row.source_snapshot.email; delete f.row.source_snapshot.phoneNumber
  f.row.proposed_changes = { conflicts: {}, updates: {} }
  const asked = []
  f.deps.repository.listPriorCreateReceipts = async (companyId, reviewId) => { asked.push([companyId, reviewId]); return ['31'] }
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '31')
  assert.equal(mutations(f).length, 0, 'nothing is created twice')
  assert.equal(asked.length, 1)
  assert.ok(f.events.some(event => event.details?.createReceiptId === '31'))
  // Two different earlier receipts are never guessed between.
  const g = fixture()
  delete g.source.properties.email; delete g.source.properties.phone
  delete g.row.source_snapshot.email; delete g.row.source_snapshot.phoneNumber
  g.row.proposed_changes = { conflicts: {}, updates: {} }
  g.deps.repository.listPriorCreateReceipts = async () => ['31', '32']
  assert.equal((await executeReviewResolution(g.deps, asCreate(g))).resolution.status, 'failed')
  assert.equal(mutations(g).length, 0)
})

test('a create cleared by a recent recheck skips re-reading all of Albi; an old one reads it', async () => {
  for (const [hoursAgo, scans] of [[2, 0], [30, 1]]) {
    const f = fixture(), createInput = asCreate(f)
    f.row.status = 'cleared'; f.row.recheck_outcome = 'safe_to_create'
    f.row.last_rechecked_at = new Date(Date.parse(stamp) - hoursAgo * 3600000).toISOString()
    f.deps.clockMs = () => Date.parse(stamp)
    let listed = 0
    const list = f.deps.albiRead.listContacts
    f.deps.albiRead.listContacts = async args => { listed++; return list(args) }
    const result = await executeReviewResolution(f.deps, createInput)
    assert.equal(result.resolution.status, 'ready_to_recheck', `${hoursAgo}h`)
    assert.equal(listed, scans, `${hoursAgo}h`)
    assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  }
})

test('successful organization create with name-only evidence maps the receipt target', async () => {
  const f = fixture()
  f.row.object_type = 'companies'; f.row.reason = 'no_match'; f.row.conflict_type = 'organization_match'
  f.row.source_snapshot = { id: '42', name: 'Acme' }; f.row.candidate_snapshots = []
  f.row.proposed_changes = { conflicts: {}, updates: {} }
  f.source.properties = { name: 'Acme' }
  f.deps.hubspotRead.getCompanies = async () => [structuredClone(f.source)]
  f.mappings.options = [{ mapping_kind: 'default_organization_type', source_key: 'default', albi_id: '12', confirmed: true }]
  f.deps.albiRead.listOrganizations = async () => ({ records: structuredClone(f.organizations), cursor: null })
  f.deps.albiWrite.createOrganization = async payload => { f.calls.push(['CREATE', structuredClone(payload)])
    f.organizations.push({ id: '60', name: 'Acme', organizationTypeIds: ['12'] }); return { id: '60' } }
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'create_albi', referralSourceId: '5' } })
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.organizations[0].albi_organization_id, '60')
  assert.equal(mutations(f).length, 1)
})

test('corrected cleared review creates only from fresh safe-to-create outcome', async () => {
  const f = fixture(), createInput = asCreate(f)
  f.row.status = 'cleared'; f.row.recheck_outcome = 'safe_to_create'
  const created = await executeReviewResolution(f.deps, createInput)
  assert.equal(created.resolution.status, 'ready_to_recheck')
  assert.equal(mutations(f).length, 1)
  const blocked = fixture(), blockedInput = asCreate(blocked)
  blocked.row.status = 'cleared'; blocked.row.recheck_outcome = 'safe_to_link'
  await assert.rejects(executeReviewResolution(blocked.deps, blockedInput), error => error.statusCode === 409)
  assert.equal(mutations(blocked).length, 0)
})

for (const kind of ['absent', 'duplicate', 'wrong_type', 'missing_field', 'owned']) test(`ambiguous create ${kind} is never blindly repeated`, async () => {
  const f = fixture(), createInput = asCreate(f)
  if (kind === 'absent') f.createdTarget = null
  if (kind === 'wrong_type') f.createdTarget.contactTypeIds = ['99']
  if (kind === 'missing_field') delete f.createdTarget.lastName
  if (kind === 'owned') f.mappings.contacts.push({ portal_id: '456', hubspot_id: '99', albi_contact_id: '30' })
  if (kind === 'duplicate') f.afterCreate = () => f.contacts.push({ ...f.createdTarget, id: '31' })
  f.writeError = new ApiError('transient', { code: 'timeout' })
  const first = await executeReviewResolution(f.deps, createInput)
  assert.equal(first.resolution.status, 'failed')
  await executeReviewResolution(f.deps, createInput)
  assert.equal(mutations(f).length, 1)
  assert.equal(f.mappings.contacts.filter(row => row.hubspot_id === '42').length, 0)
})

test('newer sample during provider write supersedes durable intent', async () => {
  const f = fixture(); f.afterWrite = () => { f.latest = 'new-sample' }
  const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'superseded'); assert.equal(mutations(f).length, 1)
})

test('waiting claim never repeats provider work even if provider evidence drifts', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, input)
  f.source.properties.email = 'changed@example.com'
  const result = await reconcileReviewResolution(f.deps, { companyId: 'tenant', resolutionId, actorId })
  assert.equal(result.resolution.status, 'ready_to_recheck'); assert.equal(mutations(f).length, 1)
})

test('production recheck completes current intent only when review evaluation clears', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, input)
  const result = await recheckDryRunReview(f.deps, input)
  assert.equal(result.review.status, 'cleared'); assert.equal(f.intent.status, 'completed')
})

test('a recheck never relabels a failed attempt as saved; it closes it so the record can be decided again', async () => {
  const f = fixture(), createInput = asCreate(f)
  f.deps.albiRead.listContacts = async () => ({ records: [{ id: '77', firstName: 'A', lastName: 'B' }], cursor: null })
  await assert.rejects(executeReviewResolution(f.deps, createInput), error => error.statusCode === 409)
  assert.equal(f.intent.status, 'failed')
  f.intent.lease_owner = null
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.intent.status, 'superseded')
})

test('production recheck retains manual waiting while values still differ', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot' } } })
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.row.status, 'needs_review'); assert.equal(f.intent.status, 'waiting_on_albi')
  assert.deepEqual(mutations(f), [])
})

test('provider read failure restores prior waiting phase with sanitized event', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, input)
  f.deps.hubspotRead.getContacts = async () => { throw new ApiError('auth', { code: 'operation_failed' }) }
  const result = await reconcileReviewResolution(f.deps, { companyId: 'tenant', resolutionId, actorId })
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.events.at(-1).eventType, 'failed'); assert.equal(mutations(f).length, 1)
})

test('missing selected current provider field is unknown and never clears HubSpot', async () => {
  const f = fixture(); delete f.target.email
  const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'failed'); assert.deepEqual(mutations(f), [])
})

test('raw overlength selected values cannot be truncated into provider writes', async () => {
  const f = fixture(); f.target.email = 'x'.repeat(501); f.row.candidate_snapshots[0].email = 'x'.repeat(500)
  f.row.proposed_changes.conflicts.email.current = 'x'.repeat(500)
  const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'failed'); assert.deepEqual(mutations(f), [])
})

test('fresh missing provider evidence never becomes a default blank', async () => {
  const f = fixture(); delete f.source.properties.email
  const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'failed'); assert.deepEqual(mutations(f), [])
})

test('ownership in a different portal also requires explicit reviewed many-to-one approval', async () => {
  const f = fixture(); f.row.reason = 'multiple_candidates'; f.row.conflict_type = 'contact_match'
  f.mappings.contacts.push({ portal_id: '456', hubspot_id: '99', albi_contact_id: '20' })
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'link_existing', candidateId: '20' } })
  assert.equal(result.resolution.status, 'failed'); assert.equal(f.calls.includes('mapping'), false)
})

test('persisted intent is superseded before any provider reads when newer sample arrives', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, input); f.latest = 'new-sample'; f.calls.length = 0
  const result = await reconcileReviewResolution(f.deps, { companyId: 'tenant', resolutionId, actorId })
  assert.equal(result.resolution.status, 'superseded'); assert.equal(f.calls.includes('read-source'), false)
})

test('real provider client reads retain address2 and contact jobTitle evidence', async () => {
  const { HubSpotClient } = await import('../../netlify/functions/_h2a/hubspotClient.js')
  const { AlbiClient } = await import('../../netlify/functions/_h2a/albiClient.js')
  const hubspot = new HubSpotClient({ token: 'token', fetch: async (_url, options) => {
    assert.ok(JSON.parse(options.body).properties.includes('address2'))
    return new Response(JSON.stringify({ status: 'COMPLETE', results: [{ id: '42', properties: { address2: 'Suite 1', jobtitle: 'Manager' } }] }))
  } })
  const albi = new AlbiClient({ apiKey: 'key', fetch: async url => new Response(JSON.stringify(
    new URL(url).pathname.endsWith('/companies') ? { data: [{ companyId: '1319', name: 'Allied' }] }
      : { data: [{ id: 20, jobTitle: 'Manager', address2: 'Suite 1' }] })) })
  assert.equal((await hubspot.getContacts(['42']))[0].properties.address2, 'Suite 1')
  assert.equal((await albi.listContacts({ cursor: '1', pageSize: 100 })).records[0].jobTitle, 'Manager')
})

test('a contact behind an organization already linked to Albi is not held up by that organization’s field differences', async () => {
  const f = fixture()
  f.contacts = []; f.row.reason = 'organization_unresolved'; f.row.conflict_type = 'association'; f.row.candidate_snapshots = []
  f.mappings.options = [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '12', confirmed: true }]
  f.associations = ['99']
  f.mappings.organizations = [{ portal_id: '123', hubspot_id: '99', albi_organization_id: '50' }]
  // Albi's organization differs from HubSpot's (name and phone), which its own review accepted.
  f.organizations = [{ id: '50', name: 'Acme Holdings LLC', phoneNumber: '5559990000', organizationTypeIds: ['12', '13'] }]
  const result = await recheckDryRunReview(f.deps, input)
  assert.equal(result.review.status, 'cleared')
  assert.equal(f.row.status, 'cleared')
})

test('a recheck clears a contact whose company HubSpot merged from a record already linked to Albi', async () => {
  const f = fixture()
  f.contacts = []; f.row.reason = 'organization_unresolved'; f.row.conflict_type = 'association'; f.row.candidate_snapshots = []
  f.mappings.options = [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '12', confirmed: true }]
  f.associations = ['900']
  f.mappings.organizations = [{ portal_id: '123', hubspot_id: '99', albi_organization_id: '50' }]
  f.deps.hubspotRead.getCompanies = async ids => [{ id: ids[0], properties: { name: 'Acme', hs_merged_object_ids: '99' } }]
  f.deps.hubspotRead.getCompany = async id => ({ id, properties: { name: 'Acme', hs_merged_object_ids: '99' } })
  f.organizations = [{ id: '50', name: 'Acme Holdings LLC', organizationTypeIds: ['12'] }]
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.row.status, 'cleared')
})

test('a contact with several HubSpot organizations uses the first (primary) one', async () => {
  const f = fixture()
  f.contacts = []; f.row.reason = 'multiple_associated_organizations'; f.row.conflict_type = 'association'; f.row.candidate_snapshots = []
  f.mappings.options = [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '12', confirmed: true }]
  f.associations = ['99', '98']
  f.mappings.organizations = [{ portal_id: '123', hubspot_id: '99', albi_organization_id: '50' }]
  f.organizations = [{ id: '50', name: 'Acme', phoneNumber: '5552223333' }]
  await recheckDryRunReview(f.deps, input)
  assert.equal(f.row.status, 'cleared')
})

test('recheck provider failure preserves waiting intent and adds fixed resolution audit', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, input)
  f.deps.hubspotRead.getContacts = async () => { throw Object.assign(Error('secret'), { category: 'auth' }) }
  await assert.rejects(recheckDryRunReview(f.deps, input), error => error.statusCode === 502)
  assert.equal(f.intent.status, 'ready_to_recheck'); assert.equal(f.events.at(-1).eventType, 'failed')
  assert.equal(f.events.at(-1).details.code, 'authorization_rejected'); assert.equal(JSON.stringify(f.events).includes('secret'), false)
})

test('persisted organization choice permits production recheck to evaluate selected direct association', async () => {
  const f = fixture(); f.source.properties.email = f.target.email
  f.associations = ['99', '98']; f.choice = { hubspot_company_id: '99' }
  f.row.reason = 'multiple_associated_organizations'; f.row.conflict_type = 'association'
  f.target.organizationId = '50'
  f.organizations = [{ id: '50', name: 'Acme', phoneNumber: '5552223333' }]
  const result = await recheckDryRunReview(f.deps, input)
  assert.equal(result.review.status, 'cleared')
})

test('intent invalidated after provider reads never starts a write', async () => {
  const f = fixture()
  f.deps.albiRead.listContacts = async () => { f.row.updated_at = '2026-10-13T13:00:00Z'; return { records: [f.target], cursor: null } }
  await assert.rejects(executeReviewResolution(f.deps, input), error => error.statusCode === 409)
  assert.deepEqual(mutations(f), [])
})

test('expired lease prevents delayed worker mutation', async () => {
  const f = fixture()
  f.deps.repository.claimReviewResolution = async () => {
    Object.assign(f.intent, { status: 'applying', execution_phase: 'applying', lease_owner: actorId, lease_expires_at: '2020-01-01T00:00:00Z' })
    return { resolution: f.intent }
  }
  await assert.rejects(executeReviewResolution(f.deps, input), error => error.statusCode === 409)
  assert.deepEqual(mutations(f), [])
})

test('crashed production recheck finalization is recovered from the persisted cleared review', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, input); f.crashFinish = true
  await assert.rejects(recheckDryRunReview(f.deps, input)); assert.equal(f.row.status, 'cleared')
  f.crashFinish = false; f.intent.lease_owner = null
  const result = await reconcileReviewResolution(f.deps, { companyId: 'tenant', resolutionId, actorId })
  assert.equal(result.resolution.status, 'completed'); assert.equal(mutations(f).length, 1)
})

test('create retry reuses persisted exact type context despite changed option mappings', async () => {
  const f = fixture(), createInput = asCreate(f); f.writeError = new ApiError('transient', { code: 'timeout' })
  f.createdTarget.contactTypeIds = ['99']
  await executeReviewResolution(f.deps, createInput)
  f.mappings.options[0].albi_id = '99'
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'failed'); assert.equal(mutations(f).length, 1)
  assert.equal(f.mappings.contacts.length, 0)
})

test('create mapping saved before finalization crash is reconciled without a second create', async () => {
  const f = fixture(), createInput = asCreate(f); f.crashFinish = true
  await assert.rejects(executeReviewResolution(f.deps, createInput))
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  f.crashFinish = false; f.intent.lease_owner = null
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(mutations(f).length, 1); assert.equal(f.events.at(-1).eventType, 'provider_reconciled')
})

test('retrying a failed create that already has an Albi receipt links that record even when Albi does not list it', async () => {
  const f = fixture(), createInput = asCreate(f)
  f.deps.albiRead.listContacts = async () => ({ records: [], cursor: null })
  // The first attempt gets Albi's receipt, then fails before the link is saved (as a 429 did for Yadira).
  const getMappings = f.deps.repository.getMappings
  let broken = true
  f.deps.repository.getMappings = async (...args) => {
    if (broken && f.calls.some(call => Array.isArray(call) && call[0] === 'CREATE')) throw new Error('rate limited')
    return getMappings(...args)
  }
  await executeReviewResolution(f.deps, createInput)
  assert.equal(f.intent.status, 'failed')
  assert.equal(f.mappings.contacts.length, 0)
  broken = false; f.intent.lease_owner = null
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  assert.equal(mutations(f).length, 1, 'Albi is written once')
})

test('retrying a create that failed before writing (a duplicate appeared, or Albi rate limited) plans it again', async () => {
  const f = fixture(), createInput = asCreate(f)
  const candidate = { id: '77', firstName: 'A', lastName: 'B' }
  f.deps.albiRead.listContacts = async () => ({ records: [candidate], cursor: null })
  await assert.rejects(executeReviewResolution(f.deps, createInput), error => error.statusCode === 409)
  assert.equal(f.intent.status, 'failed')
  assert.equal(mutations(f).length, 0)
  // The possible duplicate is gone (merged in Albi); the same request is planned again rather than stuck on its old plan.
  f.deps.albiRead.listContacts = async () => ({ records: [], cursor: null }); f.intent.lease_owner = null
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(mutations(f).length, 1)
})

test('a retry after a create that timed out links the record Albi made instead of creating a second one', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  f.writeError = new ApiError('transient', { operation: 'createContact', code: 'timeout' })
  await executeReviewResolution(f.deps, createInput)
  assert.equal(f.intent.status, 'failed')
  assert.equal(mutations(f).length, 1)
  f.writeError = null; f.intent.lease_owner = null
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  assert.equal(mutations(f).length, 1, 'no second create')
})

test('a retry after a create that timed out without making a record creates it then', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  const made = f.createdTarget
  f.createdTarget = null
  f.writeError = new ApiError('transient', { operation: 'createContact', code: 'timeout' })
  await executeReviewResolution(f.deps, createInput)
  assert.equal(f.intent.status, 'failed')
  f.writeError = null; f.createdTarget = made; f.intent.lease_owner = null
  // Right away it is still unknown (Albi's list may lag), so nothing is created.
  await executeReviewResolution(f.deps, createInput)
  assert.equal(mutations(f).length, 1)
  f.intent.lease_owner = null
  // Ten minutes on, Albi still has no such record: it was not made, so it is created now.
  f.deps.clockMs = () => Date.now() + 10 * 60000
  const list = f.deps.repository.listReviewResolutionEvents
  f.deps.repository.listReviewResolutionEvents = async (...args) => (await list(...args)).map(event => ({ ...event, created_at: new Date().toISOString() }))
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(mutations(f).length, 2)
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
})

test('explicit organization addition uses one PUT, saves choice, and leaves Albi reassociation manual', async () => {
  const f = fixture(); f.row.reason = 'multiple_associated_organizations'; f.row.conflict_type = 'association'
  f.row.candidate_snapshots = []; f.associations = ['98']; f.target.organizationId = '51'
  f.source.properties.email = f.target.email; f.row.source_snapshot.email = f.target.email
  f.organizations = [{ id: '50', name: 'Acme', phoneNumber: '5552223333' }]
  const result = await executeReviewResolution(f.deps, { ...input,
    decision: { action: 'choose_organization', organizationSourceId: '99', addHubSpotAssociation: true } })
  assert.deepEqual(mutations(f), [['PUT', '42', '99']]); assert.equal(result.resolution.status, 'waiting_on_albi')
  assert.equal(f.choice.hubspot_company_id, '99')
  assert.deepEqual(f.events.at(-1).details.manualTasks[0].fields, [{ field: 'organizationId', value: '50' }])
})

test('separate narrow reconciliation capability completes intents through unchanged diagnostic adapter', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, input)
  const deps = { ...f.deps, repository: createReviewRepositoryCapabilities(f.deps.repository),
    resolutionRepository: createReviewReconciliationCapabilities(f.deps.repository) }
  assert.equal('saveMapping' in deps.resolutionRepository, false)
  await recheckDryRunReview(deps, input)
  assert.equal(f.intent.status, 'completed')
})

test('new target ownership after persisted link context still blocks unapproved mapping', async () => {
  const f = fixture(); f.row.reason = 'multiple_candidates'; f.row.conflict_type = 'contact_match'
  const linkInput = { ...input, decision: { action: 'link_existing', candidateId: '20' } }
  f.deps.repository.saveMapping = async () => { throw Error('storage unavailable') }
  await executeReviewResolution(f.deps, linkInput)
  f.mappings.contacts.push({ portal_id: '456', hubspot_id: '99', albi_contact_id: '20' })
  f.deps.repository.saveMapping = async () => { f.calls.push('mapping') }
  const result = await executeReviewResolution(f.deps, linkInput)
  assert.equal(result.resolution.status, 'failed'); assert.equal(f.calls.includes('mapping'), false)
})

test('older exact RPC replay survives recheck freshness even when a newer intent exists', async () => {
  const f = fixture(); await executeReviewResolution(f.deps, input)
  f.row.updated_at = '2026-10-13T13:00:00Z'
  f.deps.repository.getCurrentReviewResolution = async () => ({ ...f.intent,
    expected_review_updated_at: f.row.updated_at, decision: { action: 'resolve_fields', fieldChoices: { phoneNumber: 'albi' } } })
  const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'ready_to_recheck'); assert.equal(mutations(f).length, 1)
})

test('HubSpot source drift during slow Albi reads is caught immediately before mutation', async () => {
  const f = fixture()
  f.deps.albiRead.listContacts = async () => { f.source.properties.email = 'changed@example.com'; return { records: [f.target], cursor: null } }
  await assert.rejects(executeReviewResolution(f.deps, input), error => error.statusCode === 409)
  assert.deepEqual(mutations(f), [])
})

test('capped history without context cannot prove that no provider mutation occurred', async () => {
  const f = fixture(); f.deps.repository.listReviewResolutionEvents = async () => Array.from({ length: 100 }, () => ({ event_type: 'claimed', sanitized_details: {} }))
  const result = await executeReviewResolution(f.deps, input)
  assert.equal(result.resolution.status, 'failed'); assert.deepEqual(mutations(f), [])
})

test('intent retry before context persistence still rejects a changed raw provider comparison', async () => {
  const f = fixture()
  f.deps.getResolutionClients = async () => { throw new ApiError('transient', { code: 'timeout' }) }
  await executeReviewResolution(f.deps, input)
  delete f.deps.getResolutionClients
  f.target.email = ' albi@example.com '
  await assert.rejects(executeReviewResolution(f.deps, input), error => error.statusCode === 409)
  assert.deepEqual(mutations(f), [])
})

test('same numeric source in another portal is another owner requiring explicit approval', async () => {
  const f = fixture(); f.row.reason = 'multiple_candidates'; f.row.conflict_type = 'contact_match'
  f.mappings.contacts.push({ portal_id: '456', hubspot_id: '42', albi_contact_id: '20' })
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'link_existing', candidateId: '20' } })
  assert.equal(result.resolution.status, 'failed'); assert.equal(f.calls.includes('mapping'), false)
})

for (const approved of [false, true]) test(`ownership race at mapping save respects explicit approval=${approved}`, async () => {
  const f = fixture(); f.enforceOwnership = true; f.row.reason = 'multiple_candidates'; f.row.conflict_type = 'contact_match'
  f.beforeMapping = () => f.mappings.contacts.push({ portal_id: '456', hubspot_id: '42', albi_contact_id: '20' })
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'link_existing', candidateId: '20', approveManyToOne: approved } })
  assert.equal(result.resolution.status, approved ? 'ready_to_recheck' : 'failed')
  assert.equal(f.mappings.contacts.filter(row => row.portal_id === '123').length, approved ? 1 : 0)
})

test('accepted blank phone PATCH reconciles after finalization crash and production recheck clears', async () => {
  const f = fixture(); f.source.properties.email = f.target.email; f.row.source_snapshot.email = f.target.email
  f.target.phoneNumber = ''; delete f.row.candidate_snapshots[0].phoneNumber
  f.row.proposed_changes.conflicts = { phoneNumber: { current: null, proposed: '5551112222' } }
  const clearInput = { ...input, decision: { action: 'resolve_fields', fieldChoices: { phoneNumber: 'albi' } } }
  f.crashFinish = true
  await assert.rejects(executeReviewResolution(f.deps, clearInput))
  assert.equal(f.source.properties.phone, '')
  f.crashFinish = false; f.intent.lease_owner = null
  const result = await executeReviewResolution(f.deps, clearInput)
  assert.equal(result.resolution.status, 'ready_to_recheck'); assert.equal(f.events.at(-1).eventType, 'provider_reconciled')
  assert.deepEqual(mutations(f), [['PATCH', { phone: '' }]])
  const rechecked = await recheckDryRunReview(f.deps, input)
  assert.equal(rechecked.review.status, 'cleared'); assert.equal(f.intent.status, 'completed')
})

test('missing intended phone after a crash is not proof of an accepted blank', async () => {
  const f = fixture(); f.target.phoneNumber = ''; delete f.row.candidate_snapshots[0].phoneNumber
  f.row.proposed_changes.conflicts.phoneNumber = { current: null, proposed: '5551112222' }
  const clearInput = { ...input, decision: { action: 'resolve_fields', fieldChoices: { phoneNumber: 'albi' } } }
  f.crashFinish = true; await assert.rejects(executeReviewResolution(f.deps, clearInput))
  f.crashFinish = false; f.intent.lease_owner = null; delete f.source.properties.phone
  await assert.rejects(executeReviewResolution(f.deps, clearInput), error => error.statusCode === 409)
  assert.equal(mutations(f).length, 1)
})

test('ambiguous create cannot adopt a target owned by equal source ID in another portal', async () => {
  const f = fixture(), createInput = asCreate(f); f.writeError = new ApiError('transient', { code: 'timeout' })
  f.mappings.contacts.push({ portal_id: '456', hubspot_id: '42', albi_contact_id: '30' })
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'failed'); assert.equal(f.mappings.contacts.filter(row => row.portal_id === '123').length, 0)
})

test('create stops before any Albi write when the chosen referral source is not in the live Albi options', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  f.deps.albiRead.listReferralSources = async () => [{ id: '6', label: 'Other' }]
  await assert.rejects(executeReviewResolution(f.deps, createInput), error => error.statusCode === 409)
  assert.equal(mutations(f).length, 0)
})

test('a fresh create stops before any Albi write when required defaults cannot be resolved', async () => {
  for (const options of [{ relationshipTypes: [], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] },
    { relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [], salespeople: [] }]) {
    const f = fixture(), createInput = asForcedCreate(f)
    f.deps.albiRead.listCreateOptions = async () => options
    await assert.rejects(executeReviewResolution(f.deps, createInput), error => error.statusCode === 409)
    assert.equal(mutations(f).length, 0)
  }
})

test('create sends Referrer type, Active status and the owner-matched salesperson', async () => {
  const f = fixture(), createInput = asForcedCreate(f)
  f.deps.hubspotRead.getOwnerId = async () => '5'
  f.deps.hubspotRead.listOwners = async () => [{ id: '5', firstName: 'Ali', lastName: 'Brown' }]
  f.deps.albiRead.listCreateOptions = async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }],
    relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [{ id: '70', label: 'Ali Brown' }] })
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  const payload = mutations(f)[0][1]
  assert.deepEqual([payload.contactTypeIds, payload.relationshipStatusId, payload.salespersonId], [['12'], '2', '70'])
})

test('choosing HubSpot for fields Albi does not return ends as a manual Albi task, not a failure', async () => {
  const f = fixture()
  Object.assign(f.source.properties, { city: 'Newport Beach', jobtitle: 'Director of engineering' })
  Object.assign(f.row.source_snapshot, { city: 'Newport Beach', jobTitle: 'Director of engineering' })
  f.row.proposed_changes = { updates: { city: 'Newport Beach', jobTitle: 'Director of engineering' }, unchanged: [],
    conflicts: { city: { current: null, proposed: 'Newport Beach' }, jobTitle: { current: null, proposed: 'Director of engineering' } } }
  f.row.reason = 'albi_contact_update_contract_unverified'
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { city: 'hubspot', jobTitle: 'hubspot' } } })
  assert.equal(result.resolution.status, 'waiting_on_albi')
  assert.deepEqual(mutations(f), [])
  assert.deepEqual(f.events.at(-1).details.manualTasks, [{ provider: 'albi', objectType: 'contacts', targetId: '20',
    fields: [{ field: 'city', value: 'Newport Beach' }, { field: 'jobTitle', value: 'Director of engineering' }] }])
})

test('a manual-only field resolution uses the captured Albi record and never enumerates Albi', async () => {
  const f = fixture()
  f.deps.albiRead.listContacts = async () => { throw Error('must not enumerate Albi contacts') }
  f.deps.albiRead.listOrganizations = async () => { throw Error('must not enumerate Albi organizations') }
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot' } } })
  assert.equal(result.resolution.status, 'waiting_on_albi')
  assert.deepEqual(mutations(f), [])
  assert.deepEqual(f.events.at(-1).details.manualTasks[0].fields, [{ field: 'email', value: 'hs@example.com' }])
})

test('a field resolution that writes HubSpot still verifies against live Albi evidence', async () => {
  const f = fixture(); let listed = 0
  const original = f.deps.albiRead.listContacts
  f.deps.albiRead.listContacts = async (...args) => { listed++; return original(...args) }
  await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'albi' } } })
  assert.ok(listed > 0)
})

test('the resolution reads the HubSpot source the same way recheck does (single-record read when available)', async () => {
  const f = fixture()
  f.deps.hubspotRead.getContact = async id => { f.calls.push('read-direct'); return structuredClone(f.source) }
  f.deps.hubspotRead.getContacts = async () => { throw Error('must use the direct read') }
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot' } } })
  assert.equal(result.resolution.status, 'waiting_on_albi')
  assert.ok(f.calls.includes('read-direct'))
})

test('a stale rejection records which check failed and the differing field names, never values', async () => {
  const f = fixture()
  f.source.properties.phone = '5559990000'
  await assert.rejects(executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot' } } }),
    error => error.statusCode === 409)
  const details = f.events.at(-1).details
  assert.equal(details.staleCheck, 'source')
  assert.deepEqual(details.staleFields, ['phoneNumber'])
  assert.equal(JSON.stringify(f.events).includes('5559990000'), false)
})

test('surrounding whitespace in live HubSpot values does not make a field resolution stale', async () => {
  const f = fixture()
  Object.assign(f.source.properties, { city: 'Newport Beach ', jobtitle: ' Director of engineering' })
  Object.assign(f.row.source_snapshot, { city: 'Newport Beach', jobTitle: 'Director of engineering' })
  f.row.proposed_changes = { updates: {}, unchanged: [],
    conflicts: { city: { current: null, proposed: 'Newport Beach' }, jobTitle: { current: null, proposed: 'Director of engineering' } } }
  f.row.reason = 'albi_contact_update_contract_unverified'
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { city: 'hubspot', jobTitle: 'hubspot' } } })
  assert.equal(result.resolution.status, 'waiting_on_albi')
  assert.deepEqual(f.events.at(-1).details.manualTasks[0].fields,
    [{ field: 'city', value: 'Newport Beach' }, { field: 'jobTitle', value: 'Director of engineering' }])
})

test('an email-match link saves the mapping from captured evidence without enumerating Albi', async () => {
  const f = fixture(); f.row.reason = 'nonblank_field_difference'
  f.source.properties.email = 'same@example.com'; f.row.source_snapshot.email = 'same@example.com'
  f.row.candidate_snapshots = [{ ...f.row.candidate_snapshots[0], email: 'Same@Example.com' }]
  f.row.proposed_changes = { conflicts: {}, updates: {} }
  f.deps.albiRead.listContacts = async () => { throw Error('must not enumerate Albi contacts') }
  const result = await executeReviewResolution(f.deps, { ...input,
    decision: { action: 'link_existing', candidateId: '20', approveManyToOne: true, ignoreContactDifferences: true } })
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '20')
  assert.deepEqual(mutations(f), [])
})

test('a review cleared as safe to link can save that link now', async () => {
  const f = fixture(); f.row.reason = 'no_match'; f.row.status = 'cleared'; f.row.recheck_outcome = 'safe_to_link'
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'link_existing', candidateId: '20', approveManyToOne: true } })
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '20')
  const other = fixture(); other.row.status = 'cleared'; other.row.recheck_outcome = 'safe_to_create'
  await assert.rejects(executeReviewResolution(other.deps, { ...input, decision: { action: 'link_existing', candidateId: '20' } }), error => error.statusCode === 409)
})

// A live row: captured by a live run, closed through the close RPC, never tied to the latest sample.
function liveFixture({ reason = 'multiple_candidates', conflictType = 'contact_match' } = {}) {
  const f = fixture()
  Object.assign(f.row, { review_kind: 'live', run_id: 'live-run', reason, conflict_type: conflictType })
  const store = liveCloseStore({ review: f.row })
  Object.assign(f.deps.repository, store.methods, { getReview: async () => f.row })
  f.deps.dispatchResume = store.dispatchResume
  f.store = store
  return f
}
const linkLive = { ...input, decision: { action: 'link_existing', candidateId: '20' } }
const skipLive = { ...input, decision: { action: 'skip_live' } }

test('live link completion closes every linked conflict and enqueues one resume each', async () => {
  const f = liveFixture()
  const result = await executeReviewResolution(f.deps, linkLive)
  assert.equal(result.resolution.status, 'completed')
  assert.equal(result.resolution.provider_outcome_code, 'linked')
  assert.deepEqual(f.mappings.contacts.map(row => row.albi_contact_id), ['20'])
  assert.deepEqual(f.store.state.closeCalls.map(call => [call.outcome, call.resolutionAction]), [['resolved', 'link_existing']])
  assert.deepEqual(f.store.state.conflicts.map(conflict => [conflict.status, conflict.resolution_action]),
    [['resolved', 'link_existing'], ['resolved', 'link_existing']])
  assert.equal(f.store.state.resumes.length, 2)
  assert.deepEqual(f.store.state.dispatched, ['resume-1', 'resume-2'])
  assert.equal(f.row.status, 'cleared')
  assert.deepEqual({ dispatched: result.close.dispatched, pending: result.close.pending }, { dispatched: 2, pending: 0 })
})

test('live create completion closes as resolved with create_new', async () => {
  const f = liveFixture(), createInput = asCreate(f)
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'completed')
  assert.deepEqual(f.store.state.closeCalls.map(call => [call.outcome, call.resolutionAction]), [['resolved', 'create_new']])
  assert.equal(f.store.state.resumes.length, 2)
})

test('replaying a completed live link does not close twice or insert a second resume', async () => {
  const f = liveFixture()
  await executeReviewResolution(f.deps, linkLive)
  const replay = await executeReviewResolution(f.deps, linkLive)
  assert.equal(replay.resolution.status, 'completed')
  assert.equal(f.store.state.resumes.length, 2)
  assert.equal(f.store.state.dispatched.length, 2)
  assert.equal(f.calls.filter(call => call === 'mapping').length, 1)
})

test('a failed close after live completion keeps the resolution and is retried on the next attempt', async () => {
  const f = liveFixture(); f.store.state.failClose = 1
  const result = await executeReviewResolution(f.deps, linkLive)
  assert.equal(result.resolution.status, 'completed')
  assert.equal(result.close.error, 'close_failed')
  assert.equal(f.row.status, 'needs_review')
  assert.equal(f.store.state.resumes.length, 0)
  // The completed resolution on a still-open live row is the durable marker; a recheck finishes the close.
  const rechecked = await recheckDryRunReview(f.deps, input)
  assert.equal(rechecked.review.status, 'cleared')
  assert.deepEqual(f.store.state.closeCalls.map(call => call.outcome), ['resolved', 'resolved'])
  assert.equal(f.store.state.resumes.length, 2)
  assert.equal(f.calls.filter(call => call === 'mapping').length, 1)
})

test('a failed close after live completion leaves the row visible in Decision, not hidden in Done', async () => {
  const f = liveFixture(); f.store.state.failClose = 1
  const triage = []
  f.deps.triageRepository = { setReviewTriage: async (_company, reviewId, next) => { triage.push([reviewId, next]) } }
  const result = await executeReviewResolution(f.deps, linkLive)
  assert.equal(result.close.error, 'close_failed')
  assert.deepEqual(triage.at(-1)[1], { bucket: 'decision', details: { closePending: true } })
})

test('a failed close is also retried by replaying the same request', async () => {
  const f = liveFixture(); f.store.state.failClose = 1
  await executeReviewResolution(f.deps, linkLive)
  const replay = await executeReviewResolution(f.deps, linkLive)
  assert.equal(replay.resolution.status, 'completed')
  assert.equal(f.row.status, 'cleared')
  assert.equal(f.store.state.resumes.length, 2)
})

test('skip_live is rejected on sample rows', async () => {
  const f = fixture()
  await assert.rejects(executeReviewResolution(f.deps, skipLive), error => error.statusCode === 400)
  assert.equal(f.intent, null)
  assert.deepEqual(f.calls, [])
})

test('skip_live closes conflicts as skipped and writes the skipped ledger', async () => {
  const f = liveFixture()
  f.deps.getResolutionClients = () => { throw Error('provider clients are not needed to skip') }
  const result = await executeReviewResolution(f.deps, skipLive)
  assert.equal(result.resolution.status, 'completed')
  assert.equal(result.resolution.action, 'skip_live')
  assert.equal(result.resolution.provider_outcome_code, 'skipped')
  assert.deepEqual(f.store.state.closeCalls.map(call => [call.outcome, call.resolutionAction]), [['skipped', 'skip']])
  assert.deepEqual(f.store.state.conflicts.map(conflict => conflict.status), ['skipped', 'skipped'])
  assert.deepEqual(f.store.state.conflictEvents.map(event => [event.event_type, event.resolution_action]), [['skipped', 'skip'], ['skipped', 'skip']])
  assert.equal(f.store.state.resumes.length, 0)
  assert.equal(f.row.status, 'no_longer_in_scope')
  // Audited as a resolution event; no provider read or write.
  assert.deepEqual(f.events.at(-1), { actorId, status: 'completed', eventType: 'completed', providerOutcomeCode: 'skipped',
    details: { code: 'skipped', outcome: 'skipped' } })
  assert.equal(f.calls.includes('read-source'), false)
  assert.deepEqual(mutations(f), [])
})

test('sample rows still supersede when a newer sample exists', async () => {
  const f = fixture(); f.row.reason = 'multiple_candidates'; f.row.conflict_type = 'contact_match'
  const original = f.deps.repository.getMappings
  f.deps.repository.getMappings = async () => { f.latest = 'new-sample'; return original() }
  const result = await executeReviewResolution(f.deps, linkLive)
  assert.equal(result.resolution.status, 'superseded')
  assert.deepEqual(f.mappings.contacts, [])
})

test('live rows are not superseded by a newer sample', async () => {
  const f = liveFixture(); f.latest = 'new-sample'
  const result = await executeReviewResolution(f.deps, linkLive)
  assert.equal(result.resolution.status, 'completed')
  assert.deepEqual(f.mappings.contacts.map(row => row.albi_contact_id), ['20'])
})

test('a live row closed by another path before the write is superseded, not linked', async () => {
  const f = liveFixture()
  const original = f.deps.repository.getMappings
  f.deps.repository.getMappings = async () => { f.row.status = 'no_longer_in_scope'; return original() }
  const result = await executeReviewResolution(f.deps, linkLive)
  assert.equal(result.resolution.status, 'superseded')
  assert.deepEqual(f.mappings.contacts, [])
  assert.deepEqual(f.store.state.closeCalls, [])
})

// Org-first: two separately audited resolutions driven by one reviewer choice.
const orgFirstIds = { contact: '00000000-0000-4000-8000-0000000000c1', organization: '00000000-0000-4000-8000-0000000000a1' }
function orgFirstFixture({ kind = 'live', orgCandidates = [], orgReady = true, fail = null } = {}) {
  const calls = [], mappings = { contacts: [], organizations: [], options: [] }, resolutions = new Map()
  const rows = {
    [orgFirstIds.contact]: { id: orgFirstIds.contact, review_kind: kind, object_type: 'contacts', source_id: '42', portal_id: '123',
      status: 'needs_review', updated_at: stamp, candidate_snapshots: [], source_snapshot: {} },
    [orgFirstIds.organization]: { id: orgFirstIds.organization, review_kind: kind, object_type: 'companies', source_id: '900', portal_id: '123',
      status: 'needs_review', updated_at: stamp, candidate_snapshots: orgCandidates, source_snapshot: {} },
  }
  const f = { calls, mappings, resolutions, rows }
  f.deps = {
    repository: {
      getConfig: async () => ({ portal_id: '123' }),
      getReview: async (_company, id) => rows[id] ?? null,
      getMappings: async () => mappings,
      getCurrentReviewResolution: async (_company, reviewId) => resolutions.get(reviewId) ?? null,
    },
    getResolutionClients: async () => ({}),
    loadResolutionOptions: async ({ row }) => row.object_type === 'contacts'
      ? { createReadiness: mappings.organizations.length ? { ready: true }
        : { ready: false, blockedReason: 'organization_not_synced', organization: { sourceId: '900', reviewId: orgFirstIds.organization } } }
      : { createReadiness: { ready: orgReady, ...(orgReady ? { referralSources: [{ id: '5', label: 'Network' }] } : {}) } },
    executeResolution: async (_deps, args) => {
      const replay = [...resolutions.values()].find(item => item.client_request_id === args.clientRequestId)
      if (replay) return { resolution: replay }
      calls.push(['create', args.reviewId, args.clientRequestId, args.decision])
      if (fail && args.reviewId === orgFirstIds.organization) throw fail
      if (args.reviewId === orgFirstIds.contact) assert.equal(mappings.organizations.length, 1, 'organization must already be mapped')
      if (args.reviewId === orgFirstIds.organization) mappings.organizations.push({ portal_id: '123', hubspot_id: '900', albi_organization_id: '777' })
      const resolution = { id: `res-${args.reviewId}`, status: kind === 'live' ? 'completed' : 'ready_to_recheck',
        client_request_id: args.clientRequestId, review_id: args.reviewId }
      resolutions.set(args.reviewId, resolution)
      return { resolution }
    },
  }
  f.input = { companyId: 'tenant', actorId, contactReviewId: orgFirstIds.contact, contactExpectedUpdatedAt: stamp,
    organizationReviewId: orgFirstIds.organization, organizationExpectedUpdatedAt: stamp, referralSourceId: '5',
    clientRequestId: '00000000-0000-4000-8000-0000000000d1' }
  return f
}

test('creates organization then contact against the new organization id', async () => {
  for (const kind of ['live', 'sample']) {
    const f = orgFirstFixture({ kind })
    const result = await executeOrganizationThenContactCreate(f.deps, f.input)
    assert.deepEqual(f.calls.map(call => [call[1], call[3]]), [
      [orgFirstIds.organization, { action: 'create_albi', referralSourceId: '5' }],
      [orgFirstIds.contact, { action: 'create_albi', referralSourceId: '5' }]])
    assert.notEqual(f.calls[0][2], f.calls[1][2])
    assert.match(f.calls[0][2], /^[0-9a-f-]{36}$/)
    assert.equal(result.organization.resolution.review_id, orgFirstIds.organization)
    assert.equal(result.contact.resolution.review_id, orgFirstIds.contact)
  }
})

test('organization failure never attempts the contact', async () => {
  const f = orgFirstFixture({ fail: new H2AReviewErrorForTest(409) })
  const result = await executeOrganizationThenContactCreate(f.deps, f.input)
  assert.equal(result.contact, null)
  assert.equal(result.organization.error.statusCode, 409)
  assert.deepEqual(f.calls.map(call => call[1]), [orgFirstIds.organization])
  // A step that ends failed (no thrown error) also stops before the contact.
  const g = orgFirstFixture(), run = g.deps.executeResolution
  g.deps.executeResolution = async (deps, args) => {
    const result = await run(deps, args)
    if (args.reviewId === orgFirstIds.organization) { g.mappings.organizations.length = 0; result.resolution.status = 'failed' }
    return result
  }
  const failed = await executeOrganizationThenContactCreate(g.deps, g.input)
  assert.equal(failed.contact, null); assert.equal(failed.organization.resolution.status, 'failed')
  assert.deepEqual(g.calls.map(call => call[1]), [orgFirstIds.organization])
})

test('replay with the same clientRequestId creates nothing twice', async () => {
  const f = orgFirstFixture()
  await executeOrganizationThenContactCreate(f.deps, f.input)
  const replay = await executeOrganizationThenContactCreate(f.deps, f.input)
  assert.equal(f.calls.length, 2)
  assert.equal(replay.organization.resolution.review_id, orgFirstIds.organization)
  assert.equal(replay.contact.resolution.review_id, orgFirstIds.contact)
})

test('ineligible when the organization has candidates', async () => {
  for (const f of [orgFirstFixture({ orgCandidates: [{ id: '1' }] }), orgFirstFixture({ orgReady: false }),
    orgFirstFixture({ kind: 'live' })]) {
    if (f.rows[orgFirstIds.organization].review_kind === 'live' && !f.rows[orgFirstIds.organization].candidate_snapshots.length &&
      f.deps.loadResolutionOptions) f.rows[orgFirstIds.contact].review_kind = 'sample' // mixed kinds
    await assert.rejects(executeOrganizationThenContactCreate(f.deps, f.input), error => error.statusCode === 409)
    assert.equal(f.calls.length, 0)
  }
  const unblocked = orgFirstFixture(); unblocked.mappings.organizations.push({ portal_id: '123', hubspot_id: '900', albi_organization_id: '1' })
  await assert.rejects(executeOrganizationThenContactCreate(unblocked.deps, unblocked.input), error => error.statusCode === 409)
  assert.equal(unblocked.calls.length, 0)
})

test('stale contact version makes zero create calls', async () => {
  const f = orgFirstFixture(); f.input.contactExpectedUpdatedAt = '2026-10-13T11:00:00Z'
  await assert.rejects(executeOrganizationThenContactCreate(f.deps, f.input), error => error.statusCode === 409)
  assert.equal(f.calls.length, 0)
})

test('stale organization version makes zero create calls', async () => {
  const f = orgFirstFixture(); f.input.organizationExpectedUpdatedAt = '2026-10-13T11:00:00Z'
  await assert.rejects(executeOrganizationThenContactCreate(f.deps, f.input), error => error.statusCode === 409)
  assert.equal(f.calls.length, 0)
})

test('a contact failure after the organization succeeded returns both results', async () => {
  const f = orgFirstFixture(), run = f.deps.executeResolution
  f.deps.executeResolution = async (deps, args) => {
    if (args.reviewId === orgFirstIds.contact) throw new H2AReviewErrorForTest(409)
    return run(deps, args)
  }
  const result = await executeOrganizationThenContactCreate(f.deps, f.input)
  assert.equal(result.organization.resolution.review_id, orgFirstIds.organization)
  assert.equal(result.contact.error.statusCode, 409)
})

test('the real engine creates the organization, then the contact against its new Albi id', async () => {
  const f = fixture(), g = fixture(), orgReviewId = '00000000-0000-4000-8000-000000000005'
  asCreate(f)
  f.createdTarget.organizationId = '60'
  f.associations = ['42']
  g.mappings.organizations = f.mappings.organizations
  Object.assign(g.row, { id: orgReviewId, object_type: 'companies', reason: 'no_match', conflict_type: 'organization_match',
    source_snapshot: { id: '42', name: 'Acme' }, candidate_snapshots: [], proposed_changes: { conflicts: {}, updates: {} } })
  g.source.properties = { name: 'Acme' }
  g.deps.hubspotRead.getCompanies = async () => [structuredClone(g.source)]
  g.mappings.options = [{ mapping_kind: 'default_organization_type', source_key: 'default', albi_id: '12', confirmed: true }]
  f.mappings.options.push(...g.mappings.options)
  g.deps.albiRead.listOrganizations = async () => ({ records: structuredClone(g.organizations), cursor: null })
  g.deps.albiWrite.createOrganization = async payload => { g.calls.push(['CREATE-ORG', structuredClone(payload)])
    const created = { id: '60', name: 'Acme', organizationTypeIds: ['12'] }
    g.organizations.push(created); f.organizations.push(created); return { id: '60' } }
  const rows = { [f.row.id]: f.row, [orgReviewId]: g.row }
  const deps = { repository: { getConfig: f.deps.repository.getConfig, getReview: async (_c, id) => rows[id] ?? null,
    getMappings: f.deps.repository.getMappings,
    getCurrentReviewResolution: async (_c, id) => (id === orgReviewId ? g : f).intent },
  loadResolutionOptions: async ({ row }) => row.object_type === 'contacts'
    ? { createReadiness: { ready: false, blockedReason: 'organization_not_synced', organization: { sourceId: '42', reviewId: orgReviewId } } }
    : { createReadiness: { ready: true } },
  executeResolution: (_deps, args) => executeReviewResolution(args.reviewId === orgReviewId ? g.deps : f.deps, args) }
  const result = await executeOrganizationThenContactCreate(deps, { companyId: 'tenant', actorId, contactReviewId: f.row.id,
    contactExpectedUpdatedAt: stamp, organizationReviewId: orgReviewId, organizationExpectedUpdatedAt: stamp, referralSourceId: '5',
    clientRequestId: '00000000-0000-4000-8000-0000000000d2' })
  assert.equal(result.organization.resolution.status, 'ready_to_recheck')
  assert.equal(result.contact.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.organizations[0].albi_organization_id, '60')
  assert.equal(mutations(g).length, 1)
  assert.equal(mutations(f).length, 1)
  assert.equal(mutations(f)[0][1].organizationId, '60')
})

// A live row has no sample: its freshness rejections use kind-neutral copy, with the audit unchanged.
const LIVE_STALE = 'This record changed. Refresh and confirm the resolution again.'
test('a stale live decision says the record changed, not the sample review', async () => {
  const f = liveFixture()
  await assert.rejects(executeReviewResolution(f.deps, { ...linkLive, expectedUpdatedAt: '2026-10-12T12:00:00Z' }),
    error => error.statusCode === 409 && error.message === LIVE_STALE)
  const changed = liveFixture({ reason: 'nonblank_field_difference', conflictType: 'contact_fields' })
  changed.source.properties.phone = '5559990000'
  await assert.rejects(executeReviewResolution(changed.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot' } } }),
    error => error.statusCode === 409 && error.message === LIVE_STALE && error.staleCheck === 'source')
  const sample = fixture()
  await assert.rejects(executeReviewResolution(sample.deps, { ...input, expectedUpdatedAt: '2026-10-12T12:00:00Z' }),
    error => error.statusCode === 409 && !error.message.includes('This record changed'))
})

test('creating a contact uses the organization mapping instead of scanning Albi organizations', async () => {
  const f = fixture(), createInput = asCreate(f)
  f.associations = ['77']
  f.mappings.organizations.push({ portal_id: '123', hubspot_id: '77', albi_organization_id: '88' })
  f.createdTarget = { ...f.createdTarget, organizationId: '88' }
  f.deps.albiRead.listOrganizations = async () => { throw Error('must not scan Albi organizations') }
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(mutations(f)[0][1].organizationId, '88')
})

test('creating a contact behind a company HubSpot merged from a mapped record uses that record’s Albi organization', async () => {
  const f = fixture(), createInput = asCreate(f)
  f.associations = ['900']
  f.mappings.organizations.push({ portal_id: '123', hubspot_id: '77', albi_organization_id: '88' })
  f.deps.hubspotRead.getCompanies = async ids => [{ id: ids[0], properties: { name: 'Acme', hs_merged_object_ids: '77' } }]
  f.createdTarget = { ...f.createdTarget, organizationId: '88' }
  f.deps.albiRead.listOrganizations = async () => { throw Error('must not scan Albi organizations') }
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(mutations(f)[0][1].organizationId, '88')
  assert.deepEqual(f.mappings.organizations.map(row => row.hubspot_id), ['77'], 'no mapping is written for the merged company')
})

test('a create given a shared Albi read uses it, verifies against the receipt, and adds the new record to that read', async () => {
  const f = fixture(), createInput = asCreate(f)
  f.deps.albiRead.listContacts = async () => { throw Error('must use the shared Albi read') }
  const snapshot = { contacts: [], organizations: [] }
  f.deps.albiSnapshot = snapshot
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.equal(f.mappings.contacts[0].albi_contact_id, '30')
  assert.deepEqual(snapshot.contacts.map(record => record.id), ['30'])
  assert.equal(snapshot.contacts[0].email, 'hs@example.com')
})

test('a link still saves when the Albi record was edited after review, since a link writes no fields', async () => {
  const f = fixture(); f.row.reason = 'multiple_candidates'; f.row.conflict_type = 'contact_match'
  Object.assign(f.contacts[0], { phoneNumber: '5559990000', address1: '9 New Street' })
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'link_existing', candidateId: '20' } })
  assert.notEqual(result.resolution.status, 'failed')
  assert.ok(f.calls.includes('mapping'))
})

test('an email-matched link that ignored differences fails if the Albi email no longer matches', async () => {
  const f = fixture(); f.row.reason = 'multiple_candidates'; f.row.conflict_type = 'contact_match'
  f.target.email = 'hs@example.com'; f.row.candidate_snapshots[0].email = 'hs@example.com'; f.contacts[0].email = 'other@example.com'
  const result = await executeReviewResolution(f.deps, { ...input,
    decision: { action: 'link_existing', candidateId: '20', ignoreContactDifferences: true } })
  assert.equal(result.resolution.status, 'failed')
  assert.equal(f.calls.includes('mapping'), false)
})

test('a field resolution is still stale when any reviewed Albi field changed after review', async () => {
  const f = fixture()
  f.contacts[0].phoneNumber = '5559990000'
  await assert.rejects(executeReviewResolution(f.deps, input), error => error.statusCode === 409)
  assert.equal(f.events.at(-1).details.staleCheck, 'target')
  assert.deepEqual(mutations(f), [])
})

test('an unexpected failure records what was thrown and where, so it can be diagnosed', async () => {
  const f = fixture(), createInput = asCreate(f)
  f.beforeMapping = () => { null.albi_contact_id }
  const result = await executeReviewResolution(f.deps, createInput)
  assert.equal(result.resolution.status, 'failed')
  const failed = f.events.filter(event => event.eventType === 'failed').at(-1)
  assert.equal(failed.details.category, 'error')
  assert.equal(failed.details.exception.kind, 'TypeError')
  assert.match(failed.details.exception.message, /reading 'albi_contact_id'/)
  assert.match(failed.details.exception.at, /beforeMapping/)
})
