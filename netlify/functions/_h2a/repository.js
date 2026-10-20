import { randomUUID } from 'node:crypto'
import { DRY_RUN_PROPOSED_ACTION_TOTALS, DRY_RUN_REVIEW_TOTAL_FIELDS, SAMPLE_LIMIT_PER_TYPE } from './constants.js'
import { assertReviewClassification, projectReviewEvent, REVIEW_REASONS, safeReviewCandidates,
  safeReviewChanges, safeReviewEvidence, safeReviewSnapshot } from './review.js'
import { normalizeResolutionDecision, hashResolutionDecision, safeResolutionEventDetails, safeResolutionInternalEventDetails, isResolutionProviderId,
  RESOLUTION_STATUSES, RESOLUTION_EVENT_TYPES, RESOLUTION_OUTCOME_CODES, RESOLUTION_EVENT_LIMIT } from './reviewResolution.js'

const BASE_RUN_TOTAL_FIELDS = ['created', 'updated', 'linked', 'delivered', 'reconciled', 'skipped', 'conflict', 'failed', 'dry_run']
const REVIEW_RUN_COLUMNS = 'id,company_id,mode,status,sample_limit_per_type,review_capture_version,created_at,finished_at'
const REVIEW_COLUMNS = 'id,company_id,run_id,portal_id,object_type,source_id,reason,conflict_type,source_snapshot,candidate_snapshots,match_evidence,proposed_changes,status,recheck_outcome,last_rechecked_at,last_rechecked_by,created_at,updated_at,review_kind,triage_bucket,triage_details'
const REVIEW_EVENT_COLUMNS = 'id,company_id,review_id,actor_id,event_type,reason,sanitized_details,created_at'
const CAPTURED_EVENT_INDEX = 'h2a_dry_review_events_captured_once_idx'
const REVIEW_STATUSES = new Set(['needs_review', 'cleared', 'no_longer_in_scope'])
const REVIEW_KINDS = new Set(['sample', 'live'])
const LIVE_CLOSE_OUTCOMES = new Set(['resolved', 'resolved_by_sync', 'skipped', 'source_missing'])
const LIVE_CLOSE_ACTIONS = new Set(['link_existing', 'create_new', 'skip'])
const TRIAGE_BUCKETS = ['quick', 'todo', 'decision', 'blocked', 'done']
const REVIEW_OBJECT_TYPES = new Set(['contacts', 'companies'])
const REVIEW_EVENT_TYPES = new Set(['captured', 'recheck_started', 'still_needs_review', 'cleared', 'no_longer_in_scope', 'recheck_failed'])
const RECHECK_ERRORS = new Set(['not_found', 'stale', 'superseded', 'invalid_recheck'])
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const RESOLUTION_COLUMNS = 'id,company_id,run_id,review_id,portal_id,object_type,source_id,action,status,expected_review_updated_at,decision,decision_hash,client_request_id,lease_owner,lease_expires_at,execution_phase,provider_outcome_code,created_by,created_at,updated_at'
const RESOLUTION_EVENT_COLUMNS = 'id,company_id,resolution_id,actor_id,event_type,sanitized_details,created_at'
const ORGANIZATION_CHOICE_COLUMNS = 'id,company_id,portal_id,hubspot_contact_id,hubspot_company_id,reviewed_by,reviewed_at,created_at,updated_at'
const RESOLUTION_ERRORS = new Set(['invalid_resolution', 'not_found', 'identity_mismatch', 'request_conflict', 'stale',
  'invalid_claim', 'not_claimable', 'review_busy', 'invalid_claim_phase', 'invalid_finish', 'lease_lost', 'invalid_transition', 'invalid_choice'])

function requireResolutionUuid(value) {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) throw new TypeError('Invalid resolution identity')
}

function requireResolutionProviderId(value) {
  if (!isResolutionProviderId(value)) throw new TypeError('Invalid resolution provider identity')
}

function resolutionFields(row, columns) {
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
    columns === RESOLUTION_COLUMNS && (typeof row.id !== 'string' || !UUID_SHAPE.test(row.id))) {
    throw new Error('Review resolution storage failed')
  }
  return Object.fromEntries(columns.split(',').filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))
}

async function resolutionStorage(call) {
  try {
    const result = await call()
    if (result?.error) throw new Error()
    return result?.data
  } catch { throw new Error('Review resolution storage failed') }
}

async function resolutionRpc(supabase, name, args, key = 'resolution', created = false) {
  const result = await resolutionStorage(() => supabase.rpc(name, args))
  if (RESOLUTION_ERRORS.has(result?.error)) return { error: result.error }
  if (!result || result.error || (created && typeof result.created !== 'boolean')) throw new Error('Review resolution storage failed')
  return { [key]: resolutionFields(result[key], key === 'choice' ? ORGANIZATION_CHOICE_COLUMNS : RESOLUTION_COLUMNS),
    ...(created ? { created: result.created } : {}) }
}

function safeStoredResolutionEvent(row) {
  const event = resolutionFields(row, RESOLUTION_EVENT_COLUMNS)
  event.sanitized_details = safeResolutionInternalEventDetails(event.sanitized_details)
  return event
}

function requireReviewIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Review identity is required')
}

function requireReviewTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_SHAPE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError('Invalid review timestamp')
  }
}

function requireReviewValue(value, allowed, label) {
  if (!allowed.has(value)) throw new TypeError(`Invalid review ${label}`)
}

const CREATE_BATCH_TABLE = 'h2a_review_create_batches'
const CREATE_BATCH_COLUMNS = 'id,company_id,review_kind,items,referral_source_id,requested_by,status,total,done,created,skipped,failed,error_code,results,heartbeat_at,started_at,finished_at,created_at,updated_at'
function createBatchResults(results) {
  if (results === undefined) return {}
  if (!Array.isArray(results) || results.length > MAX_CREATE_BATCH_ITEMS || results.some(item => !item || typeof item !== 'object' ||
    typeof item.reviewId !== 'string' || !UUID_SHAPE.test(item.reviewId) || !['created', 'skipped', 'failed'].includes(item.outcome) ||
    item.reason !== undefined && (typeof item.reason !== 'string' || !/^[a-z_]{1,40}$/.test(item.reason)))) throw new TypeError('Invalid create batch results')
  return { results: results.map(item => ({ reviewId: item.reviewId, outcome: item.outcome, ...(item.reason ? { reason: item.reason } : {}) })) }
}
const MAX_CREATE_BATCH_ITEMS = 50
function createBatchCounts(counts) {
  if (!counts || typeof counts !== 'object') throw new TypeError('Invalid create batch counts')
  return Object.fromEntries(['total', 'done', 'created', 'skipped', 'failed'].map(key => {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) throw new TypeError('Invalid create batch counts')
    return [key, counts[key]]
  }))
}
const RECHECK_BATCH_TABLE = 'h2a_review_recheck_batches'
const RECHECK_BATCH_COLUMNS = 'id,company_id,run_id,review_kind,review_ids,requested_by,status,total,done,cleared,still_needs_review,no_longer_in_scope,stale,failed,error_code,heartbeat_at,started_at,finished_at,created_at,updated_at'
const RECHECK_BATCH_ERRORS = new Set(['superseded', 'timeout', 'expired', 'dispatch_failed', 'operation_failed',
  'pagination_loop', 'malformed_response', 'application_error', 'unsupported_contract', 'network'])
const MAX_RECHECK_BATCH_IDS = 200

function recheckBatchCounts(counts) {
  const fields = { total: 'total', done: 'done', cleared: 'cleared', stillNeedsReview: 'still_needs_review',
    noLongerInScope: 'no_longer_in_scope', stale: 'stale', failed: 'failed' }
  if (!counts || typeof counts !== 'object') throw new TypeError('Invalid recheck batch counts')
  return Object.fromEntries(Object.entries(fields).map(([key, column]) => {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) throw new TypeError('Invalid recheck batch counts')
    return [column, counts[key]]
  }))
}

function reviewQuery(supabase, companyId, runId) {
  requireReviewIdentity(companyId)
  requireReviewIdentity(runId)
  return supabase.from('h2a_dry_run_reviews').select(REVIEW_COLUMNS)
    .eq('company_id', companyId).eq('run_id', runId)
}

// Live rows span every live run, so the configured portal is the scope (a portal switch hides old rows).
function liveReviewQuery(supabase, companyId, portalId) {
  requireReviewIdentity(companyId)
  requireReviewIdentity(portalId)
  return supabase.from('h2a_dry_run_reviews').select(REVIEW_COLUMNS).eq('company_id', companyId).eq('portal_id', portalId)
}

function reviewSourceIdentity(query, row) {
  return query.eq('portal_id', row.portal_id).eq('object_type', row.object_type).eq('source_id', row.source_id)
}

