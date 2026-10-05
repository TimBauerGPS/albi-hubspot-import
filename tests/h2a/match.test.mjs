import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideContactMatch,
  decideFieldChanges,
  decideOrganizationMatch,
} from '../../netlify/functions/_h2a/match.js'

const contact = (id, fields) => ({ id, ...fields })
const org = (id, fields) => ({ id, ...fields })

test('links one exact normalized contact email', () => {
  const result = decideContactMatch({
    sourceId: 'hs-1', source: { email: ' JANE@EXAMPLE.COM ' },
    candidates: [contact('albi-1', { email: 'jane@example.com' })],
  })
  assert.equal(result.action, 'link')
  assert.equal(result.targetId, 'albi-1')
  assert.deepEqual(result.evidence, ['email'])
  assert.deepEqual(result.proposedChanges, { updates: {}, conflicts: {}, unchanged: ['email'] })
})

test('links one exact normalized contact phone', () => {
  const result = decideContactMatch({
    source: { phone: '+1 (415) 555-0123' },
    candidates: [contact('albi-1', { phone: '4155550123' })],
  })
  assert.equal(result.action, 'link')
  assert.equal(result.targetId, 'albi-1')
  assert.deepEqual(result.evidence, ['phone'])
})

test('conflicts when email and phone point to different contact records', () => {
  const result = decideContactMatch({
    source: { email: 'jane@example.com', phone: '4155550123' },
    candidates: [
      contact('by-email', { email: 'jane@example.com' }),
      contact('by-phone', { phone: '4155550123' }),
    ],
  })
  assert.equal(result.action, 'conflict')
  assert.equal(result.reason, 'email_phone_disagree')
})

test('conflicts on duplicate exact contact email or phone candidates', () => {
  for (const candidates of [
    [contact('a', { email: 'jane@example.com' }), contact('b', { email: 'jane@example.com' })],
    [contact('a', { phone: '4155550123' }), contact('b', { phone: '(415) 555-0123' })],
  ]) {
    assert.equal(decideContactMatch({
      source: { email: 'jane@example.com', phone: '4155550123' }, candidates,
    }).reason, 'duplicate_candidates')
  }
})

test('does not treat unsupported phone extensions as exact identity evidence', () => {
  const result = decideContactMatch({
    sourceId: 'hs-1', source: { phone: '415-555-0123 ext 204' },
    candidates: [contact('albi-1', { phoneNumber: '415-555-0123 ext 205' })],
  })
  assert.equal(result.action, 'conflict')
  assert.equal(result.reason, 'unsupported_phone_evidence')
})

test('exact email match conflicts when both records have different phone identity evidence', () => {
  const result = decideContactMatch({
    sourceId: 'hs-1', source: { email: 'jane@example.com', phone: '4155550123' },
    candidates: [contact('albi-1', { email: 'jane@example.com', phoneNumber: '5105550199' })],
  })
  assert.equal(result.action, 'conflict')
  assert.equal(result.reason, 'email_phone_disagree')
})

test('routes name-only contact candidates to review and creates when none exist', () => {
  const review = decideContactMatch({
    source: { firstName: 'Jane', lastName: 'Doe' },
    candidates: [contact('albi-1', { firstName: 'Jane', lastName: 'Doe' })],
  })
  assert.equal(review.action, 'conflict')
  assert.equal(review.reason, 'name_only_candidate')
  assert.equal(decideContactMatch({
    source: { firstName: 'New', lastName: 'Person', email: 'new@example.com' }, candidates: [],
  }).action, 'create')
  assert.equal(decideContactMatch({ source: { firstName: 'New' }, candidates: [] }).reason, 'missing_required_name')
})

