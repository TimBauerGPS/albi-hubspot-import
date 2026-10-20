import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { normalizeResolutionDecision, hashResolutionDecision, projectReviewResolution,
  projectReviewResolutionEvent, safeResolutionEventDetails } from '../../netlify/functions/_h2a/reviewResolution.js'
import * as resolution from '../../netlify/functions/_h2a/reviewResolution.js'

const ID = '00000000-0000-4000-8000-000000000003'
const TIME = '2026-10-13T12:00:00.123456Z'

const contactReview = { objectType: 'contacts', sourceId: '42', reason: 'nonblank_field_difference',
  candidateSnapshots: [{ id: '2590478' }], proposedChanges: { updates: {}, conflicts: {
    email: { current: 'old', proposed: 'old' }, phoneNumber: { current: 'old', proposed: 'old' },
  }, unchanged: [] } }
const fieldsInput = () => ({ review: structuredClone(contactReview),
  hubspot: { id: '42', properties: { email: 'hs@example.com', phone: '111' } },
  albi: { id: '2590478', email: 'albi@example.com', phoneNumber: '222' },
  decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } } })
const plan = input => {
  assert.equal(typeof resolution.buildReviewResolutionPlan, 'function', 'record-level planner is exported')
  return resolution.buildReviewResolutionPlan(input)
}

test('planner partitions mixed fields from current records and preserves the waiting state after HubSpot succeeds', () => {
  const input = fieldsInput(), before = structuredClone(input)
  const result = plan(input)
  assert.deepEqual(result.providerOperation, { provider: 'hubspot', operation: 'updateContact', id: '42',
    properties: { email: 'albi@example.com' } })
  assert.deepEqual(result.manualTasks, [{ provider: 'albi', objectType: 'contacts', targetId: '2590478',
    url: 'https://app.albiware.com/Relationships/Contact/2590478', fields: [{ field: 'phoneNumber', value: '111' }] }])
  assert.equal(result.verification.successStatus, 'waiting_on_albi')
  assert.deepEqual(result.verification.properties, { email: 'albi@example.com' })
  assert.equal(result.decisionHash, '949cec54ac94767f4aeb692bb844c25d7f8d7e656772c5f0785cfb965357deb7')
  assert.equal(result.mapping, null); assert.equal(result.organizationChoice, null)
  assert.deepEqual(input, before)
})

test('whole-record equivalent choices produce one patch or one grouped manual task', () => {
  const input = fieldsInput()
  input.decision.fieldChoices = { email: 'albi', phoneNumber: 'albi' }
  const automatic = plan(input)
  assert.deepEqual(automatic.providerOperation.properties, { email: 'albi@example.com', phone: '222' })
  assert.deepEqual(automatic.manualTasks, [])
  assert.equal(automatic.verification.successStatus, 'ready_to_recheck')
  input.decision.fieldChoices = { email: 'hubspot', phoneNumber: 'hubspot' }
  const manual = plan(input)
  assert.equal(manual.providerOperation, null)
  assert.deepEqual(manual.manualTasks[0].fields, [{ field: 'email', value: 'hs@example.com' }, { field: 'phoneNumber', value: '111' }])
})

test('explicit chosen blank clears HubSpot while unchosen blanks and equal values are omitted', () => {
  const input = fieldsInput()
  input.albi.email = ''; input.albi.phoneNumber = '111'
  assert.deepEqual(plan(input).providerOperation.properties, { email: '' })
  input.albi.email = null
  assert.deepEqual(plan(input).providerOperation.properties, { email: '' })
  input.decision.fieldChoices = { phoneNumber: 'albi' }
  assert.equal(plan(input).providerOperation, null)
  input.decision.fieldChoices = { email: 'hubspot' }; input.hubspot.properties.email = ''
  assert.deepEqual(plan(input).manualTasks, [])
  input.hubspot.properties.email = null; input.albi.email = 'keep'
  assert.deepEqual(plan(input).manualTasks[0].fields, [{ field: 'email', value: '' }])
})

test('company aliases generate one company patch and a fixed organization link', () => {
  const input = { review: { objectType: 'companies', sourceId: '43', reason: 'organization_fields_require_review',
    candidateSnapshots: [{ id: '635650' }], proposedChanges: { conflicts: { name: {}, zipcode: {}, address2: {} } } },
  hubspot: { id: '43', properties: { name: 'HS', zip: '90001', address2: 'Suite 1' } },
  albi: { id: '635650', name: 'Albi', zipCode: '90002', addressLine2: 'Suite 2' },
  decision: { action: 'resolve_fields', fieldChoices: { name: 'albi', zipcode: 'albi', address2: 'hubspot' } } }
  const result = plan(input)
  assert.deepEqual(result.providerOperation, { provider: 'hubspot', operation: 'updateCompany', id: '43',
    properties: { name: 'Albi', zip: '90002' } })
  assert.equal(result.manualTasks[0].url, 'https://app.albiware.com/Relationships/Organization/635650')
  assert.deepEqual(result.manualTasks[0].fields, [{ field: 'address2', value: 'Suite 1' }])
})