function reviewResolutionRepository(supabase) {
  return {
    // Explicit internal rows preserve fencing/phase for execution; HTTP callers must project them.
    async createReviewResolution(companyId, input) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(input.runId)
      requireResolutionUuid(input.reviewId)
      requireResolutionProviderId(input.portalId)
      requireReviewValue(input.objectType, REVIEW_OBJECT_TYPES, 'object type')
      requireResolutionProviderId(input.sourceId)
      requireReviewTimestamp(input.expectedUpdatedAt)
      requireResolutionUuid(input.clientRequestId)
      requireResolutionUuid(input.actorId)
      const decision = normalizeResolutionDecision(input.decision)
      return resolutionRpc(supabase, 'h2a_create_review_resolution', {
        p_company_id: companyId, p_run_id: input.runId, p_review_id: input.reviewId, p_portal_id: input.portalId,
        p_object_type: input.objectType, p_source_id: input.sourceId, p_action: decision.action,
        p_expected_review_updated_at: input.expectedUpdatedAt, p_decision: decision, p_decision_hash: hashResolutionDecision(decision),
        p_client_request_id: input.clientRequestId, p_actor_id: input.actorId,
      }, 'resolution', true)
    },
    async getReviewResolution(companyId, resolutionId) {
      requireReviewIdentity(companyId)
      requireResolutionUuid(resolutionId)
      const row = await resolutionStorage(() => scoped(supabase, 'h2a_dry_run_review_resolutions', companyId, RESOLUTION_COLUMNS)
        .eq('id', resolutionId).maybeSingle())
      return row == null ? null : resolutionFields(row, RESOLUTION_COLUMNS)
    },
    async getCurrentReviewResolution(companyId, reviewId) {
      requireReviewIdentity(companyId)
      requireResolutionUuid(reviewId)
      const row = await resolutionStorage(() => scoped(supabase, 'h2a_dry_run_review_resolutions', companyId, RESOLUTION_COLUMNS)
        .eq('review_id', reviewId).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle())
      return row == null ? null : resolutionFields(row, RESOLUTION_COLUMNS)
    },
    async claimReviewResolution(companyId, resolutionId, ownerToken, actorId, ttlSeconds = 120) {
      requireReviewIdentity(companyId)
      for (const id of [resolutionId, ownerToken, actorId]) requireResolutionUuid(id)
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new TypeError('Invalid resolution lease')
      return resolutionRpc(supabase, 'h2a_claim_review_resolution', { p_company_id: companyId,
        p_resolution_id: resolutionId, p_owner_token: ownerToken, p_actor_id: actorId, p_ttl_seconds: ttlSeconds })
    },
    async finishReviewResolution(companyId, resolutionId, ownerToken, input) {
      requireReviewIdentity(companyId)
      for (const id of [resolutionId, ownerToken, input.actorId]) requireResolutionUuid(id)
      if (!RESOLUTION_STATUSES.includes(input.status) || input.status === 'applying' ||
        !RESOLUTION_EVENT_TYPES.includes(input.eventType) || ['planned', 'claimed'].includes(input.eventType) ||
        input.providerOutcomeCode != null && !RESOLUTION_OUTCOME_CODES.includes(input.providerOutcomeCode)) {
        throw new TypeError('Invalid resolution finalization')
      }
      return resolutionRpc(supabase, 'h2a_finish_review_resolution', { p_company_id: companyId,
        p_resolution_id: resolutionId, p_owner_token: ownerToken, p_actor_id: input.actorId, p_status: input.status,
        p_event_type: input.eventType, p_event_details: safeResolutionEventDetails(input.details),
        p_provider_outcome_code: input.providerOutcomeCode ?? null })
    },
    // Albi create receipts recorded by any earlier resolution of this review (newest 20 resolutions).
    async listPriorCreateReceipts(companyId, reviewId) {
      requireReviewIdentity(companyId)
      requireResolutionUuid(reviewId)
      const resolutions = await resolutionStorage(() => scoped(supabase, 'h2a_dry_run_review_resolutions', companyId, 'id')
        .eq('review_id', reviewId).order('created_at', { ascending: false }).limit(20))
      const ids = (Array.isArray(resolutions) ? resolutions : []).map(row => row?.id).filter(id => typeof id === 'string')
      if (!ids.length) return []
      const events = await resolutionStorage(() => scoped(supabase, 'h2a_dry_run_review_resolution_events', companyId, RESOLUTION_EVENT_COLUMNS)
        .in('resolution_id', ids).eq('event_type', 'claimed').limit(RESOLUTION_EVENT_LIMIT))
      if (!Array.isArray(events)) throw new Error('Review resolution storage failed')
      return [...new Set(events.map(safeStoredResolutionEvent).map(event => event.sanitized_details?.createReceiptId)
        .filter(id => typeof id === 'string' && /^[1-9]\d{0,99}$/.test(id)))]
    },
    async listReviewResolutionEvents(companyId, resolutionId) {
      requireReviewIdentity(companyId)
      requireResolutionUuid(resolutionId)
      const rows = await resolutionStorage(() => scoped(supabase, 'h2a_dry_run_review_resolution_events', companyId, RESOLUTION_EVENT_COLUMNS)
        .eq('resolution_id', resolutionId).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(RESOLUTION_EVENT_LIMIT))
      if (!Array.isArray(rows)) throw new Error('Review resolution storage failed')
      return rows.slice(0, RESOLUTION_EVENT_LIMIT).map(safeStoredResolutionEvent)
    },
    async appendReviewResolutionEvent(companyId, resolutionId, { actorId, eventType, details = {}, now = new Date().toISOString() }) {
      requireReviewIdentity(companyId)
      requireResolutionUuid(resolutionId)
      requireResolutionUuid(actorId)
      if (!RESOLUTION_EVENT_TYPES.includes(eventType)) throw new TypeError('Invalid resolution event')
      requireReviewTimestamp(now)
      const row = await resolutionStorage(() => supabase.from('h2a_dry_run_review_resolution_events')
        .insert({ company_id: companyId, resolution_id: resolutionId, actor_id: actorId, event_type: eventType,
          sanitized_details: safeResolutionInternalEventDetails(details), created_at: now })
        .eq('company_id', companyId).select(RESOLUTION_EVENT_COLUMNS).single())
      return safeStoredResolutionEvent(row)
    },
    async getContactOrganizationChoice(companyId, portalId, contactId) {
      requireReviewIdentity(companyId)
      requireResolutionProviderId(portalId)
      requireResolutionProviderId(contactId)
      const row = await resolutionStorage(() => scoped(supabase, 'h2a_contact_organization_choices', companyId, ORGANIZATION_CHOICE_COLUMNS)
        .eq('portal_id', portalId).eq('hubspot_contact_id', contactId).maybeSingle())
      return row == null ? null : resolutionFields(row, ORGANIZATION_CHOICE_COLUMNS)
    },
    async upsertContactOrganizationChoice(companyId, input) {
      requireReviewIdentity(companyId)
      for (const id of [input.portalId, input.contactId, input.organizationSourceId]) requireResolutionProviderId(id)
      requireResolutionUuid(input.actorId)
      return resolutionRpc(supabase, 'h2a_upsert_contact_organization_choice', { p_company_id: companyId,
        p_portal_id: input.portalId, p_hubspot_contact_id: input.contactId, p_hubspot_company_id: input.organizationSourceId,
        p_actor_id: input.actorId }, 'choice')
    },
  }
}

function reviewEvidencePayload(input, objectType) {
  return {
    source_snapshot: safeReviewSnapshot(input.source_snapshot, objectType),
    candidate_snapshots: safeReviewCandidates(input.candidate_snapshots, objectType),
    match_evidence: { evidence: safeReviewEvidence(input.match_evidence) },
    proposed_changes: safeReviewChanges(input.proposed_changes, objectType),
  }
}

function reviewEventPayload(companyId, reviewId, { eventType, reason = null, actorId = null, details = {}, now = new Date().toISOString() }) {
  requireReviewValue(eventType, REVIEW_EVENT_TYPES, 'event type')
  if (reason !== null) requireReviewValue(reason, REVIEW_REASONS, 'reason')
  if ((eventType !== 'captured' || actorId !== null) && (typeof actorId !== 'string' || !UUID_SHAPE.test(actorId))) {
    throw new TypeError('Invalid review actor')
  }
  requireReviewTimestamp(now)
  return { company_id: companyId, review_id: reviewId, actor_id: actorId, event_type: eventType, reason,
    sanitized_details: projectReviewEvent({ sanitized_details: details }).details, created_at: now }
}

function safeTriageDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw new TypeError('Invalid triage details')
  const safe = {}
  if (typeof details.blockedReason === 'string') safe.blockedReason = details.blockedReason.slice(0, 80)
  if (details.merged === true) safe.merged = true
  if (['link', 'create'].includes(details.quickKind)) safe.quickKind = details.quickKind
  if (details.closePending === true) safe.closePending = true
  if (details.recheckPending === true) safe.recheckPending = true
  if (typeof details.mergedIntoSourceId === 'string' && /^[1-9]\d{0,99}$/.test(details.mergedIntoSourceId)) safe.mergedIntoSourceId = details.mergedIntoSourceId
  return safe
}

// Key-order-independent JSON, so jsonb read back from Postgres compares equal to the payload.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function checked(result) {
  if (result?.error) throw result.error
  return result?.data
}

function capturedEventAlreadyExists(error) {
  return error?.code === '23505' && (error.constraint === CAPTURED_EVENT_INDEX ||
    error.message === `duplicate key value violates unique constraint "${CAPTURED_EVENT_INDEX}"`)
}

function scoped(supabase, table, companyId, columns = '*') {
  if (typeof companyId !== 'string' || !companyId.trim()) throw new TypeError('Company ID is required')
  return supabase.from(table).select(columns).eq('company_id', companyId)
}

function boundary(row) {
  return row ? { timestamp: row.cursor_timestamp ?? row.checkpoint_timestamp, objectId: row.cursor_object_id ?? row.checkpoint_object_id } : null
}

async function readAll(supabase, table, companyId, filter = query => query, columns = '*') {
  const rows = []
  for (let start = 0; start < 1000000; start += 1000) {
    const page = checked(await filter(scoped(supabase, table, companyId, columns)).order('id', { ascending: true }).range(start, start + 999))
    if (!Array.isArray(page)) throw new Error(`Invalid ${table} page`)
    rows.push(...page)
    if (page.length < 1000) return rows
  }
  throw new Error(`${table} page limit exceeded`)
}

export function aggregateRunTotals(rows, mode) {
  const totals = Object.fromEntries(BASE_RUN_TOTAL_FIELDS.map(field => [field, 0]))
  if (mode === 'dry_run') {
    for (const field of DRY_RUN_REVIEW_TOTAL_FIELDS) totals[field] = 0
  }
  const latest = new Map()
  for (const row of [...(rows ?? [])].sort((a, b) =>
    Date.parse(a.created_at) - Date.parse(b.created_at) || String(a.id).localeCompare(String(b.id)))) {
    const key = JSON.stringify([row.object_type, row.source_id, row.albi_target_type, row.albi_target_id])
    latest.set(key, row)
  }
  for (const row of latest.values()) {
    if (Object.hasOwn(totals, row.outcome)) totals[row.outcome] += 1
    if (mode !== 'dry_run' || row.outcome !== 'dry_run') continue
    const action = row.sanitized_details?.proposedAction
    const field = typeof action === 'string' && Object.hasOwn(DRY_RUN_PROPOSED_ACTION_TOTALS, action)
      ? DRY_RUN_PROPOSED_ACTION_TOTALS[action]
      : null
    if (field) totals[field] = (totals[field] ?? 0) + 1
  }
  return totals
}

