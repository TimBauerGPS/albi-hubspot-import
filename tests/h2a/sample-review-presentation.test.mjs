import assert from 'node:assert/strict'
import test from 'node:test'
import { buildResolutionRequest, presentReviewResolution, buildResolutionConfirmation } from '../../src/features/hubspotToAlbi/sampleReviewResolution.js'
import { presentReviewBreakdown } from '../../src/features/hubspotToAlbi/reviewBreakdown.js'
import { projectReviewRow } from '../../netlify/functions/_h2a/review.js'

test('server-to-browser confirmation distinguishes missing evidence from an explicit clearing value', () => {
  const stored = { object_type: 'contacts', source_id: '34', reason: 'nonblank_field_difference', status: 'needs_review',
    source_snapshot: { email: 'hs@example.com' }, candidate_snapshots: [{ id: '2590478', email: 'snapshot@example.com' }],
    proposed_changes: { conflicts: { email: { proposed: 'hs@example.com', token: 'SECRET' }, token: { current: 'SECRET' } } } }
  const projected = projectReviewRow(stored, { detail: true })
  assert.deepEqual(projected.proposedChanges.conflicts.email, { proposed: 'hs@example.com' })
  const missing = presentSampleReviewItem(projected)
  assert.deepEqual(missing.resolutionFields, [])
  assert.throws(() => buildResolutionConfirmation({ review: missing,
    decision: { action: 'resolve_fields', fieldChoices: { email: 'albi' } } }), TypeError)
  stored.proposed_changes.conflicts.email.current = null
  const explicit = presentSampleReviewItem(projectReviewRow(stored, { detail: true }))
  assert.deepEqual(explicit.resolutionFields, [{ key: 'email', label: 'Email', hubspot: 'hs@example.com', albi: null }])
  assert.deepEqual(buildResolutionConfirmation({ review: explicit,
    decision: { action: 'resolve_fields', fieldChoices: { email: 'albi' } } }).hubspotWrites, [{ field: 'Email', value: null }])
  assert.equal(JSON.stringify(explicit).includes('SECRET'), false)
  stored.proposed_changes.conflicts.email.current = { token: 'SECRET' }
  const malformed = presentSampleReviewItem(projectReviewRow(stored, { detail: true }))
  assert.deepEqual(malformed.resolutionFields, [])
  assert.equal(JSON.stringify(malformed).includes('SECRET'), false)
  delete stored.proposed_changes.conflicts.email.proposed
  assert.deepEqual(presentSampleReviewItem(projectReviewRow(stored, { detail: true })).resolutionFields, [])
})

const resolutionRequest = { reviewId: '00000000-0000-4000-8000-000000000001', expectedUpdatedAt: '2026-10-12T12:00:00.000Z',
  clientRequestId: '00000000-0000-4000-8000-000000000002', action: 'link_existing', candidateId: '2590478', approveManyToOne: false }

test('resolution requests preserve explicit approvals and retry identity and reject payload leakage', () => {
  assert.deepEqual(buildResolutionRequest(resolutionRequest), resolutionRequest)
  assert.deepEqual(buildResolutionRequest(resolutionRequest), resolutionRequest)
  for (const extra of [{ sourceSnapshot: { email: 'SECRET' } }, { url: 'https://evil.test' }, { portalId: '12' },
    { fieldChoices: { email: 'albi' } }, { approveManyToOne: null }, { candidateId: 'javascript:1' },
    { clientRequestId: '' }, { expectedUpdatedAt: '2026-02-30T12:00:00Z' }]) {
    assert.throws(() => buildResolutionRequest({ ...resolutionRequest, ...extra }), TypeError)
  }
  assert.throws(() => buildResolutionRequest({ ...resolutionRequest, action: 'choose_organization', candidateId: undefined,
    approveManyToOne: undefined, organizationSourceId: '22', addHubSpotAssociation: false }), TypeError)
  const { candidateId, approveManyToOne, ...base } = resolutionRequest
  assert.deepEqual(buildResolutionRequest({ ...base, action: 'choose_organization', organizationSourceId: '22', addHubSpotAssociation: false }),
    { ...base, action: 'choose_organization', organizationSourceId: '22', addHubSpotAssociation: false })
})

