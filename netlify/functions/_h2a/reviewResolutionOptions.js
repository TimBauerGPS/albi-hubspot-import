import { isDeepStrictEqual } from 'node:util'
import { getH2AReviewActions, getH2AReviewRowActions } from '../../../shared/h2aReviewReasons.js'
import { buildAlbiRecordUrl } from '../../../shared/h2aProviderLinks.js'
import { resolveContactType } from './options.js'
import { decideContactMatch, decideOrganizationMatch } from './match.js'
import { safeReviewSnapshot } from './review.js'
import { buildCreateReadiness, evidenceOf, loadCreateDefaults, safeReferralSources, stepped, suggestReferralSource } from './createDefaults.js'
import { cachedRead } from './readCache.js'

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
// progress (optional) is told the read in progress, so a caller that gives up on time can say where.
export async function loadReviewResolutionOptions({ row, repository, reads, progress = null }) {
  const unavailable = { organizationOptions: [], createReadiness: { ready: false }, forceCreateReadiness: { eligible: false, ready: false } }
  if (!record(row) || !providerId(row.source_id) || !providerId(row.portal_id) ||
    !['contacts', 'companies'].includes(row.object_type) || !reads?.hubspotRead || !reads?.albiRead) return unavailable
  const actions = getH2AReviewRowActions(row)
  if (!actions.includes('choose_organization') && !actions.includes('create_albi') && !actions.includes('force_create_albi')) return unavailable
  // Every reason creation is off is named, so the record never shows an unexplained "unavailable".
  const hasCandidates = Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length > 0
  const named = (reason, evidence = null) => {
    const extra = evidence && Object.keys(evidence).length ? { evidence } : {}
    return { ...unavailable, ...(hasCandidates ? { forceCreateReadiness: { eligible: false, ready: false, blockedReason: reason, ...extra } }
      : { createReadiness: { ready: false, blockedReason: reason, ...extra } }) }
  }
  const step = (name, run) => stepped(name, run, progress)
  try {
    const hubspot = reads.hubspotRead
    const [mappings, sourceRows, associationRows] = await Promise.all([
      step('mappings', () => repository.getMappings(row.company_id)),
      step('hubspot_record', () => row.object_type === 'contacts' ? hubspot.getContacts([row.source_id]) : hubspot.getCompanies([row.source_id])),
      row.object_type === 'contacts' ? step('hubspot_associations', () => hubspot.getAssociations({
        objectType: 'contacts', objectIds: [row.source_id], toObjectTypes: ['companies'],
      })) : Promise.resolve([]),
    ])
    if (!mappings || !['contacts', 'organizations', 'options'].every(key => Array.isArray(mappings[key]))) return named('evidence_unavailable')
    if (!Array.isArray(sourceRows) || sourceRows.length !== 1 || sourceRows[0]?.id !== row.source_id ||
      sourceRows[0]?.archived === true || !record(sourceRows[0]?.properties)) return named('source_unavailable')
    const allAssociated = row.object_type === 'contacts' ? associationIds(associationRows, row.source_id) : []
    if (allAssociated === null) return named('evidence_unavailable')
    // Several associated organizations: the first (HubSpot's primary company) is the one matched to Albi.
    const associated = allAssociated.slice(0, 1)

    // A contact a recheck cleared as safe to create is offered creation (with its organization gate), not the choice.
    const clearedToCreate = row.status === 'cleared' && row.recheck_outcome === 'safe_to_create'
    if (actions.includes('choose_organization') && row.object_type === 'contacts' && !clearedToCreate) {
      // A single associated organization with no tenant mapping must be synced first. Decide that from cheap
      // evidence so the slow full Albi enumeration (which exceeds the detail deadline) is not needed to show it.
      if (allAssociated.length === 1 && !mappings.organizations.some(item => item?.portal_id === row.portal_id && mappedSource(item) === allAssociated[0])) {
        const companies = await hubspot.getCompanies([allAssociated[0]])
        if (Array.isArray(companies) && companies.length === 1 && companies[0]?.id === allAssociated[0] &&
          companies[0]?.archived !== true && record(companies[0]?.properties)) {
          const found = typeof repository.findDryRunReviewBySource === 'function'
            ? await repository.findDryRunReviewBySource(row.company_id, row.run_id, 'companies', allAssociated[0]) : null
          return { ...unavailable, organizationOptions: [],
            organizationGate: { sourceId: allAssociated[0], reviewId: typeof found?.id === 'string' ? found.id : null } }
        }
        return unavailable
      }
      const contacts = await step('albi_contacts', () => all(args => reads.albiRead.listContacts(args)))
      const organizations = await step('albi_organizations', () => all(args => reads.albiRead.listOrganizations(args)))
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
      let gate = null
      const mappedSources = mappings.organizations.filter(item => item?.portal_id === row.portal_id && providerId(mappedSource(item)))
        .map(mappedSource)
      for (const sourceId of [...new Set([...allAssociated, ...mappedSources])].slice(0, 25)) {
        const companies = await hubspot.getCompanies([sourceId])
        if (!Array.isArray(companies) || companies.length !== 1 || companies[0]?.id !== sourceId ||
          companies[0]?.archived === true || !record(companies[0]?.properties)) continue
        const organizationMappings = mappings.organizations.filter(item => item?.portal_id === row.portal_id && mappedSource(item) === sourceId)
        if (organizationMappings.length > 1) continue
        const match = decideOrganizationMatch({ source: companies[0], candidates: organizations,
          mappings: mappings.organizations, portalId: row.portal_id,
          existingMapping: organizationMappings[0] })
        const targetId = match.action === 'link' ? match.targetId : null
        if (!providerId(targetId) || !organizations.some(item => item.id === targetId)) {
          // An associated organization with no Albi record must be created first, on its own review.
          if (!gate && allAssociated.includes(sourceId) && organizationMappings.length === 0) {
            const found = typeof repository.findDryRunReviewBySource === 'function'
              ? await repository.findDryRunReviewBySource(row.company_id, row.run_id, 'companies', sourceId) : null
            gate = { sourceId, reviewId: typeof found?.id === 'string' ? found.id : null }
          }
          continue
        }
        organizationOptions.push({ sourceId, targetId, contactTargetId, currentOrganizationTargetId,
          associated: allAssociated.includes(sourceId),
          contactUrl: buildAlbiRecordUrl('contacts', contactTargetId), organizationUrl: buildAlbiRecordUrl('companies', targetId) })
      }
      return { ...unavailable, organizationOptions, ...(organizationOptions.length === 0 && gate ? { organizationGate: gate } : {}) }
    }

    const forced = actions.includes('force_create_albi') && row.status === 'needs_review' &&
      Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length > 0
    const normal = actions.includes('create_albi') && (row.status === 'needs_review' || row.status === 'cleared' && row.recheck_outcome === 'safe_to_create') &&
      Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length === 0
    const sourceMapped = mappings[row.object_type === 'contacts' ? 'contacts' : 'organizations'].some(item =>
      item?.portal_id === row.portal_id && mappedSource(item) === row.source_id)
    if (forced && (sourceMapped || associated.length > 1)) {
      return { ...unavailable, forceCreateReadiness: { eligible: false, ready: false,
        blockedReason: sourceMapped ? 'source_already_mapped' : 'multiple_organizations' } }
    }
    if ((normal || forced) && associated.length <= 1 && !sourceMapped) {
      const blocked = reason => ({ ...unavailable, ...(forced ? { forceCreateReadiness: { eligible: true, ready: false, blockedReason: reason } }
        : { createReadiness: { ready: false, blockedReason: reason } }) })
      if (!isDeepStrictEqual(safeReviewSnapshot(sourceRows[0], row.object_type), row.source_snapshot)) return blocked('source_changed')
      // No full Albi scan here: the last recheck captured no candidates, and the create itself re-checks Albi
      // live before writing, so a duplicate that appeared since is still refused.
      if (forced) {
        const capturedIds = row.candidate_snapshots.map(item => item?.id)
        if (!capturedIds.length || capturedIds.length > 10 || capturedIds.some(id => !providerId(id)) ||
          new Set(capturedIds).size !== capturedIds.length) return unavailable
      }
      const props = sourceRows[0].properties
      // One name is enough for a contact: the create fills Albi's other required name with a placeholder.
      const nameReady = row.object_type === 'contacts' ? Boolean(String(props.firstname ?? '').trim() || String(props.lastname ?? '').trim())
        : Boolean(String(props.name ?? '').trim())
      let organizationTypeId = null, organizationReady = true, organizationBlock = null, organizationTargetId = null
      if (associated.length === 1) {
        const sourceId = associated[0]
        const associationMappings = mappings.organizations.filter(item => item?.portal_id === row.portal_id && mappedSource(item) === sourceId)
        if (associationMappings.length > 1) return blocked('organization_mapping_ambiguous')
        const targetId = exactMapping(mappings.organizations, row.portal_id, sourceId, 'companies')
        organizationTargetId = targetId
        const companies = await step('hubspot_organization', () => hubspot.getCompanies([sourceId]))
        const companyReady = Array.isArray(companies) && companies.length === 1 && companies[0]?.id === sourceId &&
          companies[0]?.archived !== true && record(companies[0]?.properties)
        if (!companyReady) return blocked('organization_missing_in_hubspot')
        // The reviewed mapping is the organization's identity; the create re-reads it live.
        organizationReady = Boolean(targetId)
        if (companyReady && associationMappings.length === 0) {
          // The organization must be synced first; point at its own audited review when one exists.
          const found = typeof repository.findDryRunReviewBySource === 'function'
            ? await step('organization_review', () => repository.findDryRunReviewBySource(row.company_id, row.run_id, 'companies', sourceId)) : null
          organizationBlock = { sourceId, reviewId: typeof found?.id === 'string' ? found.id : null }
        }
      }
      const options = row.object_type === 'contacts' ? mappings.options : mappings.options.filter(item =>
        (item?.mapping_kind ?? item?.mappingKind) === 'default_organization_type' && (item?.source_key ?? item?.sourceKey) === 'default')
        .map(item => ({ ...item, mapping_kind: 'default_contact_type' }))
      const type = resolveContactType({ mappings: options, inheritFromOrganization: associated.length === 1,
        organizationTypeId })
      const typeReady = type.action === 'resolved' && providerId(type.contactTypeId) &&
        Number.isSafeInteger(Number(type.contactTypeId))
      const baseReady = nameReady && organizationReady && typeReady && !organizationBlock
      const notReadyReason = organizationBlock ? null : !nameReady ? 'missing_name' : !typeReady ? 'default_type_unconfirmed' : null
      // Referral sources and the create defaults load in parallel; Albi's lists are cached per company while warm.
      const cacheKey = typeof row.company_id === 'string' && row.company_id ? row.company_id : null
      const [sources, defaults] = baseReady ? await Promise.all([
        step('albi_referral_sources', () => cachedRead(cacheKey && `${cacheKey}:albi-referral-sources`, () => reads.albiRead.listReferralSources())),
        step('create_defaults', () => loadCreateDefaults({ hubspotRead: hubspot, albiRead: reads.albiRead, objectType: row.object_type, sourceId: row.source_id, cacheKey })),
      ]) : [[], null]
      const referralSources = safeReferralSources(sources)
      const built = buildCreateReadiness({ baseReady, organizationBlock, referralSources, defaults, notReadyReason })
      const suggestion = built.ready ? await suggestReferralSource({ organizationTargetId: row.object_type === 'contacts' ? organizationTargetId : null,
        ownerEmail: defaults?.ownerEmail ?? '', referralSources, albiRead: reads.albiRead, repository, companyId: row.company_id, cacheKey }) : null
      const details = suggestion ? { ...built, defaultReferralSourceId: suggestion.id, defaultReferralFrom: suggestion.from } : built
      return { ...unavailable, ...(forced ? { forceCreateReadiness: { eligible: true, ...details } } : { createReadiness: details }) }
    }
    if (normal || forced) return named(sourceMapped ? 'source_already_mapped' : associated.length > 1 ? 'multiple_organizations' : 'evidence_unavailable')
  } catch (error) { return named('evidence_unavailable', evidenceOf(error)) /* A failed read cannot become an actionable projection. */ }
  return unavailable
}

