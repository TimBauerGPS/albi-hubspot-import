import assert from 'node:assert/strict'
import test from 'node:test'
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
