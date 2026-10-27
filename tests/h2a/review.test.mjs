import assert from 'node:assert/strict'
import test from 'node:test'
import * as review from '../../netlify/functions/_h2a/review.js'
import {
  evaluateContactReview, evaluateOrganizationReview, safeReviewSnapshot, safeReviewCandidates,
  safeReviewEvidence, safeReviewChanges, projectReviewRow, projectReviewEvent,
  assertReviewClassification, REVIEW_REASONS, REVIEW_CONFLICT_TYPES,
} from '../../netlify/functions/_h2a/review.js'
import { presentSampleReviewItem } from '../../src/features/hubspotToAlbi/sampleReview.js'
import { buildReviewResolutionPlan } from '../../netlify/functions/_h2a/reviewResolution.js'

const contact = { id: 'hs-1', properties: { firstname: 'A', lastname: 'Person', email: 'a@example.com' } }
const company = { id: 'hs-2', properties: { name: 'Allied', domain: 'allied.example' } }
const contactType = { mapping_kind: 'default_contact_type', source_key: 'default', albi_id: 'ct-1', confirmed_at: '2026-10-12T00:00:00Z' }
const organizationType = { mapping_kind: 'default_organization_type', source_key: 'default', albi_id: 'ot-1', confirmed_at: '2026-10-12T00:00:00Z' }
const cleanContact = { id: 'albi-1', firstName: 'A', lastName: 'Person', email: 'a@example.com' }
const cleanCompany = { id: 'albi-2', name: 'Allied', domain: 'allied.example' }

const reviewedChoice = { company_id: 'tenant', portal_id: '123', hubspot_contact_id: 'hs-1', hubspot_company_id: '11' }
const reviewedContext = { associatedCompanyIds: ['11', '12'], choice: reviewedChoice,
  availableCompanies: [{ id: '11' }, { id: '12' }], companyId: 'tenant', portalId: '123', contactId: 'hs-1' }

test('reviewed organization selector chooses one existing direct company without changing associations', () => {
  assert.equal(typeof review.selectReviewedOrganizationContext, 'function')
  const input = structuredClone(reviewedContext)
  assert.deepEqual(review.selectReviewedOrganizationContext(input), { status: 'selected', companyId: '11' })
  assert.deepEqual(review.selectReviewedOrganizationContext({ associatedCompanyIds: ['11', '12'], choice: reviewedChoice,
    availableCompanies: [{ id: '11' }] }), { status: 'selected', companyId: '11' })
  assert.deepEqual(input, reviewedContext)
  assert.deepEqual(review.selectReviewedOrganizationContext({ associatedCompanyIds: [11, '11'], availableCompanies: [] }),
    { status: 'single', companyId: '11' })
})

for (const [name, override] of [
  ['missing choice', { choice: null }], ['missing company', { availableCompanies: [{ id: '12' }] }],
  ['deleted company', { availableCompanies: [{ id: '11', archived: true }] }],
  ['cross-tenant', { choice: { ...reviewedChoice, company_id: 'other' } }],
  ['wrong portal', { choice: { ...reviewedChoice, portal_id: '456' } }],
  ['wrong contact', { choice: { ...reviewedChoice, hubspot_contact_id: 'other' } }],
  ['no longer associated', { choice: { ...reviewedChoice, hubspot_company_id: '13' }, availableCompanies: [{ id: '13' }] }],
  ['malformed choice', { choice: { ...reviewedChoice, hubspot_company_id: {} } }],
]) test(`review evaluation ignores ${name} and preserves organization ambiguity`, () => {
  const context = { ...reviewedContext, ...override }
  const result = evaluateContactReview({ ...context, organizationChoice: context.choice, source: contact,
    candidates: [cleanContact], organization: { outcome: 'safe_to_link', targetId: 'albi-2' } })
  assert.equal(result.outcome, 'needs_review')
  assert.equal(result.reason, 'multiple_associated_organizations')
})

