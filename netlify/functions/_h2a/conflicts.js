import { randomUUID } from 'node:crypto'

const API_TO_DB_ACTION = Object.freeze({
  link_existing: 'link_existing',
  create_new: 'create_new',
  approve_fields: 'approve_hubspot',
  retain_albi: 'retain_albi',
  skip_item: 'skip',
})
const WRITABLE_FIELDS = new Set(['firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
  'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country'])
const SNAPSHOT_FIELDS = WRITABLE_FIELDS
const CONFLICT_FIELDS = ['id', 'portal_id', 'object_type', 'source_id', 'conflict_type', 'reason', 'match_evidence',
  'source_snapshot', 'candidate_snapshots', 'proposed_changes', 'status', 'run_id', 'activity_delivery_id',
  'activity_object_type', 'activity_id', 'resolved_by', 'resolution_action', 'resolved_at', 'created_at', 'updated_at']
const SECRET_KEY = /(?:token|secret|credential|cipher|authorization|password|raw|error|body|api.?key|message|response)/i

export function conflictResumePayload(intent) {
  return {
    companyId: intent.company_id, mode: 'live', trigger: 'conflict_resolution', resumeId: intent.id,
    sourceObjectType: intent.source_object_type, sourceId: intent.source_id,
    ...(intent.activity_object_type && intent.activity_id ? { activityObjectType: intent.activity_object_type, activityId: intent.activity_id } : {}),
    ...(intent.originating_run_id ? { originatingRunId: intent.originating_run_id } : {}),
    ...(intent.activity_delivery_id ? { activityDeliveryId: intent.activity_delivery_id } : {}),
  }
}

export class H2AConflictError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'H2AConflictError'
    this.statusCode = statusCode
  }
}

function fail(statusCode, message) { throw new H2AConflictError(statusCode, message) }

function object(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, message)
  return value
}

function validCompanyId(companyId) {
  if (typeof companyId !== 'string' || !companyId.trim() || companyId.length > 200) fail(400, 'A valid company is required.')
}

function validTimestamp(value, label) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  if (!match || !Number.isFinite(Date.parse(value))) fail(400, `${label} must be a valid ISO timestamp.`)
  const [, year, month, day, hour, minute, second, zone] = match
  const calendar = new Date(0)
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  calendar.setUTCHours(Number(hour), Number(minute), Number(second), 0)
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4, 6)) > 59 ||
      Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4, 6)) !== 0)) {
    fail(400, `${label} must be a valid ISO timestamp.`)
  }
  return value
}

function validateCursor(cursor) {
  if (cursor == null || cursor === '') return null
  object(cursor, 'Invalid conflict cursor.')
  if (Object.keys(cursor).length !== 2 || typeof cursor.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.id)) {
    fail(400, 'Invalid conflict cursor.')
  }
  return { createdAt: validTimestamp(cursor.createdAt, 'Conflict cursor timestamp'), id: cursor.id }
}

function safeJson(value, depth = 0) {
  if (depth > 5 || value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 500)
  if (Array.isArray(value)) return value.slice(0, 25).map(item => safeJson(item, depth + 1))
  if (typeof value !== 'object') return undefined
  const result = {}
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (SECRET_KEY.test(key) || key.length > 80) continue
    const safe = safeJson(item, depth + 1)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

function safeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key]) => SNAPSHOT_FIELDS.has(key))
    .slice(0, 25).map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 500) : safeJson(item)]))
}

function sanitizeConflict(row, audit = []) {
  if (!row || typeof row !== 'object') return null
  const result = Object.fromEntries(CONFLICT_FIELDS.filter(key => row[key] !== undefined)
    .map(key => [key, key === 'source_snapshot' ? safeSnapshot(row[key])
      : key === 'candidate_snapshots' && Array.isArray(row[key]) ? row[key].slice(0, 10).map(safeSnapshot)
        : ['match_evidence', 'proposed_changes'].includes(key) ? safeJson(row[key]) : row[key]]))
  delete result.company_id
  result.audit = audit.map(event => ({
    id: event.id, event_type: event.event_type, actor_id: event.actor_id, resolution_action: event.resolution_action,
    created_at: event.created_at, sanitized_details: safeJson(event.sanitized_details),
  }))
  return result
}

export async function listConflicts({ repository, companyId, cursor = null, limit = 25 }) {
  validCompanyId(companyId)
  if (!repository?.listConflicts || !repository?.listConflictEvents) throw new TypeError('Conflict repository is required')
  if (!Number.isSafeInteger(limit) || limit < 1) fail(400, 'Conflict page size must be between 1 and 100.')
  const pageSize = Math.min(limit, 100)
  const before = validateCursor(cursor)
  const page = await repository.listConflicts(companyId, { limit: pageSize + 1, before })
  const rows = Array.isArray(page?.items) ? page.items : []
  const hasMore = page?.hasMore === true || rows.length > pageSize
  const selected = rows.slice(0, pageSize)
  const events = selected.length ? await repository.listConflictEvents(companyId, selected.map(row => row.id)) : []
  const auditByConflict = new Map()
  for (const event of events ?? []) {
    if (!selected.some(row => row.id === event.conflict_id)) continue
    const group = auditByConflict.get(event.conflict_id) ?? []
    group.push(event)
    auditByConflict.set(event.conflict_id, group)
  }
  const items = selected.map(row => sanitizeConflict(row, auditByConflict.get(row.id) ?? []))
  const last = items.at(-1)
  return { items, nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null }
}

