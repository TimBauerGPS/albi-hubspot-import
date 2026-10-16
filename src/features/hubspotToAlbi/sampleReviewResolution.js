import { getH2AReviewReason, H2A_REVIEW_ERROR_CATEGORIES, H2A_REVIEW_ERROR_CODES } from '../../../shared/h2aReviewReasons.js'
import { buildAlbiRecordUrl, buildHubSpotRecordUrl } from '../../../shared/h2aProviderLinks.js'

export const RESOLUTION_FIELDS = Object.freeze({
  contacts: Object.freeze(['firstName', 'lastName', 'email', 'phoneNumber', 'mobileNumber', 'jobTitle', 'address1', 'address2', 'city', 'state', 'zipcode', 'country']),
  companies: Object.freeze(['name', 'domain', 'phoneNumber', 'address1', 'address2', 'city', 'state', 'zipcode', 'country']),
})
const LABELS = Object.freeze({ firstName: 'First name', lastName: 'Last name', email: 'Email', phoneNumber: 'Phone',
  mobileNumber: 'Mobile', jobTitle: 'Job title', address1: 'Address', address2: 'Address line 2', city: 'City',
  state: 'State / region', zipcode: 'Postal code', country: 'Country', name: 'Name', domain: 'Domain', organizationId: 'Organization ID' })
const ACTION_FIELDS = Object.freeze({ resolve_fields: ['fieldChoices'], link_existing: ['candidateId', 'approveManyToOne'],
  create_albi: [], force_create_albi: ['ignoredCandidateIds', 'deferOrganizationAssociation'], choose_organization: ['organizationSourceId', 'addHubSpotAssociation'] })
const STATUS_LABELS = Object.freeze({ pending: 'Pending', applying: 'Applying', waiting_on_albi: 'Waiting on Albi',
  ready_to_recheck: 'Ready to recheck', completed: 'Completed', failed: 'Failed', superseded: 'Superseded' })
const EVENT_LABELS = Object.freeze({ planned: 'Resolution planned', claimed: 'Resolution started', provider_applied: 'Provider change applied',
  provider_reconciled: 'Provider change verified', waiting_on_albi: 'Waiting on Albi', recheck_requested: 'Recheck requested',
  completed: 'Completed', failed: 'Failed', superseded: 'Superseded' })