test('planner rejects injected values, immutable fields, inapplicable fields, and choices outside current review evidence', () => {
  const cases = [
    input => { input.decision.values = { email: 'injected' } },
    input => { input.decision.url = 'https://evil.test' },
    input => { input.values = { email: 'injected' } },
    input => { input.decision.fieldChoices = { id: 'albi' } },
    input => { input.decision.fieldChoices = { organizationId: 'hubspot' } },
    input => { input.decision.fieldChoices = { name: 'albi' }; input.review.proposedChanges.conflicts.name = {} },
    input => { input.review.objectType = 'companies' },
    input => { delete input.review.proposedChanges.conflicts.email },
    input => { input.review.reason = 'contact_type_confirmation_required' },
    input => { input.review.objectType = '__proto__' },
    input => { input.hubspot.id = '43' }, input => { input.albi.id = '0' },
    input => { input.albi.objectType = 'companies' },
    input => { input.hubspot.object_type = 'companies' },
    input => { input.review.portalId = '123'; input.portalId = '456' },
    input => { input.albi.id = '2590479' },
    input => { input.review.candidateSnapshots = [{ id: '2590479' }] },
    input => { delete input.albi.email }, input => { input.albi.email = { value: 'injected' } },
    input => { input.albi.email = 'x'.repeat(501) },
    input => { input.hubspot.properties.phone = false },
    input => { Object.defineProperty(input.albi, 'email', { get() { throw new Error('Do not read accessor') } }) },
  ]
  for (const change of cases) { const input = fieldsInput(); change(input); assert.throws(() => plan(input), TypeError) }
})

test('link plans use the current reviewed candidate and require explicit many-to-one approval', () => {
  const input = fieldsInput()
  input.review.reason = 'multiple_candidates'; input.review.portalId = '123'
  input.decision = { action: 'link_existing', candidateId: '2590478' }
  const linked = plan(input)
  assert.equal(linked.providerOperation, null)
  assert.deepEqual(linked.mapping, { objectType: 'contacts', sourceId: '42', targetId: '2590478', approveManyToOne: false })
  input.mappings = [{ portal_id: '123', hubspot_id: '99', albi_contact_id: '2590478' }]
  assert.throws(() => plan(input), TypeError)
  input.decision.approveManyToOne = true
  assert.equal(plan(input).mapping.approveManyToOne, true)
  input.mappings.push({ portal_id: '123', hubspot_id: '42', albi_contact_id: '888' })
  assert.throws(() => plan(input), TypeError)
  input.mappings = []; input.decision.candidateId = '777'
  assert.throws(() => plan(input), TypeError)
  input.decision.candidateId = '2590478'; input.review.candidateSnapshots = []
  assert.throws(() => plan(input), TypeError)
})

test('link planner treats equal numeric IDs in different portals as different source owners', () => {
  const input = fieldsInput(); input.review.reason = 'multiple_candidates'; input.portalId = '123'
  input.decision = { action: 'link_existing', candidateId: '2590478' }
  input.mappings = [{ portal_id: '456', hubspot_id: '42', albi_contact_id: '2590478' }]
  assert.throws(() => plan(input), TypeError)
  input.decision.approveManyToOne = true
  assert.equal(plan(input).mapping.approveManyToOne, true)
})

const createInput = objectType => ({ review: { objectType, sourceId: '42', reason: 'no_match', candidateSnapshots: [] },
  hubspot: { id: '42', properties: objectType === 'contacts' ? { firstname: 'A', lastname: 'B', email: 'a@example.com', phone: '5551112222' }
    : { name: 'Company', phone: '5551112222' } }, decision: { action: 'create_albi', referralSourceId: '5' }, createDefaults: { ok: true, typeId: '12', statusId: '2', salespersonId: '70' },
  optionMappings: [{ mapping_kind: objectType === 'contacts' ? 'default_contact_type' : 'default_organization_type',
    source_key: 'default', albi_id: '12', confirmed: true }] })

test('durable internal execution context preserves exact allowlisted proof and stays out of public events', () => {
  const original = plan(createInput('contacts'))
  assert.equal(typeof resolution.safeResolutionExecutionContext, 'function')
  assert.deepEqual(resolution.safeResolutionExecutionContext(original), original)
  const legacy = structuredClone(original); delete legacy.ignoredCandidateIds
  assert.deepEqual(resolution.safeResolutionExecutionContext(legacy), original)
  const details = resolution.safeResolutionInternalEventDetails({ executionContext: original, token: 'secret' })
  assert.deepEqual(details, { executionContext: original })
  assert.deepEqual(projectReviewResolutionEvent({ event_type: 'claimed', sanitized_details: details }).details, {})
  for (const change of [
    value => { value.providerOperation.payload.apiKey = 'secret' },
    value => { value.providerOperation.payload.firstName = 'x'.repeat(501) },
    value => { value.verification.create.typeId = '99' },
    value => { value.verification.create.payload.organizationId = '999' },
    value => { value.providerOperation.operation = 'updateContact' },
    value => { value.rawResponse = 'secret' },
  ]) { const value = structuredClone(original); change(value); assert.equal(resolution.safeResolutionExecutionContext(value), null) }
})