test('reviewed context permits safe evaluation but cannot bypass organization or contact safeguards', () => {
  const args = { ...reviewedContext, organizationChoice: reviewedChoice, source: contact,
    candidates: [{ ...cleanContact, organizationId: 'albi-2' }], organization: { outcome: 'safe_to_link', targetId: 'albi-2' } }
  assert.equal(evaluateContactReview(args).outcome, 'safe_to_link')
  assert.equal(evaluateContactReview({ ...args, organization: null }).reason, 'organization_unresolved')
  assert.equal(evaluateContactReview({ ...args, organization: { outcome: 'needs_review' } }).reason, 'organization_unresolved')
  assert.equal(evaluateContactReview({ ...args, candidates: [{ ...cleanContact, firstName: 'Other' }] }).reason, 'nonblank_field_difference')
  assert.equal(evaluateContactReview({ ...args, candidates: [cleanContact] }).reason, 'albi_contact_association_contract_unverified')
  assert.equal(evaluateContactReview({ ...args, mappings: [{ portal_id: '456', hubspot_id: 'hs-1', albi_contact_id: 'albi-1' }] }).reason,
    'target_already_mapped')
  assert.equal(evaluateContactReview({ ...args, candidates: [], organization: { outcome: 'safe_to_link', targetId: 'albi-2' } }).reason,
    'contact_type_confirmation_required')
})

for (const organization of [{ outcome: 'safe_to_create', targetId: null }, { outcome: 'safe_to_link', targetId: null }]) {
  test(`reviewed ${organization.outcome} company without a resolved target cannot clear an existing contact`, () => {
    const result = evaluateContactReview({ ...reviewedContext, organizationChoice: reviewedChoice, source: contact,
      candidates: [{ ...cleanContact, organizationId: organization.outcome === 'safe_to_create' ? 'old-org' : null }], organization })
    assert.equal(result.outcome, 'needs_review')
    assert.equal(result.reason, 'albi_contact_association_contract_unverified')
    assert.equal(result.conflictType, 'association')
  })
}

test('reviewed company creation remains eligible when the contact is genuinely new', () => {
  const result = evaluateContactReview({ ...reviewedContext, organizationChoice: reviewedChoice, source: contact,
    candidates: [], organization: { outcome: 'safe_to_create', targetId: null }, optionMappings: [contactType] })
  assert.equal(result.outcome, 'safe_to_create')
})

test('evaluator update-contract reasons retain safe field decisions with known target values', () => {
  const source = { id: '42', properties: { firstname: 'Alex', lastname: 'Stone', email: 'alex@example.com', jobtitle: 'Manager' } }
  const candidate = { id: '99', firstName: 'Alec', lastName: 'Stone', email: 'alex@example.com' }
  const result = evaluateContactReview({ source, candidates: [candidate] })
  assert.equal(result.reason, 'albi_contact_update_contract_unverified')
  const item = presentSampleReviewItem(projectReviewRow({ object_type: 'contacts', source_id: '42', status: 'needs_review',
    reason: result.reason, source_snapshot: safeReviewSnapshot(source, 'contacts'),
    candidate_snapshots: safeReviewCandidates(result.candidates, 'contacts'), proposed_changes: result.proposedChanges }, { detail: true }))
  assert.equal(item.actions.includes('resolve_fields'), true)
  assert.deepEqual(item.resolutionFields.map(field => field.key), ['firstName'])
  assert.equal(item.resolutionFields.some(field => field.key === 'jobTitle'), false)
  const plan = buildReviewResolutionPlan({ review: { objectType: 'contacts', sourceId: '42', reason: result.reason,
    candidateSnapshots: [{ id: '99' }], proposedChanges: result.proposedChanges },
  hubspot: source, albi: candidate, decision: { action: 'resolve_fields', fieldChoices: { firstName: 'albi' } } })
  assert.deepEqual(plan.providerOperation.properties, { firstname: 'Alec' })
})

test('organization update-contract evaluator exposes only known Albi differences', () => {
  const source = { id: '43', properties: { name: 'New name', domain: 'acme.example', phone: '5551112222' } }
  const candidate = { id: '98', name: 'Old name', domain: 'acme.example' }
  const result = evaluateOrganizationReview({ source, candidates: [candidate] })
  assert.equal(result.reason, 'albi_organization_update_contract_unverified')
  const item = presentSampleReviewItem(projectReviewRow({ object_type: 'companies', source_id: '43', status: 'needs_review',
    reason: result.reason, source_snapshot: safeReviewSnapshot(source, 'companies'),
    candidate_snapshots: safeReviewCandidates(result.candidates, 'companies'), proposed_changes: result.proposedChanges }, { detail: true }))
  assert.equal(item.actions.includes('resolve_fields'), true)
  assert.deepEqual(item.resolutionFields.map(field => field.key), ['name'])
  assert.equal(item.resolutionFields.some(field => field.key === 'phoneNumber'), false)
})

