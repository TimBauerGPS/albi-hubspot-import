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
const LEASE_SECONDS = 300
const WORKER_SECONDS = 900
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const SENT = new Set(['ready_to_recheck', 'completed', 'waiting_on_albi'])
const clock = deps => (deps.clockMs ?? Date.now)()
const sleepFor = deps => deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// What a queued action may be: a review resolution decision, or "create the organization, then the contact".
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
  throw new TypeError('Invalid outbox action')
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
    const result = await (deps.executeResolution ?? executeReviewResolution)(deps, { companyId, actorId: row.requested_by, reviewId: row.review_id,
      expectedUpdatedAt: row.expected_updated_at, clientRequestId: row.client_request_id, decision: action.decision })
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
      const result = await runOutboxItem(deps, row)
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