test('resolution presentation rebuilds audit and manual tasks with fixed copy and generated links', () => {
  const presented = presentReviewResolution({ id: resolutionRequest.reviewId, objectType: 'contacts', portalId: '12', sourceId: '34',
    action: 'resolve_fields', status: 'waiting_on_albi', decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot', token: 'SECRET' } },
    providerOutcomeCode: 'authorization_rejected', message: 'SECRET', url: 'https://evil.test', credentials: 'SECRET',
    events: [{ eventType: 'waiting_on_albi', details: { message: 'SECRET', executionContext: { token: 'SECRET' },
      manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '2590478', url: 'https://evil.test',
        fields: [{ field: 'email', value: null }, { field: 'phoneNumber', value: '' }, { field: 'token', value: 'SECRET' }] }] } }] })
  assert.equal(presented.statusLabel, 'Waiting on Albi')
  assert.equal(presented.outcomeLabel, 'Authentication or write scope rejected')
  assert.equal(presented.hubspotUrl, 'https://app.hubspot.com/contacts/12/record/0-1/34')
  assert.deepEqual(presented.events[0].manualTasks[0].fields, [{ field: 'email', label: 'Email', value: null }, { field: 'phoneNumber', label: 'Phone', value: '' }])
  assert.equal(presented.events[0].manualTasks[0].url, 'https://app.albiware.com/Relationships/Contact/2590478')
  assert.equal(JSON.stringify(presented).includes('SECRET'), false)
  assert.equal(JSON.stringify(presented).includes('evil.test'), false)
  assert.equal(presentReviewResolution({ status: 'SECRET', providerOutcomeCode: 'SECRET' }).statusLabel, 'Unknown resolution status')
  assert.equal(presentReviewResolution(null), null)
})

test('confirmation separates mixed writes and manual tasks and retains explicit clearing values', () => {
  const review = presentSampleReviewItem({ reason: 'nonblank_field_difference', objectType: 'contacts', sourceId: '34',
    sourceSnapshot: { email: 'hs@example.com', phoneNumber: '5551112222' }, candidateSnapshots: [{ id: '2590478' }],
    proposedChanges: { conflicts: { email: { proposed: 'hs@example.com', current: 'albi@example.com' },
      phoneNumber: { proposed: '5551112222', current: '5553334444' }, city: { proposed: 'London', current: null } } } })
  assert.deepEqual(buildResolutionConfirmation({ review, decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } } }), {
    hubspotWrites: [{ field: 'Email', value: 'albi@example.com' }],
    albiTasks: [{ field: 'Phone', value: '5551112222', url: 'https://app.albiware.com/Relationships/Contact/2590478' }], mapping: null, association: null,
  })
  assert.deepEqual(buildResolutionConfirmation({ review, decision: { action: 'resolve_fields', fieldChoices: { city: 'albi' } } }).hubspotWrites,
    [{ field: 'City', value: null }])
  assert.throws(() => buildResolutionConfirmation({ review, decision: { action: 'resolve_fields', fieldChoices: { id: 'albi' } } }), TypeError)
  // Contact field reviews may confirm the link (for example, emails match and phone/address are ignored).
  assert.equal(buildResolutionConfirmation({ review, decision: { action: 'link_existing', candidateId: '2590478' } }).mapping.targetId, '2590478')
  const company = presentSampleReviewItem({ reason: 'nonblank_field_difference', objectType: 'companies', sourceId: '34', candidateSnapshots: [{ id: '2590478' }] })
  // Organization field reviews may confirm the link too; only contacts may choose an organization context.
  assert.equal(buildResolutionConfirmation({ review: company, decision: { action: 'link_existing', candidateId: '2590478' } }).mapping.targetId, '2590478')
  assert.throws(() => buildResolutionConfirmation({ review: company, decision: { action: 'choose_organization', organizationSourceId: '22', addHubSpotAssociation: false } }), TypeError)
})

