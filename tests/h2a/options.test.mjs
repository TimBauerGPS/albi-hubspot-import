import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveActivityType, resolveContactType } from '../../netlify/functions/_h2a/options.js'

test('uses a confirmed organization-to-contact mapping when inheritance is enabled', () => {
  assert.deepEqual(resolveContactType({ inheritFromOrganization: true, organizationTypeId: '11616',
    mappings: [{ mapping_kind: 'organization_to_contact_type', source_key: '11616', albi_id: '11611', confirmed_at: '2026-10-01T12:00:00.000Z' }],
    defaultContactTypeId: '11610' }), { action: 'resolved', contactTypeId: '11611', source: 'organization_mapping' })
})

test('falls back to a confirmed tenant default if inheritance is off or unmapped', () => {
  for (const input of [
    { inheritFromOrganization: false, organizationTypeId: '11616' },
    { inheritFromOrganization: true, organizationTypeId: 'unknown' },
  ]) assert.deepEqual(resolveContactType({ ...input, mappings: [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '11610', confirmed_at: '2026-10-01T12:00:00.000Z' }] }),
    { action: 'resolved', contactTypeId: '11610', source: 'default' })
})

test('suggestions and same-label values in other namespaces never authorize writes', () => {
  const result = resolveContactType({ inheritFromOrganization: true, organizationTypeId: 'same-id',
    organizationType: { id: 'same-id', label: 'Referral' }, contactTypes: [{ id: 'same-id', label: 'Referral' }],
    suggestions: [{ mapping_kind: 'organization_to_contact_type', source_key: 'same-id', albi_id: 'same-id', label: 'Referral' }],
    defaultContactTypeId: 'unconfirmed-default', defaultConfirmed: false })
  assert.equal(result.action, 'conflict')
  assert.equal(result.reason, 'contact_type_confirmation_required')
})

test('requires confirmed tenant activity mappings and returns an actionable conflict', () => {
  assert.deepEqual(resolveContactType({ defaultContactTypeId: null }), {
    action: 'conflict', reason: 'contact_type_confirmation_required', conflict: { kind: 'default_contact_type', actionable: true },
  })
})

test('activity type mappings require tenant confirmation and the matching activity namespace', () => {
  assert.deepEqual(resolveActivityType({ objectType: 'emails', mappings: [
    { mapping_kind: 'activity_type', source_key: 'emails', albi_id: '6711', confirmed_at: '2026-10-01T12:00:00.000Z' },
    { mapping_kind: 'organization_to_contact_type', source_key: 'emails', albi_id: '6711', confirmed: true },
  ] }), { action: 'resolved', activityTypeId: '6711' })
  assert.equal(resolveActivityType({ objectType: 'emails', mappings: [
    { mapping_kind: 'activity_type', source_key: 'emails', albi_id: '6711', confirmed: false },
  ] }).action, 'conflict')
})

test('blank, null, and malformed confirmation timestamps never authorize option IDs', () => {
  for (const confirmed_at of [null, '', '   ', 'not-a-date', '2026-02-30T12:00:00Z']) {
    const result = resolveContactType({ mappings: [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '11610', confirmed_at }] })
    assert.equal(result.action, 'conflict')
  }
  assert.equal(resolveActivityType({ objectType: 'emails', mappings: [
    { mapping_kind: 'activity_type', source_key: 'emails', albi_id: '6711', confirmed_at: ' ' },
  ] }).action, 'conflict')
})
