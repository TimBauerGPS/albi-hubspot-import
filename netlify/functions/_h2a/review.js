import { H2A_REVIEW_REASON_CATALOG, H2A_REVIEW_ERROR_CATEGORIES, H2A_REVIEW_ERROR_CODES } from '../../../shared/h2aReviewReasons.js'
import { decideContactMatch, decideOrganizationMatch, selectReviewCandidates } from './match.js'
import { normalizePhone } from './normalize.js'
import { resolveContactType } from './options.js'
import { rankReviewCandidates } from './ranking.js'

const MAX_STRING = 500
const MAX_CANDIDATES = 10
const EMPTY_CHANGES = () => ({ updates: {}, conflicts: {}, unchanged: [] })

function frozenSet(values) {
  const set = new Set(values)
  for (const method of ['add', 'delete', 'clear']) {
    Object.defineProperty(set, method, { value() { throw new TypeError('Review allowlists are immutable') } })
  }
  return Object.freeze(set)
}

const ERROR_CATEGORIES = frozenSet(H2A_REVIEW_ERROR_CATEGORIES)
const ERROR_CODES = frozenSet(H2A_REVIEW_ERROR_CODES)
const REVIEW_OUTCOMES = frozenSet(['still_needs_review', 'safe_to_link', 'safe_to_create', 'source_missing', 'recheck_failed'])
const EVENT_TYPES = frozenSet(['captured', 'recheck_started', 'still_needs_review', 'cleared', 'no_longer_in_scope', 'recheck_failed'])
const STATUSES = frozenSet(['needs_review', 'cleared', 'no_longer_in_scope'])
const RESOLUTION_STATUSES = frozenSet(['pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded'])
const EVIDENCE = frozenSet(['existing_mapping', 'email', 'phone', 'mobilePhone', 'name', 'domain', 'address'])

export const REVIEW_REASONS = frozenSet(Object.keys(H2A_REVIEW_REASON_CATALOG))
export const REVIEW_CONFLICT_TYPES = frozenSet([
  'organization_match', 'organization_fields', 'organization_phone', 'contact_match', 'contact_fields',
  'contact_phone', 'configuration', 'association', 'missing_source', 'activity_target', 'identity',
])

const SHARED_FIELDS = {
  email: ['email', 'emailAddress'], phoneNumber: ['phoneNumber', 'phone', 'phone_number'],
  address1: ['address1', 'address', 'streetAddress', 'street_address'], address2: ['address2', 'addressLine2'],
  city: ['city'], state: ['state', 'stateCode'], zipcode: ['zipcode', 'zipCode', 'zip', 'postalCode'], country: ['country', 'countryCode'],
}
const CONTACT_FIELDS = {
  id: ['id', 'targetId', 'albiId'], firstName: ['firstName', 'firstname'], lastName: ['lastName', 'lastname'], fullName: ['fullName', 'fullname'],
  email: SHARED_FIELDS.email, additionalEmails: ['hs_additional_emails', 'additionalEmails'], phoneNumber: SHARED_FIELDS.phoneNumber, mobileNumber: ['mobileNumber', 'mobilePhone', 'mobilephone', 'mobile'],
  organizationId: ['organizationId', 'organization_id'], organizationName: ['organizationName', 'company', 'companyName'], jobTitle: ['jobTitle', 'jobtitle', 'title'],
  address1: SHARED_FIELDS.address1, address2: SHARED_FIELDS.address2, city: SHARED_FIELDS.city, state: SHARED_FIELDS.state,
  zipcode: SHARED_FIELDS.zipcode, country: SHARED_FIELDS.country,
}
const ORGANIZATION_FIELDS = {
  id: ['id', 'targetId', 'albiId'], name: ['name', 'companyName'], domain: ['domain', 'website', 'websiteUrl'],
  email: SHARED_FIELDS.email, phoneNumber: SHARED_FIELDS.phoneNumber, organizationTypeIds: ['organizationTypeIds'], parentOrganizationId: ['parentOrganizationId'],
  address1: SHARED_FIELDS.address1, address2: SHARED_FIELDS.address2, city: SHARED_FIELDS.city, state: SHARED_FIELDS.state,
  zipcode: SHARED_FIELDS.zipcode, country: SHARED_FIELDS.country,
}

const owns = (record, key) => record != null && Object.hasOwn(record, key)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const scalar = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
  ? String(value).trim().slice(0, MAX_STRING) : null
// Matching uses complete IDs; truncation belongs only at the storage/response boundary.
const identity = value => (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) && String(value).trim()
  ? String(value) : null