test('identity and organization confirmation name the consequence without trusting incoming links', () => {
  const review = presentSampleReviewItem({ objectType: 'companies', reason: 'name_only_candidate', sourceId: '34', portalId: '12',
    candidateSnapshots: [{ id: '2590478', url: 'https://evil.test' }] })
  assert.deepEqual(buildResolutionConfirmation({ review, decision: { action: 'link_existing', candidateId: '2590478', approveManyToOne: true } }), {
    hubspotWrites: [], albiTasks: [], mapping: { objectType: 'companies', sourceId: '34', targetId: '2590478', approveManyToOne: true,
      url: 'https://app.albiware.com/Relationships/Organization/2590478' }, association: null,
  })
  assert.deepEqual(buildResolutionConfirmation({ review, decision: { action: 'create_albi' } }).mapping,
    { objectType: 'companies', sourceId: '34', targetId: null, createAlbi: true })
  assert.throws(() => buildResolutionConfirmation({ review, decision: { action: 'link_existing', candidateId: '999' } }), TypeError)
  const contact = presentSampleReviewItem({ objectType: 'contacts', reason: 'multiple_associated_organizations', sourceId: '34', portalId: '12' })
  assert.deepEqual(buildResolutionConfirmation({ review: contact, decision: { action: 'choose_organization', organizationSourceId: '22', addHubSpotAssociation: false } }).association,
    { contactId: '34', organizationSourceId: '22', addHubSpotAssociation: false, url: 'https://app.hubspot.com/contacts/12/record/0-2/22' })
  assert.equal(buildResolutionConfirmation({ review: contact, decision: { action: 'choose_organization', organizationSourceId: '22', addHubSpotAssociation: true } }).association.addHubSpotAssociation, true)
})

test('unavailable field evidence cannot imply a clearing write and unsafe IDs never make links', () => {
  const review = presentSampleReviewItem({ objectType: 'contacts', reason: 'nonblank_field_difference', sourceId: 'javascript:1', portalId: 'https://evil.test',
    candidateSnapshots: [{ id: '2590478' }], proposedChanges: { conflicts: { email: { proposed: 'hs@example.com' } } },
    resolutionCapability: { enabled: true, mode: 'SECRET', canResolve: true, hubspotWrites: 'SECRET' } })
  assert.deepEqual(review.resolutionFields, [])
  assert.equal(review.hubspotUrl, null)
  assert.deepEqual(review.resolutionCapability, { enabled: false, mode: 'disabled', canResolve: false, hubspotWrites: 'verified_when_first_used' })
  assert.throws(() => buildResolutionConfirmation({ review, decision: { action: 'resolve_fields', fieldChoices: { email: 'albi' } } }), TypeError)
  assert.deepEqual(presentReviewResolution({ events: [{ eventType: 'SECRET', details: { manualTasks: [
    { provider: 'albi', objectType: 'contacts', targetId: 'javascript:1', fields: [{ field: 'email', value: 'ok' }] },
  ] } }] }).events[0].manualTasks, [])
})

test('breakdown retains the queue label for formerly collapsed review reasons', () => {
  const breakdown = presentReviewBreakdown({ mode: 'dry_run', sampleLimitPerType: 10, totals: { requires_review: 1 },
    reviewBreakdown: [{ kind: 'record', objectType: 'contacts', reason: 'organization_unresolved', count: 1 }] })
  assert.equal(breakdown.groups[0].items[0].reasonLabel, 'Organization needs review')
  assert.equal(presentSampleReviewItem({ reason: 'organization_unresolved' }).reasonLabel, 'Organization needs review')
  assert.equal(presentSampleReviewItem({ reason: 'email_phone_disagree' }).reasonLabel, 'Email and phone point to different records')
})
import {
  SAMPLE_REVIEW_GUIDANCE,
  SAMPLE_REVIEW_REASON_OPTIONS,
  presentSampleReviewItem,
  presentSampleReviewProgress,
} from '../../src/features/hubspotToAlbi/sampleReview.js'

