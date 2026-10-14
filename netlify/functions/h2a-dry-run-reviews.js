import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { createH2AProviderClients, readOnlyH2ACapabilities } from './_h2a/providerClients.js'
import { H2AReviewError, createReviewRepositoryCapabilities, recheckDryRunReview, resolveReviewSample, reviewProgress } from './_h2a/reviewService.js'
import { createReviewReconciliationCapabilities } from './_h2a/reviewResolutionService.js'
import { REVIEW_REASONS, projectReviewRow, projectReviewEvent } from './_h2a/review.js'
import { ApiError } from './_h2a/http.js'
import { currentResolutionProjection } from './h2a-dry-run-review-resolutions.js'
import { projectResolutionCapability } from './_h2a/resolutionCapability.js'
import { loadReviewResolutionOptions } from './_h2a/reviewResolutionOptions.js'
import { getH2AReviewReason } from '../../shared/h2aReviewReasons.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const validTime = value => typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10)
const fail = (status, message) => { throw new H2AReviewError(status, message) }
const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: JSON.stringify(body) })
const emptyProgress = () => ({ total: 0, needsReview: 0, cleared: 0, noLongerInScope: 0, fullDryRunReady: false })
const AUTH_MESSAGES = new Set(['Authentication required.', 'Invalid authentication token.', 'Administrator access is required.',
  'You are not authorized to access H2A.', 'You are not authorized to access the requested company.', 'A company must be selected.', 'Company not found.'])

function cursor(value) {
  if (value === undefined) return null
  const invalid = () => fail(400, 'Invalid sample review cursor.')
  if (typeof value !== 'string' || !value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid()
  let decoded
  try {
    const buffer = Buffer.from(value, 'base64url')
    if (buffer.toString('base64url') !== value) invalid()
    decoded = JSON.parse(buffer.toString('utf8'))
  } catch { invalid() }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).length !== 2 ||
    !validTime(decoded.createdAt) || typeof decoded.id !== 'string' || !UUID.test(decoded.id)) invalid()
  return { createdAt: decoded.createdAt, id: decoded.id }
}

function request(event) {
  const query = event.queryStringParameters ?? {}
  let body = {}
  if (event.httpMethod === 'POST') {
    try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body } catch { fail(400, 'Invalid request body.') }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['companyId', 'reviewId', 'expectedUpdatedAt'].includes(key))) fail(400, 'Unsupported request fields.')
    if (Object.keys(query).some(key => key !== 'companyId')) fail(400, 'Unsupported query parameters.')
    if (!UUID.test(body.reviewId ?? '') || !validTime(body.expectedUpdatedAt)) fail(400, 'Invalid sample review request.')
  } else if (Object.keys(query).some(key => !['companyId', 'limit', 'cursor', 'status', 'objectType', 'reason', 'reviewId'].includes(key))) fail(400, 'Unsupported query parameters.')
  const selectors = [query.companyId, body.companyId].filter(value => value !== undefined)
  if (selectors.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(selectors).size > 1) fail(400, 'A single company selector is required.')
  if (event.httpMethod === 'POST') return { companyId: selectors[0], ...body }
  if (query.reviewId !== undefined) {
    if (!UUID.test(query.reviewId) || Object.keys(query).some(key => !['companyId', 'reviewId'].includes(key))) fail(400, 'Invalid sample review request.')
    return { companyId: selectors[0], reviewId: query.reviewId }
  }
  const limit = query.limit === undefined ? 25 : typeof query.limit === 'string' && /^\d{1,3}$/.test(query.limit) ? Number(query.limit) : NaN
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'Sample review page size must be between 1 and 100.')
  if (query.status !== undefined && !['needs_review', 'cleared', 'no_longer_in_scope'].includes(query.status) ||
    query.objectType !== undefined && !['contacts', 'companies'].includes(query.objectType) ||
    query.reason !== undefined && !REVIEW_REASONS.has(query.reason)) fail(400, 'Unsupported sample review filters.')
  return { companyId: selectors[0], filters: { limit, before: cursor(query.cursor), status: query.status ?? null,
    objectType: query.objectType ?? null, reason: query.reason ?? null } }
}

