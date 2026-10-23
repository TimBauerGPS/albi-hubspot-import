import { randomUUID } from 'node:crypto'
import { executeReviewResolution, executeOrganizationThenContactCreate } from './reviewResolutionService.js'
import { normalizeResolutionDecision } from './reviewResolution.js'
import { H2AReviewError } from './reviewService.js'
import { refreshReviewTriage } from './triage.js'

// The review outbox: actions from the review workspace are queued and sent by one background worker per company,
// one at a time at a steady pace, backing off when Albi refuses as busy (429). A failed action stays in the
// outbox, with its reason, until it is retried or returned to review.
export const OUTBOX_PACE_MS = 1500
export const OUTBOX_BUSY_START_MS = 30000
export const OUTBOX_BUSY_MAX_MS = 10 * 60000
export const OUTBOX_MAX_BUSY_ATTEMPTS = 8
// Queued creates share one read of Albi's lists (grown with each record created) instead of each walking Albi;
// it is read again once it is this old.
export const OUTBOX_SNAPSHOT_MS = 5 * 60000
const LEASE_SECONDS = 300
const WORKER_SECONDS = 900
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const SENT = new Set(['ready_to_recheck', 'completed', 'waiting_on_albi'])
const clock = deps => (deps.clockMs ?? Date.now)()
const sleepFor = deps => deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const reasonCode = value => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : null

// What a queued action may be: a review resolution decision, "create the organization, then the contact", or
// "create with the record's default referral source" (its Albi organization's, else its salesperson's; the
// optional fallback covers a record without one).
export function normalizeOutboxAction(input) {
  if (!object(input)) throw new TypeError('Invalid outbox action')
  if (input.kind === 'resolution' && Object.keys(input).every(key => ['kind', 'decision'].includes(key))) {
    return { kind: 'resolution', decision: normalizeResolutionDecision(input.decision) }
  }
  if (input.kind === 'create_with_organization' &&
    Object.keys(input).every(key => ['kind', 'referralSourceId', 'organizationReviewId', 'organizationExpectedUpdatedAt'].includes(key))) {
    const { referralSourceId } = normalizeResolutionDecision({ action: 'create_albi', referralSourceId: input.referralSourceId })
    if (input.organizationReviewId !== undefined && (typeof input.organizationReviewId !== 'string' || !UUID.test(input.organizationReviewId) ||
      typeof input.organizationExpectedUpdatedAt !== 'string' || !TIME.test(input.organizationExpectedUpdatedAt))) throw new TypeError('Invalid outbox action')
    if (input.organizationReviewId === undefined && input.organizationExpectedUpdatedAt !== undefined) throw new TypeError('Invalid outbox action')
    return { kind: 'create_with_organization', referralSourceId,
      ...(input.organizationReviewId ? { organizationReviewId: input.organizationReviewId, organizationExpectedUpdatedAt: input.organizationExpectedUpdatedAt } : {}) }
  }
  if (input.kind === 'create_default_referral' && Object.keys(input).every(key => ['kind', 'fallbackReferralSourceId'].includes(key))) {
    if (input.fallbackReferralSourceId === undefined) return { kind: 'create_default_referral' }
    const { referralSourceId } = normalizeResolutionDecision({ action: 'create_albi', referralSourceId: input.fallbackReferralSourceId })
    return { kind: 'create_default_referral', fallbackReferralSourceId: referralSourceId }
  }
  throw new TypeError('Invalid outbox action')
}

// Whether a queued action creates one record in Albi (and so can use the shared Albi read).
export function outboxCreates(action) {
  return object(action) && (action.kind === 'create_default_referral' || action.kind === 'resolution' && action.decision?.action === 'create_albi')
}

// A failed resolution's reason, from its last failed event (sanitized details only).
async function failureOf(deps, companyId, resolution) {
  if (typeof deps.repository.listReviewResolutionEvents !== 'function' || !resolution?.id) return {}
  const events = await deps.repository.listReviewResolutionEvents(companyId, resolution.id).catch(() => [])
  const failed = [...(Array.isArray(events) ? events : [])].reverse().find(event => event?.event_type === 'failed')
  return object(failed?.sanitized_details) ? failed.sanitized_details : {}
}