test('create plans rebuild supported payloads from current HubSpot and confirmed type mappings', () => {
  const contact = plan(createInput('contacts'))
  assert.deepEqual(contact.providerOperation, { provider: 'albi', operation: 'createContact', payload: {
    firstName: 'A', lastName: 'B', email: 'a@example.com', phoneNumber: '555-111-2222', contactTypeIds: ['12'], referralSourceId: '5', relationshipStatusId: '2', salespersonId: '70',
  } })
  assert.deepEqual(contact.mapping, { objectType: 'contacts', sourceId: '42', targetId: null, approveManyToOne: false })
  assert.deepEqual(contact.verification.create, { objectType: 'contacts', sourceId: '42', portalId: null,
    typeId: '12', organizationId: null, payload: { firstName: 'A', lastName: 'B', email: 'a@example.com',
      phoneNumber: '555-111-2222', contactTypeIds: ['12'], referralSourceId: '5', relationshipStatusId: '2', salespersonId: '70' } })
  assert.deepEqual(plan(createInput('companies')).providerOperation, { provider: 'albi', operation: 'createOrganization',
    payload: { name: 'Company', phoneNumber: '555-111-2222', organizationTypeIds: ['12'], referralSourceId: '5', relationshipStatusId: '2', salespersonId: '70' } })
  const input = createInput('contacts'); input.hubspot.properties.mobilephone = '111'; input.hubspot.properties.zip = '90001'
  const result = plan(input)
  assert.equal(result.providerOperation.payload.mobileNumber, undefined)
  assert.equal(result.providerOperation.payload.zipCode, undefined)
})

test('create plans canonicalize surrounding HubSpot whitespace before comparing captured evidence', () => {
  const input = createInput('contacts')
  input.hubspot.properties = {
    firstname: ' John ', lastname: ' Robinson ', email: ' john@example.com ', phone: ' 9496626181 ',
    jobtitle: ' Director of engineering ', address: ' 1 Main St ', city: ' Newport Beach ',
  }

  assert.deepEqual(plan(input).providerOperation.payload, {
    firstName: 'John', lastName: 'Robinson', email: 'john@example.com', phoneNumber: '949-662-6181',
    contactTypeIds: ['12'], referralSourceId: '5', relationshipStatusId: '2', salespersonId: '70',
  })
})

test('create plans use the production-proven minimal Albi contact contract', () => {
  const input = createInput('contacts')
  Object.assign(input.hubspot.properties, {
    jobtitle: 'Director of engineering', address: '1 Main St', address2: 'Suite 2', city: 'Newport Beach',
    state: 'CA', zip: '92663', country: 'US',
  })

  assert.deepEqual(plan(input).providerOperation.payload, {
    firstName: 'A', lastName: 'B', email: 'a@example.com', phoneNumber: '555-111-2222', contactTypeIds: ['12'], referralSourceId: '5', relationshipStatusId: '2', salespersonId: '70',
  })
})

test('forced create records the exact ignored candidates and still builds a create plan', () => {
  const input = createInput('contacts')
  input.review.reason = 'name_only_candidate'
  input.review.candidateSnapshots = [{ id: '20', firstName: 'A', lastName: 'B' }, { id: '21', firstName: 'A', lastName: 'Bee' }]
  input.decision = { action: 'force_create_albi', ignoredCandidateIds: ['21', '20'], referralSourceId: '5' }
  const result = plan(input)
  assert.equal(result.action, 'force_create_albi')
  assert.equal(result.providerOperation.operation, 'createContact')
  assert.deepEqual(result.ignoredCandidateIds, ['20', '21'])
  assert.deepEqual(result.mapping, { objectType: 'contacts', sourceId: '42', targetId: null, approveManyToOne: false })
  input.mappings = [{ portal_id: '123', hubspot_id: '42', albi_contact_id: '20' }]
  assert.throws(() => plan(input), TypeError)
})

test('a contact create needs its associated organization mapped; deferral is no longer a decision', () => {
  const input = createInput('contacts')
  input.review.reason = 'name_only_candidate'
  input.review.candidateSnapshots = [{ id: '20', firstName: 'A', lastName: 'B' }]
  input.associatedCompanyIds = ['99']
  input.decision = { action: 'force_create_albi', ignoredCandidateIds: ['20'], referralSourceId: '5' }
  assert.throws(() => plan(input), TypeError)
  input.organizations = [{ source: { id: '99' }, targetId: '635650', organizationTypeId: null }]
  assert.equal(plan(input).providerOperation.payload.organizationId, '635650')
  assert.throws(() => normalizeResolutionDecision({ ...input.decision, deferOrganizationAssociation: true }), TypeError)
})