const OUTCOMES = new Set([...H2A_REVIEW_ERROR_CODES, 'authorization_rejected', ...Object.keys(EVENT_LABELS),
  'safe_to_link', 'safe_to_create', 'still_needs_review', 'source_missing', 'recheck_failed', 'linked', 'created', 'forced_created', 'updated', 'reconciled'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const record = value => object(value) ? value : {}
const ownMember = (values, key) => typeof key === 'string' && Object.hasOwn(values, key)
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null
const id = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value) ? value : null
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10) ? value : null
const fail = () => { throw new TypeError('Invalid resolution decision.') }
// Preserve blanks: null and empty text are an explicit clearing consequence.
export function resolutionDisplayValue(value) {
  return value === null ? null : typeof value === 'string' && value.length <= 500 ? value
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

function decision(input) {
  if (!object(input) || !ownMember(ACTION_FIELDS, input.action) ||
    Object.keys(input).some(key => key !== 'action' && !ACTION_FIELDS[input.action].includes(key))) fail()
  const result = { action: input.action }
  if (input.action === 'resolve_fields') {
    if (!object(input.fieldChoices) || !Object.keys(input.fieldChoices).length || Object.entries(input.fieldChoices)
      .some(([field, winner]) => ![...RESOLUTION_FIELDS.contacts, ...RESOLUTION_FIELDS.companies].includes(field) || !['hubspot', 'albi'].includes(winner))) fail()
    result.fieldChoices = Object.fromEntries(Object.keys(input.fieldChoices).sort().map(field => [field, input.fieldChoices[field]]))
  }
  if (input.action === 'force_create_albi') {
    if (!Array.isArray(input.ignoredCandidateIds) || !input.ignoredCandidateIds.length || input.ignoredCandidateIds.length > 10 ||
      input.ignoredCandidateIds.some(value => !id(value)) || new Set(input.ignoredCandidateIds).size !== input.ignoredCandidateIds.length) fail()
    result.ignoredCandidateIds = [...input.ignoredCandidateIds].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
    if (Object.hasOwn(input, 'deferOrganizationAssociation')) {
      if (input.deferOrganizationAssociation !== true) fail()
      result.deferOrganizationAssociation = true
    }
  }
  for (const field of ['candidateId', 'organizationSourceId']) if (ACTION_FIELDS[input.action].includes(field)) {
    if (!id(input[field])) fail()
    result[field] = input[field]
  }
  for (const field of ['approveManyToOne', 'addHubSpotAssociation']) if (Object.hasOwn(input, field)) {
    if (typeof input[field] !== 'boolean') fail()
    result[field] = input[field]
  }
  return result
}

export function buildResolutionRequest(input) {
  if (!object(input) || !uuid(input.reviewId) || !uuid(input.clientRequestId) || !time(input.expectedUpdatedAt)) fail()
  const { reviewId, expectedUpdatedAt, clientRequestId, ...choices } = input
  return { reviewId, expectedUpdatedAt, clientRequestId, ...decision(choices) }
}

function publicDecision(input, action) {
  if (!ownMember(ACTION_FIELDS, action) || input?.action !== action) return null
  const clean = { action }
  for (const field of ACTION_FIELDS[action]) if (Object.hasOwn(record(input), field)) clean[field] = input[field]
  if (action === 'resolve_fields') clean.fieldChoices = Object.fromEntries(Object.entries(record(input.fieldChoices)).filter(([field, winner]) =>
    [...RESOLUTION_FIELDS.contacts, ...RESOLUTION_FIELDS.companies].includes(field) && ['hubspot', 'albi'].includes(winner)))
  try { return decision(clean) } catch { return null }
}

function manualTasks(input) {
  return (Array.isArray(input) ? input : []).slice(0, 10).flatMap(item => {
    const task = record(item)
    if (task.provider !== 'albi' || !ownMember(RESOLUTION_FIELDS, task.objectType) || !id(task.targetId)) return []
    const allowed = [...RESOLUTION_FIELDS[task.objectType], ...(task.objectType === 'contacts' ? ['organizationId'] : [])]
    const fields = (Array.isArray(task.fields) ? task.fields : []).slice(0, 20).flatMap(item => {
      const field = record(item), value = resolutionDisplayValue(field.value)
      return allowed.includes(field.field) && value !== undefined && (field.field !== 'organizationId' || id(value))
        ? [{ field: field.field, label: LABELS[field.field], value }] : []
    })
    const organizationId = fields.find(field => field.field === 'organizationId')?.value
    return fields.length ? [{ provider: 'albi', objectType: task.objectType, targetId: task.targetId,
      url: buildAlbiRecordUrl(task.objectType, task.targetId), organizationUrl: buildAlbiRecordUrl('companies', organizationId), fields }] : []
  })
}

export function presentResolutionCapability(input) {
  const value = record(input), mode = ['disabled', 'super_admin', 'admins'].includes(value.mode) ? value.mode : 'disabled'
  return { enabled: mode !== 'disabled' && value.enabled === true, mode,
    canResolve: mode !== 'disabled' && value.enabled === true && value.canResolve === true,
    hubspotWrites: ['available', 'rejected'].includes(value.hubspotWrites) ? value.hubspotWrites : 'verified_when_first_used' }
}

export function presentReviewResolution(item) {
  if (!object(item)) return null
  const status = ownMember(STATUS_LABELS, item.status) ? item.status : null
  const action = ownMember(ACTION_FIELDS, item.action) ? item.action : null
  const objectType = ownMember(RESOLUTION_FIELDS, item.objectType) ? item.objectType : null
  const providerOutcomeCode = OUTCOMES.has(item.providerOutcomeCode) ? item.providerOutcomeCode : null
  return { id: uuid(item.id), reviewId: uuid(item.reviewId), runId: uuid(item.runId), portalId: id(item.portalId), sourceId: id(item.sourceId),
    objectType, action, status, statusLabel: STATUS_LABELS[status] ?? 'Unknown resolution status',
    decision: publicDecision(item.decision, action), providerOutcomeCode,
    outcomeLabel: providerOutcomeCode === 'authorization_rejected' ? 'Authentication or write scope rejected'
      : EVENT_LABELS[providerOutcomeCode] ?? (providerOutcomeCode ? getH2AReviewReason(providerOutcomeCode).label : 'Resolution details unavailable'),
    hubspotUrl: buildHubSpotRecordUrl(id(item.portalId), objectType, id(item.sourceId)),
    expectedUpdatedAt: time(item.expectedUpdatedAt), createdBy: uuid(item.createdBy), createdAt: time(item.createdAt), updatedAt: time(item.updatedAt),
    events: (Array.isArray(item.events) ? item.events : []).slice(0, 100).map(item => {
      const event = record(item), details = record(event.details), eventType = ownMember(EVENT_LABELS, event.eventType) ? event.eventType : null
      return { id: uuid(event.id), actorId: uuid(event.actorId), eventType, label: EVENT_LABELS[eventType] ?? 'Resolution event',
        createdAt: time(event.createdAt), code: OUTCOMES.has(details.code) ? details.code : null,
        category: H2A_REVIEW_ERROR_CATEGORIES.includes(details.category) ? details.category : null,
        outcome: OUTCOMES.has(details.outcome) ? details.outcome : null, manualTasks: manualTasks(details.manualTasks) }
    }) }
}

// Confirmation is local display evidence only; it is never sent as a provider payload.
export function buildResolutionConfirmation({ review, decision: input } = {}) {
  if (!object(review) || !ownMember(RESOLUTION_FIELDS, review.objectType)) fail()
  const selected = decision(input)
  if (!getH2AReviewReason(review.reason).actions.includes(selected.action)) fail()
  const result = { hubspotWrites: [], albiTasks: [], mapping: null, association: null }
  if (selected.action === 'resolve_fields') {
    const candidates = Array.isArray(review.candidates) ? review.candidates : []
    if (candidates.length !== 1 || !id(candidates[0].id)) fail()
    for (const [key, winner] of Object.entries(selected.fieldChoices)) {
      if (!RESOLUTION_FIELDS[review.objectType].includes(key)) fail()
      const changes = (Array.isArray(review.resolutionFields) ? review.resolutionFields : []).filter(field => field.key === key)
      if (changes.length !== 1) fail()
      const field = changes[0], value = resolutionDisplayValue(field[winner])
      if (value === undefined) fail()
      if (field.hubspot === field.albi) continue
      if (winner === 'albi') result.hubspotWrites.push({ field: LABELS[key], value })
      else result.albiTasks.push({ field: LABELS[key], value, url: buildAlbiRecordUrl(review.objectType, candidates[0].id) })
    }
  } else if (selected.action === 'link_existing') {
    if (!id(review.sourceId) || !(Array.isArray(review.candidates) ? review.candidates : []).some(item => item.id === selected.candidateId)) fail()
    result.mapping = { objectType: review.objectType, sourceId: review.sourceId, targetId: selected.candidateId,
      approveManyToOne: selected.approveManyToOne === true, url: buildAlbiRecordUrl(review.objectType, selected.candidateId) }
  } else if (selected.action === 'create_albi') {
    if (!id(review.sourceId)) fail()
    result.mapping = { objectType: review.objectType, sourceId: review.sourceId, targetId: null, createAlbi: true }
  } else if (selected.action === 'force_create_albi') {
    if (!id(review.sourceId)) fail()
    const candidates = (Array.isArray(review.candidates) ? review.candidates : []).map(item => id(item.id)).filter(Boolean)
      .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
    if (!candidates.length || JSON.stringify(candidates) !== JSON.stringify(selected.ignoredCandidateIds)) fail()
    result.mapping = { objectType: review.objectType, sourceId: review.sourceId, targetId: null, createAlbi: true,
      forced: true, ignoredCandidateIds: [...selected.ignoredCandidateIds],
      deferOrganizationAssociation: selected.deferOrganizationAssociation === true }
  } else {
    if (review.objectType !== 'contacts' || !id(review.sourceId)) fail()
    result.association = { contactId: review.sourceId, organizationSourceId: selected.organizationSourceId,
      addHubSpotAssociation: selected.addHubSpotAssociation === true,
      url: buildHubSpotRecordUrl(review.portalId, 'companies', selected.organizationSourceId) }
  }
  return result
}