function validateResolution(input) {
  object(input, 'A conflict resolution is required.')
  validCompanyId(input.companyId)
  if (typeof input.actorId !== 'string' || !input.actorId.trim()) fail(403, 'Administrator identity is required.')
  if (typeof input.conflictId !== 'string' || !input.conflictId.trim() || input.conflictId.length > 200) fail(400, 'A conflict ID is required.')
  const expectedUpdatedAt = validTimestamp(input.expectedUpdatedAt, 'Expected conflict version')
  const action = input.action
  if (!Object.hasOwn(API_TO_DB_ACTION, action)) fail(400, 'Unsupported conflict action.')

  const allowed = new Set(['companyId', 'actorId', 'conflictId', 'expectedUpdatedAt', 'action'])
  const normalized = { companyId: input.companyId, actorId: input.actorId, conflictId: input.conflictId,
    expectedUpdatedAt, action, dbAction: API_TO_DB_ACTION[action], targetId: null,
    selectedFields: [], approveManyToOne: false }
  if (action === 'link_existing') {
    allowed.add('targetId'); allowed.add('approveManyToOne')
    if (typeof input.targetId !== 'string' || !input.targetId.trim() || input.targetId.length > 200) fail(400, 'Linking requires an explicit target ID.')
    if (input.approveManyToOne !== undefined && typeof input.approveManyToOne !== 'boolean') fail(400, 'Many-to-one approval must be boolean.')
    normalized.targetId = input.targetId.trim()
    normalized.approveManyToOne = input.approveManyToOne === true
  } else if (action === 'approve_fields' || action === 'retain_albi') {
    allowed.add('fields')
    if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > WRITABLE_FIELDS.size ||
      input.fields.some(field => typeof field !== 'string' || !WRITABLE_FIELDS.has(field)) || new Set(input.fields).size !== input.fields.length) {
      fail(400, 'Select valid fields for this conflict action.')
    }
    normalized.selectedFields = [...input.fields].sort()
  }
  if (Object.keys(input).some(key => !allowed.has(key))) fail(400, 'Unsupported conflict resolution fields.')
  return normalized
}

function mapResolutionError(error) {
  const responses = {
    not_found: [404, 'Conflict not found.'],
    stale: [409, 'This conflict changed or is no longer open. Refresh it before resolving.'],
    not_open: [409, 'This conflict is no longer open.'],
    many_to_one_required: [409, 'This target is already mapped. Explicit many-to-one approval is required.'],
    mapping_conflict: [409, 'This source is already mapped to a different target.'],
    invalid_conflict_type: [409, 'This conflict cannot use that resolution action.'],
    invalid_action: [400, 'Invalid conflict resolution payload.'],
  }
  const [status, message] = responses[error]
  fail(status ?? 500, message ?? 'Unable to resolve this conflict.')
}

async function deliverResume(deps, companyId, intent, ownerToken = randomUUID()) {
  if (!intent || !deps.dispatchResume) return { accepted: false, pending: true }
  const claimed = await deps.repository.claimConflictResume?.(companyId, intent.id, ownerToken, 120)
  if (!claimed) return { accepted: false, pending: true }
  let accepted = false
  let errorCode = null
  try {
    accepted = (await deps.dispatchResume(claimed)) === true
    if (!accepted) errorCode = 'dispatch_not_accepted'
  } catch {
    errorCode = 'dispatch_failed'
  }
  const finished = await deps.repository.finishConflictResume?.(companyId, intent.id, ownerToken, accepted, errorCode)
  const delivered = accepted && finished === true
  return { accepted: delivered, pending: !delivered }
}

export async function dispatchPendingConflictResumes(deps, companyId, limit = 25) {
  validCompanyId(companyId)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'Resume batch size must be between 1 and 100.')
  const pending = await deps.repository.listPendingConflictResumes(companyId, limit)
  const results = []
  for (const intent of pending ?? []) results.push({ resumeId: intent.id, ...await deliverResume(deps, companyId, intent) })
  return results
}

export async function resolveConflict(deps, input) {
  if (!deps?.repository?.resolveConflict) throw new TypeError('Conflict repository is required')
  const request = validateResolution(input)
  const result = await deps.repository.resolveConflict(request.companyId, {
    ...request,
    now: (deps.now?.() ?? new Date()).toISOString(),
  })
  if (result?.error) mapResolutionError(result.error)
  if (!result?.conflict || !result?.event) fail(500, 'Conflict resolution was not durably recorded.')
  let resume = { accepted: true, pending: false }
  if (!result.replayed && result.resume) resume = await deliverResume(deps, request.companyId, result.resume)
  if (result.resume && resume.pending) fail(502, 'Resolution was saved; its targeted resume remains pending for retry.')
  return { conflict: sanitizeConflict(result.conflict), event: {
    id: result.event.id, event_type: result.event.event_type, actor_id: result.event.actor_id,
    resolution_action: result.event.resolution_action, created_at: result.event.created_at,
    sanitized_details: safeJson(result.event.sanitized_details),
  }, resumeId: result.resume?.id ?? null, replayed: result.replayed === true }
}