test('create prerequisites reject missing names, options, unresolved context and unsafe phone formats', () => {
  for (const change of [
    input => { input.hubspot.properties.lastname = '' }, input => { input.optionMappings[0].confirmed = false },
    input => { input.optionMappings.push({ ...input.optionMappings[0] }) }, input => { input.optionMappings[0].albi_id = '0' },
    input => { input.hubspot.properties.phone = '5551112222 x123' },
    input => { input.associatedCompanyIds = ['99'] },
    input => { input.mappings = [{ hubspot_id: '42', albi_contact_id: '7' }] },
  ]) { const input = createInput('contacts'); change(input); assert.throws(() => plan(input), TypeError) }
  const company = createInput('companies'); company.hubspot.properties.name = null
  assert.throws(() => plan(company), TypeError)
})

const organizationInput = () => ({ ...fieldsInput(), review: { ...structuredClone(contactReview), reason: 'multiple_associated_organizations' },
  decision: { action: 'choose_organization', organizationSourceId: '99' }, associatedCompanyIds: ['98', '99'],
  organizations: [{ source: { id: '99', properties: { name: 'Organization' } }, targetId: '635650', organizationTypeId: '12' }],
  albi: { id: '2590478', organizationId: '635650' } })

test('already-associated organization choice saves context without a provider operation or association removal', () => {
  const result = plan(organizationInput())
  assert.equal(result.providerOperation, null)
  assert.deepEqual(result.organizationChoice, { contactId: '42', organizationSourceId: '99' })
  assert.deepEqual(result.manualTasks, [])
})

test('organization choice permits one explicit association addition and linked manual Albi reassociation', () => {
  const input = organizationInput(); input.associatedCompanyIds = ['98']; input.albi.organizationId = '100'
  assert.throws(() => plan(input), TypeError)
  input.decision.addHubSpotAssociation = true
  const result = plan(input)
  assert.deepEqual(result.providerOperation, { provider: 'hubspot', operation: 'addContactCompanyAssociation', contactId: '42', companyId: '99' })
  assert.deepEqual(result.manualTasks, [{ provider: 'albi', objectType: 'contacts', targetId: '2590478',
    url: 'https://app.albiware.com/Relationships/Contact/2590478',
    organizationUrl: 'https://app.albiware.com/Relationships/Organization/635650', fields: [{ field: 'organizationId', value: '635650' }] }])
  assert.deepEqual(result.verification.association, { contactId: '42', companyId: '99' })
  assert.equal(result.verification.successStatus, 'waiting_on_albi')
})

test('organization choice rejects missing, archived, mismatched or unresolved current organizations', () => {
  for (const change of [input => { input.organizations = [] }, input => { input.organizations[0].source.archived = true },
    input => { input.organizations[0].source.objectType = 'contacts' }, input => { input.organizations[0].targetId = null },
    input => { input.organizations[0].targetId = 'https://evil.test' }, input => { input.review.objectType = 'companies' },
  ]) { const input = organizationInput(); change(input); assert.throws(() => plan(input), TypeError) }
})

test('organization choice rejects absent organization evidence on a current Albi contact', () => {
  for (const properties of [undefined, {}]) {
    const input = organizationInput()
    input.albi = { id: '2590478', ...(properties ? { properties } : {}) }
    input.associatedCompanyIds = ['98']; input.decision.addHubSpotAssociation = true
    assert.throws(() => plan(input), TypeError)
  }
})

test('organization choice retains deliberate reassociation tasks for explicitly blank organization evidence', () => {
  for (const alias of ['organizationId', 'organization_id']) {
    for (const value of [null, '']) {
      const input = organizationInput()
      input.albi = { id: '2590478', [alias]: value }
      const result = plan(input)
      assert.equal(result.providerOperation, null)
      assert.deepEqual(result.manualTasks, [{ provider: 'albi', objectType: 'contacts', targetId: '2590478',
        url: 'https://app.albiware.com/Relationships/Contact/2590478',
        organizationUrl: 'https://app.albiware.com/Relationships/Organization/635650',
        fields: [{ field: 'organizationId', value: '635650' }] }])
      assert.equal(result.verification.successStatus, 'waiting_on_albi')
    }
  }
})

test('association review without identity candidates can use a server-selected current Albi contact', () => {
  const input = organizationInput(); input.review.candidateSnapshots = []; input.albi.organizationId = '100'
  assert.deepEqual(plan(input).manualTasks[0].fields, [{ field: 'organizationId', value: '635650' }])
})