function classify(details = {}) {
  const detail = Object.fromEntries(['category', 'code', 'staleCheck', 'providerStatus'].filter(key => details[key] !== undefined && details[key] !== null)
    .map(key => [key, key === 'providerStatus' ? Number(details[key]) : String(details[key]).slice(0, 40)]))
  if (details.category === 'rate_limit') return { outcome: 'busy', errorCode: 'albi_busy', detail }
  const errorCode = details.staleCheck === 'candidates' ? 'possible_match' : details.code === 'malformed_response' ? 'reply_unreadable'
    : details.staleCheck ? 'record_changed' : ['permission', 'auth'].includes(details.category) ? 'not_allowed'
      : details.category === 'validation' ? 'albi_rejected' : 'error'
  return { outcome: 'failed', errorCode, detail }
}

function classifyError(error) {
  if (error instanceof H2AReviewError) {
    if (error.statusCode === 409) return { outcome: 'failed', errorCode: 'changed', detail: {} }
    if ([400, 403, 404].includes(error.statusCode)) return { outcome: 'failed', errorCode: error.statusCode === 404 ? 'not_found' : 'not_allowed', detail: {} }
  }
  if (error?.category === 'rate_limit') return { outcome: 'busy', errorCode: 'albi_busy', detail: { category: 'rate_limit' } }
  return { outcome: 'failed', errorCode: 'error', detail: {} }
}

// Runs one queued action exactly as the workspace used to (same audited, idempotent resolution).
export async function runOutboxItem(deps, row) {
  const companyId = row.company_id
  const action = normalizeOutboxAction(row.action)
  try {
    if (action.kind === 'create_with_organization') {
      let { organizationReviewId, organizationExpectedUpdatedAt } = action
      if (!organizationReviewId) {
        if (typeof deps.prepareOrganization !== 'function') return { outcome: 'failed', errorCode: 'not_allowed', detail: {} }
        ;({ organizationReviewId, organizationExpectedUpdatedAt } = await deps.prepareOrganization(row))
      }
      const result = await (deps.executeOrganizationFirst ?? executeOrganizationThenContactCreate)(deps, { companyId, actorId: row.requested_by,
        contactReviewId: row.review_id, contactExpectedUpdatedAt: row.expected_updated_at, organizationReviewId, organizationExpectedUpdatedAt,
        referralSourceId: action.referralSourceId, clientRequestId: row.client_request_id })
      if (result?.organization?.error) return classifyError(result.organization.error)
      if (result?.contact?.error) return classifyError(result.contact.error)
      const status = result?.contact?.resolution?.status
      if (SENT.has(status)) return { outcome: 'sent' }
      return status === 'failed' ? classify(await failureOf(deps, companyId, result.contact.resolution)) : { outcome: 'failed', errorCode: 'error', detail: {} }
    }
    let decision = action.decision
    if (action.kind === 'create_default_referral') {
      // The same create checks and default the record shows; a record that is not ready fails with its reason.
      if (typeof deps.loadCreateDefault !== 'function') return { outcome: 'failed', errorCode: 'not_allowed', detail: {} }
      const readiness = await deps.loadCreateDefault(row)
      if (readiness?.ready !== true) return { outcome: 'failed', errorCode: reasonCode(readiness?.blockedReason) ?? 'not_ready', detail: {} }
      const referralSourceId = providerId(readiness.defaultReferralSourceId) ? readiness.defaultReferralSourceId : action.fallbackReferralSourceId
      if (!providerId(referralSourceId)) return { outcome: 'failed', errorCode: 'no_default_referral', detail: {} }
      decision = { action: 'create_albi', referralSourceId }
    }
    const result = await (deps.executeResolution ?? executeReviewResolution)(deps, { companyId, actorId: row.requested_by, reviewId: row.review_id,
      expectedUpdatedAt: row.expected_updated_at, clientRequestId: row.client_request_id, decision })
    const status = result?.resolution?.status
    if (SENT.has(status)) return { outcome: 'sent' }
    if (status === 'superseded') return { outcome: 'failed', errorCode: 'record_changed', detail: {} }
    if (status === 'failed') return classify(await failureOf(deps, companyId, result.resolution))
    return { outcome: 'failed', errorCode: 'error', detail: {} }
  } catch (error) {
    return classifyError(error)
  }
}