test('honors an existing contact mapping unless another source already owns its target', () => {
  const mapped = decideContactMatch({
    sourceId: 'hs-1', source: {}, candidates: [], existingMapping: { sourceId: 'hs-1', targetId: 'albi-1' },
  })
  assert.deepEqual([mapped.action, mapped.targetId, mapped.reason], ['link', 'albi-1', 'existing_mapping'])
  const collision = decideContactMatch({
    sourceId: 'hs-1', source: {}, candidates: [], existingMapping: { targetId: 'albi-1' },
    mappings: [{ sourceId: 'hs-2', targetId: 'albi-1' }],
  })
  assert.equal(collision.action, 'conflict')
  assert.equal(collision.reason, 'target_already_mapped')
})

test('conflicts instead of creating a second contact source mapping automatically', () => {
  const result = decideContactMatch({
    sourceId: 'hs-2', source: { email: 'jane@example.com' },
    candidates: [contact('albi-1', { email: 'jane@example.com' })],
    mappings: [{ sourceId: 'hs-1', targetId: 'albi-1' }],
  })
  assert.equal(result.action, 'conflict')
  assert.equal(result.reason, 'target_already_mapped')
})

test('fails closed on target ownership when the current source ID is missing', () => {
  const result = decideContactMatch({
    source: { email: 'jane@example.com' },
    candidates: [contact('albi-1', { email: 'jane@example.com' })],
    mappings: [{ hubspot_id: 'hs-owner', albi_contact_id: 'albi-1' }],
  })
  assert.equal(result.action, 'conflict')
  assert.equal(result.reason, 'target_already_mapped')
})