test('explicit blank Albi fields remain actionable while absent fields stay unknown', () => {
  const source = { id: '44', properties: { firstname: 'Alex', lastname: 'Stone', email: 'alex@example.com', jobtitle: 'Manager', city: 'LA' } }
  const candidate = { id: '97', firstName: 'Alex', lastName: 'Stone', email: 'alex@example.com', jobTitle: null }
  const result = evaluateContactReview({ source, candidates: [candidate] })
  assert.equal(result.reason, 'albi_contact_update_contract_unverified')
  assert.deepEqual(result.proposedChanges.conflicts.jobTitle, { current: null, proposed: 'Manager' })
  assert.equal(Object.hasOwn(result.proposedChanges.conflicts, 'city'), false)
  const item = presentSampleReviewItem(projectReviewRow({ object_type: 'contacts', source_id: '44', status: 'needs_review',
    reason: result.reason, source_snapshot: safeReviewSnapshot(source, 'contacts'),
    candidate_snapshots: safeReviewCandidates(result.candidates, 'contacts'), proposed_changes: result.proposedChanges }, { detail: true }))
  assert.deepEqual(item.resolutionFields.map(field => [field.key, field.albi]), [['jobTitle', null]])
  const plan = buildReviewResolutionPlan({ review: { objectType: 'contacts', sourceId: '44', reason: result.reason,
    candidateSnapshots: [{ id: '97' }], proposedChanges: result.proposedChanges }, hubspot: source, albi: candidate,
    decision: { action: 'resolve_fields', fieldChoices: { jobTitle: 'albi' } } })
  assert.deepEqual(plan.providerOperation.properties, { jobtitle: '' })
})

test('production evaluation recognizes same-numbered foreign-portal target ownership', () => {
  const source = { ...contact, id: '42' }
  const result = evaluateContactReview({ source, candidates: [cleanContact], portalId: '123',
    mappings: [{ portal_id: '456', hubspot_id: '42', albi_contact_id: 'albi-1' }] })
  assert.equal(result.outcome, 'needs_review'); assert.equal(result.reason, 'target_already_mapped')
})

