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

test('create readiness trusts the last recheck (no full Albi scan) and names why it is blocked', async () => {
  const createRow = { ...row, reason: 'no_match', recheck_outcome: null, candidate_snapshots: [],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const currentMappings = { ...mappings, contacts: [], options: [{ mapping_kind: 'default_contact_type',
    albi_id: '12', confirmed: true }] }
  const currentReads = { ...reads, hubspotRead: { ...reads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }] },
  albiRead: { ...reads.albiRead, listContacts: async () => { throw Error('must not scan Albi contacts') },
    listOrganizations: async () => { throw Error('must not scan Albi organizations') } } }
  const load = (overrides = {}) => loadReviewResolutionOptions({ row: overrides.row ?? createRow,
    repository: { getMappings: async () => overrides.mappings ?? currentMappings }, reads: overrides.reads ?? currentReads })
  assert.deepEqual((await load()).createReadiness, { ready: true, referralSources: [{ id: '5', label: 'Network' }] })
  assert.deepEqual((await load({ mappings: { ...currentMappings, options: [] } })).createReadiness, { ready: false, blockedReason: 'default_type_unconfirmed' })
  assert.deepEqual((await load({ row: { ...createRow, source_snapshot: { ...createRow.source_snapshot, firstName: 'Old' } } })).createReadiness,
    { ready: false, blockedReason: 'source_changed' })
  assert.deepEqual((await load({ reads: { ...currentReads, hubspotRead: { ...currentReads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: '' } }] } },
  row: { ...createRow, source_snapshot: { id: '123', firstName: 'Alex' } } })).createReadiness, { ready: false, blockedReason: 'missing_name' })
  assert.deepEqual((await load({ reads: { ...currentReads, albiRead: { ...currentReads.albiRead, listReferralSources: async () => [] } } })).createReadiness,
    { ready: false, blockedReason: 'referral_sources_unavailable' })
  const mapped = await load({ mappings: { ...currentMappings, contacts: [{ portal_id: '321', hubspot_id: '123', albi_contact_id: '456' }] } })
  assert.deepEqual(mapped.createReadiness, { ready: false, blockedReason: 'source_already_mapped' })
  const missing = await load({ reads: { ...currentReads, hubspotRead: { ...currentReads.hubspotRead, getContacts: async () => [] } } })
  assert.deepEqual(missing.createReadiness, { ready: false, blockedReason: 'source_unavailable' })
  const failing = await load({ reads: { ...currentReads, hubspotRead: { ...currentReads.hubspotRead, getContacts: async () => { throw new Error('down') } } } })
  assert.deepEqual(failing.createReadiness, { ready: false, blockedReason: 'evidence_unavailable', evidence: { step: 'hubspot_record' } })
  const several = await load({ reads: { ...currentReads, hubspotRead: { ...currentReads.hubspotRead,
    getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: ['777', '778'] }] } } })
  assert.deepEqual(several.createReadiness, { ready: false, blockedReason: 'multiple_organizations' })
})

test('a contact behind a mapped organization is ready without scanning Albi organizations', async () => {
  const createRow = { ...row, reason: 'no_match', recheck_outcome: null, candidate_snapshots: [],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const result = await loadReviewResolutionOptions({ row: createRow,
    repository: { getMappings: async () => ({ ...mappings, contacts: [], options: [{ mapping_kind: 'default_contact_type', albi_id: '12', confirmed: true }] }) },
    reads: { ...reads, hubspotRead: { ...reads.hubspotRead, getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }] },
      albiRead: { ...reads.albiRead, listContacts: async () => { throw Error('no scan') }, listOrganizations: async () => { throw Error('no scan') } } } })
  assert.equal(result.createReadiness.ready, true)
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
  assert.deepEqual(mapped.forceCreateReadiness, { eligible: false, ready: false, blockedReason: 'source_already_mapped' })

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

test('contact creation is blocked until its one associated organization is mapped, and names where to do that', async () => {
  const forceRow = { ...row, reason: 'name_only_candidate', candidate_snapshots: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const currentMappings = { contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type',
    source_key: 'default', albi_id: '12', confirmed: true }] }
  const currentReads = { ...reads, hubspotRead: { ...reads.hubspotRead,
    getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }],
    getCompanies: async () => [{ id: '777', properties: { name: 'Unmapped Company' } }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: ['777'] }] },
  albiRead: { ...reads.albiRead, listContacts: async () => { throw Error('must not enumerate Albi contacts') },
    listOrganizations: async () => { throw Error('must not enumerate Albi organizations') } } }
  const lookups = []
  const load = findDryRunReviewBySource => loadReviewResolutionOptions({ row: forceRow,
    repository: { getMappings: async () => currentMappings, findDryRunReviewBySource }, reads: currentReads })

  const none = await load(async (...args) => { lookups.push(args); return null })
  assert.deepEqual(none.forceCreateReadiness, { eligible: true, ready: false, blockedReason: 'organization_not_synced',
    organization: { sourceId: '777', reviewId: null } })
  assert.deepEqual(lookups[0].slice(2), ['companies', '777'])
  const known = await load(async () => ({ id: '00000000-0000-4000-8000-0000000000aa' }))
  assert.deepEqual(known.forceCreateReadiness.organization, { sourceId: '777', reviewId: '00000000-0000-4000-8000-0000000000aa' })
  assert.equal(known.forceCreateReadiness.deferredOrganizationSourceId, undefined)
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

