import assert from 'node:assert/strict'
import test from 'node:test'
import { rankReviewCandidates } from '../../netlify/functions/_h2a/ranking.js'
import { projectReviewRow, safeReviewSnapshot } from '../../netlify/functions/_h2a/review.js'

const rank = (over) => rankReviewCandidates({ objectType: 'contacts', source: {}, candidates: [], mappings: [], portalId: '1', sourceId: 'hs-1', ...over })

test('trimmed, case-insensitive email is same_email and Strong', () => {
  const r = rank({ source: { email: ' Lena@x.com' }, candidates: [{ id: 'a1', email: 'LENA@x.com ' }] })
  assert.deepEqual(r.candidates[0].matchReasons, ['same_email'])
  assert.equal(r.candidates[0].strength, 'Strong')
  assert.equal(r.suggestedCandidateId, 'a1')
})

test('additional HubSpot email matching Albi email is same_other_email', () => {
  const r = rank({ source: { email: 'a@x.com', additionalEmails: 'b@x.com; Lena@x.com' }, candidates: [{ id: 'a1', email: 'lena@x.com' }] })
  assert.ok(r.candidates[0].matchReasons.includes('same_other_email'))
  assert.equal(r.candidates[0].strength, 'Strong')
  assert.ok(!r.candidates[0].warnings.includes('different_email'))
})

test('HubSpot phone equal to Albi mobile is phone_matches_mobile and Likely', () => {
  const r = rank({ source: { phoneNumber: '(555) 123-4567' }, candidates: [{ id: 'a1', mobileNumber: '555-123-4567' }] })
  assert.deepEqual(r.candidates[0].matchReasons, ['phone_matches_mobile'])
  assert.equal(r.candidates[0].strength, 'Likely')
  assert.equal(r.suggestedCandidateId, null)
})

test('different emails add a warning and prevent Strong', () => {
  const r = rank({ source: { email: 'a@x.com', firstName: 'Lena', lastName: 'Q', organizationName: 'Acme' },
    candidates: [{ id: 'a1', email: 'b@x.com', firstName: 'Lena', lastName: 'Q', organizationName: 'Acme' }] })
  assert.deepEqual(r.candidates[0].warnings, ['different_email'])
  assert.equal(r.candidates[0].strength, 'Likely')
  const s = rank({ source: { email: 'a@x.com', phoneNumber: '5551234567' }, candidates: [{ id: 'a1', email: 'A@x.com', phoneNumber: '5551234567' }] })
  assert.equal(s.candidates[0].strength, 'Strong')
  const w = rank({ source: { email: 'a@x.com' }, candidates: [{ id: 'a1', email: 'b@x.com' }] })
  assert.equal(w.candidates[0].strength, 'Weak')
})

test('a candidate mapped to another HubSpot source warns already_linked_elsewhere and is never suggested', () => {
  const r = rank({ source: { email: 'a@x.com' }, candidates: [{ id: 'a1', email: 'a@x.com' }],
    mappings: [{ hubspot_id: 'hs-other', albi_contact_id: 'a1', portal_id: '1' }, { hubspot_id: 'hs-1', albi_contact_id: 'a1', portal_id: '1' }] })
  assert.deepEqual(r.candidates[0].warnings, ['already_linked_elsewhere'])
  assert.equal(r.candidates[0].linkedElsewhere, 1)
  assert.equal(r.suggestedCandidateId, null)
})

test('two Strong candidates produce no suggestion', () => {
  const r = rank({ source: { email: 'a@x.com' }, candidates: [{ id: 'a1', email: 'a@x.com' }, { id: 'a2', email: 'a@x.com' }] })
  assert.equal(r.suggestedCandidateId, null)
})

test('organization with same domain is Strong', () => {
  const r = rank({ objectType: 'companies', source: { name: 'Acme', domain: 'https://www.acme.com/x' },
    candidates: [{ id: 'o1', name: 'Other', domain: 'acme.com' }],
    mappings: [{ hubspot_id: 'hs-9', albi_organization_id: 'o2', portal_id: '1' }] })
  assert.deepEqual(r.candidates[0].matchReasons, ['same_domain'])
  assert.equal(r.candidates[0].strength, 'Strong')
  assert.equal(r.suggestedCandidateId, 'o1')
})

test('ordering is strength, then reason count, then id', () => {
  const r = rank({ source: { email: 'a@x.com', phoneNumber: '5551234567', firstName: 'Lena' }, candidates: [
    { id: 'z', firstName: 'Lena' }, { id: 'b', email: 'a@x.com' }, { id: 'a', email: 'a@x.com' },
    { id: 'c', email: 'a@x.com', phoneNumber: '5551234567' }, { id: 'y', phoneNumber: '5551234567' } ] })
  assert.deepEqual(r.candidates.map(c => c.id), ['c', 'a', 'b', 'y', 'z'])
})

test('safeReviewSnapshot keeps additionalEmails and projectReviewRow detail ranks candidates', () => {
  const snap = safeReviewSnapshot({ id: 'hs-1', properties: { hs_additional_emails: 'l@x.com;m@x.com' } }, 'contacts')
  assert.equal(snap.additionalEmails, 'l@x.com;m@x.com')
  const row = { id: 'r1', object_type: 'contacts', source_id: 'hs-1', portal_id: '1',
    source_snapshot: { id: 'hs-1', email: 'a@x.com' }, candidate_snapshots: [{ id: 'a1', email: 'a@x.com' }] }
  const detail = projectReviewRow(row, { detail: true })
  assert.equal(detail.suggestedCandidateId, 'a1')
  assert.equal(detail.rankedCandidates[0].strength, 'Strong')
  const linked = projectReviewRow(row, { detail: true, mappings: { contacts: [{ hubspot_id: 'x', albi_contact_id: 'a1', portal_id: '1' }], companies: [] } })
  assert.equal(linked.suggestedCandidateId, null)
  assert.equal('rankedCandidates' in projectReviewRow(row), false)
})