async function moveTriage(deps, companyId, reviewId, outcome) {
  const repository = deps.repository
  try {
    if (outcome === 'sent') {
      const row = await repository.getReview(companyId, reviewId)
      if (row) await refreshReviewTriage(repository, { companyId, row, force: true })
    } else await repository.setReviewTriage(companyId, reviewId, { bucket: 'outbox', details: { outbox: outcome } })
  } catch { /* Triage is advisory; the outbox row holds the truth. */ }
}

// One worker per company: claims due actions in order, pausing OUTBOX_PACE_MS between them. A busy Albi puts the
// action back in line and pauses the worker (doubling up to OUTBOX_BUSY_MAX_MS); after OUTBOX_MAX_BUSY_ATTEMPTS
// busy refusals the action fails. Near its time limit the worker hands the rest to a continuation.
export async function runReviewOutbox(deps, { companyId }) {
  const repository = deps.repository
  const owner = randomUUID()
  if (!await repository.claimOutboxWorker(companyId, owner, WORKER_SECONDS)) return { status: 'busy' }
  const sleep = sleepFor(deps)
  const pace = Number.isFinite(deps.paceMs) ? Math.max(0, deps.paceMs) : OUTBOX_PACE_MS
  const maxBusy = Number.isInteger(deps.maxBusyAttempts) ? deps.maxBusyAttempts : OUTBOX_MAX_BUSY_ATTEMPTS
  const deadline = clock(deps) + Math.min(13 * 60000, Math.max(1000, deps.budgetMs ?? 13 * 60000))
  let busyMs = 0, sent = 0, failed = 0, status = 'idle'
  // One Albi read per list for this run's creates; any failed read just leaves that create to read Albi itself.
  let shared = null
  const snapshotFor = async row => {
    if (typeof deps.readAlbiList !== 'function' || !outboxCreates(row.action)) return null
    if (!shared || clock(deps) - shared.at >= OUTBOX_SNAPSHOT_MS) shared = { at: clock(deps), lists: {} }
    try {
      const review = await repository.getReview(companyId, row.review_id)
      const kind = review?.object_type === 'companies' ? 'organizations' : 'contacts'
      if (!Array.isArray(shared.lists[kind])) shared.lists[kind] = await deps.readAlbiList(kind)
      return shared.lists
    } catch { return null }
  }
  try {
    for (;;) {
      if (clock(deps) >= deadline - 30000) { status = 'continued'; break }
      const row = await repository.claimOutboxItem(companyId, LEASE_SECONDS)
      if (!row) {
        const due = await repository.nextOutboxDue(companyId)
        if (!due) break
        const wait = Math.max(0, Date.parse(due) - clock(deps))
        if (clock(deps) + wait >= deadline - 30000) { status = 'continued'; break }
        await sleep(wait)
        continue
      }
      const snapshot = await snapshotFor(row)
      const result = await runOutboxItem(snapshot ? { ...deps, albiSnapshot: snapshot } : deps, row)
      const now = clock(deps)
      if (result.outcome === 'sent') {
        busyMs = 0; sent++
        await repository.finishOutboxItem(companyId, row.id, { status: 'sent' })
        await moveTriage(deps, companyId, row.review_id, 'sent')
      } else if (result.outcome === 'busy' && row.attempts < maxBusy) {
        busyMs = busyMs ? Math.min(OUTBOX_BUSY_MAX_MS, busyMs * 2) : OUTBOX_BUSY_START_MS
        await repository.finishOutboxItem(companyId, row.id, { status: 'queued', nextAttemptAt: new Date(now + busyMs).toISOString(),
          errorCode: 'albi_busy', errorDetail: result.detail })
        await moveTriage(deps, companyId, row.review_id, 'queued')
        if (clock(deps) + busyMs >= deadline - 30000) { status = 'continued'; break }
        await sleep(busyMs)
        continue
      } else {
        failed++
        await repository.finishOutboxItem(companyId, row.id, { status: 'failed', errorCode: result.errorCode, errorDetail: result.detail })
        await moveTriage(deps, companyId, row.review_id, 'failed')
      }
      await repository.claimOutboxWorker(companyId, owner, WORKER_SECONDS)
      await sleep(pace)
    }
  } finally {
    await repository.releaseOutboxWorker(companyId, owner).catch(() => {})
  }
  if (status === 'continued' && typeof deps.dispatchContinuation === 'function') {
    try { await deps.dispatchContinuation({ companyId }) } catch { /* The hourly job resumes a queue left waiting. */ }
  }
  return { status, sent, failed }
}
