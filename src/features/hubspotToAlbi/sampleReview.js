import { getH2AReviewActions, getH2AReviewReason, H2A_REVIEW_GUIDANCE, listH2AReviewReasonOptions } from '../../../shared/h2aReviewReasons.js'
import { buildAlbiRecordUrl, buildHubSpotRecordUrl } from '../../../shared/h2aProviderLinks.js'
import { RESOLUTION_FIELDS, resolutionDisplayValue, presentReviewResolution, presentResolutionCapability } from './sampleReviewResolution.js'

export const SAMPLE_REVIEW_GUIDANCE = H2A_REVIEW_GUIDANCE
export const SAMPLE_REVIEW_REASON_OPTIONS = listH2AReviewReasonOptions()

export const SOURCE_FIELDS = Object.freeze([
  ['id', 'ID'], ['fullName', 'Full name'], ['firstName', 'First name'], ['lastName', 'Last name'], ['name', 'Name'],
  ['email', 'Email'], ['phoneNumber', 'Phone'], ['mobileNumber', 'Mobile'], ['organizationId', 'Organization ID'],
  ['organizationName', 'Organization'], ['domain', 'Domain'], ['jobTitle', 'Job title'], ['address1', 'Address'], ['address2', 'Address line 2'],
  ['city', 'City'], ['state', 'State / region'], ['zipcode', 'Postal code'], ['country', 'Country'],
])
const COMPARISON_FIELDS = Object.freeze([
  ['id', 'ID'], ['fullName', 'Full name'], ['name', 'Name'], ['firstName', 'First name'], ['lastName', 'Last name'],
  ['email', 'Email'], ['phoneNumber', 'Phone'], ['mobileNumber', 'Mobile'], ['organizationId', 'Organization ID'],
  ['organizationName', 'Organization'], ['domain', 'Domain'], ['jobTitle', 'Job title'], ['address1', 'Address'], ['address2', 'Address line 2'],
  ['city', 'City'], ['state', 'State / region'], ['zipcode', 'Postal code'], ['country', 'Country'],
])
const STATUSES = new Set(['needs_review', 'cleared', 'no_longer_in_scope'])
const RESOLUTION_STATUSES = new Set(['pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded'])
const EVIDENCE = new Set(['existing_mapping', 'email', 'phone', 'mobilePhone', 'name', 'domain', 'address'])
const CHANGE_FIELDS = new Set(SOURCE_FIELDS.map(([key]) => key))

function safeRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function safeScalar(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return null
  const safe = String(value).trim().slice(0, 500)
  return safe || null
}

function safeSnapshot(snapshot) {
  const input = safeRecord(snapshot)
  return Object.fromEntries(SOURCE_FIELDS.flatMap(([key]) => {
    const value = safeScalar(input[key])
    return value === null ? [] : [[key, value]]
  }))
}

function comparisons(hubspot, albi) {
  return COMPARISON_FIELDS.map(([key, label]) => ({
    key, label, hubspot: hubspot[key] ?? 'Not provided', albi: albi[key] ?? 'Not provided',
  }))
}

function safeChanges(value) {
  const changes = safeRecord(value)
  const conflicts = safeRecord(changes.conflicts)
  return Object.keys(conflicts).filter(key => CHANGE_FIELDS.has(key)).sort().map(key => {
    const conflict = safeRecord(conflicts[key])
    return { key, label: SOURCE_FIELDS.find(([field]) => field === key)?.[1] ?? key,
      hubspot: safeScalar(conflict.proposed) ?? 'Not provided', albi: safeScalar(conflict.current) ?? 'Not provided' }
  })
}

