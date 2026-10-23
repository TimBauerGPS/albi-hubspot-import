import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { createH2AProviderClients, reviewResolutionProviderCapabilities } from './_h2a/providerClients.js'
import { H2AReviewError, resolveReviewSample } from './_h2a/reviewService.js'
import { canResolve, resolutionMode } from './_h2a/resolutionCapability.js'
import { normalizeOutboxAction, runReviewOutbox } from './_h2a/outbox.js'
import { prepareOrganizationReview } from './_h2a/organizationReview.js'
import { loadReviewResolutionOptions } from './_h2a/reviewResolutionOptions.js'
import { listAll } from './_h2a/createBatch.js'
import { refreshReviewTriage } from './_h2a/triage.js'
import { defaultDispatchResume } from './h2a-conflict-resolve.js'
import { ApiError } from './_h2a/http.js'

// The review outbox. POST op=enqueue queues workspace actions (the records move to the Outbox tab) and starts
// the background worker; GET lists waiting, sending and failed actions; op=retry puts failed actions back in
// line; op=return cancels them and puts the records back in review. The background variant (internal
// credentials only) runs the worker.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const KINDS = ['sample', 'live']
const AUTH_MESSAGES = new Set(['Authentication required.', 'Invalid authentication token.', 'Administrator access is required.',
  'You are not authorized to access H2A.', 'You are not authorized to access the requested company.', 'A company must be selected.', 'Company not found.'])