test('fixed review reasons share filter labels while the unknown fallback stays presentation-only', () => {
  assert.deepEqual(SAMPLE_REVIEW_REASON_OPTIONS, Object.entries(SAMPLE_REVIEW_GUIDANCE).filter(([value]) => value !== 'other_review_reason').map(([value, copy]) => ({
    value, label: copy.label,
  })))
  assert.equal(SAMPLE_REVIEW_REASON_OPTIONS.some(option => option.value === 'other_review_reason'), false)
  assert.equal(presentSampleReviewItem({ reason: 'unrecognized' }).reasonLabel, 'Other review reason')
  for (const [reason, copy] of Object.entries(SAMPLE_REVIEW_GUIDANCE)) {
    const presented = presentSampleReviewItem({ reason })
    assert.equal(presented.reasonLabel, copy.label)
    assert.equal(presented.guidance, copy.guidance)
  }
})

test('unknown reason and unapproved item properties never enter presentation copy', () => {
  const rawReason = 'provider-secret-reason'
  const presented = presentSampleReviewItem({ reason: rawReason, privatePayload: 'SECRET' })
  assert.equal(presented.reasonLabel, SAMPLE_REVIEW_GUIDANCE.other_review_reason.label)
  assert.equal(presented.guidance, SAMPLE_REVIEW_GUIDANCE.other_review_reason.guidance)
  assert.equal(JSON.stringify(presented).includes(rawReason), false)
  assert.equal(JSON.stringify(presented).includes('SECRET'), false)
})

