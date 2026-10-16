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
  getOwnerId: async () => null,
  getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: ['777'] }],
}, albiRead: {
  listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }), 
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
  assert.deepEqual(ready.createReadiness, { ready: true, referralSources: [{ id: '5', label: 'Network' }] })
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

test('forced create readiness permits the captured candidate set but never an existing source mapping', async () => {
  const forceRow = { ...row, reason: 'name_only_candidate', candidate_snapshots: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const currentMappings = { contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type',
    source_key: 'default', albi_id: '12', confirmed: true }] }
  const currentReads = { ...reads, hubspotRead: { ...reads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: [] }] },
  albiRead: { ...reads.albiRead, listContacts: async () => ({ records: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }], cursor: null }) } }
  const ready = await loadReviewResolutionOptions({ row: forceRow, repository: { getMappings: async () => currentMappings }, reads: currentReads })
  assert.deepEqual(ready.forceCreateReadiness, { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }] })
  const mapped = await loadReviewResolutionOptions({ row: forceRow, repository: { getMappings: async () => ({ ...currentMappings,
    contacts: [{ portal_id: '321', hubspot_id: '123', albi_contact_id: '456' }] }) }, reads: currentReads })
  assert.deepEqual(mapped.forceCreateReadiness, { eligible: false, ready: false })

  const eleven = Array.from({ length: 11 }, (_, index) => ({ id: String(100 + index), firstName: 'Alex', lastName: 'Stone' }))
  const cappedRow = { ...forceRow, candidate_snapshots: eleven.slice(0, 10) }
  const capped = await loadReviewResolutionOptions({ row: cappedRow, repository: { getMappings: async () => currentMappings },
    reads: { ...currentReads, albiRead: { ...currentReads.albiRead,
      listContacts: async () => ({ records: eleven, cursor: null }) } } })
  assert.deepEqual(capped.forceCreateReadiness, { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }] })
})

test('forced create readiness uses the captured candidate set without enumerating Albi contacts', async () => {
  const forceRow = { ...row, reason: 'name_only_candidate', candidate_snapshots: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const currentMappings = { contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type',
    source_key: 'default', albi_id: '12', confirmed: true }] }
  const currentReads = { ...reads, hubspotRead: { ...reads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: [] }] },
  albiRead: { ...reads.albiRead, listContacts: async () => { throw Error('must not enumerate Albi contacts') } } }

  const result = await loadReviewResolutionOptions({ row: forceRow,
    repository: { getMappings: async () => currentMappings }, reads: currentReads })

  assert.deepEqual(result.forceCreateReadiness, { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }] })
})

test('forced create readiness starts independent repository and HubSpot reads together', async () => {
  const forceRow = { ...row, reason: 'name_only_candidate', candidate_snapshots: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const started = new Set()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const begin = async name => {
    started.add(name)
    if (started.size === 3) release()
    await gate
  }
  const result = await Promise.race([
    loadReviewResolutionOptions({ row: forceRow, repository: { getMappings: async () => {
      await begin('mappings')
      return { contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '12', confirmed: true }] }
    } }, reads: { hubspotRead: {
      getContacts: async () => { await begin('source'); return [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }] },
      getCompanies: async () => [],
      getOwnerId: async () => null,
      getAssociations: async () => { await begin('associations'); return [{ fromId: '123', toObjectType: 'companies', toIds: [] }] },
    }, albiRead: { listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }), listContacts: async () => { throw Error('must not enumerate Albi contacts') }, listOrganizations: async () => ({ records: [], cursor: null }) } } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('independent readiness reads were serialized')), 100)),
  ])

  assert.deepEqual(result.forceCreateReadiness, { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }] })
})

test('forced contact creation uses a mapped association without enumerating Albi organizations', async () => {
  const forceRow = { ...row, reason: 'name_only_candidate', candidate_snapshots: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const currentMappings = { contacts: [], organizations: [{ portal_id: '321', hubspot_id: '777', albi_organization_id: '888' }],
    options: [{ mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '12', confirmed: true }] }
  const currentReads = { ...reads, hubspotRead: { ...reads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }],
    getCompanies: async () => [{ id: '777', properties: { name: 'Acme' } }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: ['777'] }] },
  albiRead: { listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }), listContacts: async () => { throw Error('must not enumerate Albi contacts') },
    listOrganizations: async () => { throw Error('must not enumerate Albi organizations') } } }

  const result = await loadReviewResolutionOptions({ row: forceRow,
    repository: { getMappings: async () => currentMappings }, reads: currentReads })

  assert.deepEqual(result.forceCreateReadiness, { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }] })
})

