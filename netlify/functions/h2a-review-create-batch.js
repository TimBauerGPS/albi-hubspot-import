import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { createH2AProviderClients, reviewResolutionProviderCapabilities } from './_h2a/providerClients.js'
import { H2AReviewError } from './_h2a/reviewService.js'
import { canResolve, resolutionMode } from './_h2a/resolutionCapability.js'
import { MAX_CREATE_BATCH_ITEMS, runReviewCreateBatch } from './_h2a/createBatch.js'
import { defaultDispatchResume } from './h2a-conflict-resolve.js'
import { ApiError } from './_h2a/http.js'
import { loadReviewResolutionOptions } from './_h2a/reviewResolutionOptions.js'

// "Create selected": POST queues one batch (selected reviews + one referral source) and hands it to the
// background function; GET returns the latest batch of a kind plus Albi's referral sources so the page can
// show the choice and poll progress. The background variant (internal credentials only) runs the batch.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const PROVIDER_ID = /^[1-9]\d{0,99}$/
// Background functions stop at 15 minutes; a batch without a heartbeat for longer is abandoned.
const STALE_AFTER_MS = 16 * 60000
const KINDS = ['sample', 'live']
const ZERO_COUNTS = Object.freeze({ total: 0, done: 0, created: 0, skipped: 0, failed: 0 })
const AUTH_MESSAGES = new Set(['Authentication required.', 'Invalid authentication token.', 'Administrator access is required.',
  'You are not authorized to access H2A.', 'You are not authorized to access the requested company.', 'A company must be selected.', 'Company not found.'])
const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: JSON.stringify(body) })
const fail = (status, message) => { throw new H2AReviewError(status, message) }
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

export function projectCreateBatch(row) {
  if (!row) return null
  return { id: row.id, kind: row.review_kind === 'live' ? 'live' : 'sample',
    status: ['queued', 'running', 'completed', 'failed'].includes(row.status) ? row.status : 'failed',
    total: count(row.total), done: count(row.done), created: count(row.created), skipped: count(row.skipped), failed: count(row.failed),
    errorCode: typeof row.error_code === 'string' ? row.error_code : null,
    results: (Array.isArray(row.results) ? row.results : []).slice(0, MAX_CREATE_BATCH_ITEMS).filter(item => item && typeof item.reviewId === 'string' &&
      ['created', 'skipped', 'failed'].includes(item.outcome)).map(item => ({ reviewId: item.reviewId, outcome: item.outcome,
      ...(typeof item.reason === 'string' && /^[a-z_]{1,40}$/.test(item.reason) ? { reason: item.reason } : {}) })),
    createdAt: row.created_at ?? null, startedAt: row.started_at ?? null, finishedAt: row.finished_at ?? null }
}

function items(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CREATE_BATCH_ITEMS ||
    value.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['reviewId', 'expectedUpdatedAt'].includes(key)) ||
      typeof item.reviewId !== 'string' || !UUID.test(item.reviewId) || typeof item.expectedUpdatedAt !== 'string' || !TIMESTAMP.test(item.expectedUpdatedAt)) ||
    new Set(value.map(item => item.reviewId.toLowerCase())).size !== value.length) fail(400, 'Invalid create request.')
  return value.map(item => ({ reviewId: item.reviewId.toLowerCase(), expectedUpdatedAt: item.expectedUpdatedAt }))
}

function request(event, background) {
  const query = event.queryStringParameters ?? {}
  let body = {}
  if (event.httpMethod === 'POST') {
    try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body ?? {} } catch { fail(400, 'Invalid request body.') }
    const allowed = background ? ['companyId', 'batchId'] : ['companyId', 'kind', 'referralSourceId', 'items']
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Invalid create request.')
    if (background && !UUID.test(body.batchId ?? '')) fail(400, 'Invalid create batch.')
    if (!background && (typeof body.referralSourceId !== 'string' || !PROVIDER_ID.test(body.referralSourceId))) fail(400, 'Invalid create request.')
    if (Object.keys(query).some(key => key !== 'companyId')) fail(400, 'Unsupported query parameters.')
  } else if (Object.keys(query).some(key => !['companyId', 'kind'].includes(key))) fail(400, 'Unsupported query parameters.')
  const kind = (event.httpMethod === 'POST' ? body.kind : query.kind) ?? 'sample'
  if (!KINDS.includes(kind)) fail(400, 'Invalid create request.')
  const selectors = [query.companyId, body.companyId].filter(value => value !== undefined)
  if (selectors.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(selectors).size > 1) fail(400, 'A single company selector is required.')
  return { companyId: selectors[0], batchId: body.batchId, kind, referralSourceId: body.referralSourceId,
    items: event.httpMethod === 'POST' && !background ? items(body.items) : null }
}