test('detail presentation allowlists direct identity fields and fixed side-by-side comparisons', () => {
  const presented = presentSampleReviewItem({
    id: 'review-1', sourceId: 'hs-1', objectType: 'contacts', reason: 'name_only_candidate', status: 'needs_review',
    sourceSnapshot: {
      id: 'hs-1', fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test',
      phoneNumber: '555-0100', mobileNumber: '555-0101', organizationId: 'hs-company', organizationName: 'Analytical Engines',
      domain: 'example.test', jobTitle: 'Engineer', address1: '1 Main St', address2: 'Suite 2', city: 'London', state: 'LN', zipcode: 'N1', country: 'UK',
      notes: 'PRIVATE',
    },
    proposedChanges: { conflicts: { email: { current: 'ada@albi.test', proposed: 'ada@example.test' }, notes: { current: 'SECRET', proposed: 'SECRET' } },
      updates: { jobTitle: 'SECRET' }, unchanged: ['city', 'notes'] },
    candidateSnapshots: [{
      id: 'albi-1', fullName: 'Ada L.', firstName: 'Ada', lastName: 'L.', email: 'ada@albi.test', phoneNumber: '555-0100',
      mobileNumber: '555-0102', organizationId: 'org-1', organizationName: 'Engines Ltd', domain: 'albi.test',
      address1: '2 High St', address2: 'Floor 3', city: 'London', state: 'LDN', zipcode: 'N2', country: 'UK',
      notes: 'SECRET CANDIDATE FIELD',
    }],
  })

  assert.deepEqual(presented.source, {
    id: 'hs-1', fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test',
    phoneNumber: '555-0100', mobileNumber: '555-0101', organizationId: 'hs-company', organizationName: 'Analytical Engines',
    domain: 'example.test', jobTitle: 'Engineer', address1: '1 Main St', address2: 'Suite 2', city: 'London', state: 'LN', zipcode: 'N1', country: 'UK',
  })
  assert.equal(presented.candidates[0].id, 'albi-1')
  assert.deepEqual(presented.candidates[0].comparisons, [
    { key: 'id', label: 'ID', hubspot: 'hs-1', albi: 'albi-1' },
    { key: 'fullName', label: 'Full name', hubspot: 'Ada Lovelace', albi: 'Ada L.' },
    { key: 'name', label: 'Name', hubspot: 'Not provided', albi: 'Not provided' },
    { key: 'firstName', label: 'First name', hubspot: 'Ada', albi: 'Ada' },
    { key: 'lastName', label: 'Last name', hubspot: 'Lovelace', albi: 'L.' },
    { key: 'email', label: 'Email', hubspot: 'ada@example.test', albi: 'ada@albi.test' },
    { key: 'phoneNumber', label: 'Phone', hubspot: '555-0100', albi: '555-0100' },
    { key: 'mobileNumber', label: 'Mobile', hubspot: '555-0101', albi: '555-0102' },
    { key: 'organizationId', label: 'Organization ID', hubspot: 'hs-company', albi: 'org-1' },
    { key: 'organizationName', label: 'Organization', hubspot: 'Analytical Engines', albi: 'Engines Ltd' },
    { key: 'domain', label: 'Domain', hubspot: 'example.test', albi: 'albi.test' },
    { key: 'jobTitle', label: 'Job title', hubspot: 'Engineer', albi: 'Not provided' },
    { key: 'address1', label: 'Address', hubspot: '1 Main St', albi: '2 High St' },
    { key: 'address2', label: 'Address line 2', hubspot: 'Suite 2', albi: 'Floor 3' },
    { key: 'city', label: 'City', hubspot: 'London', albi: 'London' },
    { key: 'state', label: 'State / region', hubspot: 'LN', albi: 'LDN' },
    { key: 'zipcode', label: 'Postal code', hubspot: 'N1', albi: 'N2' },
    { key: 'country', label: 'Country', hubspot: 'UK', albi: 'UK' },
  ])
  assert.equal(JSON.stringify(presented).includes('SECRET'), false)
  assert.equal(JSON.stringify(presented).includes('PRIVATE'), false)
  assert.deepEqual(presented.proposedChanges, [
    { key: 'email', label: 'Email', hubspot: 'ada@example.test', albi: 'ada@albi.test' },
  ])
})

test('a job-title-only conflict retains both approved values in comparisons and differences', () => {
  const presented = presentSampleReviewItem({ objectType: 'contacts', reason: 'nonblank_field_difference',
    sourceSnapshot: { id: 'hs-1', jobTitle: 'Engineer' }, candidateSnapshots: [{ id: 'albi-1', jobTitle: 'Manager' }],
    proposedChanges: { conflicts: { jobTitle: { current: 'Manager', proposed: 'Engineer' } } } })
  assert.equal(presented.source.jobTitle, 'Engineer')
  assert.deepEqual(presented.candidates[0].comparisons.find(field => field.key === 'jobTitle'),
    { key: 'jobTitle', label: 'Job title', hubspot: 'Engineer', albi: 'Manager' })
  assert.deepEqual(presented.proposedChanges, [{ key: 'jobTitle', label: 'Job title', hubspot: 'Engineer', albi: 'Manager' }])
})

test('malformed item data is normalized to safe defaults', () => {
  const presented = presentSampleReviewItem({
    status: 'provider-status', sourceSnapshot: ['unexpected'], candidateSnapshots: { private: 'SECRET' },
    matchEvidence: ['email', { token: 'SECRET' }], proposedChanges: ['bad'],
  })
  assert.equal(presented.status, 'needs_review')
  assert.deepEqual(presented.source, {})
  assert.deepEqual(presented.candidates, [])
  assert.deepEqual(presented.matchEvidence, ['email'])
  assert.deepEqual(presented.proposedChanges, [])
  assert.equal(JSON.stringify(presented).includes('SECRET'), false)
})