test('an associated organization that is not in Albi yet is named so it can be created first', async () => {
  const unmapped = { ...mappings, organizations: [] }
  const lookups = []
  const load = find => loadReviewResolutionOptions({ row: { ...row, company_id: 'c', run_id: 'r' },
    repository: { getMappings: async () => unmapped, findDryRunReviewBySource: find },
    reads: { ...reads, albiRead: { ...reads.albiRead, listOrganizations: async () => ({ records: [], cursor: null }) } } })
  const none = await load(async (...args) => { lookups.push(args); return null })
  assert.deepEqual(none.organizationOptions, [])
  assert.deepEqual(none.organizationGate, { sourceId: '777', reviewId: null })
  assert.deepEqual(lookups[0], ['c', 'r', 'companies', '777'])
  const known = await load(async () => ({ id: '00000000-0000-4000-8000-0000000000dd' }))
  assert.deepEqual(known.organizationGate, { sourceId: '777', reviewId: '00000000-0000-4000-8000-0000000000dd' })
  const mapped = await loadReviewResolutionOptions({ row, repository: { getMappings: async () => mappings }, reads })
  assert.equal(mapped.organizationGate, undefined)
})

test('an unmapped associated organization is gated from cheap evidence without enumerating Albi', async () => {
  const throwing = { ...reads, albiRead: { ...reads.albiRead,
    listContacts: async () => { throw Error('must not enumerate Albi contacts') },
    listOrganizations: async () => { throw Error('must not enumerate Albi organizations') } } }
  const result = await loadReviewResolutionOptions({ row: { ...row, company_id: 'c', run_id: 'r', reason: 'albi_contact_update_contract_unverified' },
    repository: { getMappings: async () => ({ ...mappings, organizations: [] }), findDryRunReviewBySource: async () => ({ id: '00000000-0000-4000-8000-0000000000dd' }) },
    reads: throwing })
  assert.deepEqual(result.organizationOptions, [])
  assert.deepEqual(result.organizationGate, { sourceId: '777', reviewId: '00000000-0000-4000-8000-0000000000dd' })
  const mapped = await loadReviewResolutionOptions({ row, repository: { getMappings: async () => mappings }, reads })
  assert.equal(mapped.organizationOptions.length, 1)
})

