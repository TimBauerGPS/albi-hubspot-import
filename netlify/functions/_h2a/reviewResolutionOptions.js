import { isDeepStrictEqual } from 'node:util'
import { getH2AReviewReason } from '../../../shared/h2aReviewReasons.js'
import { buildAlbiRecordUrl } from '../../../shared/h2aProviderLinks.js'
import { resolveContactType } from './options.js'
import { decideContactMatch, decideOrganizationMatch } from './match.js'
import { safeReviewSnapshot } from './review.js'

const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const mappedSource = row => row?.hubspot_id ?? row?.sourceId
const mappedTarget = (row, type) => row?.[type === 'contacts' ? 'albi_contact_id' : 'albi_organization_id'] ?? row?.targetId

async function all(read) {
  const result = [], seen = new Set()
  let cursor = '1'
  for (let page = 0; page < 100; page++) {
    if (seen.has(cursor)) return null
    seen.add(cursor)
    const next = await read({ cursor, pageSize: 100 })
    if (!record(next) || !Array.isArray(next.records) || next.records.length > 100 ||
      next.records.some(item => !record(item) || !providerId(item.id))) return null
    result.push(...next.records)
    if (next.cursor === null) return new Set(result.map(item => item.id)).size === result.length ? result : null
    if (!providerId(next.cursor) || Number(next.cursor) <= Number(cursor)) return null
    cursor = next.cursor
  }
  return null
}

function exactMapping(rows, portalId, sourceId, type) {
  const matches = rows.filter(item => item?.portal_id === portalId && mappedSource(item) === sourceId)
  return matches.length === 1 && providerId(mappedTarget(matches[0], type)) ? mappedTarget(matches[0], type) : null
}

function associationIds(rows, sourceId) {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.fromId !== sourceId || rows[0]?.toObjectType !== 'companies' ||
    !Array.isArray(rows[0].toIds) || rows[0].toIds.some(id => !providerId(id)) ||
    new Set(rows[0].toIds).size !== rows[0].toIds.length) return null
  return rows[0].toIds
}