const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: JSON.stringify(body) })
const fail = (status, message) => { throw new H2AReviewError(status, message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value.trim() : ''

// Browser-safe view of an outbox row: what it is for, where it stands, and why it failed.
export function projectOutboxItem(row) {
  const snapshot = object(row?.review?.source_snapshot) ? row.review.source_snapshot : {}
  const name = text(snapshot.name) || [text(snapshot.firstName), text(snapshot.lastName)].filter(Boolean).join(' ') || 'Unnamed record'
  const action = object(row?.action) ? row.action : {}
  const kind = action.kind === 'create_with_organization' ? 'create_with_organization' : action.kind === 'create_default_referral' ? 'create_albi'
    : typeof action.decision?.action === 'string' ? action.decision.action : 'unknown'
  return { id: row.id, reviewId: row.review_id, name: name.slice(0, 200),
    objectType: row?.review?.object_type === 'companies' ? 'companies' : 'contacts', action: kind,
    status: ['queued', 'sending', 'failed'].includes(row.status) ? row.status : 'queued',
    attempts: Number.isSafeInteger(row.attempts) ? row.attempts : 0,
    errorCode: typeof row.error_code === 'string' && /^[a-z_]{1,40}$/.test(row.error_code) ? row.error_code : null,
    nextAttemptAt: row.next_attempt_at ?? null, updatedAt: row.updated_at ?? null }
}

function request(event, background) {
  const query = event.queryStringParameters ?? {}
  let body = {}
  if (event.httpMethod === 'POST') {
    try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body ?? {} } catch { fail(400, 'Invalid request body.') }
    if (!object(body)) fail(400, 'Invalid outbox request.')
    if (Object.keys(query).some(key => key !== 'companyId')) fail(400, 'Unsupported query parameters.')
  } else if (Object.keys(query).some(key => !['companyId', 'kind'].includes(key))) fail(400, 'Unsupported query parameters.')
  const selectors = [query.companyId, body.companyId].filter(value => value !== undefined)
  if (selectors.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(selectors).size > 1) fail(400, 'A single company selector is required.')
  const companyId = selectors[0]
  if (background) {
    if (event.httpMethod !== 'POST' || Object.keys(body).some(key => key !== 'companyId')) fail(400, 'Invalid outbox request.')
    return { companyId, op: 'run' }
  }
  if (event.httpMethod === 'GET') {
    const kind = query.kind ?? 'live'
    if (!KINDS.includes(kind)) fail(400, 'Invalid outbox request.')
    return { companyId, op: 'list', kind }
  }
  if (body.op === 'enqueue') {
    const { items, op, companyId: _company, ...extra } = body
    if (Object.keys(extra).length || !Array.isArray(items) || items.length < 1 || items.length > 50) fail(400, 'Invalid outbox request.')
    const clean = items.map(item => {
      if (!object(item) || Object.keys(item).some(key => !['reviewId', 'expectedUpdatedAt', 'clientRequestId', 'action'].includes(key)) ||
        !UUID.test(item.reviewId ?? '') || !UUID.test(item.clientRequestId ?? '') || !TIMESTAMP.test(item.expectedUpdatedAt ?? '')) fail(400, 'Invalid outbox request.')
      let action
      try { action = normalizeOutboxAction(item.action) } catch { fail(400, 'Invalid outbox request.') }
      return { reviewId: item.reviewId.toLowerCase(), expectedUpdatedAt: item.expectedUpdatedAt, clientRequestId: item.clientRequestId.toLowerCase(), action }
    })
    if (new Set(clean.map(item => item.reviewId)).size !== clean.length) fail(400, 'Invalid outbox request.')
    return { companyId, op, items: clean }
  }
  if (['retry', 'return'].includes(body.op)) {
    const { ids, op, companyId: _company, ...extra } = body
    if (Object.keys(extra).length || !Array.isArray(ids) || ids.length < 1 || ids.length > 500 || ids.some(id => !UUID.test(id ?? ''))) fail(400, 'Invalid outbox request.')
    return { companyId, op, ids: [...new Set(ids.map(id => id.toLowerCase()))] }
  }
  fail(400, 'Invalid outbox request.')
}

async function dispatchWorker(companyId, options) {
  if (options.dispatch) return options.dispatch({ companyId })
  const base = options.siteUrl ?? process.env.URL
  const secret = options.internalCronSecret ?? process.env.INTERNAL_CRON_SECRET
  if (!base || !secret) throw new Error('Outbox dispatch is not configured')
  const url = new URL('/.netlify/functions/h2a-review-outbox-background', base)
  const response = await (options.fetch ?? fetch)(url.toString(), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Cron-Secret': secret }, body: JSON.stringify({ companyId }) })
  if (!response.ok) throw new Error('Outbox dispatch failed')
}

// The worker's dependencies: the same audited resolution path the workspace used directly.
export function outboxWorkerDeps(options, repository, companyId) {
  const makeClients = () => options.makeClients ? options.makeClients(companyId)
    : createH2AProviderClients({ companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
  const getResolutionClients = async (_company, config) => {
    const clients = await makeClients()
    if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission', { code: 'authorization_rejected' })
    return reviewResolutionProviderCapabilities(clients)
  }
  // Reads for queued creates (the shared Albi lists, each record's create checks) reuse one set of clients per run.
  let reads = null
  const readClients = () => (reads ??= repository.getConfig(companyId).then(config => getResolutionClients(companyId, config))
    .catch(error => { reads = null; throw error }))
  return { repository, now: options.now, clockMs: options.clockMs, sleep: options.sleep, paceMs: options.paceMs, budgetMs: options.budgetMs,
    dispatchResume: options.dispatchResume ?? (intent => defaultDispatchResume(intent, options)),
    dispatchContinuation: () => dispatchWorker(companyId, options),
    getResolutionClients,
    readAlbiList: async kind => {
      const clients = await readClients()
      return listAll(args => kind === 'organizations' ? clients.albiRead.listOrganizations(args) : clients.albiRead.listContacts(args))
    },
    // A "create with its default referral source" action: the record's own create checks and suggested source.
    loadCreateDefault: async item => {
      const row = await repository.getReview(companyId, item.review_id)
      if (!row) fail(404, 'Review item not found.')
      if (row.updated_at !== item.expected_updated_at) fail(409, 'This review changed.')
      if (Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length) return { ready: false, blockedReason: 'possible_match' }
      const loaded = await loadReviewResolutionOptions({ row: { ...row, company_id: companyId }, repository, reads: await readClients() })
      return loaded?.createReadiness ?? { ready: false, blockedReason: 'not_ready' }
    },
    // A sample contact's organization review is captured first, as the workspace's direct path does.
    prepareOrganization: async row => {
      if (row.review_kind === 'live') fail(409, 'Creating with the organization is not available for this record.')
      const prepared = await prepareOrganizationReview({ repository, options, companyId, input: { reviewId: row.review_id, expectedUpdatedAt: row.expected_updated_at } })
      const { sample } = await resolveReviewSample(repository, companyId)
      const organization = prepared.reviewId && sample ? await repository.getDryRunReview(companyId, sample.id, prepared.reviewId) : null
      if (!organization) fail(409, 'Creating with the organization is not available for this record.')
      return { organizationReviewId: organization.id, organizationExpectedUpdatedAt: organization.updated_at }
    } }
}

async function list(repository, companyId, kind) {
  const rows = await repository.listOutboxItems(companyId, kind)
  const items = rows.map(projectOutboxItem)
  const waiting = items.filter(item => item.status === 'queued')
  const pausedUntil = waiting.map(item => Date.parse(item.nextAttemptAt)).filter(time => Number.isFinite(time) && time > Date.now()).sort((a, b) => a - b)[0]
  return { items, summary: { queued: waiting.length, sending: items.filter(item => item.status === 'sending').length,
    failed: items.filter(item => item.status === 'failed').length,
    ...(pausedUntil && waiting.every(item => Date.parse(item.nextAttemptAt) > Date.now()) ? { pausedUntil: new Date(pausedUntil).toISOString() } : {}) } }
}

export function createOutboxHandler(options = {}, { background = false } = {}) {
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
      if (background) return reply(200, await runReviewOutbox(outboxWorkerDeps(options, repository, companyId), { companyId }))
      if (input.op === 'list') return reply(200, await list(repository, companyId, input.kind))
      const mode = resolutionMode((options.env ?? process.env).H2A_REVIEW_RESOLUTION_MODE)
      if (mode === 'disabled') fail(409, 'Review resolution is unavailable.')
      if (!canResolve({ mode, isAdmin: auth.role === 'admin', isSuperAdmin: auth.isSuperAdmin })) fail(403, 'Super administrator access is required.')
      if (input.op === 'enqueue') {
        const reviews = []
        for (const item of input.items) {
          const review = await repository.getReview(companyId, item.reviewId)
          if (!review || review.company_id !== companyId) fail(404, 'Review item not found.')
          reviews.push({ ...item, reviewKind: review.review_kind === 'live' ? 'live' : 'sample' })
        }
        const queued = await repository.enqueueOutboxItems(companyId, reviews, { actorId: auth.userId })
        for (const entry of queued) {
          if (entry.row?.status === 'queued' || entry.row?.status === 'sending') {
            try { await repository.setReviewTriage(companyId, entry.row.review_id, { bucket: 'outbox', details: { outbox: 'queued' } }) } catch { /* Advisory. */ }
          }
        }
        try { await dispatchWorker(companyId, options) } catch { /* The hourly job starts a worker for a queue left waiting. */ }
        return reply(202, { items: queued.map(entry => entry.row).filter(Boolean).map(row => ({ id: row.id, reviewId: row.review_id, status: row.status })) })
      }
      if (input.op === 'retry') {
        const retried = await repository.retryOutboxItems(companyId, input.ids)
        for (const row of retried) {
          try { await repository.setReviewTriage(companyId, row.review_id, { bucket: 'outbox', details: { outbox: 'queued' } }) } catch { /* Advisory. */ }
        }
        try { await dispatchWorker(companyId, options) } catch { /* The hourly job starts a worker. */ }
        return reply(200, { retried: retried.length })
      }
      const returned = await repository.cancelOutboxItems(companyId, input.ids)
      for (const row of returned) {
        try {
          const review = await repository.getReview(companyId, row.review_id)
          if (review) await refreshReviewTriage(repository, { companyId, row: review, force: true })
        } catch { /* Advisory: the next detail load or recheck buckets it. */ }
      }
      return reply(200, { returned: returned.length })
    } catch (error) {
      const typed = error instanceof H2AReviewError || error instanceof H2AAuthError
      return reply(typed ? error.statusCode : 500, { error: error instanceof H2AReviewError ? error.message
        : error instanceof H2AAuthError && (AUTH_MESSAGES.has(error.message) || background) ? error.message
          : event.httpMethod === 'GET' ? 'Unable to load the outbox.' : 'Unable to update the outbox.' })
    }
  }
}

export const handler = createOutboxHandler()