const array = value => Array.isArray(value) ? value : []
const fieldsFor = type => ['contact', 'contacts'].includes(type) ? CONTACT_FIELDS
  : ['organization', 'organizations', 'company', 'companies'].includes(type) ? ORGANIZATION_FIELDS : {}

function valueOf(record, aliases, rootFirst = false) {
  const sources = rootFirst ? [object(record), object(record?.properties)] : [object(record?.properties), object(record)]
  for (const alias of aliases) {
    for (const source of sources) {
      if (owns(source, alias) && source[alias] != null && source[alias] !== '') return source[alias]
    }
  }
  return null
}

export function safeReviewSnapshot(record, objectType) {
  const snapshot = {}
  for (const [field, aliases] of Object.entries(fieldsFor(objectType))) {
    const value = valueOf(record, aliases, field === 'id')
    if (field === 'organizationTypeIds') {
      if (Array.isArray(value)) snapshot[field] = value.map(scalar).filter(item => item !== null && item !== '').slice(0, MAX_CANDIDATES)
    } else {
      const safe = scalar(value)
      if (safe !== null && safe !== '') snapshot[field] = safe
    }
  }
  return snapshot
}

export function safeReviewCandidates(records, objectType) {
  return array(records).map(record => safeReviewSnapshot(record, objectType)).filter(record => record.id).slice(0, MAX_CANDIDATES)
}

export function safeReviewEvidence(value) {
  return [...new Set(array(Array.isArray(value) ? value : value?.evidence).filter(item => EVIDENCE.has(item)))]
}

const displayReason = value => REVIEW_REASONS.has(value) ? value : 'other_review_reason'

export function assertReviewClassification(reason, conflictType) {
  if (!REVIEW_REASONS.has(reason) || !REVIEW_CONFLICT_TYPES.has(conflictType)) throw new TypeError('Invalid review classification')
}

export function safeReviewChanges(value, objectType) {
  const changes = EMPTY_CHANGES()
  const allowed = Object.keys(fieldsFor(objectType)).filter(field => !['id', 'organizationTypeIds'].includes(field))
  const input = object(value)
  for (const field of allowed) {
    if (owns(input.updates, field)) {
      const safe = scalar(input.updates[field])
      if (safe !== null) changes.updates[field] = safe
    }
    if (owns(input.conflicts, field)) {
      const comparison = object(input.conflicts[field])
      if (owns(comparison, 'current') || owns(comparison, 'proposed')) {
        // Missing evidence is unknown, distinct from an explicitly captured blank.
        changes.conflicts[field] = Object.fromEntries(['current', 'proposed'].filter(key => owns(comparison, key) &&
          (comparison[key] === null || scalar(comparison[key]) !== null))
          .map(key => [key, scalar(comparison[key])]))
        if (owns(comparison, 'reason')) changes.conflicts[field].reason = displayReason(comparison.reason)
      }
    }
  }
  changes.unchanged = [...new Set(array(input.unchanged).filter(field => allowed.includes(field)))]
  return changes
}

function mappingForReview(mappings, sourceId, portalId) {
  return array(mappings).find(mapping => identity(mapping?.sourceId ?? mapping?.hubspotId ?? mapping?.hubspot_id) === sourceId &&
    (portalId === null || (mapping.portal_id ?? mapping.portalId ?? portalId) === portalId))
}

function defaultOption(mappings, kind) {
  const matching = array(mappings).filter(mapping => (mapping?.mapping_kind ?? mapping?.mappingKind) === kind &&
    (mapping?.source_key ?? mapping?.sourceKey) === 'default')
  // Reuse the option resolver's confirmation and duplicate validation for the default.
  const resolved = resolveContactType({ mappings: matching.map(mapping => ({
    mapping_kind: 'default_contact_type', albi_id: mapping.albi_id ?? mapping.albiId,
    confirmed: mapping.confirmed, is_confirmed: mapping.is_confirmed, confirmed_at: mapping.confirmed_at,
  })) })
  return resolved.action === 'resolved' ? resolved.contactTypeId : null
}

function sourcePhone(source) {
  return normalizePhone(valueOf(source, SHARED_FIELDS.phoneNumber))
}
const hasChanges = changes => Object.keys(changes.updates).length > 0 || Object.keys(changes.conflicts).length > 0

function reviewResult(outcome, conflictType, decision, candidates, entityType) {
  if (outcome === 'needs_review') assertReviewClassification(decision.reason, conflictType)
  return {
    outcome, reason: displayReason(decision.reason), conflictType, targetId: scalar(decision.targetId),
    evidence: safeReviewEvidence(decision.evidence), proposedChanges: safeReviewChanges(decision.proposedChanges, entityType),
    candidates: safeReviewCandidates(candidates, entityType),
  }
}