const cases = [
  ['email match beside another record phone', evaluateContactReview, { source: { ...contact, properties: { ...contact.properties, phone: '5551112222' } }, candidates: [cleanContact, { id: 'albi-phone', phoneNumber: '5551112222' }] }, 'albi_contact_update_contract_unverified', 'contact_fields'],
  ['contact name only', evaluateContactReview, { source: contact, candidates: [{ id: 'name', firstName: 'A', lastName: 'Person' }] }, 'name_only_candidate', 'contact_match'],
  ['duplicate contacts', evaluateContactReview, { source: contact, candidates: [cleanContact, { ...cleanContact, id: 'duplicate' }] }, 'duplicate_candidates', 'contact_match'],
  ['unsupported contact phone evidence', evaluateContactReview, { source: { id: 'hs', firstname: 'A', lastname: 'Person', phone: '5551112222 ext 9' }, candidates: [{ id: 'phone', phoneNumber: '5551112222' }] }, 'unsupported_phone_evidence', 'contact_match'],
  ['missing contact name', evaluateContactReview, { source: { id: 'hs', email: 'new@example.com' } }, 'missing_required_name', 'contact_match'],
  ['contact nonblank fields', evaluateContactReview, { source: contact, candidates: [{ ...cleanContact, firstName: 'B' }] }, 'nonblank_field_difference', 'contact_fields'],
  ['contact update contract', evaluateContactReview, { source: contact, candidates: [{ id: 'albi', email: 'a@example.com' }] }, 'albi_contact_update_contract_unverified', 'contact_fields'],
  ['contact organization mismatch', evaluateContactReview, { source: contact, candidates: [{ ...cleanContact, organizationId: 'other' }], organization: { outcome: 'safe_to_link', targetId: 'intended' } }, 'albi_contact_association_contract_unverified', 'association'],
  ['multiple companies before matching', evaluateContactReview, { source: contact, associatedCompanyIds: ['a', 'b'] }, 'multiple_associated_organizations', 'association'],
  ['missing contact type', evaluateContactReview, { source: contact }, 'contact_type_confirmation_required', 'configuration'],
  ['unresolved company on create', evaluateContactReview, { source: contact, optionMappings: [contactType], organization: { outcome: 'needs_review' } }, 'organization_unresolved', 'association'],
  ['missing company context on create', evaluateContactReview, { source: contact, associatedCompanyIds: ['hs-org'], optionMappings: [contactType] }, 'organization_unresolved', 'association'],
  ['invalid contact create phone', evaluateContactReview, { source: { ...contact, properties: { ...contact.properties, phone: '12' } }, optionMappings: [contactType] }, 'invalid_phone_length', 'contact_phone'],
  ['contact create phone extension', evaluateContactReview, { source: { ...contact, properties: { ...contact.properties, phone: '5551112222 ext 9' } }, optionMappings: [contactType] }, 'extension_not_supported', 'contact_phone'],
  ['organization name only', evaluateOrganizationReview, { source: company, candidates: [{ id: 'name', name: 'Allied' }] }, 'name_only_candidate', 'organization_match'],
  ['duplicate organizations', evaluateOrganizationReview, { source: company, candidates: [cleanCompany, { ...cleanCompany, id: 'dup' }] }, 'duplicate_candidates', 'organization_match'],
  ['missing organization name', evaluateOrganizationReview, { source: { id: 'hs-org', domain: 'new.example' } }, 'missing_required_name', 'organization_match'],
  ['organization nonblank fields', evaluateOrganizationReview, { source: company, candidates: [{ ...cleanCompany, name: 'Other' }] }, 'nonblank_field_difference', 'organization_fields'],
  ['organization update contract', evaluateOrganizationReview, { source: company, candidates: [{ id: 'albi', domain: 'allied.example' }] }, 'albi_organization_update_contract_unverified', 'organization_fields'],
  ['missing organization type', evaluateOrganizationReview, { source: company }, 'organization_type_confirmation_required', 'configuration'],
  ['invalid organization phone', evaluateOrganizationReview, { source: { ...company, properties: { ...company.properties, phone: '+44 1234567890' } }, optionMappings: [organizationType] }, 'unsupported_international_format', 'organization_phone'],
]
for (const [name, evaluate, input, reason, conflictType] of cases) {
  test(`review evaluation blocks ${name}`, () => {
    const original = structuredClone(input)
    const result = evaluate(input)
    assert.equal(result.outcome, 'needs_review')
    assert.equal(result.reason, reason)
    assert.equal(result.conflictType, conflictType)
    assert.deepEqual(Object.keys(result), ['outcome', 'reason', 'conflictType', 'targetId', 'evidence', 'proposedChanges', 'candidates'])
    assert.deepEqual(input, original)
    assertReviewClassification(result.reason, result.conflictType)
  })
}

test('ambiguous contact candidates preserve both identities', () => {
  const result = evaluateContactReview(cases[0][2])
  assert.deepEqual(result.candidates.map(item => item.id), ['albi-1', 'albi-phone'])
})

test('clean links use the matcher evidence and clean creates require confirmed options', () => {
  assert.deepEqual(evaluateOrganizationReview({ source: company, candidates: [cleanCompany] }), {
    outcome: 'safe_to_link', reason: 'unique_exact_domain', conflictType: '', targetId: 'albi-2',
    evidence: ['domain'], proposedChanges: { updates: {}, conflicts: {}, unchanged: ['name'] }, candidates: [cleanCompany],
  })
  const linked = evaluateContactReview({ source: contact, candidates: [cleanContact] })
  assert.equal(linked.outcome, 'safe_to_link')
  assert.equal(linked.targetId, 'albi-1')
  assert.deepEqual(linked.evidence, ['email'])
  for (const [evaluate, source, mapping] of [[evaluateOrganizationReview, company, organizationType], [evaluateContactReview, contact, contactType]]) {
    const result = evaluate({ source, optionMappings: [mapping] })
    assert.equal(result.outcome, 'safe_to_create')
    assert.equal(result.reason, 'no_match')
    assert.equal(result.targetId, null)
    assert.throws(() => assertReviewClassification(result.reason, result.conflictType))
    assert.equal(evaluate({ source, optionMappings: [{ ...mapping, confirmed_at: null }] }).outcome, 'needs_review')
  }
})

