import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { createH2AProviderClients, readOnlyH2ACapabilities } from './_h2a/providerClients.js'
import { H2AReviewError, createReviewBatchCapabilities, resolveReviewSample, runReviewRecheckBatch } from './_h2a/reviewService.js'
import { createTriageCapabilities } from './_h2a/triage.js'
import { createReviewReconciliationCapabilities } from './_h2a/reviewResolutionService.js'
import { createLiveCloseCapabilities } from './_h2a/liveReview.js'
import { defaultDispatchResume } from './h2a-conflict-resolve.js'
import { ApiError } from './_h2a/http.js'

// "Recheck all": POST queues one batch for the current sample (kind 'sample') or for the open live
// rows (kind 'live', no sample run), optionally only for up to 200 review IDs, and hands it to the
// background function; GET returns the latest batch of a kind so the page can poll progress. The
// background variant (internal credentials only) runs the batch: one Albi walk, then every row.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// Background functions stop at 15 minutes; a batch without a heartbeat for longer is abandoned.
const STALE_AFTER_MS = 16 * 60000
const MAX_REVIEW_IDS = 200
const KINDS = ['sample', 'live']
const ZERO_COUNTS = Object.freeze({ total: 0, done: 0, cleared: 0, stillNeedsReview: 0, noLongerInScope: 0, stale: 0, failed: 0 })
const AUTH_MESSAGES = new Set(['Authentication required.', 'Invalid authentication token.', 'Administrator access is required.',
  'You are not authorized to access H2A.', 'You are not authorized to access the requested company.', 'A company must be selected.', 'Company not found.'])
const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: JSON.stringify(body) })
const fail = (status, message) => { throw new H2AReviewError(status, message) }
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

export function projectRecheckBatch(row) {
  if (!row) return null
  return { id: row.id, kind: row.review_kind === 'live' ? 'live' : 'sample',
    targeted: Array.isArray(row.review_ids),
    status: ['queued', 'running', 'completed', 'failed'].includes(row.status) ? row.status : 'failed',
    total: count(row.total), done: count(row.done), cleared: count(row.cleared), stillNeedsReview: count(row.still_needs_review),
    noLongerInScope: count(row.no_longer_in_scope), stale: count(row.stale), failed: count(row.failed),
    errorCode: typeof row.error_code === 'string' ? row.error_code : null,
    createdAt: row.created_at ?? null, startedAt: row.started_at ?? null, finishedAt: row.finished_at ?? null }
}

function reviewIds(value) {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REVIEW_IDS ||
    value.some(id => typeof id !== 'string' || !UUID.test(id))) fail(400, 'Invalid recheck request.')
  return [...new Set(value.map(id => id.toLowerCase()))]
}

function request(event, background) {
  const query = event.queryStringParameters ?? {}
  let body = {}
  if (event.httpMethod === 'POST') {
    try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body ?? {} } catch { fail(400, 'Invalid request body.') }
    const allowed = background ? ['companyId', 'batchId'] : ['companyId', 'kind', 'reviewIds']
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Unsupported request fields.')
    if (background && !UUID.test(body.batchId ?? '')) fail(400, 'Invalid recheck batch.')
    if (Object.keys(query).some(key => key !== 'companyId')) fail(400, 'Unsupported query parameters.')
  } else if (Object.keys(query).some(key => !['companyId', 'kind'].includes(key))) fail(400, 'Unsupported query parameters.')
  const kind = (event.httpMethod === 'POST' ? body.kind : query.kind) ?? 'sample'
  if (!KINDS.includes(kind)) fail(400, 'Invalid recheck request.')
  const selectors = [query.companyId, body.companyId].filter(value => value !== undefined)
  if (selectors.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(selectors).size > 1) fail(400, 'A single company selector is required.')
  return { companyId: selectors[0], batchId: body.batchId, kind, reviewIds: background ? null : reviewIds(body.reviewIds) }
}

async function dispatchBackground(payload, options) {
  if (options.dispatch) return options.dispatch(payload)
  const base = options.siteUrl ?? process.env.URL
  const secret = options.internalCronSecret ?? process.env.INTERNAL_CRON_SECRET
  if (!base || !secret) throw new Error('Recheck dispatch is not configured')
  const url = new URL('/.netlify/functions/h2a-dry-run-review-recheck-all-background', base)
  const response = await (options.fetch ?? fetch)(url.toString(), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Cron-Secret': secret }, body: JSON.stringify(payload) })
  if (!response.ok) throw new Error('Recheck dispatch failed')
}

// Same read-only, portal-verified clients the single-record recheck uses.
function readClients(options, repository, companyId) {
  return async (_companyId, config, { signal }) => {
    const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
      companyId, repository, keyring: options.keyring, env: options.env, fetch: async (url, init) => {
        if (signal.aborted) throw new ApiError('transient', { code: 'timeout' })
        return (options.fetch ?? globalThis.fetch)(url, { ...init, signal: AbortSignal.any([signal, init.signal]) })
      },
    })
    if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission')
    return readOnlyH2ACapabilities(clients)
  }
}