export function evaluateOrganizationReview({ source, candidates = [], mappings = [], optionMappings = [], portalId = null } = {}) {
  const sourceId = identity(valueOf(source, ['id'], true))
  const input = { source, sourceId, candidates, existingMapping: mappingForReview(mappings, sourceId, portalId), mappings, portalId }
  const decision = decideOrganizationMatch(input)
  const related = selectReviewCandidates(input, decision, 'organization')
  const conflict = (type, result = decision, selected = related) => reviewResult('needs_review', type, result, selected, 'organization')
  if (decision.action === 'conflict') return conflict('organization_match')
  if (decision.action === 'link' && hasChanges(decision.proposedChanges)) {
    return conflict('organization_fields', { ...decision, reason: Object.keys(decision.proposedChanges.updates).length
      ? 'albi_organization_update_contract_unverified' : 'nonblank_field_difference' })
  }
  if (decision.action === 'link') return reviewResult('safe_to_link', '', decision, related, 'organization')
  if (!defaultOption(optionMappings, 'default_organization_type')) return conflict('configuration', { reason: 'organization_type_confirmation_required' }, [])
  const phone = sourcePhone(source)
  if (phone.conflictReason) return conflict('organization_phone', { reason: phone.conflictReason }, [])
  return reviewResult('safe_to_create', '', decision, [], 'organization')
}

export function selectReviewedOrganizationContext({ associatedCompanyIds = [], choice = null, availableCompanies = [],
  companyId = null, portalId = null, contactId = null } = {}) {
  const ids = new Set(array(associatedCompanyIds).map(identity).filter(Boolean))
  const selected = identity(object(choice).hubspot_company_id)
  const applicable = [['company_id', companyId], ['portal_id', portalId], ['hubspot_contact_id', contactId]]
    .every(([field, expected]) => expected === null || !owns(choice, field) || identity(choice[field]) === identity(expected))
  if (selected && applicable && ids.has(selected) && array(availableCompanies)
    .some(company => company?.archived !== true && identity(company?.id) === selected)) {
    return { status: 'selected', companyId: selected }
  }
  return { status: ids.size === 1 ? 'single' : 'ambiguous', companyId: ids.size === 1 ? [...ids][0] : null }
}

export function evaluateContactReview({ source, candidates = [], mappings = [], optionMappings = [], associatedCompanyIds = [],
  organization = null, organizationChoice = null, availableCompanies = [], companyId = null, portalId = null } = {}) {
  const conflict = (type, result, selected = []) => reviewResult('needs_review', type, result, selected, 'contact')
  const sourceId = identity(valueOf(source, ['id'], true))
  const context = selectReviewedOrganizationContext({ associatedCompanyIds, choice: organizationChoice, availableCompanies,
    companyId, portalId, contactId: sourceId })
  if (context.status === 'ambiguous' && new Set(associatedCompanyIds.map(String)).size > 1) {
    return conflict('association', { reason: 'multiple_associated_organizations' })
  }
  if (context.status === 'selected' && !['safe_to_link', 'safe_to_create'].includes(organization?.outcome)) {
    return conflict('association', { reason: 'organization_unresolved' })
  }
  const input = { source, sourceId, candidates, existingMapping: mappingForReview(mappings, sourceId, portalId), mappings, portalId }
  const decision = decideContactMatch(input)
  const related = selectReviewCandidates(input, decision, 'contact')
  if (decision.action === 'conflict') return conflict('contact_match', decision, related)
  if (decision.action === 'link') {
    if (hasChanges(decision.proposedChanges)) return conflict('contact_fields', { ...decision,
      reason: Object.keys(decision.proposedChanges.updates).length ? 'albi_contact_update_contract_unverified' : 'nonblank_field_difference' }, related)
    const target = candidates.find(candidate => identity(valueOf(candidate, ['id', 'targetId', 'albiId'], true)) === decision.targetId)
    const organizationTargetId = identity(organization?.targetId)
    // Existing contacts require a resolved organization target; a proposed
    // organization creation cannot establish their current association.
    if (organization?.outcome === 'safe_to_create' || organization?.outcome === 'safe_to_link' &&
      (!organizationTargetId || target && identity(valueOf(target, ['organizationId'])) !== organizationTargetId)) {
      return conflict('association', { ...decision, reason: 'albi_contact_association_contract_unverified' }, related)
    }
    return reviewResult('safe_to_link', '', decision, related, 'contact')
  }
  const type = resolveContactType({ mappings: optionMappings, inheritFromOrganization: true, organizationTypeId: organization?.organizationTypeId })
  if (type.action !== 'resolved') return conflict('configuration', { reason: type.reason })
  if ((organization && !['safe_to_link', 'safe_to_create'].includes(organization.outcome)) || (associatedCompanyIds.length && !organization)) {
    return conflict('association', { reason: 'organization_unresolved' })
  }
  const phone = sourcePhone(source)
  if (phone.conflictReason) return conflict('contact_phone', { reason: phone.conflictReason })
  return reviewResult('safe_to_create', '', decision, [], 'contact')
}

