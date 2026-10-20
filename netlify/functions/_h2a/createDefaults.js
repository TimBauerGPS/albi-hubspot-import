// Fixed defaults for records created from a review resolution. Values are matched by label against live
// Albi options and the HubSpot owner's name; nothing here is a user-supplied provider value.
import { cachedRead } from './readCache.js'

export const CREATE_TYPE_LABEL = 'Referrer'
export const CREATE_STATUS_LABEL = 'Active'

const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')

function single(options, label) {
  const matches = (Array.isArray(options) ? options : []).filter(option => providerId(option?.id) && normalize(option.label) === normalize(label))
  return matches.length === 1 ? matches[0].id : null
}

// Pure. Returns ids or the single reason creation cannot proceed.
export function resolveCreateDefaults({ relationshipTypes, relationshipStatuses, salespeople, ownerId, owners }) {
  const typeId = single(relationshipTypes, CREATE_TYPE_LABEL)
  if (!typeId) return { ok: false, reason: 'referrer_type_missing' }
  const statusId = single(relationshipStatuses, CREATE_STATUS_LABEL)
  if (!statusId) return { ok: false, reason: 'active_status_missing' }
  if (ownerId === null || ownerId === undefined || ownerId === '') return { ok: true, typeId, statusId, salespersonId: null }
  const owner = (Array.isArray(owners) ? owners : []).find(item => item?.id === ownerId)
  const name = owner ? `${owner.firstName ?? ''} ${owner.lastName ?? ''}` : ''
  if (!owner || !normalize(name)) return { ok: false, reason: 'owner_not_found' }
  const salespersonId = single(salespeople, name)
  if (!salespersonId) return { ok: false, reason: 'salesperson_not_found' }
  return { ok: true, typeId, statusId, salespersonId }
}

// Names the read a failure came from (and, while running, the read in progress) without copying any message.
export async function stepped(step, run, progress = null) {
  if (progress) progress.step = step
  try { return await run() } catch (error) {
    if (error && typeof error === 'object' && !error.h2aStep) { try { error.h2aStep = step } catch { /* frozen */ } }
    throw error
  }
}
const TAG = /^[a-z][a-z0-9_:]{0,39}$/i
// Sanitized: the step and, for a provider error, its category code, operation and HTTP status. Never a message.
export function evidenceOf(error) {
  const status = error?.name === 'ApiError' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null
  return { ...(TAG.test(error?.h2aStep ?? '') ? { step: error.h2aStep } : {}),
    ...(error?.name === 'ApiError' && TAG.test(error.code ?? '') ? { code: error.code } : {}),
    ...(error?.name === 'ApiError' && TAG.test(error.operation ?? '') ? { operation: error.operation } : {}),
    ...(status ? { status } : {}) }
}

// Reads only. The record's owner is read live; Albi's option lists and HubSpot's owners are cached per company
// (cacheKey) while the function is warm, and the reads run in parallel.
export async function loadCreateDefaults({ hubspotRead, albiRead, objectType, sourceId, cacheKey = null }) {
  const [options, ownerId] = await Promise.all([
    stepped('albi_create_options', () => cachedRead(cacheKey && `${cacheKey}:albi-create-options`, () => albiRead.listCreateOptions())),
    stepped('hubspot_owner', () => hubspotRead.getOwnerId(objectType === 'contacts' ? 'contacts' : 'companies', sourceId)),
  ])
  const owners = ownerId ? await stepped('hubspot_owners', () => cachedRead(cacheKey && `${cacheKey}:hubspot-owners`, () => hubspotRead.listOwners())) : []
  return resolveCreateDefaults({ ...options, ownerId, owners })
}

// Bounded, id/label-only copy of Albi's live referral-source list.
export function safeReferralSources(sources) {
  return Array.isArray(sources) ? sources.filter(option => providerId(option?.id) && typeof option.label === 'string')
    .map(option => ({ id: option.id, label: option.label })).slice(0, 100) : []
}

// Pure. The one create-readiness shape, shared by the review detail projection and live capture.
// baseReady covers the record's own checks; an organization block always names organization_not_synced.
export function buildCreateReadiness({ baseReady, organizationBlock = null, referralSources = [], defaults = null, notReadyReason = null }) {
  const ready = Boolean(baseReady) && referralSources.length > 0 && defaults?.ok === true
  // The first failing check names itself, so the record never shows an unexplained "unavailable".
  const blockedReason = organizationBlock ? 'organization_not_synced' : notReadyReason ? notReadyReason
    : baseReady && referralSources.length === 0 ? 'referral_sources_unavailable'
      : defaults && defaults.ok !== true ? defaults.reason : undefined
  return { ready, ...(ready ? { referralSources } : {}), ...(blockedReason ? { blockedReason } : {}),
    ...(organizationBlock ? { organization: organizationBlock } : {}) }
}

// Create readiness for a new record at capture (live sync and the live review backfill), built like the
// review detail projection: Albi create options and referral sources once per cache (a run or a backfill
// call), the record's HubSpot owner, and the organization gate. reads = { albi, hubspot } read clients.
// cache = { owners: Map, createOptions?, createOwners? } is reused across records. Any read failure
// returns undefined ("not known") so the record is still captured and triage refreshes later.
export async function computeCaptureReadiness(reads, cache, { objectType, sourceId, organization = null, portalId, organizationMappings = [] }) {
  try {
    const organizationId = organization?.id == null ? '' : String(organization.id).trim()
    const synced = (Array.isArray(organizationMappings) ? organizationMappings : [])
      .some(row => row.portal_id === portalId && row.hubspot_id === organizationId)
    if (objectType === 'contacts' && organizationId && !synced) {
      return buildCreateReadiness({ baseReady: false, organizationBlock: { sourceId: organizationId, reviewId: null } })
    }
    cache.owners ??= new Map()
    cache.createOptions ??= Promise.resolve().then(async () => ({ options: await reads.albi.listCreateOptions(),
      referralSources: safeReferralSources(await reads.albi.listReferralSources()) }))
    const { options, referralSources } = await cache.createOptions
    let defaults = null
    if (referralSources.length > 0) {
      const ownerId = await reads.hubspot.getOwnerId(objectType, sourceId)
      if (ownerId && !cache.owners.has(String(ownerId))) {
        cache.createOwners ??= Promise.resolve().then(() => reads.hubspot.listOwners())
        for (const owner of await cache.createOwners) cache.owners.set(String(owner.id), owner)
      }
      defaults = resolveCreateDefaults({ ...options, ownerId, owners: [...cache.owners.values()] })
    }
    return buildCreateReadiness({ baseReady: true, referralSources, defaults })
  } catch { return undefined }
}