// Projection is advisory UI evidence only. The POST service repeats all reads
// and validates the tenant, portal, review version and provider state.
export async function loadReviewResolutionOptions({ row, repository, reads }) {
  const unavailable = { organizationOptions: [], createReadiness: { ready: false }, forceCreateReadiness: { eligible: false, ready: false } }
  if (!record(row) || !providerId(row.source_id) || !providerId(row.portal_id) ||
    !['contacts', 'companies'].includes(row.object_type) || !reads?.hubspotRead || !reads?.albiRead) return unavailable
  const actions = getH2AReviewReason(row.reason).actions
  if (!actions.includes('choose_organization') && !actions.includes('create_albi') && !actions.includes('force_create_albi')) return unavailable
  try {
    const hubspot = reads.hubspotRead
    const [mappings, sourceRows, associationRows] = await Promise.all([
      repository.getMappings(row.company_id),
      row.object_type === 'contacts' ? hubspot.getContacts([row.source_id]) : hubspot.getCompanies([row.source_id]),
      row.object_type === 'contacts' ? hubspot.getAssociations({
        objectType: 'contacts', objectIds: [row.source_id], toObjectTypes: ['companies'],
      }) : Promise.resolve([]),
    ])
    if (!mappings || !['contacts', 'organizations', 'options'].every(key => Array.isArray(mappings[key]))) return unavailable
    if (!Array.isArray(sourceRows) || sourceRows.length !== 1 || sourceRows[0]?.id !== row.source_id ||
      sourceRows[0]?.archived === true || !record(sourceRows[0]?.properties)) return unavailable
    const associated = row.object_type === 'contacts' ? associationIds(associationRows, row.source_id) : []
    if (associated === null) return unavailable

    if (actions.includes('choose_organization') && row.object_type === 'contacts') {
      const contacts = await all(args => reads.albiRead.listContacts(args))
      const organizations = await all(args => reads.albiRead.listOrganizations(args))
      if (!contacts || !organizations) return unavailable
      const contactMappings = mappings.contacts.filter(item => item?.portal_id === row.portal_id && mappedSource(item) === row.source_id)
      if (contactMappings.length > 1) return unavailable
      const contactMatch = decideContactMatch({ source: sourceRows[0], candidates: contacts,
        mappings: mappings.contacts, portalId: row.portal_id,
        existingMapping: contactMappings[0] })
      const contactTargetId = contactMatch.action === 'link' ? contactMatch.targetId : null
      if (!providerId(contactTargetId)) return unavailable
      const contact = contacts?.find(item => item.id === contactTargetId)
      if (!contact || !organizations) return unavailable
      const currentOrganizationTargetId = contact.organizationId == null || contact.organizationId === '' ? null : contact.organizationId
      if (currentOrganizationTargetId !== null && !providerId(currentOrganizationTargetId)) return unavailable
      const organizationOptions = []
      const mappedSources = mappings.organizations.filter(item => item?.portal_id === row.portal_id && providerId(mappedSource(item)))
        .map(mappedSource)
      for (const sourceId of [...new Set([...associated, ...mappedSources])].slice(0, 25)) {
        const companies = await hubspot.getCompanies([sourceId])
        if (!Array.isArray(companies) || companies.length !== 1 || companies[0]?.id !== sourceId ||
          companies[0]?.archived === true || !record(companies[0]?.properties)) continue
        const organizationMappings = mappings.organizations.filter(item => item?.portal_id === row.portal_id && mappedSource(item) === sourceId)
        if (organizationMappings.length > 1) continue
        const match = decideOrganizationMatch({ source: companies[0], candidates: organizations,
          mappings: mappings.organizations, portalId: row.portal_id,
          existingMapping: organizationMappings[0] })
        const targetId = match.action === 'link' ? match.targetId : null
        if (!providerId(targetId) || !organizations.some(item => item.id === targetId)) continue
        organizationOptions.push({ sourceId, targetId, contactTargetId, currentOrganizationTargetId,
          associated: associated.includes(sourceId),
          contactUrl: buildAlbiRecordUrl('contacts', contactTargetId), organizationUrl: buildAlbiRecordUrl('companies', targetId) })
      }
      return { ...unavailable, organizationOptions }
    }

    const forced = actions.includes('force_create_albi') && row.status === 'needs_review' &&
      Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length > 0
    const normal = actions.includes('create_albi') && (row.status === 'needs_review' || row.status === 'cleared' && row.recheck_outcome === 'safe_to_create') &&
      Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length === 0
    if ((normal || forced) && associated.length <= 1 &&
      !mappings[row.object_type === 'contacts' ? 'contacts' : 'organizations'].some(item =>
        item?.portal_id === row.portal_id && mappedSource(item) === row.source_id)) {
      if (!isDeepStrictEqual(safeReviewSnapshot(sourceRows[0], row.object_type), row.source_snapshot)) return unavailable
      if (normal) {
        const candidates = row.object_type === 'contacts' ? await all(args => reads.albiRead.listContacts(args))
          : await all(args => reads.albiRead.listOrganizations(args))
        if (!candidates) return unavailable
        const match = (row.object_type === 'contacts' ? decideContactMatch : decideOrganizationMatch)({
          source: sourceRows[0], candidates, portalId: row.portal_id,
          mappings: mappings[row.object_type === 'contacts' ? 'contacts' : 'organizations'],
        })
        if (match.action !== 'create') return unavailable
      }
      if (forced) {
        const capturedIds = row.candidate_snapshots.map(item => item?.id)
        if (!capturedIds.length || capturedIds.length > 10 || capturedIds.some(id => !providerId(id)) ||
          new Set(capturedIds).size !== capturedIds.length) return unavailable
      }
      const props = sourceRows[0].properties
      const nameReady = row.object_type === 'contacts' ? Boolean(String(props.firstname ?? '').trim() && String(props.lastname ?? '').trim())
        : Boolean(String(props.name ?? '').trim())
      let organizationTypeId = null, organizationReady = true, deferredOrganizationSourceId = null
      if (associated.length === 1) {
        const sourceId = associated[0]
        const associationMappings = mappings.organizations.filter(item => item?.portal_id === row.portal_id && mappedSource(item) === sourceId)
        if (associationMappings.length > 1) return unavailable
        const targetId = exactMapping(mappings.organizations, row.portal_id, sourceId, 'companies')
        const companies = await hubspot.getCompanies([sourceId])
        const organizations = forced ? null : await all(args => reads.albiRead.listOrganizations(args))
        const target = organizations?.find(item => item.id === targetId)
        const companyReady = Array.isArray(companies) && companies.length === 1 && companies[0]?.id === sourceId &&
          companies[0]?.archived !== true && record(companies[0]?.properties)
        organizationReady = Boolean(companyReady && (forced ? targetId || associationMappings.length === 0 : targetId && target))
        if (forced && companyReady && associationMappings.length === 0) deferredOrganizationSourceId = sourceId
        if (organizationReady && Array.isArray(target?.organizationTypeIds) && target.organizationTypeIds.length === 1 &&
          providerId(target.organizationTypeIds[0])) organizationTypeId = target.organizationTypeIds[0]
      }
      const options = row.object_type === 'contacts' ? mappings.options : mappings.options.filter(item =>
        (item?.mapping_kind ?? item?.mappingKind) === 'default_organization_type' && (item?.source_key ?? item?.sourceKey) === 'default')
        .map(item => ({ ...item, mapping_kind: 'default_contact_type' }))
      const type = resolveContactType({ mappings: options, inheritFromOrganization: associated.length === 1,
        organizationTypeId })
      const typeReady = type.action === 'resolved' && providerId(type.contactTypeId) &&
        Number.isSafeInteger(Number(type.contactTypeId))
      const ready = nameReady && organizationReady && typeReady
      return { ...unavailable, ...(forced ? { forceCreateReadiness: { eligible: true, ready,
        ...(deferredOrganizationSourceId ? { deferredOrganizationSourceId } : {}) } } : { createReadiness: { ready } }) }
    }
  } catch { /* A failed read cannot become an actionable projection. */ }
  return unavailable
}