// Advisory projection for "Create organization and contact". Eligible only when this contact waits on
// exactly one unsynced organization whose own review has no candidates and is ready to create. Live rows
// use the open live organization row (never prepared here); sample rows use the sample review, or a
// not-yet-saved row built from HubSpot so the reviewer can be offered the action before it is prepared.
export async function loadOrgFirstCreate({ row, readiness, repository, reads, load = loadReviewResolutionOptions }) {
  const no = { eligible: false }
  try {
    const sourceId = readiness?.organization?.sourceId
    if (!record(row) || row.object_type !== 'contacts' || readiness?.blockedReason !== 'organization_not_synced' ||
      !providerId(sourceId) || (row.candidate_snapshots ?? []).length !== 0) return no
    const live = row.review_kind === 'live'
    let organization = null
    if (live) {
      organization = typeof repository.findOpenLiveReviewBySource === 'function'
        ? await repository.findOpenLiveReviewBySource(row.company_id, row.portal_id, 'companies', sourceId) : null
    } else if (typeof readiness.organization.reviewId === 'string') {
      organization = await repository.getReview(row.company_id, readiness.organization.reviewId)
    }
    if (organization && (organization.object_type !== 'companies' || organization.source_id !== sourceId ||
      organization.status !== 'needs_review' || (organization.candidate_snapshots ?? []).length !== 0)) return no
    let candidate = organization
    if (!candidate) {
      if (live) return no
      const companies = await reads.hubspotRead.getCompanies([sourceId])
      if (!Array.isArray(companies) || companies.length !== 1 || companies[0]?.id !== sourceId || companies[0]?.archived === true ||
        !record(companies[0]?.properties)) return no
      candidate = { company_id: row.company_id, run_id: row.run_id, portal_id: row.portal_id, object_type: 'companies', source_id: sourceId,
        reason: 'no_match', status: 'needs_review', candidate_snapshots: [], source_snapshot: safeReviewSnapshot(companies[0], 'companies') }
    }
    const loaded = await load({ row: { ...candidate, company_id: row.company_id }, repository, reads })
    if (loaded?.createReadiness?.ready !== true) return no
    const name = typeof candidate.source_snapshot?.name === 'string' ? candidate.source_snapshot.name.trim().slice(0, 200) : ''
    return { eligible: true, ...(organization?.id ? { organizationReviewId: organization.id } : {}),
      ...(name ? { organizationName: name } : {}), referralSources: safeReferralSources(loaded.createReadiness.referralSources),
      ...(loaded.createReadiness.defaultReferralSourceId ? { defaultReferralSourceId: loaded.createReadiness.defaultReferralSourceId,
        defaultReferralFrom: loaded.createReadiness.defaultReferralFrom } : {}) }
  } catch { return no }
}