test('contact type inherits organization mapping and falls back to confirmed default', () => {
  const organization = { outcome: 'safe_to_create', targetId: null, organizationTypeId: 'ot-1' }
  const mapping = { mapping_kind: 'organization_to_contact_type', source_key: 'ot-1', albi_id: 'ct-2', confirmed: true }
  assert.equal(evaluateContactReview({ source: contact, organization, optionMappings: [mapping] }).outcome, 'safe_to_create')
  assert.equal(evaluateContactReview({ source: contact, organization, optionMappings: [contactType] }).outcome, 'safe_to_create')
})

test('existing ownership remains authoritative and matcher field comparisons survive', () => {
  const mappings = [{ hubspot_id: 'hs-other', albi_contact_id: 'albi-1' }]
  assert.equal(evaluateContactReview({ source: contact, candidates: [cleanContact], mappings }).reason, 'target_already_mapped')
  const result = evaluateContactReview(cases[5][2])
  assert.deepEqual(result.proposedChanges.conflicts, { firstName: { current: 'B', proposed: 'A' } })
  assert.equal(result.targetId, 'albi-1')
  assert.equal(evaluateContactReview({ source: { id: 'hs-1' }, candidates: [{ id: 'mapped' }], mappings: [{ hubspot_id: 'hs-1', albi_contact_id: 'mapped' }] }).reason, 'existing_mapping')
})

test('review string caps cannot collapse distinct source IDs during mapping ownership checks', () => {
  const prefix = 'x'.repeat(500)
  const source = { id: `${prefix}a`, properties: contact.properties }
  const mappings = [{ hubspot_id: `${prefix}b`, albi_contact_id: 'different' }]
  const result = evaluateContactReview({ source, candidates: [cleanContact, { id: 'different' }], mappings })
  assert.equal(result.reason, 'unique_exact_match')
  assert.equal(result.targetId, 'albi-1')
})

test('long target IDs still verify organization identity before safe response truncation', () => {
  const targetId = 't'.repeat(501)
  const result = evaluateContactReview({ source: contact,
    candidates: [{ ...cleanContact, id: targetId, organizationId: 'wrong' }],
    organization: { outcome: 'safe_to_link', targetId: 'correct' } })
  assert.equal(result.reason, 'albi_contact_association_contract_unverified')
  assert.equal(result.targetId.length, 500)
})

test('organization defaults reject malformed confirmations and duplicate configured defaults', () => {
  for (const optionMappings of [[{ ...organizationType, confirmed_at: 'garbage' }], [organizationType, organizationType]]) {
    assert.equal(evaluateOrganizationReview({ source: company, optionMappings }).reason, 'organization_type_confirmation_required')
  }
  assert.equal(evaluateOrganizationReview({ source: company, optionMappings: [{ ...organizationType, confirmed_at: null, confirmed: true }] }).outcome, 'safe_to_create')
})

test('snapshot aliases normalize to canonical allowlists and discard provider content', () => {
  const source = { id: 'hs', apiKey: 'SECRET', properties: { firstname: 'A', lastname: 'Person', fullName: 'A Person',
    email: 'a@example.com', phone: '5551112222', mobilephone: '5553334444', company: 'Allied', jobtitle: 'Owner',
    address: 'One St', address2: 'Two', city: 'City', state: 'CA', zip: '90210', country: 'US', organizationId: 'org',
    authorization: 'SECRET', nested: { apiKey: 'SECRET' }, notes: 'BODY', hs_email_text: 'BODY', emailBody: 'BODY' } }
  assert.deepEqual(safeReviewSnapshot(source, 'contacts'), { id: 'hs', firstName: 'A', lastName: 'Person', fullName: 'A Person', email: 'a@example.com',
    phoneNumber: '5551112222', mobileNumber: '5553334444', organizationId: 'org', organizationName: 'Allied', jobTitle: 'Owner',
    address1: 'One St', address2: 'Two', city: 'City', state: 'CA', zipcode: '90210', country: 'US' })
  const org = { id: 2, companyName: 'Allied', website: 'allied.example', emailAddress: 'org@example.com', phone: '5551112222',
    organizationTypeIds: [1, 'two', { apiKey: 'SECRET' }], parentOrganizationId: 3, address: 'One', address2: 'Two', city: 'C',
    state: 'CA', postalCode: '90210', countryCode: 'US', notes: 'BODY', apiKey: 'SECRET' }
  assert.deepEqual(safeReviewSnapshot(org, 'companies'), { id: '2', name: 'Allied', domain: 'allied.example', email: 'org@example.com', phoneNumber: '5551112222',
    organizationTypeIds: ['1', 'two'], parentOrganizationId: '3', address1: 'One', address2: 'Two', city: 'C', state: 'CA', zipcode: '90210', country: 'US' })
  assert.deepEqual(safeReviewSnapshot(source, 'emails'), {})
})

