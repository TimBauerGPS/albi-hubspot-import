import { getH2AReviewReason, H2A_REVIEW_GUIDANCE, listH2AReviewReasonOptions } from '../../../shared/h2aReviewReasons.js'

export const SAMPLE_REVIEW_GUIDANCE = H2A_REVIEW_GUIDANCE
export const SAMPLE_REVIEW_REASON_OPTIONS = listH2AReviewReasonOptions()

const SOURCE_FIELDS = Object.freeze([
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
  const rawCandidates = Array.isArray(input.candidateSnapshots) ? input.candidateSnapshots : []
  const candidates = rawCandidates.slice(0, 10).map(candidate => {
    const snapshot = safeSnapshot(candidate)
    return { id: snapshot.id ?? 'Not provided', snapshot, comparisons: comparisons(source, snapshot) }
  })
  const displayName = source.fullName ?? [source.firstName, source.lastName].filter(Boolean).join(' ') ?? source.name ?? ''
  return {
    id: safeScalar(input.id), runId: safeScalar(input.runId), objectType: ['contacts', 'companies'].includes(input.objectType) ? input.objectType : 'contacts',
    sourceId: safeScalar(input.sourceId) ?? source.id ?? 'Not provided', reason,
    reasonLabel: copy.label, guidance: copy.guidance,
    status: STATUSES.has(input.status) ? input.status : 'needs_review',
    displayName: displayName || source.name || 'Not provided', source,
    candidates, matchEvidence: Array.isArray(input.matchEvidence) ? [...new Set(input.matchEvidence.filter(value => EVIDENCE.has(value)))] : [],
    proposedChanges: safeChanges(input.proposedChanges),
    lastRecheckedAt: safeScalar(input.lastRecheckedAt), createdAt: safeScalar(input.createdAt), updatedAt: safeScalar(input.updatedAt),
  }
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