test('create with one resolved organization uses inherited confirmed types and retains exact reconciliation evidence', () => {
  const input = createInput('contacts')
  input.review.portalId = '123'; input.associatedCompanyIds = ['99']
  input.organizations = [{ source: { id: '99' }, targetId: '635650', organizationTypeId: '7' }]
  input.optionMappings = [{ mapping_kind: 'organization_to_contact_type', source_key: '7', albi_id: '14', confirmed: true }]
  const result = plan(input)
  assert.equal(result.providerOperation.payload.organizationId, '635650')
  assert.deepEqual(result.providerOperation.payload.contactTypeIds, ['12'])
  assert.deepEqual(result.verification.create, { objectType: 'contacts', sourceId: '42', portalId: '123', typeId: '12',
    organizationId: '635650', payload: { firstName: 'A', lastName: 'B', email: 'a@example.com', phoneNumber: '555-111-2222',
      contactTypeIds: ['12'], referralSourceId: '5', relationshipStatusId: '2', salespersonId: '70', organizationId: '635650' } })
  result.providerOperation.payload.firstName = 'changed'
  assert.equal(result.verification.create.payload.firstName, 'A')
})

test('create context rejects organization IDs that the existing numeric wrapper cannot represent', () => {
  const input = createInput('contacts'); input.associatedCompanyIds = ['99']
  input.organizations = [{ source: { id: '99' }, targetId: '9999999999999999999999' }]
  assert.throws(() => plan(input), TypeError)
})

test('contact aliases cover every approved field without allowing provider-native names as decisions', () => {
  const input = fieldsInput()
  input.hubspot.properties = { firstname: 'HS', lastname: 'HS', email: 'HS', phone: 'HS', mobilephone: 'HS', jobtitle: 'HS',
    address: 'HS', address2: 'HS', city: 'HS', state: 'HS', zip: 'HS', country: 'HS' }
  input.albi = { id: '2590478', firstname: 'A', lastname: 'B', emailAddress: 'a@example.com', phone_number: '111',
    mobilePhone: '222', title: 'Director', street_address: 'Road', addressLine2: 'Suite', city: 'City',
    stateCode: 'CA', postalCode: '90001', countryCode: 'US' }
  input.decision.fieldChoices = { firstName: 'albi', lastName: 'albi', email: 'albi', phoneNumber: 'albi', mobileNumber: 'albi',
    jobTitle: 'albi', address1: 'albi', address2: 'albi', city: 'albi', state: 'albi', zipcode: 'albi', country: 'albi' }
  input.review.proposedChanges.conflicts = Object.fromEntries(Object.keys(input.decision.fieldChoices).map(field => [field, {}]))
  assert.deepEqual(plan(input).providerOperation.properties, { firstname: 'A', lastname: 'B', email: 'a@example.com', phone: '111',
    mobilephone: '222', jobtitle: 'Director', address: 'Road', address2: 'Suite', city: 'City', state: 'CA', zip: '90001', country: 'US' })
  input.decision.fieldChoices = { firstname: 'albi' }
  assert.throws(() => plan(input), TypeError)
})

test('decisions keep exact action-specific fields and sort field choices without mutating input', () => {
  const input = { action: 'resolve_fields', fieldChoices: { phoneNumber: 'hubspot', email: 'albi' } }
  assert.deepEqual(normalizeResolutionDecision(input), {
    action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' },
  })
  assert.deepEqual(Object.keys(input.fieldChoices), ['phoneNumber', 'email'])
  assert.deepEqual(normalizeResolutionDecision({ action: 'link_existing', candidateId: '2590478', approveManyToOne: true }),
    { action: 'link_existing', candidateId: '2590478', approveManyToOne: true })
  assert.deepEqual(normalizeResolutionDecision({ action: 'link_existing', candidateId: '2590478' }),
    { action: 'link_existing', candidateId: '2590478' })
  assert.deepEqual(normalizeResolutionDecision({ action: 'create_albi' }), { action: 'create_albi' })
  assert.deepEqual(normalizeResolutionDecision({ action: 'force_create_albi', ignoredCandidateIds: ['21', '20'] }),
    { action: 'force_create_albi', ignoredCandidateIds: ['20', '21'] })
  assert.deepEqual(normalizeResolutionDecision({ action: 'choose_organization', organizationSourceId: '123', addHubSpotAssociation: false }),
    { action: 'choose_organization', organizationSourceId: '123', addHubSpotAssociation: false })
})

test('decision hash uses canonical sorted JSON and changes when semantic choices change', () => {
  const input = { fieldChoices: { phoneNumber: 'hubspot', email: 'albi' }, action: 'resolve_fields' }
  const expected = createHash('sha256').update('{"action":"resolve_fields","fieldChoices":{"email":"albi","phoneNumber":"hubspot"}}').digest('hex')
  assert.equal(hashResolutionDecision(input), expected)
  assert.equal(hashResolutionDecision({ action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } }), expected)
  assert.notEqual(hashResolutionDecision({ action: 'resolve_fields', fieldChoices: { email: 'hubspot', phoneNumber: 'hubspot' } }), expected)
  assert.equal(hashResolutionDecision({ candidateId: '12', approveManyToOne: false, action: 'link_existing' }),
    createHash('sha256').update('{"action":"link_existing","approveManyToOne":false,"candidateId":"12"}').digest('hex'))
})