async function dispatchBackground(payload, options) {
  if (options.dispatch) return options.dispatch(payload)
  const base = options.siteUrl ?? process.env.URL
  const secret = options.internalCronSecret ?? process.env.INTERNAL_CRON_SECRET
  if (!base || !secret) throw new Error('Create dispatch is not configured')
  const url = new URL('/.netlify/functions/h2a-review-create-batch-background', base)
  const response = await (options.fetch ?? fetch)(url.toString(), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Cron-Secret': secret }, body: JSON.stringify(payload) })
  if (!response.ok) throw new Error('Create dispatch failed')
}

const makeClients = (options, repository, companyId) => options.makeClients ? options.makeClients(companyId)
  : createH2AProviderClients({ companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })

async function referralSources(options, repository, companyId) {
  try {
    const clients = await makeClients(options, repository, companyId)
    const sources = await clients.albi.listReferralSources()
    return (Array.isArray(sources) ? sources : []).filter(source => typeof source?.id === 'string' && PROVIDER_ID.test(source.id) &&
      typeof source.label === 'string' && source.label.trim()).slice(0, 100).map(source => ({ id: source.id, label: source.label }))
  } catch { return [] }
}

async function start({ repository, options, auth, companyId, input }) {
  // The chosen source must exist in Albi now; each record re-checks it again before creating.
  if (!(await referralSources(options, repository, companyId)).some(source => source.id === input.referralSourceId)) {
    fail(400, 'The selected referral source is not available in Albi.')
  }
  const now = options.now?.() ?? new Date()
  const created = await repository.createReviewCreateBatch(companyId, { kind: input.kind, items: input.items, referralSourceId: input.referralSourceId,
    actorId: auth.userId, now: now.toISOString(), staleBefore: new Date(now.getTime() - STALE_AFTER_MS).toISOString() })
  if (created?.error === 'active') return reply(200, { status: 'already_running', batch: projectCreateBatch(created.batch) })
  if (!created?.batch?.id) fail(502, 'Unable to start creating the selected records.')
  try { await dispatchBackground({ companyId, batchId: created.batch.id }, options) } catch {
    try {
      await repository.finishReviewCreateBatch(companyId, created.batch.id, { status: 'failed', errorCode: 'dispatch_failed',
        counts: { ...ZERO_COUNTS, total: input.items.length }, fromStatus: 'queued' })
    } catch { /* The batch expires by heartbeat if this cleanup also fails. */ }
    fail(502, 'Unable to start creating the selected records.')
  }
  return reply(202, { status: 'queued', batch: projectCreateBatch(created.batch) })
}

async function run({ repository, options, companyId, batchId }) {
  try {
    const result = await runReviewCreateBatch({ repository, batchRepository: repository,
      now: options.now, clockMs: options.clockMs, deadlineMs: options.deadlineMs, batchDeadlineMs: options.batchDeadlineMs,
      dispatchResume: options.dispatchResume ?? (intent => defaultDispatchResume(intent, options)),
      // The record's own create checks (organization linked, owner/type/status, referral sources), read once per record.
      loadReadiness: async (row, clients) => {
        const loaded = await loadReviewResolutionOptions({ row: { ...row, company_id: companyId }, repository, reads: clients })
        return Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length ? loaded.forceCreateReadiness : loaded.createReadiness
      },
      getResolutionClients: async (_company, config) => {
        const clients = await makeClients(options, repository, companyId)
        if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission', { code: 'authorization_rejected' })
        return reviewResolutionProviderCapabilities(clients)
      } }, { companyId, batchId })
    return reply(200, { status: result.status })
  } catch {
    try { await repository.finishReviewCreateBatch(companyId, batchId, { status: 'failed', errorCode: 'operation_failed', counts: ZERO_COUNTS }) } catch { /* Expires by heartbeat. */ }
    return reply(200, { status: 'failed' })
  }
}

export function createCreateBatchHandler(options = {}, { background = false } = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return reply(200, {})
    if (background ? event.httpMethod !== 'POST' : !['GET', 'POST'].includes(event.httpMethod)) return reply(405, { error: 'Method not allowed.' })
    try {
      const input = request(event, background)
      const auth = await (options.requireRequest ?? requireH2ARequest)(event, { supabase: options.supabase, getSupabase: options.getSupabase,
        internalCronSecret: options.internalCronSecret, internalJob: background, requireAdmin: !background, requireAppAccess: !background,
        requestedCompanyId: input.companyId })
      const repository = options.repository ?? createH2ARepository(auth.supabase)
      const companyId = auth.companyId
      if (background) return await run({ repository, options, companyId, batchId: input.batchId })
      const mode = resolutionMode((options.env ?? process.env).H2A_REVIEW_RESOLUTION_MODE)
      if (event.httpMethod === 'GET') {
        return reply(200, { batch: projectCreateBatch(await repository.getLatestReviewCreateBatch(companyId, input.kind)),
          referralSources: await referralSources(options, repository, companyId) })
      }
      if (mode === 'disabled') fail(409, 'Review resolution is unavailable.')
      if (!canResolve({ mode, isAdmin: auth.role === 'admin', isSuperAdmin: auth.isSuperAdmin })) fail(403, 'Super administrator access is required.')
      return await start({ repository, options, auth, companyId, input })
    } catch (error) {
      const typed = error instanceof H2AReviewError || error instanceof H2AAuthError
      const fallback = event.httpMethod === 'GET' ? 'Unable to load create progress.' : 'Unable to start creating the selected records.'
      return reply(typed ? error.statusCode : 500, { error: error instanceof H2AReviewError ? error.message
        : error instanceof H2AAuthError && (AUTH_MESSAGES.has(error.message) || background) ? error.message : fallback })
    }
  }
}

export const handler = createCreateBatchHandler()