export function createH2ARepository(supabase) {
  if (!supabase?.from || !supabase?.rpc) throw new TypeError('A server-side Supabase client is required')
  return {
    ...reviewResolutionRepository(supabase),
    // runId arguments are resolved by the server; HTTP handlers must never accept them from browsers.
    async getLatestCompletedSampleDryRun(companyId, after) {
      requireReviewIdentity(companyId)
      requireReviewTimestamp(after)
      return checked(await supabase.from('h2a_sync_runs')
        .select('id,created_at,finished_at,review_capture_version,sample_limit_per_type,status').eq('company_id', companyId)
        .eq('mode', 'dry_run').eq('status', 'completed').eq('sample_limit_per_type', SAMPLE_LIMIT_PER_TYPE)
        .gt('created_at', after).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle())
    },
    async getCurrentReviewSample(companyId, after) {
      requireReviewIdentity(companyId)
      requireReviewTimestamp(after)
      return checked(await supabase.from('h2a_sync_runs').select(REVIEW_RUN_COLUMNS).eq('company_id', companyId)
        .eq('mode', 'dry_run').eq('status', 'completed').eq('sample_limit_per_type', SAMPLE_LIMIT_PER_TYPE)
        .eq('review_capture_version', 1).gt('created_at', after)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle())
    },
    async countDryRunReviews(companyId, runId, status = null) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(runId)
      if (status !== null) requireReviewValue(status, REVIEW_STATUSES, 'status')
      let query = supabase.from('h2a_dry_run_reviews').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('run_id', runId)
      if (status !== null) query = query.eq('status', status)
      const result = await query
      if (result?.error) throw result.error
      if (!Number.isSafeInteger(result?.count) || result.count < 0) throw new Error('Invalid review count')
      return result.count
    },
    async hasCleanReviewSampleDryRun(companyId, after) {
      const run = await this.getLatestCompletedSampleDryRun(companyId, after)
      if (run?.review_capture_version !== 1) return false
      // Count all captured rows. Individual rechecks cannot unlock their original sample.
      if (await this.countDryRunReviews(companyId, run.id) !== 0) return false
      // A replacement may have completed and pruned this run between selection and counting.
      const current = await this.getLatestCompletedSampleDryRun(companyId, after)
      return current?.id === run.id && current?.review_capture_version === 1
    },
    async listDryRunReviews(companyId, runId, { limit = 25, before = null, status = null, objectType = null, reason = null, kind = 'sample', bucket = null, includeCounts = false, portalId = null } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid review page size')
      if (status !== null) requireReviewValue(status, REVIEW_STATUSES, 'status')
      if (objectType !== null) requireReviewValue(objectType, REVIEW_OBJECT_TYPES, 'object type')
      if (reason !== null) requireReviewValue(reason, REVIEW_REASONS, 'reason')
      requireReviewValue(kind, REVIEW_KINDS, 'kind')
      if (bucket !== null) requireReviewValue(bucket, new Set(TRIAGE_BUCKETS), 'bucket')
      if (before !== null) {
        requireReviewTimestamp(before.createdAt)
        if (typeof before.id !== 'string' || !UUID_SHAPE.test(before.id)) throw new TypeError('Invalid review cursor')
      }
      // Live rows span every live run that captured them; only sample lists are run-scoped.
      const unscopedLive = kind === 'live' && runId === null
      let query = unscopedLive ? liveReviewQuery(supabase, companyId, portalId) : reviewQuery(supabase, companyId, runId)
      if (status !== null) query = query.eq('status', status)
      if (objectType !== null) query = query.eq('object_type', objectType)
      if (reason !== null) query = query.eq('reason', reason)
      query = query.eq('review_kind', kind)
      if (bucket !== null) query = query.eq('triage_bucket', bucket)
      if (before !== null) query = query.or(`created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`)
      const rows = checked(await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1))
      if (!Array.isArray(rows)) throw new Error('Invalid review page')
      const page = { items: rows.slice(0, limit), hasMore: rows.length > limit }
      if (includeCounts) page.bucketCounts = await this.countReviewBuckets(companyId, runId, kind, unscopedLive ? portalId : null)
      return page
    },
    // Counts for the current kind and run; independent of the page filters so tabs stay stable.
    async countReviewBuckets(companyId, runId, kind = 'sample', portalId = null) {
      requireReviewIdentity(companyId)
      requireReviewValue(kind, REVIEW_KINDS, 'kind')
      if (!(kind === 'live' && runId === null)) requireReviewIdentity(runId)
      else requireReviewIdentity(portalId)
      const entries = await Promise.all(TRIAGE_BUCKETS.map(async triageBucket => {
        let query = supabase.from('h2a_dry_run_reviews').select('id', { count: 'exact', head: true }).eq('company_id', companyId)
        query = runId !== null ? query.eq('run_id', runId) : query.eq('portal_id', portalId)
        const result = await query.eq('review_kind', kind).eq('triage_bucket', triageBucket)
        if (result?.error) throw result.error
        if (!Number.isSafeInteger(result?.count) || result.count < 0) throw new Error('Invalid review count')
        return [triageBucket, result.count]
      }))
      return Object.fromEntries(entries)
    },
    async setReviewTriage(companyId, reviewId, { bucket, details = {} } = {}) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(reviewId)
      requireReviewValue(bucket, new Set(TRIAGE_BUCKETS), 'bucket')
      const safe = safeTriageDetails(details)
      checked(await supabase.from('h2a_dry_run_reviews').update({ triage_bucket: bucket, triage_details: safe })
        .eq('company_id', companyId).eq('id', reviewId))
    },
    async getDryRunReview(companyId, runId, reviewId) {
      requireReviewIdentity(reviewId)
      return checked(await reviewQuery(supabase, companyId, runId).eq('id', reviewId).maybeSingle())
    },
    async listDryRunReviewEvents(companyId, runId, reviewId) {
      if (!await this.getDryRunReview(companyId, runId, reviewId)) return []
      return checked(await supabase.from('h2a_dry_run_review_events').select(REVIEW_EVENT_COLUMNS)
        .eq('company_id', companyId).eq('review_id', reviewId)
        .order('created_at', { ascending: true }).order('id', { ascending: true }))
    },
    async appendDryRunReviewEvent(companyId, runId, reviewId, input) {
      const payload = reviewEventPayload(companyId, reviewId, input)
      if (!await this.getDryRunReview(companyId, runId, reviewId)) return null
      return checked(await supabase.from('h2a_dry_run_review_events').insert(payload).select(REVIEW_EVENT_COLUMNS).single())
    },
    async findDryRunReviewBySource(companyId, runId, objectType, sourceId) {
      for (const value of [companyId, runId, sourceId]) requireReviewIdentity(value)
      requireReviewValue(objectType, REVIEW_OBJECT_TYPES, 'object type')
      const query = reviewQuery(supabase, companyId, runId).eq('object_type', objectType).eq('source_id', sourceId)
      return checked(await query.order('created_at', { ascending: false }).limit(1).maybeSingle())
    },
    async recordDryRunReview(companyId, input) {
      for (const value of [companyId, input.run_id, input.portal_id, input.source_id]) requireReviewIdentity(value)
      requireReviewValue(input.object_type, REVIEW_OBJECT_TYPES, 'object type')
      assertReviewClassification(input.reason, input.conflict_type)
      const payload = { company_id: companyId, run_id: input.run_id, portal_id: input.portal_id,
        object_type: input.object_type, source_id: input.source_id, reason: input.reason, conflict_type: input.conflict_type,
        ...reviewEvidencePayload(input, input.object_type), status: 'needs_review' }
      // Triage computed at capture (sample capture passes it); other captures keep the column default.
      if (input.triage_bucket !== undefined) {
        requireReviewValue(input.triage_bucket, new Set(TRIAGE_BUCKETS), 'bucket')
        payload.triage_bucket = input.triage_bucket
        payload.triage_details = safeTriageDetails(input.triage_details ?? {})
      }
      const inserted = await supabase.from('h2a_dry_run_reviews').insert(payload).select(REVIEW_COLUMNS).single()
      let review
      if (inserted?.error) {
        if (inserted.error.code !== '23505') throw inserted.error
        const existing = checked(await reviewSourceIdentity(reviewQuery(supabase, companyId, input.run_id), payload).maybeSingle())
        if (!existing) throw inserted.error
        review = checked(await reviewSourceIdentity(supabase.from('h2a_dry_run_reviews').update(payload)
          .eq('company_id', companyId).eq('run_id', input.run_id), payload).eq('id', existing.id).select(REVIEW_COLUMNS).single())
      } else review = checked(inserted)
      if (!review?.id) throw new Error('Invalid review capture response')
      try {
        const event = await this.appendDryRunReviewEvent(companyId, input.run_id, review.id,
          { eventType: 'captured', reason: payload.reason })
        if (!event) throw new Error('Review capture event was not recorded')
      } catch (error) {
        if (!capturedEventAlreadyExists(error)) {
          // Retain the bounded row for replay repair. Deleting it could erase
          // a captured event that a concurrent replay has already ensured.
          throw new Error('Review capture event was not recorded')
        }
      }
      return review
    },
    async getReview(companyId, reviewId) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(reviewId)
      return checked(await supabase.from('h2a_dry_run_reviews').select(REVIEW_COLUMNS)
        .eq('company_id', companyId).eq('id', reviewId).maybeSingle())
    },
    // The one open live review row for a source (the live partial unique key), or null.
    async findOpenLiveReviewBySource(companyId, portalId, objectType, sourceId) {
      for (const value of [companyId, portalId, sourceId]) requireReviewIdentity(value)
      requireReviewValue(objectType, REVIEW_OBJECT_TYPES, 'object type')
      return checked(await reviewSourceIdentity(supabase.from('h2a_dry_run_reviews').select(REVIEW_COLUMNS)
        .eq('company_id', companyId), { portal_id: portalId, object_type: objectType, source_id: sourceId })
        .eq('review_kind', 'live').eq('status', 'needs_review').maybeSingle())
    },
    // Upserts on the live partial key (one open live row per source). Supabase cannot target a
    // partial index in onConflict, so this is select-then-insert with a unique-violation retry.
    // run_id keeps the run that first captured the row; later captures only refresh evidence and triage.
    async upsertLiveReview(companyId, input) {
      for (const value of [companyId, input.run_id, input.portal_id, input.source_id]) requireReviewIdentity(value)
      requireReviewValue(input.object_type, REVIEW_OBJECT_TYPES, 'object type')
      assertReviewClassification(input.reason, input.conflict_type)
      requireReviewValue(input.triage_bucket, new Set(TRIAGE_BUCKETS), 'bucket')
      const identity = { portal_id: input.portal_id, object_type: input.object_type, source_id: input.source_id }
      const evidence = { reason: input.reason, conflict_type: input.conflict_type,
        ...reviewEvidencePayload(input, input.object_type), triage_bucket: input.triage_bucket,
        triage_details: safeTriageDetails(input.triage_details) }
      const openLive = () => reviewSourceIdentity(supabase.from('h2a_dry_run_reviews').select(REVIEW_COLUMNS)
        .eq('company_id', companyId), identity).eq('review_kind', 'live').eq('status', 'needs_review')
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = checked(await openLive().maybeSingle())
        if (existing?.id) {
          const next = { ...evidence }
          // A capture with no HubSpot source (e.g. missing contact) never replaces a rich stored snapshot with {id}.
          if (input.source_known === false && Object.keys(existing.source_snapshot ?? {}).some(key => key !== 'id')) {
            next.source_snapshot = existing.source_snapshot
          }
          if (typeof input.triage_for === 'function') {
            const triage = input.triage_for(existing)
            requireReviewValue(triage?.bucket, new Set(TRIAGE_BUCKETS), 'bucket')
            next.triage_bucket = triage.bucket
            next.triage_details = safeTriageDetails(triage.details ?? {})
          }
          if (Object.keys(next).every(key => stableJson(existing[key]) === stableJson(next[key]))) {
            return { id: existing.id, inserted: false }
          }
          const refreshed = checked(await supabase.from('h2a_dry_run_reviews')
            .update({ ...next, updated_at: new Date().toISOString() })
            .eq('company_id', companyId).eq('id', existing.id).eq('review_kind', 'live').eq('status', 'needs_review')
            .select(REVIEW_COLUMNS).maybeSingle())
          if (refreshed?.id) return { id: refreshed.id, inserted: false }
          continue // Closed between read and refresh: capture again.
        }
        const inserted = await supabase.from('h2a_dry_run_reviews').insert({ company_id: companyId, run_id: input.run_id,
          ...identity, ...evidence, status: 'needs_review', review_kind: 'live' }).select(REVIEW_COLUMNS).single()
        if (!inserted?.error) {
          const row = checked(inserted)
          if (!row?.id) throw new Error('Invalid live review capture response')
          return { id: row.id, inserted: true }
        }
        if (inserted.error.code !== '23505') throw inserted.error
        // The per-run key also covers live rows. A row this run already captured and that has
        // since closed stays closed: report it as handled rather than reopening it.
        const sameRun = checked(await reviewSourceIdentity(reviewQuery(supabase, companyId, input.run_id), identity).maybeSingle())
        if (sameRun?.id && sameRun.status !== 'needs_review') {
          if (sameRun.review_kind !== 'live') throw inserted.error
          return { id: sameRun.id, inserted: false, closed: true }
        }
        // Otherwise a concurrent capture won the live key; refresh its row on the next pass.
      }
      throw new Error('Live review capture did not settle')
    },
    // One transaction: closes the live row, marks its open conflicts and inserts their resumes.
    async closeLiveReview(companyId, { reviewId, actorId, outcome, resolutionAction = null } = {}) {
      for (const value of [companyId, reviewId, actorId]) requireReviewIdentity(value)
      requireReviewValue(outcome, LIVE_CLOSE_OUTCOMES, 'close outcome')
      if (resolutionAction !== null) requireReviewValue(resolutionAction, LIVE_CLOSE_ACTIONS, 'close action')
      return checked(await supabase.rpc('h2a_close_live_review', { p_company_id: companyId, p_review_id: reviewId,
        p_actor_id: actorId, p_outcome: outcome, p_resolution_action: resolutionAction }))
    },
    // The close a live row was closed with, from the close event h2a_close_live_review records on its
    // first close ({ actorId, outcome, resolutionAction }), or null when there is none.
    async getLiveReviewClose(companyId, reviewId) {
      for (const value of [companyId, reviewId]) requireReviewIdentity(value)
      const rows = checked(await supabase.from('h2a_dry_run_review_events').select('event_type,actor_id,sanitized_details,created_at')
        .eq('company_id', companyId).eq('review_id', reviewId).in('event_type', ['cleared', 'no_longer_in_scope'])
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(10))
      for (const row of Array.isArray(rows) ? rows : []) {
        const outcome = row?.sanitized_details?.outcome
        if (outcome === undefined) continue
        const resolutionAction = row.sanitized_details.resolutionAction ?? null
        if (!LIVE_CLOSE_OUTCOMES.has(outcome) || resolutionAction !== null && !LIVE_CLOSE_ACTIONS.has(resolutionAction) ||
          typeof row.actor_id !== 'string' || !UUID_SHAPE.test(row.actor_id)) return null
        return { actorId: row.actor_id, outcome, resolutionAction }
      }
      return null
    },
    // Open live rows whose HubSpot source was merged into survivorSourceId (recorded in triage details).
    async listMergedAwayLiveReviews(companyId, portalId, objectType, survivorSourceId) {
      for (const value of [companyId, portalId]) requireReviewIdentity(value)
      requireReviewValue(objectType, REVIEW_OBJECT_TYPES, 'object type')
      if (typeof survivorSourceId !== 'string' || !/^[1-9]\d{0,99}$/.test(survivorSourceId)) throw new TypeError('Invalid survivor source')
      const rows = checked(await supabase.from('h2a_dry_run_reviews').select(REVIEW_COLUMNS).eq('company_id', companyId)
        .eq('portal_id', portalId).eq('object_type', objectType).eq('review_kind', 'live').eq('status', 'needs_review')
        .eq('triage_details->>mergedIntoSourceId', survivorSourceId).order('created_at', { ascending: true }).limit(100))
      if (!Array.isArray(rows)) throw new Error('Invalid review page')
      return rows
    },
    // The live review row a conflict is attached to, if any (unique per conflict).
    async findLiveReviewConflictLink(companyId, conflictId) {
      for (const value of [companyId, conflictId]) requireReviewIdentity(value)
      return checked(await supabase.from('h2a_live_review_conflicts').select('company_id,review_id,conflict_id')
        .eq('company_id', companyId).eq('conflict_id', conflictId).maybeSingle()) ?? null
    },
    // Open contact/company conflicts, oldest first, for the on-demand live review backfill.
    async listOpenSourceConflicts(companyId, { limit = 50, after = null } = {}) {
      requireReviewIdentity(companyId)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid conflict page size')
      if (after !== null) {
        requireReviewTimestamp(after?.createdAt)
        if (typeof after.id !== 'string' || !UUID_SHAPE.test(after.id)) throw new TypeError('Invalid conflict cursor')
      }
      let query = supabase.from('h2a_conflicts').select('*').eq('company_id', companyId).eq('status', 'open')
        .in('object_type', ['contacts', 'companies'])
      if (after !== null) query = query.or(`created_at.gt.${after.createdAt},and(created_at.eq.${after.createdAt},id.gt.${after.id})`)
      const rows = checked(await query.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit + 1))
      if (!Array.isArray(rows)) throw new Error('Invalid conflict page')
      return { items: rows.slice(0, limit), hasMore: rows.length > limit }
    },
    async linkLiveReviewConflict(companyId, reviewId, conflictId) {
      for (const value of [companyId, reviewId, conflictId]) requireReviewIdentity(value)
      const result = await supabase.from('h2a_live_review_conflicts')
        .insert({ company_id: companyId, review_id: reviewId, conflict_id: conflictId })
      if (result?.error) {
        if (result.error.code === '23505') return false
        throw result.error
      }
      return true
    },
    async applyDryRunRecheck(companyId, input) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(input.runId)
      requireReviewIdentity(input.reviewId)
      requireReviewTimestamp(input.expectedUpdatedAt)
      requireReviewTimestamp(input.now)
      assertReviewClassification(input.reason, input.conflictType)
      const terminal = {
        still_needs_review: ['needs_review', 'still_needs_review'],
        safe_to_link: ['cleared', 'cleared'], safe_to_create: ['cleared', 'cleared'],
        source_missing: ['no_longer_in_scope', 'no_longer_in_scope'],
      }
      // A live recheck only refreshes evidence and records its outcome; the row closes through the close RPC.
      const live = input.kind === 'live'
      if (!Object.hasOwn(terminal, input.outcome) || (live
        ? input.status !== 'needs_review' || input.eventType !== 'still_needs_review'
        : terminal[input.outcome][0] !== input.status || terminal[input.outcome][1] !== input.eventType)) {
        throw new TypeError('Invalid review recheck state')
      }
      const event = reviewEventPayload(companyId, input.reviewId, { eventType: input.eventType, reason: input.reason,
        actorId: input.actorId, details: input.eventDetails, now: input.now })
      const review = await this.getDryRunReview(companyId, input.runId, input.reviewId)
      if (!review) return { error: 'not_found' }
      if (live !== (review.review_kind === 'live')) return { error: 'stale' }
      requireReviewValue(review.object_type, REVIEW_OBJECT_TYPES, 'object type')
      const evidence = reviewEvidencePayload({ source_snapshot: input.sourceSnapshot, candidate_snapshots: input.candidateSnapshots,
        match_evidence: input.matchEvidence, proposed_changes: input.proposedChanges }, review.object_type)
      const result = checked(await supabase.rpc('h2a_apply_dry_run_recheck', {
        p_company_id: companyId, p_review_id: input.reviewId, p_expected_updated_at: input.expectedUpdatedAt,
        p_actor_id: input.actorId, p_status: input.status, p_recheck_outcome: input.outcome,
        p_reason: input.reason, p_conflict_type: input.conflictType, p_source_snapshot: evidence.source_snapshot,
        p_candidate_snapshots: evidence.candidate_snapshots, p_match_evidence: evidence.match_evidence,
        p_proposed_changes: evidence.proposed_changes, p_event_type: input.eventType,
        p_event_details: event.sanitized_details, p_now: input.now,
      }))
      if (RECHECK_ERRORS.has(result?.error)) return { error: result.error }
      if (!result || result.error || !result.review || typeof result.review !== 'object' || Array.isArray(result.review)) {
        throw new Error('Invalid review recheck response')
      }
      return { review: result.review }
    },
    // One queued/running recheck batch per company and kind (partial unique index); abandoned batches
    // expire by heartbeat. Live batches have no single sample run; reviewIds narrows a batch to those rows.
    async createReviewRecheckBatch(companyId, { kind = 'sample', runId = null, reviewIds = null, actorId, requestedBy = actorId,
      now = new Date().toISOString(), staleBefore }) {
      requireReviewIdentity(companyId)
      requireReviewValue(kind, REVIEW_KINDS, 'kind')
      if (kind === 'sample' || runId !== null) requireReviewIdentity(runId)
      if (reviewIds !== null && (!Array.isArray(reviewIds) || reviewIds.length < 1 || reviewIds.length > MAX_RECHECK_BATCH_IDS ||
        reviewIds.some(value => typeof value !== 'string' || !UUID_SHAPE.test(value)))) throw new TypeError('Invalid recheck batch reviews')
      requireReviewIdentity(requestedBy)
      requireReviewTimestamp(now)
      requireReviewTimestamp(staleBefore)
      checked(await supabase.from(RECHECK_BATCH_TABLE).update({ status: 'failed', error_code: 'expired', finished_at: now, updated_at: now })
        .eq('company_id', companyId).eq('review_kind', kind).in('status', ['queued', 'running']).lt('heartbeat_at', staleBefore).select('id'))
      const inserted = await supabase.from(RECHECK_BATCH_TABLE).insert({ company_id: companyId, run_id: runId, review_kind: kind,
        review_ids: reviewIds === null ? null : [...new Set(reviewIds)], requested_by: requestedBy,
        status: 'queued', heartbeat_at: now, created_at: now, updated_at: now }).select(RECHECK_BATCH_COLUMNS).single()
      if (inserted?.error?.code === '23505') {
        const active = checked(await supabase.from(RECHECK_BATCH_TABLE).select(RECHECK_BATCH_COLUMNS).eq('company_id', companyId)
          .eq('review_kind', kind).in('status', ['queued', 'running']).order('created_at', { ascending: false }).limit(1).maybeSingle())
        return { error: 'active', batch: active ?? null }
      }
      return { batch: checked(inserted) }
    },
    async createReviewCreateBatch(companyId, { kind = 'sample', items, referralSourceId, actorId, now = new Date().toISOString(), staleBefore }) {
      requireReviewIdentity(companyId)
      requireReviewValue(kind, REVIEW_KINDS, 'kind')
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CREATE_BATCH_ITEMS || items.some(item => !item || typeof item !== 'object' ||
        typeof item.reviewId !== 'string' || !UUID_SHAPE.test(item.reviewId) || typeof item.expectedUpdatedAt !== 'string' ||
        !TIMESTAMP_SHAPE.test(item.expectedUpdatedAt)) || new Set(items.map(item => item.reviewId)).size !== items.length) throw new TypeError('Invalid create batch items')
      if (typeof referralSourceId !== 'string' || !/^[1-9]\d{0,99}$/.test(referralSourceId)) throw new TypeError('Invalid create batch referral source')
      requireReviewIdentity(actorId)
      requireReviewTimestamp(now)
      requireReviewTimestamp(staleBefore)
      checked(await supabase.from(CREATE_BATCH_TABLE).update({ status: 'failed', error_code: 'expired', finished_at: now, updated_at: now })
        .eq('company_id', companyId).in('status', ['queued', 'running']).lt('heartbeat_at', staleBefore).select('id'))
      const inserted = await supabase.from(CREATE_BATCH_TABLE).insert({ company_id: companyId, review_kind: kind,
        items: items.map(item => ({ reviewId: item.reviewId, expectedUpdatedAt: item.expectedUpdatedAt })), referral_source_id: referralSourceId,
        requested_by: actorId, status: 'queued', total: items.length, heartbeat_at: now, created_at: now, updated_at: now })
        .select(CREATE_BATCH_COLUMNS).single()
      if (inserted?.error?.code === '23505') {
        const active = checked(await supabase.from(CREATE_BATCH_TABLE).select(CREATE_BATCH_COLUMNS).eq('company_id', companyId)
          .in('status', ['queued', 'running']).order('created_at', { ascending: false }).limit(1).maybeSingle())
        return { error: 'active', batch: active ?? null }
      }
      return { batch: checked(inserted) }
    },
    async getLatestReviewCreateBatch(companyId, kind = 'sample') {
      requireReviewIdentity(companyId)
      requireReviewValue(kind, REVIEW_KINDS, 'kind')
      return checked(await supabase.from(CREATE_BATCH_TABLE).select(CREATE_BATCH_COLUMNS).eq('company_id', companyId)
        .eq('review_kind', kind).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle())
    },
    async claimReviewCreateBatch(companyId, batchId, now = new Date().toISOString()) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(batchId)
      requireReviewTimestamp(now)
      return checked(await supabase.from(CREATE_BATCH_TABLE).update({ status: 'running', started_at: now, heartbeat_at: now, updated_at: now })
        .eq('company_id', companyId).eq('id', batchId).eq('status', 'queued').select(CREATE_BATCH_COLUMNS).maybeSingle()) ?? null
    },
    async updateReviewCreateBatch(companyId, batchId, { counts, results, now = new Date().toISOString() }) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(batchId)
      requireReviewTimestamp(now)
      const rows = checked(await supabase.from(CREATE_BATCH_TABLE).update({ ...createBatchCounts(counts), ...createBatchResults(results), heartbeat_at: now, updated_at: now })
        .eq('company_id', companyId).eq('id', batchId).eq('status', 'running').select('id'))
      return Array.isArray(rows) && rows.length === 1
    },
    async finishReviewCreateBatch(companyId, batchId, { status, errorCode = null, counts, results, now = new Date().toISOString(), fromStatus = 'running' }) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(batchId)
      requireReviewTimestamp(now)
      if (!['completed', 'failed'].includes(status) || !['queued', 'running'].includes(fromStatus)) throw new TypeError('Invalid create batch state')
      if (errorCode !== null && !['timeout', 'expired', 'dispatch_failed', 'operation_failed'].includes(errorCode)) throw new TypeError('Invalid create batch error')
      const rows = checked(await supabase.from(CREATE_BATCH_TABLE).update({ ...createBatchCounts(counts), ...createBatchResults(results), status, error_code: errorCode,
        finished_at: now, heartbeat_at: now, updated_at: now }).eq('company_id', companyId).eq('id', batchId).eq('status', fromStatus).select('id'))
      return Array.isArray(rows) && rows.length === 1
    },
    async getLatestReviewRecheckBatch(companyId, kind = 'sample') {
      requireReviewIdentity(companyId)
      requireReviewValue(kind, REVIEW_KINDS, 'kind')
      return checked(await supabase.from(RECHECK_BATCH_TABLE).select(RECHECK_BATCH_COLUMNS).eq('company_id', companyId)
        .eq('review_kind', kind).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle())
    },
    async claimReviewRecheckBatch(companyId, batchId, now = new Date().toISOString()) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(batchId)
      requireReviewTimestamp(now)
      return checked(await supabase.from(RECHECK_BATCH_TABLE).update({ status: 'running', started_at: now, heartbeat_at: now, updated_at: now })
        .eq('company_id', companyId).eq('id', batchId).eq('status', 'queued').select(RECHECK_BATCH_COLUMNS).maybeSingle()) ?? null
    },
    async updateReviewRecheckBatch(companyId, batchId, { counts, now = new Date().toISOString() }) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(batchId)
      requireReviewTimestamp(now)
      const rows = checked(await supabase.from(RECHECK_BATCH_TABLE).update({ ...recheckBatchCounts(counts), heartbeat_at: now, updated_at: now })
        .eq('company_id', companyId).eq('id', batchId).eq('status', 'running').select('id'))
      return Array.isArray(rows) && rows.length === 1
    },
    async finishReviewRecheckBatch(companyId, batchId, { status, errorCode = null, counts, now = new Date().toISOString(), fromStatus = 'running' }) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(batchId)
      requireReviewTimestamp(now)
      if (!['completed', 'failed'].includes(status) || !['queued', 'running'].includes(fromStatus)) throw new TypeError('Invalid recheck batch state')
      if (errorCode !== null && !RECHECK_BATCH_ERRORS.has(errorCode)) throw new TypeError('Invalid recheck batch error')
      const rows = checked(await supabase.from(RECHECK_BATCH_TABLE).update({ ...recheckBatchCounts(counts), status, error_code: errorCode,
        heartbeat_at: now, finished_at: now, updated_at: now })
        .eq('company_id', companyId).eq('id', batchId).eq('status', fromStatus).select('id'))
      return Array.isArray(rows) && rows.length === 1
    },
    async pruneSupersededDryRunReviews(companyId, keepRunId) {
      requireReviewIdentity(companyId)
      requireReviewIdentity(keepRunId)
      // Paused, failed, and partially failed runs may resume past already
      // captured sources. Preserve all resumable sets regardless of their age.
      const terminalRuns = await readAll(supabase, 'h2a_sync_runs', companyId, query => query
        .eq('mode', 'dry_run').eq('sample_limit_per_type', SAMPLE_LIMIT_PER_TYPE).eq('review_capture_version', 1)
        .in('status', ['completed', 'cancelled']).neq('id', keepRunId), 'id')
      const ids = [...new Set(terminalRuns.map(run => {
        requireReviewIdentity(run?.id)
        return run.id
      }))]
      if (!ids.length) return []
      // The database supersedes old nonleased intents and returns every run
      // whose review rows are still needed for immutable resolution history.
      const retained = checked(await supabase.rpc('h2a_retain_review_resolution_runs', {
        p_company_id: companyId, p_keep_run_id: keepRunId,
      }))
      if (!Array.isArray(retained) || retained.some(id => typeof id !== 'string')) {
        throw new Error('Invalid review retention response')
      }
      const protectedRuns = new Set(retained)
      const deletable = ids.filter(id => !protectedRuns.has(id))
      const removed = []
      for (let start = 0; start < deletable.length; start += 100) {
        const result = checked(await supabase.from('h2a_dry_run_reviews').delete().eq('company_id', companyId)
          .in('run_id', deletable.slice(start, start + 100)).select('id'))
        if (!Array.isArray(result)) throw new Error('Invalid review cleanup response')
        removed.push(...result)
      }
      return removed
    },
    async getConflict(companyId, conflictId) {
      return checked(await scoped(supabase, 'h2a_conflicts', companyId).eq('id', conflictId).maybeSingle())
    },
    async listConflicts(companyId, { limit, before = null }) {
      let query = scoped(supabase, 'h2a_conflicts', companyId)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit)
      if (before) query = query.or(`created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`)
      const items = checked(await query)
      if (!Array.isArray(items)) throw new Error('Invalid conflict page')
      return { items, hasMore: false }
    },
    async listConflictEvents(companyId, conflictIds) {
      if (!Array.isArray(conflictIds) || conflictIds.length === 0) return []
      return checked(await supabase.from('h2a_conflict_events').select('*').eq('company_id', companyId)
        .in('conflict_id', conflictIds).order('created_at', { ascending: true }).order('id', { ascending: true }))
    },
    async resolveConflict(companyId, input) {
      return checked(await supabase.rpc('h2a_resolve_conflict', {
        p_company_id: companyId, p_conflict_id: input.conflictId, p_expected_updated_at: input.expectedUpdatedAt,
        p_actor_id: input.actorId, p_api_action: input.action, p_db_action: input.dbAction,
        p_request: { targetId: input.targetId, selectedFields: input.selectedFields,
          approveManyToOne: input.approveManyToOne }, p_now: input.now,
      }))
    },
    async listPendingConflictResumes(companyId, limit = 25) {
      return checked(await scoped(supabase, 'h2a_conflict_resumes', companyId).eq('status', 'pending')
        .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit))
    },
    async claimConflictResume(companyId, resumeId, ownerToken, ttlSeconds = 120) {
      return checked(await supabase.rpc('h2a_claim_conflict_resume', {
        p_company_id: companyId, p_resume_id: resumeId, p_owner_token: ownerToken, p_ttl_seconds: ttlSeconds,
      }))
    },
    async finishConflictResume(companyId, resumeId, ownerToken, accepted, errorCode = null) {
      return checked(await supabase.rpc('h2a_finish_conflict_resume', {
        p_company_id: companyId, p_resume_id: resumeId, p_owner_token: ownerToken,
        p_accepted: accepted, p_error_code: errorCode,
      })) === true
    },
    async getConflictResume(companyId, resumeId) {
      return checked(await scoped(supabase, 'h2a_conflict_resumes', companyId).eq('id', resumeId).maybeSingle())
    },
    async getResumeRun(companyId, resumeId) {
      return checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('resume_id', resumeId).maybeSingle())
    },
    async getRun(companyId, runId) {
      return checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('id', runId).maybeSingle())
    },
    async requeueConflictResume(companyId, resumeId) {
      return checked(await supabase.rpc('h2a_requeue_conflict_resume', { p_company_id: companyId, p_resume_id: resumeId })) === true
    },
    async isSkippedItem(companyId, portalId, objectType, activityId) {
      const source = checked(await scoped(supabase, 'h2a_conflicts', companyId).eq('portal_id', portalId)
        .eq('object_type', objectType).eq('source_id', activityId).is('activity_object_type', null).is('activity_id', null)
        .eq('status', 'skipped').limit(1).maybeSingle())
      if (source) return true
      return Boolean(checked(await scoped(supabase, 'h2a_conflicts', companyId).eq('portal_id', portalId)
        .eq('activity_object_type', objectType).eq('activity_id', activityId).eq('status', 'skipped').limit(1).maybeSingle()))
    },
    async claimLease(companyId, ownerToken = randomUUID(), ttlSeconds = 900) {
      return checked(await supabase.rpc('h2a_claim_lease', { p_company_id: companyId, p_owner_token: ownerToken, p_ttl_seconds: ttlSeconds })) === true
    },
    async heartbeatLease(companyId, ownerToken, ttlSeconds = 900) {
      return checked(await supabase.rpc('h2a_heartbeat_lease', { p_company_id: companyId, p_owner_token: ownerToken, p_ttl_seconds: ttlSeconds })) === true
    },
    async releaseLease(companyId, ownerToken) {
      return checked(await supabase.rpc('h2a_release_lease', { p_company_id: companyId, p_owner_token: ownerToken })) === true
    },
    async getConfig(companyId) { return checked(await scoped(supabase, 'h2a_company_config', companyId).maybeSingle()) },
    async getCredentials(companyId) {
      return checked(await supabase.rpc('h2a_get_credentials', { p_company_id: companyId }))
    },
    async getActiveLease(companyId) {
      const lease = checked(await scoped(supabase, 'h2a_execution_leases', companyId).maybeSingle())
      return lease && Date.parse(lease.expires_at) > Date.now() ? lease : null
    },
    async hasCompletedSampleDryRun(companyId, after) {
      const run = checked(await scoped(supabase, 'h2a_sync_runs', companyId)
        .eq('mode', 'dry_run').eq('status', 'completed').eq('sample_limit_per_type', SAMPLE_LIMIT_PER_TYPE)
        .gt('created_at', after).order('created_at', { ascending: false }).limit(1).maybeSingle())
      return Boolean(run)
    },
    async queueRun(companyId, { mode, trigger, requestedBy = null, runId = null, businessDate = null,
      sampleLimitPerType = null, reviewCaptureVersion = null }) {
      if (reviewCaptureVersion !== null && !(mode === 'dry_run' &&
        sampleLimitPerType === SAMPLE_LIMIT_PER_TYPE && reviewCaptureVersion === 1)) {
        throw new TypeError('Invalid review capture version')
      }
      if (sampleLimitPerType !== null && (mode !== 'dry_run' || !Number.isInteger(sampleLimitPerType) ||
        sampleLimitPerType < 1 || sampleLimitPerType > 50)) {
        throw new TypeError('Invalid sample limit')
      }
      const payload = { ...(runId ? { id: runId } : {}), company_id: companyId,
        mode: mode === 'backfill' ? 'live' : mode, trigger: mode === 'backfill' ? 'backfill' : trigger,
        requested_by: requestedBy, business_date: businessDate, status: 'queued',
        ...(sampleLimitPerType === null ? {} : { sample_limit_per_type: sampleLimitPerType }),
        ...(reviewCaptureVersion === null ? {} : { review_capture_version: reviewCaptureVersion }) }
      try { return checked(await supabase.from('h2a_sync_runs').insert(payload).select('*').single()) }
      catch (error) {
        if (!runId) throw error
        const existing = checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('id', runId).maybeSingle())
        if (existing?.trigger === 'scheduled' && existing.business_date === businessDate) return existing
        throw error
      }
    },
    async queueScheduledRun(companyId, claimId, businessDate) {
      try {
        return checked(await supabase.from('h2a_sync_runs').insert({ id: claimId, company_id: companyId, mode: 'live', trigger: 'scheduled',
          scheduler_claim_id: claimId, business_date: businessDate, status: 'queued' }).select('*').single())
      } catch (error) {
        const existing = checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('scheduler_claim_id', claimId).maybeSingle())
        if (existing?.business_date === businessDate && existing.trigger === 'scheduled') return existing
        throw error
      }
    },
    async claimDailyRun(companyId, businessDate, ownerToken, ttlSeconds = 180) {
      const result = checked(await supabase.rpc('h2a_claim_daily_run', { p_company_id: companyId,
        p_business_date: businessDate, p_owner_token: ownerToken, p_ttl_seconds: ttlSeconds }))
      if (!result || typeof result !== 'object') throw new Error('Invalid daily claim response')
      return { ...result.claim, acquired: result.acquired === true }
    },
    async finishDailyRun(companyId, claimId, ownerToken, accepted, errorCode = null) {
      return checked(await supabase.rpc('h2a_finish_daily_run', { p_company_id: companyId, p_claim_id: claimId,
        p_owner_token: ownerToken, p_accepted: accepted, p_error_code: errorCode })) === true
    },
    async markQueueFailed(companyId, runId) {
      const now = new Date().toISOString()
      return checked(await supabase.from('h2a_sync_runs').update({ status: 'failed', started_at: now,
        finished_at: now, error_summary: 'background_dispatch_failed', updated_at: now })
        .eq('company_id', companyId).eq('id', runId).eq('status', 'queued').select('*').maybeSingle())
    },
    async markRunCollision(companyId, runId) {
      const now = new Date().toISOString()
      return checked(await supabase.from('h2a_sync_runs').update({ status: 'cancelled', started_at: now,
        finished_at: now, error_summary: 'already_running', updated_at: now })
        .eq('company_id', companyId).eq('id', runId).eq('status', 'queued').select('*').maybeSingle())
    },
    async getMappings(companyId) {
      const [contacts, organizations, options] = await Promise.all([
        readAll(supabase, 'h2a_contact_mappings', companyId),
        readAll(supabase, 'h2a_organization_mappings', companyId),
        readAll(supabase, 'h2a_option_mappings', companyId),
      ])
      return { contacts, organizations, options }
    },
    async startRun(companyId, { runId, mode, trigger, requestedBy = null, schedulerClaimId = null, resumeId = null }) {
      if (resumeId) {
        const existing = await this.getResumeRun(companyId, resumeId)
        if (existing && !['queued', 'running', 'paused', 'partially_failed', 'failed'].includes(existing.status)) return existing
        if (existing) {
          return checked(await supabase.from('h2a_sync_runs').update({ status: 'running', started_at: existing.started_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString() }).eq('company_id', companyId).eq('id', existing.id)
            .in('status', ['queued', 'running', 'paused', 'partially_failed', 'failed']).select('*').single())
        }
        return checked(await supabase.from('h2a_sync_runs').insert({ company_id: companyId, mode: 'live', trigger: 'conflict_resolution',
          status: 'running', resume_id: resumeId, started_at: new Date().toISOString() }).select('*').single())
      }
      if (runId) {
        const run = checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('id', runId).maybeSingle())
        if (!run || run.mode !== (mode === 'backfill' ? 'live' : mode)) throw new Error('Run is missing or belongs to another mode')
        if (!['queued', 'running', 'paused', 'partially_failed', 'failed'].includes(run.status)) throw new Error('Run is not resumable')
        return checked(await supabase.from('h2a_sync_runs').update({ status: 'running', started_at: run.started_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString() }).eq('company_id', companyId).eq('id', runId)
          .in('status', ['queued', 'running', 'paused', 'partially_failed', 'failed']).select('*').single())
      }
      const storedMode = mode === 'backfill' ? 'live' : mode
      return checked(await supabase.from('h2a_sync_runs').insert({ company_id: companyId, mode: storedMode,
        trigger: mode === 'backfill' ? 'backfill' : trigger, status: 'running', requested_by: requestedBy,
        scheduler_claim_id: schedulerClaimId,
        started_at: new Date().toISOString() }).select('*').single())
    },
    async finishRun(companyId, runId, status, totals, errorSummary = null) {
      return checked(await supabase.from('h2a_sync_runs').update({ status, totals, error_summary: errorSummary,
        finished_at: status === 'paused' ? null : new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('company_id', companyId).eq('id', runId).select('*').single())
    },
    async getCursor(companyId, objectType) {
      return boundary(checked(await scoped(supabase, 'h2a_cursors', companyId).eq('object_type', objectType).maybeSingle()))
    },
    async getRunCheckpoint(companyId, runId, objectType) {
      const row = checked(await scoped(supabase, 'h2a_run_checkpoints', companyId).eq('run_id', runId)
        .eq('object_type', objectType).maybeSingle())
      if (!row) return null
      return { ...(row.cursor_timestamp && row.cursor_object_id
        ? { timestamp: row.cursor_timestamp, objectId: row.cursor_object_id } : {}),
      upperBound: row.upper_bound, pageAfter: row.page_after ?? null,
      processedCount: Number.isInteger(row.processed_count) ? row.processed_count : 0, completed: row.completed === true }
    },
    async saveRunCheckpoint(companyId, runId, objectType, checkpoint) {
      const timestamp = checkpoint?.timestamp ?? null
      const objectId = checkpoint?.objectId ?? null
      return checked(await supabase.from('h2a_run_checkpoints').upsert({ company_id: companyId, run_id: runId,
        object_type: objectType, upper_bound: checkpoint?.upperBound, page_after: checkpoint?.pageAfter ?? null,
        cursor_timestamp: timestamp, cursor_object_id: objectId,
        processed_count: checkpoint?.processedCount ?? 0,
        completed: checkpoint?.completed === true, updated_at: new Date().toISOString() },
      { onConflict: 'company_id,run_id,object_type' }).select('*').single())
    },
    async saveCursor(companyId, objectType, checkpoint) {
      return checked(await supabase.from('h2a_cursors').upsert({ company_id: companyId, object_type: objectType,
        cursor_timestamp: checkpoint.timestamp, cursor_object_id: checkpoint.objectId, updated_at: new Date().toISOString() },
      { onConflict: 'company_id,object_type' }).select('*').single())
    },
    async listBackfillWindows(companyId, objectType) {
      return checked(await scoped(supabase, 'h2a_backfill_windows', companyId).eq('object_type', objectType)
        .in('status', ['pending', 'running']).order('start_at', { ascending: true }))
    },
    async saveBackfillWindow(companyId, windowId, patch) {
      return checked(await supabase.from('h2a_backfill_windows').update(patch).eq('company_id', companyId).eq('id', windowId).select('*').single())
    },
    async getItemOutcomes(companyId, runId, objectType, sourceId) {
      return checked(await scoped(supabase, 'h2a_item_results', companyId).eq('run_id', runId)
        .eq('object_type', objectType).eq('source_id', sourceId))
    },
    async recordItem(companyId, item) {
      const row = { ...item, company_id: companyId }
      return checked(await supabase.from('h2a_item_results').insert(row).select('*').single())
    },
    async totals(companyId, runId, mode) {
      const rows = await readAll(supabase, 'h2a_item_results', companyId, query => query.eq('run_id', runId))
      return aggregateRunTotals(rows, mode)
    },
    async saveMapping(companyId, kind, row, { approveManyToOne = false, forceResolutionId = null } = {}) {
      const objectType = kind === 'contact' ? 'contacts' : kind === 'organization' ? 'companies' : null
      if (!objectType) throw new TypeError('Unsupported mapping kind')
      if (typeof approveManyToOne !== 'boolean' || approveManyToOne && (row?.match_method !== 'reviewed' || !row?.reviewed_by)) {
        throw new TypeError('Invalid many-to-one approval')
      }
      const targetId = kind === 'contact' ? row?.albi_contact_id : row?.albi_organization_id
      const result = checked(await supabase.rpc('h2a_save_mapping', {
        p_company_id: companyId, p_portal_id: row?.portal_id, p_object_type: objectType,
        p_source_id: row?.hubspot_id, p_target_id: targetId, p_match_method: row?.match_method,
        p_reviewed_by: row?.reviewed_by ?? null, p_now: new Date().toISOString(),
        p_approve_many_to_one: approveManyToOne, p_force_resolution_id: forceResolutionId,
      }))
      if (result?.error === 'mapping_conflict') {
        throw Object.assign(new Error('A different Albi target is already mapped for this HubSpot source'), { code: 'mapping_conflict' })
      }
      if (result?.error === 'mapping_reserved') {
        throw Object.assign(new Error('This HubSpot source is reserved by an active reviewed create'), { code: 'mapping_reserved' })
      }
      if (result?.error === 'many_to_one_required') {
        throw Object.assign(new Error('Explicit approval is required to map another source to this Albi target'), { code: 'many_to_one_required' })
      }
      if (result?.error === 'invalid_mapping') throw new TypeError('Invalid source mapping')
      if (!result || result.error) throw new Error('Invalid source mapping response')
      return result
    },
    async recordConflict(companyId, conflict) {
      let query = scoped(supabase, 'h2a_conflicts', companyId)
        .eq('portal_id', conflict.portal_id).eq('object_type', conflict.object_type)
        .eq('source_id', conflict.source_id).eq('conflict_type', conflict.conflict_type)
        .eq('reason', conflict.reason)
      query = conflict.activity_object_type ? query.eq('activity_object_type', conflict.activity_object_type)
        : query.is('activity_object_type', null)
      query = conflict.activity_id ? query.eq('activity_id', conflict.activity_id) : query.is('activity_id', null)
      const existing = checked(await query.eq('status', 'open').maybeSingle())
      if (existing) return { ...existing, inserted: false }
      return { ...checked(await supabase.from('h2a_conflicts').insert({ ...conflict, company_id: companyId }).select('*').single()), inserted: true }
    },
    deliveryStore(companyId) {
      if (typeof companyId !== 'string' || !companyId.trim()) throw new TypeError('Company ID is required')
      return {
        async reserve({ identity, source_marker, now, staleBefore, retryEligibleAt }) {
          const row = checked(await supabase.rpc('h2a_reserve_delivery', {
            p_company_id: companyId, p_portal_id: identity.portalId, p_object_type: identity.objectType,
            p_activity_id: identity.activityId, p_albi_target_type: identity.albiTargetType,
            p_albi_target_id: identity.albiTargetId, p_source_marker: source_marker,
            p_now: now, p_stale_before: staleBefore, p_retry_eligible_at: retryEligibleAt,
          }))
          if (!row || typeof row !== 'object') throw new Error('Invalid delivery reservation response')
          return { acquired: row.acquired, isNew: row.is_new, previous: row.previous, row: row.delivery }
        },
        async transition({ id, expectedVersion, attemptToken, patch }) {
          if (String(expectedVersion) !== attemptToken) throw new TypeError('Invalid delivery attempt token')
          const row = checked(await supabase.rpc('h2a_transition_delivery', {
            p_company_id: companyId, p_delivery_id: id, p_expected_attempt_count: expectedVersion, p_patch: patch,
          }))
          return { updated: row?.updated === true, row: row?.delivery ?? null }
        },
      }
    },
  }
}