test('snapshot and candidate caps apply to every scalar without stringifying nested values', () => {
  const long = 'x'.repeat(600)
  assert.deepEqual(safeReviewSnapshot({ id: long, firstName: long, email: { authorization: 'SECRET' }, phoneNumber: ['BODY'] }, 'contact'), { id: 'x'.repeat(500), firstName: 'x'.repeat(500) })
  const candidates = safeReviewCandidates([null, {}, ...Array.from({ length: 15 }, (_, i) => ({ id: i, name: long, organizationTypeIds: [long], body: 'BODY' }))], 'organization')
  assert.equal(candidates.length, 10)
  assert.equal(candidates[0].id, '0')
  assert.equal(candidates[0].name.length, 500)
  assert.equal(candidates[0].organizationTypeIds[0].length, 500)
})

test('field comparison and evidence projectors use fixed keys and reasons', () => {
  assert.deepEqual(safeReviewChanges({ updates: { firstName: 'A', email: { apiKey: 'SECRET' }, apiKey: 'SECRET' },
    conflicts: { phoneNumber: { current: '123', proposed: '456', reason: 'extension_not_supported', error: 'SECRET' },
      email: { current: { body: 'BODY' }, proposed: 'a@example.com', reason: 'SECRET' }, notes: { proposed: 'BODY' } },
    unchanged: ['firstName', 'apiKey', { body: 'BODY' }], raw: 'SECRET' }, 'contacts'), {
    updates: { firstName: 'A' }, conflicts: { phoneNumber: { current: '123', proposed: '456', reason: 'extension_not_supported' },
      email: { proposed: 'a@example.com', reason: 'other_review_reason' } }, unchanged: ['firstName'],
  })
  assert.deepEqual(safeReviewEvidence({ evidence: ['email', 'phone', 'BODY', { token: 'SECRET' }, 'email'], apiKey: 'SECRET' }), ['email', 'phone'])
})

test('evaluated and projected comparisons cap scalars throughout the output tree', () => {
  const long = 'x'.repeat(600)
  const input = { source: { id: 'hs', firstname: long, lastname: 'Person', email: 'a@example.com' },
    candidates: [{ ...cleanContact, jobTitle: long, apiKey: 'SECRET', notes: 'BODY' }] }
  const result = evaluateContactReview(input)
  assert.equal(result.proposedChanges.conflicts.firstName.proposed.length, 500)
  const projected = projectReviewRow({ ...row, id: long, run_id: long, source_id: long, last_rechecked_at: long,
    last_rechecked_by: long, created_at: long, updated_at: long, proposed_changes: {
      updates: { jobTitle: long }, conflicts: { email: { current: long, proposed: long } }, unchanged: ['email'],
    } }, { detail: true })
  const checkCaps = value => {
    if (typeof value === 'string') assert.ok(value.length <= 500)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(checkCaps)
  }
  checkCaps(result)
  checkCaps(projected)
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  assert.ok(!JSON.stringify(result).includes('BODY'))
})