test('forced contact creation can explicitly defer one current unmapped organization', async () => {
  const forceRow = { ...row, reason: 'name_only_candidate', candidate_snapshots: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const currentMappings = { contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type',
    source_key: 'default', albi_id: '12', confirmed: true }] }
  const currentReads = { ...reads, hubspotRead: { ...reads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }],
    getCompanies: async () => [{ id: '777', properties: { name: 'Unmapped Company' } }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: ['777'] }] },
  albiRead: { listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }), listContacts: async () => { throw Error('must not enumerate Albi contacts') },
    listOrganizations: async () => { throw Error('must not enumerate Albi organizations') } } }

  const result = await loadReviewResolutionOptions({ row: forceRow,
    repository: { getMappings: async () => currentMappings }, reads: currentReads })

  assert.deepEqual(result.forceCreateReadiness, { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }], deferredOrganizationSourceId: '777' })
})

test('fresh zero-association evidence can offer a mapped organization as an explicit addition', async () => {
  const result = await loadReviewResolutionOptions({ row, repository: { getMappings: async () => mappings },
    reads: { ...reads, hubspotRead: { ...reads.hubspotRead,
      getOwnerId: async () => null,
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

test('first sample derives advisory organization choices from unique live matches without mappings', async () => {
  const first = { ...row, reason: 'multiple_associated_organizations', candidate_snapshots: [] }
  const live = { hubspotRead: {
    getContacts: async () => [{ id: '123', properties: { firstname: 'A', lastname: 'B', email: 'a@example.com' } }],
    getCompanies: async ids => [{ id: ids[0], properties: { name: ids[0] === '777' ? 'One' : 'Two', domain: `${ids[0]}.example` } }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: ['777', '778'] }],
  }, albiRead: {
    listReferralSources: async () => [{ id: '5', label: 'Network' }], listCreateOptions: async () => ({ relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }),
    listContacts: async () => ({ records: [{ id: '456', firstName: 'A', lastName: 'B', email: 'a@example.com' }], cursor: null }),
    listOrganizations: async () => ({ records: [{ id: '888', name: 'One', domain: '777.example' },
      { id: '889', name: 'Two', domain: '778.example' }], cursor: null }),
  } }
  const result = await loadReviewResolutionOptions({ row: first, repository: { getMappings: async () => ({ contacts: [], organizations: [], options: [] }) }, reads: live })
  assert.deepEqual(result.organizationOptions.map(option => [option.sourceId, option.targetId, option.contactTargetId, option.associated]),
    [['777', '888', '456', true], ['778', '889', '456', true]])
})

test('create readiness names the missing Albi default instead of offering a create that cannot succeed', async () => {
  const createRow = { ...row, reason: 'no_match', recheck_outcome: null, candidate_snapshots: [],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const currentMappings = { ...mappings, contacts: [], options: [{ mapping_kind: 'default_contact_type', albi_id: '12', confirmed: true }] }
  const make = (albi, hubspot = {}) => ({ ...reads, hubspotRead: { ...reads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }], ...hubspot },
  albiRead: { ...reads.albiRead, listContacts: async () => ({ records: [], cursor: null }), ...albi } })
  const options = { relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [] }
  const load = currentReads => loadReviewResolutionOptions({ row: createRow, repository: { getMappings: async () => currentMappings }, reads: currentReads })
  assert.deepEqual((await load(make({ listCreateOptions: async () => ({ ...options, relationshipTypes: [] }) }))).createReadiness,
    { ready: false, blockedReason: 'referrer_type_missing' })
  assert.deepEqual((await load(make({ listCreateOptions: async () => ({ ...options, relationshipStatuses: [] }) }))).createReadiness,
    { ready: false, blockedReason: 'active_status_missing' })
  const owned = make({ listCreateOptions: async () => options },
    { getOwnerId: async () => '5', listOwners: async () => [{ id: '5', firstName: 'Ali', lastName: 'Brown' }] })
  assert.deepEqual((await load(owned)).createReadiness, { ready: false, blockedReason: 'salesperson_not_found' })
})