test('matches directly from HubSpot adapter properties and Albi contact fields', () => {
  const result = decideContactMatch({
    sourceContact: { id: 'hs-1', properties: {
      firstname: 'Jane', lastname: 'Doe', email: 'JANE@example.com', mobilephone: '4155550123',
    } },
    candidates: [contact('albi-1', { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', mobileNumber: '415-555-0123' })],
  })
  assert.equal(result.action, 'link')
  assert.equal(result.reason, 'unique_exact_match')
  assert.ok(result.evidence.includes('mobilePhone'))
})

test('accepts the persisted H2A mapping column names and checks target ownership', () => {
  const existing = decideContactMatch({
    sourceId: 'hs-1', source: {}, candidates: [],
    existingMapping: { id: 'mapping-row', hubspot_id: 'hs-1', albi_contact_id: 'albi-1' },
  })
  assert.deepEqual([existing.action, existing.targetId], ['link', 'albi-1'])

  const collision = decideOrganizationMatch({
    sourceId: 'hs-company-2', source: { domain: 'acme.com' },
    candidates: [org('org-1', { domain: 'acme.com' })],
    mappings: [{ hubspot_id: 'hs-company-1', albi_organization_id: 'org-1' }],
  })
  assert.equal(collision.reason, 'target_already_mapped')
})

test('links organizations by a unique exact normalized domain', () => {
  const result = decideOrganizationMatch({
    source: { name: 'Acme Inc', domain: 'https://www.Acme.com/' },
    candidates: [org('org-1', { domain: 'acme.com' })],
  })
  assert.equal(result.action, 'link')
  assert.equal(result.targetId, 'org-1')
  assert.deepEqual(result.evidence, ['domain'])
})

test('links organization by normalized name plus phone or address corroboration', () => {
  const byPhone = decideOrganizationMatch({
    source: { name: 'Acme, Inc.', phone: '4155550123' },
    candidates: [org('org-1', { name: 'ACME Inc', phone: '(415) 555-0123' })],
  })
  assert.equal(byPhone.action, 'link')
  assert.deepEqual(byPhone.evidence, ['name', 'phone'])
  const byAddress = decideOrganizationMatch({
    source: { name: 'Acme, Inc.', address: '123 Main St.' },
    candidates: [org('org-1', { name: 'ACME Inc', address: '123 Main Street' })],
  })
  assert.equal(byAddress.action, 'link')
  assert.deepEqual(byAddress.evidence, ['name', 'address'])
})

test('conflicts for organization name only, duplicates, and contradictory evidence', () => {
  const nameOnly = decideOrganizationMatch({
    source: { name: 'Acme' }, candidates: [org('org-1', { name: 'Acme' })],
  })
  assert.equal(nameOnly.reason, 'name_only_candidate')
  const duplicate = decideOrganizationMatch({
    source: { domain: 'acme.com' }, candidates: [org('a', { domain: 'acme.com' }), org('b', { domain: 'acme.com' })],
  })
  assert.equal(duplicate.reason, 'duplicate_candidates')
  const contradictory = decideOrganizationMatch({
    source: { domain: 'acme.com', name: 'Acme', phone: '4155550123' },
    candidates: [org('domain-org', { domain: 'acme.com' }), org('name-org', { name: 'Acme', phone: '4155550123' })],
  })
  assert.equal(contradictory.reason, 'contradictory_evidence')
})

test('applies shared field policy: equal unchanged, blank filled, different nonblank proposed', () => {
  const changes = decideFieldChanges({
    entityType: 'contact',
    source: { email: 'JANE@example.com', phone: '(415) 555-0123', address: '1 Oak Rd.' },
    target: { email: 'jane@EXAMPLE.com', phoneNumber: null, address1: '2 Pine Rd.' },
  })
  assert.deepEqual(changes, {
    updates: { phoneNumber: '415-555-0123' },
    conflicts: { address1: { current: '2 Pine Rd.', proposed: '1 Oak Rd.' } },
    unchanged: ['email'],
  })
})

test('routes phone values that cannot be safely written into field review', () => {
  const changes = decideFieldChanges({
    entityType: 'contact',
    source: { phone: '+1 415-555-0123 ext 9' },
    target: { phoneNumber: null },
  })
  assert.deepEqual(changes, {
    updates: {},
    conflicts: { phoneNumber: { current: null, proposed: '+1 415-555-0123 ext 9', reason: 'extension_not_supported' } },
    unchanged: [],
  })
})

test('emits only canonical Albi contact fields and ignores source aliases and unknown keys', () => {
  const changes = decideFieldChanges({
    entityType: 'contact',
    source: {
      id: 'hs-1', firstname: 'Jane', firstName: 'JANE', lastname: 'Doe', email: 'jane@example.com',
      phone: '4155550123', phoneNumber: '4155550123', mobilephone: '5105550199',
      address: '1 Oak St.', city: 'Oakland', zip: '94601', website: 'example.com', unknownField: 'drop me',
    },
    target: { id: 'albi-id', firstName: '', lastName: null, email: '', phoneNumber: '', mobileNumber: '', address1: '', city: '', zipcode: '' },
  })
  assert.deepEqual(changes.updates, {
    firstName: 'JANE', lastName: 'Doe', email: 'jane@example.com', phoneNumber: '415-555-0123',
    mobileNumber: '510-555-0199', address1: '1 Oak St.', city: 'Oakland', zipcode: '94601',
  })
})

test('treats whitespace-only Albi values as blank when filling allowed fields', () => {
  const changes = decideFieldChanges({
    entityType: 'contact', source: { email: 'jane@example.com' }, target: { email: '   ' },
  })
  assert.deepEqual(changes.updates, { email: 'jane@example.com' })
})

test('uses Albi address1 as organization address corroboration and requires a name for creation', () => {
  const linked = decideOrganizationMatch({
    sourceCompany: { id: 'hs-org', properties: { name: 'Acme', address: '123 Main St.' } },
    candidates: [org('albi-org', { name: 'ACME', address1: '123 Main Street' })],
  })
  assert.equal(linked.action, 'link')
  assert.deepEqual(linked.evidence, ['name', 'address'])

  const missingName = decideOrganizationMatch({ source: { domain: 'new.example' }, candidates: [] })
  assert.equal(missingName.action, 'conflict')
  assert.equal(missingName.reason, 'missing_required_name')
})