export function presentSampleReviewItem(item) {
  const input = safeRecord(item)
  const copy = getH2AReviewReason(input.reason)
  const reason = copy.code
  const source = safeSnapshot(input.sourceSnapshot)
  // The snapshot only holds HubSpot's free-text company property; the live association is authoritative when present.
  const liveOrganizations = Array.isArray(input.hubspotOrganizations)
    ? input.hubspotOrganizations.map(organization => typeof organization?.name === 'string' ? safeScalar(organization.name) : null).filter(Boolean).slice(0, 5) : []
  if (liveOrganizations.length && !source.organizationName) source.organizationName = liveOrganizations.join(', ')
  const rawCandidates = Array.isArray(input.candidateSnapshots) ? input.candidateSnapshots : []
  const candidates = rawCandidates.slice(0, 10).map(candidate => {
    const snapshot = safeSnapshot(candidate)
    return { id: snapshot.id ?? 'Not provided', snapshot, comparisons: comparisons(source, snapshot) }
  })
  const displayName = source.fullName ?? [source.firstName, source.lastName].filter(Boolean).join(' ') ?? source.name ?? ''
  const objectType = ['contacts', 'companies'].includes(input.objectType) ? input.objectType : 'contacts'
  const changes = safeRecord(input.proposedChanges), conflicts = safeRecord(changes.conflicts), updates = safeRecord(changes.updates)
  const resolutionFields = RESOLUTION_FIELDS[objectType].flatMap(key => {
    const conflict = safeRecord(conflicts[key])
    // A missing value is unknown, not an implicit request to clear a property.
    if (Object.hasOwn(conflicts, key) && (!Object.hasOwn(conflict, 'proposed') || !Object.hasOwn(conflict, 'current'))) return []
    const hubspot = Object.hasOwn(conflict, 'proposed') ? resolutionDisplayValue(conflict.proposed)
      : Object.hasOwn(updates, key) ? resolutionDisplayValue(updates[key]) : undefined
    const albi = Object.hasOwn(conflict, 'current') ? resolutionDisplayValue(conflict.current)
      : candidates.length === 1 && Object.hasOwn(candidates[0].snapshot, key) ? candidates[0].snapshot[key] : undefined
    return hubspot !== undefined && albi !== undefined && hubspot !== albi
      ? [{ key, label: SOURCE_FIELDS.find(([field]) => field === key)[1], hubspot, albi }] : []
  })
  // Fields HubSpot leaves blank but the one Albi candidate has: these can be filled into HubSpot from Albi.
  const flagged = new Set(resolutionFields.map(field => field.key))
  const fillableFields = candidates.length === 1 ? RESOLUTION_FIELDS[objectType].flatMap(key => {
    const albi = candidates[0].snapshot[key]
    return !flagged.has(key) && !Object.hasOwn(conflicts, key) && !Object.hasOwn(updates, key) &&
      (source[key] === undefined || source[key] === '') && typeof albi === 'string' && albi.trim() !== ''
      ? [{ key, label: SOURCE_FIELDS.find(([field]) => field === key)[1], hubspot: '', albi, fill: true }] : []
  }) : []
  const portalId = typeof input.portalId === 'string' && /^[1-9]\d{0,99}$/.test(input.portalId) ? input.portalId : null
  return {
    id: safeScalar(input.id), runId: safeScalar(input.runId), objectType,
    sourceId: safeScalar(input.sourceId) ?? source.id ?? 'Not provided', reason,
    reasonLabel: copy.label, guidance: copy.guidance,
    status: STATUSES.has(input.status) ? input.status : 'needs_review',
    resolutionStatus: RESOLUTION_STATUSES.has(input.resolutionStatus) ? input.resolutionStatus : null,
    displayName: displayName || source.name || 'Not provided', source,
    candidates, matchEvidence: Array.isArray(input.matchEvidence) ? [...new Set(input.matchEvidence.filter(value => EVIDENCE.has(value)))] : [],
    proposedChanges: safeChanges(input.proposedChanges),
    resolutionFields, fillableFields, actions: input.status === 'needs_review' || input.status === undefined ? [...getH2AReviewActions(input.reason, objectType)]
      : input.status === 'cleared' && input.recheckOutcome === 'safe_to_create' && copy.actions.includes('create_albi') ? ['create_albi']
        // Recheck found one safe Albi match; let the reviewer save that link now instead of waiting for a sync.
        : input.status === 'cleared' && input.recheckOutcome === 'safe_to_link' && copy.actions.includes('link_existing') && candidates.length > 0 ? ['link_existing'] : [],
    portalId, hubspotUrl: buildHubSpotRecordUrl(portalId, objectType, input.sourceId ?? source.id),
    candidateLinks: candidates.map(candidate => ({ id: candidate.id, url: buildAlbiRecordUrl(objectType, candidate.id) })),
    resolution: presentReviewResolution(input.resolution), resolutionCapability: presentResolutionCapability(input.resolutionCapability),
    lastRecheckedAt: safeScalar(input.lastRecheckedAt), createdAt: safeScalar(input.createdAt), updatedAt: safeScalar(input.updatedAt),
  }
}

// Progress and outcome copy for a "Recheck all" batch polled from the server.
export function presentRecheckAllBatch(batch) {
  const value = safeRecord(batch)
  if (!['queued', 'running', 'completed', 'failed'].includes(value.status)) return null
  const count = number => Number.isSafeInteger(number) && number >= 0 ? number : 0
  const total = count(value.total), done = Math.min(count(value.done), total)
  const percent = total ? Math.round(done / total * 100) : value.status === 'completed' ? 100 : 0
  if (value.status === 'queued' || value.status === 'running') {
    return { active: true, tone: 'info', percent, message: total
      ? `Rechecking ${done} of ${total} open records…` : 'Reading the latest Albi and HubSpot records…' }
  }
  if (value.status === 'completed') {
    if (!total) return { active: false, tone: 'success', percent, message: 'There were no open records to recheck.' }
    const stale = count(value.stale), failed = count(value.failed)
    const message = [`Recheck all finished: ${count(value.cleared)} cleared, ${count(value.stillNeedsReview)} still need review, ${count(value.noLongerInScope)} no longer in scope.`,
      stale ? `${stale} changed during the recheck and were skipped.` : '',
      failed ? `${failed} could not be rechecked; open them to retry.` : ''].filter(Boolean).join(' ')
    return { active: false, tone: stale || failed ? 'warning' : 'success', percent, message }
  }
  const progress = `${done} of ${total} records`
  const message = value.errorCode === 'superseded' ? `A newer sample replaced this one, so recheck all stopped after ${progress}. Reload the queue.`
    : value.errorCode === 'timeout' ? `Recheck all stopped after ${progress}. Run it again to recheck the rest.`
      : done ? `Recheck all stopped unexpectedly after ${progress}. Run it again to recheck the rest.`
        : 'Recheck all could not read the latest Albi or HubSpot records. No records were changed. Try again.'
  return { active: false, tone: 'error', percent, message }
}

export function presentSampleReviewProgress(progress) {
  const value = safeRecord(progress)
  const count = number => Number.isSafeInteger(number) && number >= 0 ? number : 0
  return [
    { key: 'needsReview', label: 'Needs review', value: count(value.needsReview) },
    { key: 'cleared', label: 'Cleared', value: count(value.cleared) },
    { key: 'noLongerInScope', label: 'No longer in scope', value: count(value.noLongerInScope) },
  ]
}