const row = { id: 'review', run_id: 'run', object_type: 'contacts', source_id: 'hs', reason: 'name_only_candidate', conflict_type: 'contact_match',
  status: 'needs_review', recheck_outcome: null, source_snapshot: { id: 'hs', firstName: 'A', lastName: 'Person', email: 'a@example.com', phoneNumber: '5551112222', organizationName: 'Allied', apiKey: 'SECRET' },
  candidate_snapshots: [{ id: 'albi', firstName: 'A', notes: 'BODY' }], match_evidence: { evidence: ['email', 'SECRET'] },
  proposed_changes: { updates: { jobTitle: 'Owner', apiKey: 'SECRET' }, conflicts: {}, unchanged: ['email', 'notes'] },
  last_rechecked_at: null, last_rechecked_by: null, created_at: 'created', updated_at: 'updated', authorization: 'SECRET' }

test('list projection constructs the exact summary shape from safe source identity', () => {
  assert.deepEqual(projectReviewRow(row), { id: 'review', runId: 'run', reviewKind: 'sample', objectType: 'contacts', sourceId: 'hs', reason: 'name_only_candidate', conflictType: 'contact_match', status: 'needs_review', recheckOutcome: null, resolutionStatus: null, triageBucket: 'decision', triageDetails: {},
    displayName: 'A Person', identity: { email: 'a@example.com', phone: '5551112222', organizationName: 'Allied', domain: null }, lastRecheckedAt: null, createdAt: 'created', updatedAt: 'updated' })
})

test('only detailed review projection exposes a validated portal for fixed-origin links', () => {
  assert.equal(projectReviewRow({ ...row, portal_id: '123' }, { detail: true }).portalId, '123')
  assert.equal(Object.hasOwn(projectReviewRow({ ...row, portal_id: '123' }), 'portalId'), false)
  for (const portal_id of ['https://evil.test', '01', '0', '12/34', '', null, 123]) {
    assert.equal(projectReviewRow({ ...row, portal_id }, { detail: true }).portalId, null)
  }
})

test('detail projection independently re-sanitizes stored JSON into the exact detail shape', () => {
  assert.deepEqual(projectReviewRow(row, { detail: true }), { id: 'review', runId: 'run', reviewKind: 'sample', objectType: 'contacts', sourceId: 'hs', reason: 'name_only_candidate', conflictType: 'contact_match', status: 'needs_review', recheckOutcome: null, resolutionStatus: null, triageBucket: 'decision', triageDetails: {},
    portalId: null,
    sourceSnapshot: { id: 'hs', firstName: 'A', lastName: 'Person', email: 'a@example.com', phoneNumber: '5551112222', organizationName: 'Allied' },
    candidateSnapshots: [{ id: 'albi', firstName: 'A' }], matchEvidence: ['email'],
    proposedChanges: { updates: { jobTitle: 'Owner' }, conflicts: {}, unchanged: ['email'] },
    rankedCandidates: [{ id: 'albi', matchReasons: ['same_first_name'], warnings: [], strength: 'Weak', linkedElsewhere: 0 }], suggestedCandidateId: null,
    lastRecheckedAt: null, lastRecheckedBy: null, createdAt: 'created', updatedAt: 'updated' })
})

test('unknown classifications are generic on display and rejected for capture', () => {
  const displayed = projectReviewRow({ ...row, reason: 'RAW SECRET', conflict_type: 'RAW SECRET' })
  assert.equal(displayed.reason, 'other_review_reason')
  assert.equal(displayed.conflictType, 'other_review_reason')
  assert.throws(() => assertReviewClassification('RAW SECRET', 'contact_match'), /Invalid review classification/)
  assert.throws(() => assertReviewClassification('name_only_candidate', 'RAW SECRET'), /Invalid review classification/)
  assert.equal(Object.isFrozen(REVIEW_REASONS), true)
  assert.equal(Object.isFrozen(REVIEW_CONFLICT_TYPES), true)
  assert.throws(() => REVIEW_REASONS.add('SECRET'), /immutable/)
  assert.throws(() => REVIEW_CONFLICT_TYPES.clear(), /immutable/)
  for (const reason of ['source_missing', 'safe_to_link', 'safe_to_create', 'still_needs_review', 'recheck_failed', 'multiple_candidates', 'missing_target', 'auth:network']) assert.equal(REVIEW_REASONS.has(reason), true)
})