const TRIAGE_BUCKET_VALUES = new Set(['quick', 'todo', 'decision', 'blocked', 'done'])
function safeTriageDetails(value) {
  const details = object(value), safe = {}
  if (typeof details.blockedReason === 'string') safe.blockedReason = details.blockedReason.slice(0, 80)
  if (details.merged === true) safe.merged = true
  if (['link', 'create'].includes(details.quickKind)) safe.quickKind = details.quickKind
  return safe
}

export function projectReviewRow(row, { detail = false, mappings = [] } = {}) {
  const stored = object(row)
  const objectType = ['contacts', 'companies'].includes(stored.object_type) ? stored.object_type : null
  const source = safeReviewSnapshot(stored.source_snapshot, objectType)
  const projected = {
    id: scalar(stored.id), runId: scalar(stored.run_id), reviewKind: stored.review_kind === 'live' ? 'live' : 'sample', objectType, sourceId: scalar(stored.source_id),
    reason: displayReason(stored.reason), conflictType: REVIEW_CONFLICT_TYPES.has(stored.conflict_type) ? stored.conflict_type : 'other_review_reason',
    status: STATUSES.has(stored.status) ? stored.status : null, recheckOutcome: REVIEW_OUTCOMES.has(stored.recheck_outcome) ? stored.recheck_outcome : null,
    resolutionStatus: RESOLUTION_STATUSES.has(stored.resolution_status) ? stored.resolution_status : null,
    triageBucket: TRIAGE_BUCKET_VALUES.has(stored.triage_bucket) ? stored.triage_bucket : 'decision',
    triageDetails: safeTriageDetails(stored.triage_details),
  }
  if (detail) {
    projected.portalId = typeof stored.portal_id === 'string' && /^[1-9]\d{0,99}$/.test(stored.portal_id) ? stored.portal_id : null
    projected.sourceSnapshot = source
    projected.candidateSnapshots = safeReviewCandidates(stored.candidate_snapshots, objectType)
    projected.matchEvidence = safeReviewEvidence(stored.match_evidence)
    projected.proposedChanges = safeReviewChanges(stored.proposed_changes, objectType)
    const scoped = Array.isArray(mappings) ? mappings : array(object(mappings)[objectType === 'companies' ? 'organizations' : 'contacts'])
    const ranked = rankReviewCandidates({ objectType, source, candidates: projected.candidateSnapshots, mappings: scoped,
      portalId: projected.portalId, sourceId: projected.sourceId })
    projected.rankedCandidates = ranked.candidates
    projected.suggestedCandidateId = ranked.suggestedCandidateId
  } else {
    projected.displayName = scalar(source.fullName ?? (objectType === 'companies' ? source.name : [source.firstName, source.lastName].filter(Boolean).join(' ')))
    projected.identity = { email: source.email ?? null, phone: source.phoneNumber ?? source.mobileNumber ?? null,
      organizationName: source.organizationName ?? (objectType === 'companies' ? source.name : null) ?? null, domain: source.domain ?? null }
  }
  projected.lastRecheckedAt = scalar(stored.last_rechecked_at)
  if (detail) projected.lastRecheckedBy = scalar(stored.last_rechecked_by)
  projected.createdAt = scalar(stored.created_at)
  projected.updatedAt = scalar(stored.updated_at)
  return projected
}

export function projectReviewEvent(row) {
  const stored = object(row)
  const details = object(stored.sanitized_details)
  const projectedDetails = {}
  if (REVIEW_OUTCOMES.has(details.outcome)) projectedDetails.outcome = details.outcome
  if (ERROR_CATEGORIES.has(details.category)) projectedDetails.category = details.category
  if (ERROR_CODES.has(details.code)) projectedDetails.code = details.code
  return { id: scalar(stored.id), eventType: EVENT_TYPES.has(stored.event_type) ? stored.event_type : null,
    reason: stored.reason == null ? null : displayReason(stored.reason), actorId: scalar(stored.actor_id),
    details: projectedDetails, createdAt: scalar(stored.created_at) }
}