test('decision schemas reject provider values, unknown fields, unsafe IDs and malformed flags', () => {
  for (const input of [null, [], 'create_albi', { action: 'delete' }, { action: 'create_albi', apiKey: 'secret' },
    { action: 'resolve_fields' }, { action: 'resolve_fields', fieldChoices: {} },
    { action: 'resolve_fields', fieldChoices: [] }, { action: 'resolve_fields', fieldChoices: { apiKey: 'hubspot' } },
    { action: 'resolve_fields', fieldChoices: { organizationId: 'albi' } },
    { action: 'resolve_fields', fieldChoices: { email: 'ALBI' } },
    { action: 'resolve_fields', fieldChoices: { email: 'albi' }, values: { email: 'injected' } },
    { action: 'link_existing' }, { action: 'link_existing', candidateId: 12 },
    { action: 'force_create_albi', ignoredCandidateIds: [] },
    { action: 'force_create_albi', ignoredCandidateIds: ['20', '20'] },
    { action: 'force_create_albi', ignoredCandidateIds: ['bad'] },
    ...['', '0', '-1', '01', ' 12', '12x', '1'.repeat(101)].map(candidateId => ({ action: 'link_existing', candidateId })),
    { action: 'link_existing', candidateId: '12', approveManyToOne: 'true' },
    { action: 'choose_organization', organizationSourceId: 'https://evil.test' },
    { action: 'choose_organization', organizationSourceId: '12', addHubSpotAssociation: 1 },
    JSON.parse('{"action":"create_albi","__proto__":{"apiKey":"secret"}}'),
  ]) assert.throws(() => normalizeResolutionDecision(input), TypeError)
})

test('normalization and hashing reject array actions before field-choice validation can be bypassed', () => {
  for (const input of [
    { action: ['resolve_fields'], fieldChoices: { apiKey: 'hubspot', email: 'arbitrary provider value' } },
    { action: ['create_albi'] },
  ]) {
    assert.throws(() => normalizeResolutionDecision(input), TypeError)
    assert.throws(() => hashResolutionDecision(input), TypeError)
  }
})

test('normalization and hashing reject object actions that coerce to valid action names', () => {
  for (const action of [new String('create_albi'), { toString() { return 'create_albi' } }]) {
    assert.throws(() => normalizeResolutionDecision({ action }), TypeError)
    assert.throws(() => hashResolutionDecision({ action }), TypeError)
  }
})

test('public projection drops array and object actions without invoking their string coercion', () => {
  for (const action of [['create_albi'], ['resolve_fields'], new String('create_albi'),
    { toString() { return 'create_albi' } },
    { toString() { throw new Error('Action coercion must not run') } },
  ]) {
    const projected = projectReviewResolution({ action, decision: { action, fieldChoices: { apiKey: 'secret' } } })
    assert.equal(projected.action, null)
    assert.equal(projected.decision, null)
  }
})

test('public resolution projection drops all internal leases, arbitrary JSON and provider messages', () => {
  const row = { id: ID, company_id: ID, run_id: ID, review_id: ID, portal_id: '123', object_type: 'contacts', source_id: '42',
    action: 'resolve_fields', status: 'waiting_on_albi', expected_review_updated_at: TIME,
    decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot', apiKey: 'secret' }, raw: 'secret' },
    provider_outcome_code: 'authorization_rejected', created_by: ID, created_at: TIME, updated_at: TIME,
    decision_hash: 'secret', client_request_id: ID, lease_owner: ID, lease_expires_at: TIME, execution_phase: 'waiting_on_albi',
    source_snapshot: { email: 'secret' }, raw_response: 'secret', error: 'secret', credentials: 'secret' }
  const event = { id: ID, actor_id: ID, event_type: 'waiting_on_albi', created_at: TIME, raw: 'secret',
    sanitized_details: { code: 'authorization_rejected', category: 'permission', outcome: 'waiting_on_albi',
      manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '2590478', url: 'https://evil.test',
        fields: [{ field: 'phoneNumber', value: '111', raw: 'secret' }, { field: 'apiKey', value: 'secret' }], snapshot: { token: 'secret' } }],
      message: 'secret', providerResponse: { secret: 'secret' }, snapshots: ['secret'], apiKey: 'secret' } }
  const projected = projectReviewResolution(row, [event])
  assert.deepEqual(projected, { id: ID, runId: ID, reviewId: ID, portalId: '123', objectType: 'contacts', sourceId: '42',
    action: 'resolve_fields', status: 'waiting_on_albi', expectedUpdatedAt: TIME,
    decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } },
    providerOutcomeCode: 'authorization_rejected', createdBy: ID, createdAt: TIME, updatedAt: TIME,
    events: [{ id: ID, actorId: ID, eventType: 'waiting_on_albi', createdAt: TIME, details: {
      code: 'authorization_rejected', category: 'permission', outcome: 'waiting_on_albi',
      manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '2590478', fields: [{ field: 'phoneNumber', value: '111' }] }],
    } }] })
  assert.equal(JSON.stringify(projected).includes('secret'), false)
  assert.equal(JSON.stringify(projected).includes('lease'), false)
})

