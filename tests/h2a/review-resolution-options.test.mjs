import assert from 'node:assert/strict'
import test from 'node:test'
import { loadReviewResolutionOptions } from '../../netlify/functions/_h2a/reviewResolutionOptions.js'

const row = { object_type: 'contacts', source_id: '123', portal_id: '321', reason: 'organization_unresolved',
  status: 'needs_review', candidate_snapshots: [{ id: '456' }], source_snapshot: { id: '123' } }
const mappings = { contacts: [{ portal_id: '321', hubspot_id: '123', albi_contact_id: '456' }],
  organizations: [{ portal_id: '321', hubspot_id: '777', albi_organization_id: '888' }], options: [] }
const reads = { hubspotRead: {
  getContacts: async () => [{ id: '123', properties: {} }],
  getCompanies: async () => [{ id: '777', properties: {} }],
  getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: ['777'] }],
}, albiRead: {
  listContacts: async () => ({ records: [{ id: '456', organizationId: '999' }], cursor: null }),
  listOrganizations: async () => ({ records: [{ id: '888' }], cursor: null }),
} }

test('organization options come from fresh association and verified tenant mappings', async () => {
  const result = await loadReviewResolutionOptions({ row, repository: { getMappings: async () => mappings }, reads })
  assert.deepEqual(result.organizationOptions, [{ sourceId: '777', targetId: '888', contactTargetId: '456',
    currentOrganizationTargetId: '999', associated: true,
    contactUrl: 'https://app.albiware.com/Relationships/Contact/456',
    organizationUrl: 'https://app.albiware.com/Relationships/Organization/888' }])
})

test('missing or contradictory live association evidence leaves organization actions unavailable', async () => {
  for (const current of [[], [{ fromId: '123', toObjectType: 'companies', toIds: ['bad'] }],
    [{ fromId: '123', toObjectType: 'companies', toIds: ['777', '777'] }]]) {
    const result = await loadReviewResolutionOptions({ row, repository: { getMappings: async () => mappings },
      reads: { ...reads, hubspotRead: { ...reads.hubspotRead, getAssociations: async () => current } } })
    assert.deepEqual(result.organizationOptions, [])
  }
})

test('create readiness requires current identity, confirmed type, and resolvable associated organization', async () => {
  const createRow = { ...row, reason: 'no_match', recheck_outcome: null, candidate_snapshots: [],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const currentMappings = { ...mappings, contacts: [], options: [{ mapping_kind: 'default_contact_type',
    albi_id: '12', confirmed: true }] }
  const currentReads = { ...reads, hubspotRead: { ...reads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }] },
  albiRead: { ...reads.albiRead, listContacts: async () => ({ records: [], cursor: null }) } }
  const ready = await loadReviewResolutionOptions({ row: createRow, repository: { getMappings: async () => currentMappings }, reads: currentReads })
  assert.deepEqual(ready.createReadiness, { ready: true })
  const missingType = await loadReviewResolutionOptions({ row: createRow, repository: { getMappings: async () => ({ ...currentMappings, options: [] }) }, reads: currentReads })
  assert.deepEqual(missingType.createReadiness, { ready: false })
  const candidate = await loadReviewResolutionOptions({ row: createRow, repository: { getMappings: async () => currentMappings },
    reads: { ...currentReads, albiRead: { ...currentReads.albiRead,
      listContacts: async () => ({ records: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }], cursor: null }) } } })
  assert.deepEqual(candidate.createReadiness, { ready: false })
  const unreadable = await loadReviewResolutionOptions({ row: createRow, repository: { getMappings: async () => currentMappings },
    reads: { ...currentReads, albiRead: { ...currentReads.albiRead, listContacts: async () => ({}) } } })
  assert.deepEqual(unreadable.createReadiness, { ready: false })
  const stale = await loadReviewResolutionOptions({ row: { ...createRow, source_snapshot: { ...createRow.source_snapshot, firstName: 'Old' } },
    repository: { getMappings: async () => currentMappings }, reads: currentReads })
  assert.deepEqual(stale.createReadiness, { ready: false })
  const ambiguousMapping = await loadReviewResolutionOptions({ row: createRow,
    repository: { getMappings: async () => ({ ...currentMappings, contacts: [{ portal_id: '321', hubspot_id: '123', albi_contact_id: '456' }] }) },
    reads: currentReads })
  assert.deepEqual(ambiguousMapping.createReadiness, { ready: false })
})

test('fresh zero-association evidence can offer a mapped organization as an explicit addition', async () => {
  const result = await loadReviewResolutionOptions({ row, repository: { getMappings: async () => mappings },
    reads: { ...reads, hubspotRead: { ...reads.hubspotRead,
      getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: [] }] } } })
  assert.deepEqual(result.organizationOptions.map(option => ({ sourceId: option.sourceId, associated: option.associated })),
    [{ sourceId: '777', associated: false }])
})

test('duplicate organization mappings cannot become an actionable option', async () => {
  const duplicate = { ...mappings, organizations: [...mappings.organizations,
    { portal_id: '321', hubspot_id: '777', albi_organization_id: 'bad' }] }
  const result = await loadReviewResolutionOptions({ row, repository: { getMappings: async () => duplicate }, reads })
  assert.deepEqual(result.organizationOptions, [])
})