async function start({ repository, options, auth, companyId, kind, reviewIds: ids }) {
  // Live batches recheck open live rows and need no sample run.
  let runId = null
  if (kind === 'sample') {
    const { sample } = await resolveReviewSample(repository, companyId)
    if (!sample) fail(409, 'Run a new sample to create detailed review data.')
    runId = sample.id
  }
  const now = (options.now?.() ?? new Date())
  const created = await repository.createReviewRecheckBatch(companyId, { kind, runId, reviewIds: ids, actorId: auth.userId,
    now: now.toISOString(), staleBefore: new Date(now.getTime() - STALE_AFTER_MS).toISOString() })
  if (created?.error === 'active') return reply(200, { status: 'already_running', batch: projectRecheckBatch(created.batch) })
  if (!created?.batch?.id) fail(502, 'Unable to start rechecking all reviews.')
  try { await dispatchBackground({ companyId, batchId: created.batch.id }, options) } catch {
    try {
      await repository.finishReviewRecheckBatch(companyId, created.batch.id, { status: 'failed', errorCode: 'dispatch_failed',
        counts: ZERO_COUNTS, fromStatus: 'queued' })
    } catch { /* The batch expires by heartbeat if this cleanup also fails. */ }
    fail(502, 'Unable to start rechecking all reviews.')
  }
  return reply(202, { status: 'queued', batch: projectRecheckBatch(created.batch) })
}

async function run({ repository, options, companyId, batchId }) {
  const capabilities = createReviewBatchCapabilities(repository)
  const resolutionRepository = ['getCurrentReviewResolution', 'claimReviewResolution', 'finishReviewResolution', 'getContactOrganizationChoice']
    .every(method => typeof repository[method] === 'function') ? createReviewReconciliationCapabilities(repository) : undefined
  try {
    const result = await runReviewRecheckBatch({ ...capabilities, resolutionRepository, triageRepository: createTriageCapabilities(repository),
      // Live rows close through the close RPC when a recheck finds them resolved or gone.
      liveCloseRepository: createLiveCloseCapabilities(repository),
      dispatchResume: options.dispatchResume ?? (intent => defaultDispatchResume(intent, options)),
      now: options.now, clockMs: options.clockMs,
      sleep: options.sleep, deadlineMs: options.deadlineMs, batchDeadlineMs: options.batchDeadlineMs,
      getReadClients: readClients(options, repository, companyId) }, { companyId, batchId })
    return reply(200, { status: result.status })
  } catch {
    try {
      await repository.finishReviewRecheckBatch(companyId, batchId, { status: 'failed', errorCode: 'operation_failed', counts: ZERO_COUNTS })
    } catch { /* The batch expires by heartbeat. */ }
    return reply(200, { status: 'failed' })
  }
}

export function createRecheckAllHandler(options = {}, { background = false } = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return reply(200, {})
    if (background ? event.httpMethod !== 'POST' : !['GET', 'POST'].includes(event.httpMethod)) return reply(405, { error: 'Method not allowed.' })
    try {
      const input = request(event, background)
      const auth = await (options.requireRequest ?? requireH2ARequest)(event, { supabase: options.supabase, getSupabase: options.getSupabase,
        internalCronSecret: options.internalCronSecret, internalJob: background, requireAdmin: !background, requestedCompanyId: input.companyId })
      const repository = options.repository ?? createH2ARepository(auth.supabase)
      const companyId = auth.companyId
      if (background) return await run({ repository, options, companyId, batchId: input.batchId })
      if (event.httpMethod === 'GET') return reply(200, { batch: projectRecheckBatch(await repository.getLatestReviewRecheckBatch(companyId, input.kind)) })
      return await start({ repository, options, auth, companyId, kind: input.kind, reviewIds: input.reviewIds })
    } catch (error) {
      const typed = error instanceof H2AReviewError || error instanceof H2AAuthError
      const fallback = event.httpMethod === 'GET' ? 'Unable to load recheck progress.' : 'Unable to start rechecking all reviews.'
      return reply(typed ? error.statusCode : 500, { error: error instanceof H2AReviewError ? error.message
        : error instanceof H2AAuthError && (AUTH_MESSAGES.has(error.message) || background) ? error.message : fallback })
    }
  }
}

export const handler = createRecheckAllHandler()