test('projection fails closed for unsafe identities and codes and caps manual task details and event history', () => {
  assert.equal(projectReviewResolution(null), null)
  const result = projectReviewResolution({ id: 'raw secret', source_id: 'token', object_type: 'raw', action: 'raw', status: 'raw',
    provider_outcome_code: 'provider_secret', created_at: 'secret', decision: { action: 'create_albi', arbitrary: 'secret' } },
  Array.from({ length: 150 }, () => ({ event_type: 'raw', actor_id: 'secret', sanitized_details: { code: 'provider_secret', message: 'secret' } })))
  assert.equal(result.id, null); assert.equal(result.sourceId, null); assert.equal(result.action, null)
  assert.equal(result.status, null); assert.equal(result.providerOutcomeCode, null); assert.equal(result.createdAt, null)
  assert.equal(result.decision, null); assert.equal(result.events.length, 100)
  assert.deepEqual(result.events[0].details, {})
  const details = safeResolutionEventDetails({ execution_phase: 'waiting_on_albi', code: 'timeout',
    providerStatus: 422,
    manualTasks: Array.from({ length: 20 }, () => ({ provider: 'albi', objectType: 'contacts', targetId: '1',
      fields: [{ field: 'organizationId', value: '12' }, { field: 'email', value: 'a'.repeat(600) },
        { field: 'city', value: { token: 'secret' } }] })) })
  assert.equal(details.execution_phase, undefined)
  assert.equal(details.providerStatus, 422)
  assert.equal(details.manualTasks.length, 10)
  assert.deepEqual(details.manualTasks[0].fields, [{ field: 'organizationId', value: '12' }, { field: 'email', value: 'a'.repeat(500) }])
  assert.deepEqual(projectReviewResolutionEvent({ event_type: 'claimed', sanitized_details: { execution_phase: 'waiting_on_albi' } }).details, {})
  assert.equal(safeResolutionEventDetails({ providerReason: 'a: b' }).providerReason, 'a: b')
  assert.equal(safeResolutionEventDetails({ providerReason: 'x'.repeat(300) }).providerReason, undefined)
  assert.equal(safeResolutionEventDetails({ providerShape: 'sent=a' }).providerShape, 'sent=a')
  assert.equal(safeResolutionEventDetails({ providerShape: 'x'.repeat(300) }).providerShape, undefined)
  assert.equal(safeResolutionEventDetails({ providerReason: { a: 1 } }).providerReason, undefined)
  assert.deepEqual(safeResolutionEventDetails({ providerStatus: '422' }), {})
  assert.deepEqual(safeResolutionEventDetails({ providerStatus: 700 }), {})
})

test('referral source is a required, validated ID on every create decision', () => {
  assert.equal(normalizeResolutionDecision({ action: 'create_albi', referralSourceId: '5' }).referralSourceId, '5')
  assert.equal(normalizeResolutionDecision({ action: 'force_create_albi', ignoredCandidateIds: ['20'], referralSourceId: '5' }).referralSourceId, '5')
  for (const bad of ['0', 'abc', 5, '', null]) {
    assert.throws(() => normalizeResolutionDecision({ action: 'create_albi', referralSourceId: bad }), TypeError)
  }
  assert.throws(() => normalizeResolutionDecision({ action: 'link_existing', candidateId: '1', referralSourceId: '5' }), TypeError)
  const input = createInput('contacts')
  input.decision = { action: 'create_albi' }
  assert.throws(() => plan(input), TypeError)
  assert.notEqual(hashResolutionDecision({ action: 'create_albi', referralSourceId: '5' }), hashResolutionDecision({ action: 'create_albi', referralSourceId: '6' }))
})

test('created records are typed, set Active, and carry the HubSpot owner as salesperson when there is one', () => {
  const withOwner = plan(createInput('contacts')).providerOperation.payload
  assert.deepEqual([withOwner.contactTypeIds, withOwner.relationshipStatusId, withOwner.salespersonId], [['12'], '2', '70'])
  const noOwner = createInput('contacts'); noOwner.createDefaults = { ok: true, typeId: '12', statusId: '2', salespersonId: null }
  assert.equal(Object.hasOwn(plan(noOwner).providerOperation.payload, 'salespersonId'), false)
  const organization = plan(createInput('companies')).providerOperation.payload
  assert.deepEqual([organization.organizationTypeIds, organization.relationshipStatusId, organization.salespersonId], [['12'], '2', '70'])
  for (const bad of [undefined, null, { ok: true, typeId: '12', salespersonId: '70' }, { ok: true, typeId: 'x', statusId: '2', salespersonId: null }]) {
    const input = createInput('contacts'); if (bad === undefined) delete input.createDefaults; else input.createDefaults = bad
    assert.throws(() => plan(input), TypeError)
  }
})

