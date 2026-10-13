import { createHash } from 'node:crypto'
import { H2A_REVIEW_ERROR_CATEGORIES, H2A_REVIEW_ERROR_CODES } from '../../../shared/h2aReviewReasons.js'

const ACTION_FIELDS = Object.freeze({
  resolve_fields: new Set(['fieldChoices']),
  link_existing: new Set(['candidateId', 'approveManyToOne']),
  create_albi: new Set([]),
  choose_organization: new Set(['organizationSourceId', 'addHubSpotAssociation']),
})
const CONTACT_FIELDS = ['firstName', 'lastName', 'email', 'phoneNumber', 'mobileNumber', 'jobTitle',
  'address1', 'address2', 'city', 'state', 'zipcode', 'country']
const ORGANIZATION_FIELDS = ['name', 'domain', 'phoneNumber', 'address1', 'address2', 'city', 'state', 'zipcode', 'country']
const DECISION_FIELDS = new Set([...CONTACT_FIELDS, ...ORGANIZATION_FIELDS])
export const RESOLUTION_STATUSES = Object.freeze(['pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded'])
export const RESOLUTION_EVENT_TYPES = Object.freeze(['planned', 'claimed', 'provider_applied', 'provider_reconciled',
  'waiting_on_albi', 'recheck_requested', 'completed', 'failed', 'superseded'])
export const RESOLUTION_OUTCOME_CODES = Object.freeze([...H2A_REVIEW_ERROR_CODES, 'authorization_rejected',
  'provider_applied', 'provider_reconciled', 'waiting_on_albi', 'recheck_requested', 'completed', 'failed', 'superseded',
  'safe_to_link', 'safe_to_create', 'still_needs_review', 'source_missing', 'recheck_failed', 'linked', 'created', 'updated', 'reconciled'])
export const RESOLUTION_EVENT_LIMIT = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const record = value => object(value) ? value : {}
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const timestamp = value => typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) ? value : null
const member = (value, choices) => choices.includes(value) ? value : null

export function isResolutionProviderId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
}
const providerId = value => isResolutionProviderId(value) ? value : null

export function normalizeResolutionDecision(input) {
  if (!object(input) || typeof input.action !== 'string' || !Object.hasOwn(ACTION_FIELDS, input.action) ||
    Object.keys(input).some(key => key !== 'action' && !ACTION_FIELDS[input.action].has(key))) {
    throw new TypeError('Invalid resolution decision')
  }
  const decision = { action: input.action }
  if (input.action === 'resolve_fields') {
    if (!object(input.fieldChoices) || !Object.keys(input.fieldChoices).length ||
      Object.entries(input.fieldChoices).some(([field, winner]) => !DECISION_FIELDS.has(field) || !['hubspot', 'albi'].includes(winner))) {
      throw new TypeError('Invalid resolution field choices')
    }
    decision.fieldChoices = Object.fromEntries(Object.keys(input.fieldChoices).sort().map(key => [key, input.fieldChoices[key]]))
  }
  for (const field of ['candidateId', 'organizationSourceId']) {
    if (ACTION_FIELDS[input.action].has(field)) {
      if (!isResolutionProviderId(input[field])) throw new TypeError('Invalid resolution provider identity')
      decision[field] = input[field]
    }
  }
  for (const field of ['approveManyToOne', 'addHubSpotAssociation']) {
    if (Object.hasOwn(input, field)) {
      if (typeof input[field] !== 'boolean') throw new TypeError('Invalid resolution approval')
      decision[field] = input[field]
    }
  }
  return decision
}

function canonical(value) {
  if (!object(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export function hashResolutionDecision(input) {
  return createHash('sha256').update(canonical(normalizeResolutionDecision(input))).digest('hex')
}

function projectedDecision(value, action) {
  const input = record(value)
  if (typeof action !== 'string' || !Object.hasOwn(ACTION_FIELDS, action) || input.action !== action) return null
  const cleaned = { action }
  for (const key of ACTION_FIELDS[action]) if (Object.hasOwn(input, key)) cleaned[key] = input[key]
  if (action === 'resolve_fields') cleaned.fieldChoices = Object.fromEntries(Object.entries(record(input.fieldChoices))
    .filter(([field, winner]) => DECISION_FIELDS.has(field) && ['hubspot', 'albi'].includes(winner)))
  try { return normalizeResolutionDecision(cleaned) } catch { return null }
}

function safeManualTasks(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 10).flatMap(item => {
    const task = record(item)
    if (task.provider !== 'albi' || !['contacts', 'companies'].includes(task.objectType) || !providerId(task.targetId)) return []
    const allowed = task.objectType === 'contacts' ? [...CONTACT_FIELDS, 'organizationId'] : ORGANIZATION_FIELDS
    const fields = (Array.isArray(task.fields) ? task.fields : []).slice(0, 20).flatMap(item => {
      const field = record(item)
      if (!allowed.includes(field.field)) return []
      if (field.field === 'organizationId' && !providerId(field.value)) return []
      const value = typeof field.value === 'string' ? field.value.slice(0, 500)
        : typeof field.value === 'number' && Number.isFinite(field.value) ? String(field.value) : field.value === null ? null : undefined
      return value === undefined ? [] : [{ field: field.field, value }]
    })
    return fields.length ? [{ provider: 'albi', objectType: task.objectType, targetId: task.targetId, fields }] : []
  })
}

export function safeResolutionEventDetails(value) {
  const input = record(value)
  const details = {}
  if (RESOLUTION_OUTCOME_CODES.includes(input.code)) details.code = input.code
  if (H2A_REVIEW_ERROR_CATEGORIES.includes(input.category)) details.category = input.category
  if (RESOLUTION_OUTCOME_CODES.includes(input.outcome)) details.outcome = input.outcome
  if (Array.isArray(input.manualTasks)) details.manualTasks = safeManualTasks(input.manualTasks)
  return details
}

export function projectReviewResolutionEvent(row) {
  const stored = record(row)
  return { id: uuid(stored.id), actorId: uuid(stored.actor_id), eventType: member(stored.event_type, RESOLUTION_EVENT_TYPES),
    details: safeResolutionEventDetails(stored.sanitized_details), createdAt: timestamp(stored.created_at) }
}

// Only this projection belongs in browser responses. Repository rows are executor-facing.
export function projectReviewResolution(row, events = []) {
  if (!object(row)) return null
  const action = typeof row.action === 'string' && Object.hasOwn(ACTION_FIELDS, row.action) ? row.action : null
  return { id: uuid(row.id), runId: uuid(row.run_id), reviewId: uuid(row.review_id), portalId: providerId(row.portal_id),
    objectType: member(row.object_type, ['contacts', 'companies']), sourceId: providerId(row.source_id), action,
    status: member(row.status, RESOLUTION_STATUSES), expectedUpdatedAt: timestamp(row.expected_review_updated_at),
    decision: projectedDecision(row.decision, action), providerOutcomeCode: member(row.provider_outcome_code, RESOLUTION_OUTCOME_CODES),
    createdBy: uuid(row.created_by), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    events: (Array.isArray(events) ? events : []).slice(0, RESOLUTION_EVENT_LIMIT).map(projectReviewResolutionEvent) }
}