test('event projector retains only fixed outcome/category/code details', () => {
  assert.deepEqual(projectReviewEvent({ id: 'e', event_type: 'recheck_failed', reason: 'RAW ERROR SECRET', actor_id: 'actor', created_at: 'created',
    sanitized_details: { outcome: 'recheck_failed', category: 'auth', code: 'network', message: 'SECRET', body: 'BODY', apiKey: 'SECRET' } }), {
    id: 'e', eventType: 'recheck_failed', reason: 'other_review_reason', actorId: 'actor', details: { outcome: 'recheck_failed', category: 'auth', code: 'network' }, createdAt: 'created',
  })
  assert.deepEqual(projectReviewEvent({ sanitized_details: { outcome: 'SECRET', category: { apiKey: 'SECRET' }, code: 'SECRET' } }).details, {})
})

test('a record already linked to Albi passes even when its fields differ, keeping the differences to show', () => {
  const source = { id: 'hs-1', firstName: 'Estela', lastName: 'Alday', email: 'e@x.test', jobTitle: 'Property Manager', city: 'Corona' }
  const albi = { id: '20', firstName: 'Estela', lastName: 'Alday', email: 'e@x.test', city: 'Irvine' }
  const mappings = [{ portal_id: '123', hubspot_id: 'hs-1', albi_contact_id: '20' }]
  const linked = evaluateContactReview({ source, candidates: [albi], mappings, portalId: '123' })
  assert.equal(linked.outcome, 'safe_to_link')
  assert.ok(Object.keys(linked.proposedChanges.conflicts).includes('city'))
  assert.ok(Object.keys(linked.proposedChanges.updates).includes('jobTitle'))
  // Not linked yet: an exact match whose fields differ still asks the reviewer.
  assert.equal(evaluateContactReview({ source, candidates: [albi], mappings: [], portalId: '123' }).outcome, 'needs_review')
  const organization = evaluateOrganizationReview({ source: { id: 'hs-org', name: 'Acme', city: 'Corona' },
    candidates: [{ id: '50', name: 'Acme', city: 'Irvine' }], mappings: [{ portal_id: '123', hubspot_id: 'hs-org', albi_organization_id: '50' }], portalId: '123' })
  assert.equal(organization.outcome, 'safe_to_link')
})

test('a linked contact whose Albi organization differs is not held (Albi cannot reassociate contacts)', () => {
  const source = { id: 'hs-1', firstName: 'Tara', lastName: 'Joanis', email: 't@x.test' }
  const albi = { id: '20', firstName: 'Tara', lastName: 'Joanis', email: 't@x.test', organizationId: '77' }
  const organization = { outcome: 'safe_to_link', targetId: '50' }
  const linked = evaluateContactReview({ source, candidates: [albi], associatedCompanyIds: ['hs-org'], organization,
    mappings: [{ portal_id: '123', hubspot_id: 'hs-1', albi_contact_id: '20' }], portalId: '123' })
  assert.equal(linked.outcome, 'safe_to_link')
  // Not linked yet: the organization mismatch still asks the reviewer.
  const unlinked = evaluateContactReview({ source, candidates: [albi], associatedCompanyIds: ['hs-org'], organization, mappings: [], portalId: '123' })
  assert.equal(unlinked.reason, 'albi_contact_association_contract_unverified')
})

test('a linked contact is not held by several HubSpot organizations or an organization still needing review', () => {
  const source = { id: 'hs-1', firstName: 'Tara', lastName: 'Joanis', email: 't@x.test' }
  const albi = { id: '20', firstName: 'Tara', lastName: 'Joanis', email: 't@x.test' }
  const mappings = [{ portal_id: '123', hubspot_id: 'hs-1', albi_contact_id: '20' }]
  assert.equal(evaluateContactReview({ source, candidates: [albi], associatedCompanyIds: ['a', 'b'], mappings, portalId: '123' }).outcome, 'safe_to_link')
  assert.equal(evaluateContactReview({ source, candidates: [albi], associatedCompanyIds: ['a'], organization: { outcome: 'needs_review' },
    mappings, portalId: '123' }).outcome, 'safe_to_link')
  // Unlinked, both still ask.
  assert.equal(evaluateContactReview({ source, candidates: [albi], associatedCompanyIds: ['a', 'b'], mappings: [], portalId: '123' }).reason, 'multiple_associated_organizations')
})