async function detail(repository, companyId, runId, row, auth, options, config) {
  const events = await repository.listDryRunReviewEvents(companyId, runId, row.id)
  const projected = await currentResolutionProjection(repository, companyId, row.id, row.portal_id)
  const resolutionCapability = projectResolutionCapability(auth, (options.env ?? process.env).H2A_REVIEW_RESOLUTION_MODE, projected.hubspotWrites)
  const actions = getH2AReviewReason(row.reason).actions
  let resolutionOptions = { organizationOptions: [], createReadiness: { ready: false } }
  if (resolutionCapability.canResolve && row.status === 'needs_review' &&
    (actions.includes('choose_organization') || actions.includes('create_albi') && row.recheck_outcome === 'safe_to_create' &&
      Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length === 0)) {
    try {
      const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
        companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
      if (options.makeClients || (await clients.hubspot.getAccountInfo()).portalId === config.portal_id) {
        resolutionOptions = await loadReviewResolutionOptions({ row: { ...row, company_id: companyId }, repository,
          reads: readOnlyH2ACapabilities(clients) })
      }
    } catch { /* The chooser remains disabled when live evidence cannot be read. */ }
  }
  return { ...projectReviewRow(row, { detail: true }), events: events.map(projectReviewEvent), resolution: projected.resolution,
    resolutionCapability, ...resolutionOptions }
}

export function createDryRunReviewHandler(options = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return reply(200, {})
    if (!['GET', 'POST'].includes(event.httpMethod)) return reply(405, { error: 'Method not allowed.' })
    const isRecheck = event.httpMethod === 'POST'
    try {
      const input = request(event)
      const auth = await (options.requireRequest ?? requireH2ARequest)(event, { supabase: options.supabase,
        getSupabase: options.getSupabase, requireAdmin: true, requestedCompanyId: input.companyId })
      const repository = options.repository ?? createH2ARepository(auth.supabase)
      const companyId = auth.companyId
      if (isRecheck) {
        const resolutionRepository = ['getCurrentReviewResolution', 'claimReviewResolution', 'finishReviewResolution', 'getContactOrganizationChoice']
          .every(method => typeof repository[method] === 'function') ? createReviewReconciliationCapabilities(repository) : undefined
        const result = await recheckDryRunReview({ repository: createReviewRepositoryCapabilities(repository), resolutionRepository,
          now: options.now, clockMs: options.clockMs,
          sleep: options.sleep, deadlineMs: options.deadlineMs, getReadClients: async (_companyId, config, { signal }) => {
            const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
              companyId, repository, keyring: options.keyring, env: options.env, fetch: async (url, init) => {
                if (signal.aborted) throw new ApiError('transient', { code: 'timeout' })
                return (options.fetch ?? globalThis.fetch)(url, { ...init, signal: AbortSignal.any([signal, init.signal]) })
              },
            })
            // The production credential may have changed since preflight; verify the trusted portal before source reads.
            if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission')
            return readOnlyH2ACapabilities(clients)
          } }, { companyId, reviewId: input.reviewId, expectedUpdatedAt: input.expectedUpdatedAt, actorId: auth.userId })
        return reply(200, { item: await detail(repository, companyId, result.sample.id, result.review, auth, options, result.config),
          progress: await reviewProgress(repository, companyId, result.sample, result.config.initial_start_locked_at) })
      }
      const { config, latest, sample } = await resolveReviewSample(repository, companyId)
      if (input.reviewId) {
        if (!sample) fail(409, 'Run a new sample to create detailed review data.')
        const row = await repository.getDryRunReview(companyId, sample.id, input.reviewId)
        if (!row) fail(404, 'Sample review item not found.')
        return reply(200, { item: await detail(repository, companyId, sample.id, row, auth, options, config) })
      }
      const metadata = latest ? { id: latest.id, createdAt: latest.created_at, finishedAt: latest.finished_at,
        reviewCaptureVersion: latest.review_capture_version === 1 ? 1 : null, historical: latest.review_capture_version !== 1 } : null
      if (!sample) return reply(200, { sample: metadata, progress: emptyProgress(), items: [], nextCursor: null,
        ...(metadata?.historical ? { message: 'Run a new sample to create detailed review data.' } : {}) })
      const page = await repository.listDryRunReviews(companyId, sample.id, input.filters)
      const last = page.items.at(-1)
      return reply(200, { sample: metadata, progress: await reviewProgress(repository, companyId, sample, config.initial_start_locked_at),
        items: page.items.map(row => projectReviewRow(row)), nextCursor: page.hasMore && last
          ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null })
    } catch (error) {
      const typed = error instanceof H2AReviewError || error instanceof H2AAuthError
      const fallback = isRecheck ? 'Unable to recheck this sample review.' : 'Unable to load sample reviews.'
      return reply(typed ? error.statusCode : 500, { error: error instanceof H2AReviewError ? error.message
        : error instanceof H2AAuthError && AUTH_MESSAGES.has(error.message) ? error.message : fallback })
    }
  }
}

export const handler = createDryRunReviewHandler()