test('HubSpot-wins choices on fields Albi does not return become manual tasks instead of invalid evidence', () => {
  const input = fieldsInput()
  input.review.proposedChanges = { conflicts: { city: { current: null, proposed: 'Newport Beach' }, jobTitle: { current: null, proposed: 'Director' } }, updates: {}, unchanged: [] }
  input.hubspot.properties = { city: 'Newport Beach', jobtitle: 'Director' }
  input.decision.fieldChoices = { city: 'hubspot', jobTitle: 'hubspot' }
  const result = plan(input)
  assert.equal(result.providerOperation, null)
  assert.deepEqual(result.manualTasks[0].fields, [{ field: 'city', value: 'Newport Beach' }, { field: 'jobTitle', value: 'Director' }])
  input.decision.fieldChoices = { city: 'albi' }
  assert.throws(() => plan(input), TypeError)
})

test('stale diagnostics are allowlisted in public event details', () => {
  assert.deepEqual(safeResolutionEventDetails({ staleCheck: 'source', staleFields: ['email', 'bad field!', 'x'.repeat(50)] }),
    { staleCheck: 'source', staleFields: ['email'] })
  assert.deepEqual(safeResolutionEventDetails({ staleCheck: 'secret', staleFields: 'email' }), {})
})

test('an email-match link may ignore phone/address differences only when the emails match exactly', () => {
  assert.deepEqual(normalizeResolutionDecision({ action: 'link_existing', candidateId: '2590478', approveManyToOne: true, ignoreContactDifferences: true }),
    { action: 'link_existing', candidateId: '2590478', approveManyToOne: true, ignoreContactDifferences: true })
  for (const bad of [false, 'yes', 1]) assert.throws(() => normalizeResolutionDecision({ action: 'link_existing', candidateId: '1', ignoreContactDifferences: bad }), TypeError)
  const input = fieldsInput()
  input.hubspot.properties.email = ' Same@Example.com '
  input.albi.email = 'same@example.com'
  input.decision = { action: 'link_existing', candidateId: '2590478', ignoreContactDifferences: true }
  assert.equal(plan(input).mapping.targetId, '2590478')
  assert.deepEqual(plan(input).manualTasks, [])
  input.albi.email = 'other@example.com'
  assert.throws(() => plan(input), TypeError)
  input.albi.email = 'same@example.com'; input.hubspot.properties.email = ''
  assert.throws(() => plan(input), TypeError)
})

test('a link may record the exact field differences the reviewer chose to ignore', () => {
  assert.deepEqual(normalizeResolutionDecision({ action: 'link_existing', candidateId: '1', ignoredFields: ['phoneNumber', 'city'] }),
    { action: 'link_existing', candidateId: '1', ignoredFields: ['city', 'phoneNumber'] })
  for (const bad of [[], ['city', 'city'], ['secret'], 'city', Array.from({ length: 21 }, () => 'city')]) {
    assert.throws(() => normalizeResolutionDecision({ action: 'link_existing', candidateId: '1', ignoredFields: bad }), TypeError)
  }
  const contact = fieldsInput(); contact.decision = { action: 'link_existing', candidateId: '2590478', ignoredFields: ['phoneNumber'] }
  assert.equal(plan(contact).mapping.targetId, '2590478'); assert.deepEqual(plan(contact).manualTasks, [])
  contact.decision.ignoredFields = ['domain']
  assert.throws(() => plan(contact), TypeError)
})

test('Albi can fill a field HubSpot leaves blank, written to HubSpot; never for a HubSpot value or a manual task', () => {
  const input = fieldsInput()
  input.albi = { ...input.albi, jobTitle: 'Property Manager', city: 'Ontario' }
  input.decision = { action: 'resolve_fields', fieldChoices: { jobTitle: 'albi' } }
  const result = plan(input)
  assert.deepEqual(result.providerOperation, { provider: 'hubspot', operation: 'updateContact', id: '42', properties: { jobtitle: 'Property Manager' } })
  input.hubspot.properties.jobtitle = 'Engineer'
  assert.throws(() => plan(input), TypeError)
  input.hubspot.properties.jobtitle = ''
  input.decision.fieldChoices = { jobTitle: 'hubspot' }
  assert.throws(() => plan(input), TypeError)
  delete input.albi.jobTitle
  input.decision.fieldChoices = { jobTitle: 'albi' }
  assert.throws(() => plan(input), TypeError)
})