test('separate-record creation names why it is unavailable for a mapped source or several organizations', async () => {
  const forceRow = { ...row, reason: 'name_only_candidate', candidate_snapshots: [{ id: '456', firstName: 'Alex', lastName: 'Stone' }],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const mapped = await loadReviewResolutionOptions({ row: forceRow, repository: { getMappings: async () => mappings }, reads })
  assert.deepEqual(mapped.forceCreateReadiness, { eligible: false, ready: false, blockedReason: 'source_already_mapped' })
  const several = await loadReviewResolutionOptions({ row: forceRow, repository: { getMappings: async () => ({ ...mappings, contacts: [] }) },
    reads: { ...reads, hubspotRead: { ...reads.hubspotRead, getAssociations: async () => [{ fromId: '123', toObjectType: 'companies', toIds: ['777', '778'] }] } } })
  assert.deepEqual(several.forceCreateReadiness, { eligible: false, ready: false, blockedReason: 'multiple_organizations' })
})

import { loadOrgFirstCreate } from '../../netlify/functions/_h2a/reviewResolutionOptions.js'
test('orgFirstCreate is eligible only for a blocked contact whose organization is ready with no candidates', async () => {
  const readiness = { ready: false, blockedReason: 'organization_not_synced', organization: { sourceId: '900', reviewId: null } }
  const contact = { company_id: 'c', id: 'k', portal_id: '123', object_type: 'contacts', review_kind: 'live', candidate_snapshots: [] }
  const org = { id: 'o', status: 'needs_review', object_type: 'companies', source_id: '900', candidate_snapshots: [], source_snapshot: { name: 'Acme' } }
  const repository = { findOpenLiveReviewBySource: async () => org }
  const load = async () => ({ createReadiness: { ready: true, referralSources: [{ id: '5', label: 'Network', extra: 'x' }, { id: 'bad', label: '' }] } })
  assert.deepEqual(await loadOrgFirstCreate({ row: contact, readiness, repository, reads: {}, load }),
    { eligible: true, organizationReviewId: 'o', organizationName: 'Acme', referralSources: [{ id: '5', label: 'Network' }] })
  assert.deepEqual(await loadOrgFirstCreate({ row: contact, readiness, repository: { findOpenLiveReviewBySource: async () => null }, reads: {}, load }), { eligible: false })
  assert.deepEqual(await loadOrgFirstCreate({ row: contact, readiness, repository, reads: {}, load: async () => ({ createReadiness: { ready: false } }) }), { eligible: false })
  assert.deepEqual(await loadOrgFirstCreate({ row: contact, readiness: { ...readiness, blockedReason: 'x' }, repository, reads: {}, load }), { eligible: false })
  assert.deepEqual(await loadOrgFirstCreate({ row: contact, readiness, repository: { findOpenLiveReviewBySource: async () => ({ ...org, candidate_snapshots: [{ id: '1' }] }) }, reads: {}, load }), { eligible: false })
})

test('a contact rechecked as safe to create under an organization reason still reports create readiness and its organization gate', async () => {
  const createRow = { ...row, company_id: 'c', run_id: 'r', reason: 'organization_unresolved', status: 'cleared', recheck_outcome: 'safe_to_create',
    candidate_snapshots: [], source_snapshot: { id: '123', firstName: 'Jack', lastName: 'Gove' } }
  const result = await loadReviewResolutionOptions({ row: createRow,
    repository: { getMappings: async () => ({ ...mappings, contacts: [], organizations: [], options: [{ mapping_kind: 'default_contact_type', albi_id: '12', confirmed: true }] }),
      findDryRunReviewBySource: async () => ({ id: '00000000-0000-4000-8000-0000000000dd' }) },
    reads: { ...reads, hubspotRead: { ...reads.hubspotRead, getContacts: async () => [{ id: '123', properties: { firstname: 'Jack', lastname: 'Gove' } }] } } })
  assert.equal(result.createReadiness.blockedReason, 'organization_not_synced')
  assert.deepEqual(result.createReadiness.organization, { sourceId: '777', reviewId: '00000000-0000-4000-8000-0000000000dd' })
})

test('a failed check names the read that failed and the provider error code', async () => {
  const { ApiError } = await import('../../netlify/functions/_h2a/http.js')
  const forcedRow = { ...row, reason: 'duplicate_candidates', recheck_outcome: 'still_needs_review', candidate_snapshots: [{ id: '456' }],
    source_snapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' } }
  const load = hubspotRead => loadReviewResolutionOptions({ row: forcedRow,
    repository: { getMappings: async () => ({ ...mappings, contacts: [], options: [{ mapping_kind: 'default_contact_type', albi_id: '12', confirmed: true }] }) },
    reads: { ...reads, hubspotRead: { ...reads.hubspotRead, getContacts: async () => [{ id: '123', properties: { firstname: 'Alex', lastname: 'Stone' } }],
      getOwnerId: async () => '99', ...hubspotRead } } })
  const owners = await load({ listOwners: async () => { throw new ApiError('validation', { operation: 'listOwners', code: 'malformed_response', status: 200 }) } })
  assert.deepEqual(owners.forceCreateReadiness, { eligible: false, ready: false, blockedReason: 'evidence_unavailable',
    evidence: { step: 'hubspot_owners', code: 'malformed_response', operation: 'listOwners', status: 200 } })
  const owner = await load({ getOwnerId: async () => { throw new ApiError('rate_limit', { operation: 'getOwnerId', status: 429 }) } })
  assert.deepEqual(owner.forceCreateReadiness.evidence, { step: 'hubspot_owner', code: 'rate_limit', operation: 'getOwnerId', status: 429 })
  // A plain error message is never copied into the projection.
  const plain = await load({ getOwnerId: async () => { throw new Error('secret token abc in message') } })
  assert.deepEqual(plain.forceCreateReadiness.evidence, { step: 'hubspot_owner' })
})
