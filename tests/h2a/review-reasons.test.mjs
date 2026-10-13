import assert from 'node:assert/strict'
import test from 'node:test'
import { REVIEW_REASONS } from '../../netlify/functions/_h2a/review.js'
import { H2A_REVIEW_REASON_CATALOG, getH2AReviewReason, listH2AReviewReasonOptions } from '../../shared/h2aReviewReasons.js'
import { buildAlbiRecordUrl, buildHubSpotRecordUrl } from '../../shared/h2aProviderLinks.js'

test('stored review reasons have safe shared presentation and action metadata', () => {
  for (const reason of REVIEW_REASONS) {
    const entry = getH2AReviewReason(reason)
    assert.equal(entry.code, reason)
    assert.ok(entry.label)
    assert.ok(Object.isFrozen(entry.actions))
    const allowed = { identity: ['link_existing', 'create_albi'], field: ['resolve_fields'], association: ['choose_organization'] }[entry.category] ?? []
    assert.ok(entry.actions.every(action => allowed.includes(action)))
  }
  assert.equal(getH2AReviewReason('missing_hubspot_company').label, 'HubSpot company is missing')
  assert.deepEqual(getH2AReviewReason('missing_hubspot_company').actions, ['choose_organization'])
  assert.deepEqual(getH2AReviewReason('nonblank_field_difference').actions, ['resolve_fields'])
  assert.deepEqual(getH2AReviewReason('organization_unresolved').actions, ['choose_organization'])
  assert.deepEqual(getH2AReviewReason('auth:network').actions, [])
  assert.equal(getH2AReviewReason('__proto__').code, 'other_review_reason')
  assert.equal(getH2AReviewReason('secret').code, 'other_review_reason')
  assert.ok(Object.isFrozen(H2A_REVIEW_REASON_CATALOG))
  assert.equal(REVIEW_REASONS.has('planned_record_dependency'), false)
  assert.equal(REVIEW_REASONS.has('other_review_reason'), false)
  assert.equal(getH2AReviewReason('planned_record_dependency').label, 'Depends on a record that would be created')
})

test('reason filters are scoped to known codes present in a sample', () => {
  assert.deepEqual(listH2AReviewReasonOptions(['missing_hubspot_company', 'secret', 'missing_hubspot_company']), [
    { value: 'missing_hubspot_company', label: 'HubSpot company is missing' },
  ])
  assert.deepEqual(listH2AReviewReasonOptions([]), [])
  assert.ok(listH2AReviewReasonOptions().some(row => row.value === 'auth:network'))
  assert.equal(listH2AReviewReasonOptions().some(row => row.value === 'other_review_reason'), false)
})

test('provider links accept only positive decimal IDs and fixed object types', () => {
  assert.equal(buildAlbiRecordUrl('contacts', '2590478'), 'https://app.albiware.com/Relationships/Contact/2590478')
  assert.equal(buildAlbiRecordUrl('companies', 635650), 'https://app.albiware.com/Relationships/Organization/635650')
  assert.equal(buildHubSpotRecordUrl('123', 'contacts', '456'), 'https://app.hubspot.com/contacts/123/record/0-1/456')
  assert.equal(buildHubSpotRecordUrl(123, 'companies', 456), 'https://app.hubspot.com/contacts/123/record/0-2/456')
  for (const invalid of ['javascript:alert(1)', '0', '01', '-1', '1/2', ' 1', '', null, {}, 1.5, Infinity]) {
    assert.equal(buildAlbiRecordUrl('contacts', invalid), null)
    assert.equal(buildHubSpotRecordUrl('123', 'contacts', invalid), null)
    assert.equal(buildHubSpotRecordUrl(invalid, 'contacts', '456'), null)
  }
  assert.equal(buildAlbiRecordUrl('__proto__', '123'), null)
  assert.equal(buildHubSpotRecordUrl('123', 'notes', '456'), null)
})