test('progress has stable ordering and rejects malformed counts', () => {
  assert.deepEqual(presentSampleReviewProgress({
    total: 4, needsReview: 2, cleared: 1, noLongerInScope: 1, fullDryRunReady: false,
  }), [
    { key: 'needsReview', label: 'Needs review', value: 2 },
    { key: 'cleared', label: 'Cleared', value: 1 },
    { key: 'noLongerInScope', label: 'No longer in scope', value: 1 },
  ])
  assert.deepEqual(presentSampleReviewProgress({ total: '4', needsReview: -1, cleared: 2.5, noLongerInScope: 0 }), [
    { key: 'needsReview', label: 'Needs review', value: 0 },
    { key: 'cleared', label: 'Cleared', value: 0 },
    { key: 'noLongerInScope', label: 'No longer in scope', value: 0 },
  ])
})

test('the live HubSpot association fills the source organization when the snapshot has none', () => {
  const base = { objectType: 'contacts', reason: 'nonblank_field_difference', status: 'needs_review', sourceSnapshot: { id: '1', firstName: 'A', lastName: 'B' } }
  assert.equal(presentSampleReviewItem({ ...base, hubspotOrganizations: [{ sourceId: '9', name: 'Lido House' }, { sourceId: '8', name: 'Other' }] }).source.organizationName, 'Lido House, Other')
  assert.equal(presentSampleReviewItem({ ...base, sourceSnapshot: { ...base.sourceSnapshot, organizationName: 'Snapshot Co' }, hubspotOrganizations: [{ sourceId: '9', name: 'Lido House' }] }).source.organizationName, 'Snapshot Co')
  for (const bad of [undefined, null, [], [{ sourceId: 'x', name: 5 }], 'Lido House']) {
    assert.equal(presentSampleReviewItem({ ...base, hubspotOrganizations: bad }).source.organizationName, undefined)
  }
})

test('a cleared safe-to-link review offers only linking', () => {
  const linkable = presentSampleReviewItem({ reason: 'no_match', objectType: 'contacts', status: 'cleared', recheckOutcome: 'safe_to_link', candidateSnapshots: [{ id: '20' }] })
  assert.deepEqual(linkable.actions, ['link_existing'])
  assert.deepEqual(presentSampleReviewItem({ reason: 'no_match', objectType: 'contacts', status: 'cleared', recheckOutcome: 'safe_to_link', candidateSnapshots: [] }).actions, [])
})

test('fields HubSpot leaves blank but Albi has are offered to fill from Albi', () => {
  const review = presentSampleReviewItem({ reason: 'nonblank_field_difference', objectType: 'contacts', sourceId: '34', status: 'needs_review',
    sourceSnapshot: { email: 'hs@example.com' }, candidateSnapshots: [{ id: '2590478', email: 'albi@example.com', jobTitle: 'Manager', city: 'Ontario' }],
    proposedChanges: { conflicts: { email: { proposed: 'hs@example.com', current: 'albi@example.com' } } } })
  assert.deepEqual(review.fillableFields.map(field => [field.key, field.albi]), [['jobTitle', 'Manager'], ['city', 'Ontario']])
  assert.deepEqual(buildResolutionConfirmation({ review, decision: { action: 'resolve_fields', fieldChoices: { city: 'albi' } } }).hubspotWrites,
    [{ field: 'City', value: 'Ontario' }])
  assert.throws(() => buildResolutionConfirmation({ review, decision: { action: 'resolve_fields', fieldChoices: { city: 'hubspot' } } }), TypeError)
  const organization = presentSampleReviewItem({ reason: 'nonblank_field_difference', objectType: 'companies', sourceId: '34', status: 'needs_review',
    sourceSnapshot: { name: 'Acme' }, candidateSnapshots: [{ id: '9', name: 'Acme', phoneNumber: '555-111-2222' }], proposedChanges: {} })
  assert.deepEqual(organization.fillableFields.map(field => field.key), ['phoneNumber'])
})
