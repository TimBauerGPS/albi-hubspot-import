import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { createH2AProviderClients, reviewResolutionProviderCapabilities } from './_h2a/providerClients.js'
import { H2AReviewError, resolveReviewSample } from './_h2a/reviewService.js'
import { executeReviewResolution, executeOrganizationThenContactCreate } from './_h2a/reviewResolutionService.js'
import { normalizeResolutionDecision, projectReviewResolution } from './_h2a/reviewResolution.js'
import { canResolve, resolutionMode, hubspotWriteReadiness, projectResolutionCapability, WRITE_AUTH_REJECTION_MESSAGE } from './_h2a/resolutionCapability.js'
import { ApiError, isRecord } from './_h2a/http.js'
import { prepareOrganizationReview } from './_h2a/organizationReview.js'
import { defaultDispatchResume } from './h2a-conflict-resolve.js'

export { canResolve } from './_h2a/resolutionCapability.js'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const validTime = value => typeof value === 'string' && TIME.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10)
const fail = (status, message) => { throw new H2AReviewError(status, message) }
const AUTH_MESSAGES = new Set(['Authentication required.', 'Invalid authentication token.', 'Administrator access is required.',
  'You are not authorized to access H2A.', 'You are not authorized to access the requested company.', 'A company must be selected.', 'Company not found.'])
const SAFE_MESSAGES = new Set(['Invalid request body.', 'Unsupported request fields.', 'Unsupported query parameters.',
  'A single company selector is required.', 'Invalid resolution request.', 'Invalid resolution decision.',
  'Review resolution is unavailable.', 'Administrator access is required.', 'Super administrator access is required.',
  'Sample review item not found.', 'Run a new sample to create detailed review data.', 'Review item not found.',
  'Skip is only available for live reviews.', 'Creating with the organization is not available for this record.'])
const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: JSON.stringify(body) })

function request(event) {
  const query = event.queryStringParameters ?? {}
  let body = {}
  if (event.httpMethod === 'POST') {
    try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body } catch { fail(400, 'Invalid request body.') }
    if (!isRecord(body)) fail(400, 'Invalid request body.')
    if (Object.keys(query).some(key => key !== 'companyId')) fail(400, 'Unsupported query parameters.')
  } else if (Object.keys(query).some(key => !['companyId', 'reviewId'].includes(key))) fail(400, 'Unsupported query parameters.')
  const selectors = [query.companyId, body.companyId].filter(value => value !== undefined)
  if (selectors.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(selectors).size > 1) fail(400, 'A single company selector is required.')
  const input = event.httpMethod === 'POST' ? body : query
  if (typeof input.reviewId !== 'string' || !UUID.test(input.reviewId)) fail(400, 'Invalid resolution request.')
  if (event.httpMethod === 'GET') return { companyId: selectors[0], reviewId: input.reviewId }
  if (typeof body.clientRequestId !== 'string' || !UUID.test(body.clientRequestId) || !validTime(body.expectedUpdatedAt)) fail(400, 'Invalid resolution request.')
  if (body.op === 'create_with_organization') {
    const { companyId, reviewId, expectedUpdatedAt, clientRequestId, op, organizationReviewId, organizationExpectedUpdatedAt, referralSourceId, ...extra } = body
    if (Object.keys(extra).length) fail(400, 'Unsupported request fields.')
    try { normalizeResolutionDecision({ action: 'create_albi', referralSourceId }) } catch { fail(400, 'Invalid resolution decision.') }
    if (referralSourceId === undefined || organizationReviewId !== undefined && (typeof organizationReviewId !== 'string' || !UUID.test(organizationReviewId)) ||
      organizationReviewId !== undefined && !validTime(organizationExpectedUpdatedAt) ||
      organizationReviewId === undefined && organizationExpectedUpdatedAt !== undefined) fail(400, 'Invalid resolution request.')
    return { companyId: selectors[0], reviewId, expectedUpdatedAt, clientRequestId, orgFirst: { organizationReviewId, organizationExpectedUpdatedAt, referralSourceId } }
  }
  const { companyId, reviewId, expectedUpdatedAt, clientRequestId, ...decisionInput } = body
  let decision
  try { decision = normalizeResolutionDecision(decisionInput) } catch { fail(400, 'Invalid resolution decision.') }
  return { companyId: selectors[0], reviewId, expectedUpdatedAt, clientRequestId, decision }
}

export async function currentResolutionProjection(repository, companyId, reviewId, portalId) {
  const row = typeof repository.getCurrentReviewResolution === 'function' ? await repository.getCurrentReviewResolution(companyId, reviewId) : null
  if (!row) return { resolution: null, hubspotWrites: 'verified_when_first_used' }
  if (row.company_id !== companyId || row.portal_id !== portalId) throw Error('Invalid resolution context')
  const events = await repository.listReviewResolutionEvents(companyId, row.id)
  if (!Array.isArray(events)) throw Error('Invalid resolution events')
  const credentials = typeof repository.getCredentials === 'function' ? await repository.getCredentials(companyId) : null
  return { resolution: projectReviewResolution(row, events), hubspotWrites: hubspotWriteReadiness(row, events, credentials?.updated_at) }
}

export function createReviewResolutionHandler(options = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return reply(200, {})
    if (!['GET', 'POST'].includes(event.httpMethod)) return reply(405, { error: 'Method not allowed.' })
    const isWrite = event.httpMethod === 'POST'
    try {
      const input = request(event)
      const auth = await (options.requireRequest ?? requireH2ARequest)(event, { supabase: options.supabase,
        getSupabase: options.getSupabase, requireAdmin: isWrite, requireAppAccess: true, requestedCompanyId: input.companyId })
      const mode = resolutionMode((options.env ?? process.env).H2A_REVIEW_RESOLUTION_MODE)
      if (isWrite) {
        if (auth.role !== 'admin' && !auth.isSuperAdmin) fail(403, 'Administrator access is required.')
        if (mode === 'disabled') fail(409, 'Review resolution is unavailable.')
        if (!canResolve({ mode, isAdmin: auth.role === 'admin', isSuperAdmin: auth.isSuperAdmin })) fail(403, 'Super administrator access is required.')
      }
      const repository = options.repository ?? createH2ARepository(auth.supabase)
      const companyId = auth.companyId
      const resolutionDeps = () => ({ repository,
          now: options.now, clockMs: options.clockMs, deadlineMs: options.deadlineMs,
          dispatchResume: options.dispatchResume ?? (intent => defaultDispatchResume(intent, options)),
          getResolutionClients: async (_company, config) => {
            const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
              companyId, repository, env: options.env, keyring: options.keyring, fetch: options.fetch })
            if ((await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission', { code: 'authorization_rejected' })
            return reviewResolutionProviderCapabilities(clients)
          } })
      if (isWrite && input.orgFirst) {
        let { organizationReviewId, organizationExpectedUpdatedAt } = input.orgFirst
        if (!organizationReviewId) {
          // Sample rows only: capture the organization's own review through the existing prepare path.
          const contact = await repository.getReview?.(companyId, input.reviewId)
          if (contact?.review_kind === 'live') fail(409, 'Creating with the organization is not available for this record.')
          const prepared = await prepareOrganizationReview({ repository, options, companyId,
            input: { reviewId: input.reviewId, expectedUpdatedAt: input.expectedUpdatedAt } })
          const { sample } = await resolveReviewSample(repository, companyId)
          const organizationRow = prepared.reviewId && sample ? await repository.getDryRunReview(companyId, sample.id, prepared.reviewId) : null
          if (!organizationRow) fail(409, 'Creating with the organization is not available for this record.')
          organizationReviewId = organizationRow.id
          organizationExpectedUpdatedAt = organizationRow.updated_at
        }
        const result = await (options.executeOrganizationFirst ?? executeOrganizationThenContactCreate)(resolutionDeps(), { companyId,
          actorId: auth.userId, contactReviewId: input.reviewId, contactExpectedUpdatedAt: input.expectedUpdatedAt,
          organizationReviewId, organizationExpectedUpdatedAt, referralSourceId: input.orgFirst.referralSourceId,
          clientRequestId: input.clientRequestId })
        if (result?.organization?.error) throw result.organization.error
        const credentials = typeof repository.getCredentials === 'function' ? await repository.getCredentials(companyId) : null
        const project = async step => {
          if (!step) return null
          // The organization already exists; the contact error is reported beside it so a retry resumes the contact.
          if (step.error) return { error: SAFE_MESSAGES.has(step.error.message) ? step.error.message
            : 'The contact could not be created. Retry to continue with the organization already created.',
          status: [400, 403, 404, 409].includes(step.error.statusCode) ? step.error.statusCode : 500 }
          if (!isRecord(step.resolution) || step.resolution.company_id !== companyId) throw Error('Invalid resolution result')
          const events = await repository.listReviewResolutionEvents(companyId, step.resolution.id)
          if (!Array.isArray(events)) throw Error('Invalid resolution events')
          return { resolution: projectReviewResolution(step.resolution, events),
            resolutionCapability: projectResolutionCapability(auth, mode, hubspotWriteReadiness(step.resolution, events, credentials?.updated_at)) }
        }
        return reply(200, { organization: await project(result.organization), contact: await project(result.contact) })
      }
      if (isWrite) {
        const result = await (options.executeResolution ?? executeReviewResolution)(resolutionDeps(), { companyId, reviewId: input.reviewId, expectedUpdatedAt: input.expectedUpdatedAt,
          clientRequestId: input.clientRequestId, decision: input.decision, actorId: auth.userId })
        if (!isRecord(result?.resolution) || result.resolution.company_id !== companyId) throw Error('Invalid resolution result')
        const events = await repository.listReviewResolutionEvents(companyId, result.resolution.id)
        if (!Array.isArray(events)) throw Error('Invalid resolution events')
        const credentials = typeof repository.getCredentials === 'function' ? await repository.getCredentials(companyId) : null
        return reply(200, { resolution: projectReviewResolution(result.resolution, events),
          resolutionCapability: projectResolutionCapability(auth, mode, hubspotWriteReadiness(result.resolution, events, credentials?.updated_at)),
          ...(result.resolution.provider_outcome_code === 'authorization_rejected' ? { message: WRITE_AUTH_REJECTION_MESSAGE } : {}) })
      }
      // Kind comes from the stored row: a live row is read without the sample gate.
      const live = typeof repository.getReview === 'function' ? await repository.getReview(companyId, input.reviewId) : null
      let config
      if (live?.review_kind === 'live') {
        config = await repository.getConfig(companyId)
        if (!config?.portal_id || live.portal_id !== config.portal_id) fail(404, 'Review item not found.')
      } else {
        const resolved = await resolveReviewSample(repository, companyId)
        config = resolved.config
        if (!resolved.sample) fail(409, 'Run a new sample to create detailed review data.')
        const row = await repository.getDryRunReview(companyId, resolved.sample.id, input.reviewId)
        if (!row) fail(404, 'Sample review item not found.')
      }
      const projected = await currentResolutionProjection(repository, companyId, input.reviewId, config.portal_id)
      return reply(200, { resolution: projected.resolution, resolutionCapability: projectResolutionCapability(auth, mode, projected.hubspotWrites),
        ...(projected.resolution?.providerOutcomeCode === 'authorization_rejected' ? { message: WRITE_AUTH_REJECTION_MESSAGE } : {}) })
    } catch (error) {
      const fallback = 'Unable to resolve this sample review.'
      if (error instanceof H2AAuthError) return reply(error.statusCode >= 500 ? 500 : error.statusCode,
        { error: AUTH_MESSAGES.has(error.message) ? error.message : fallback })
      if (error instanceof TypeError) return reply(400, { error: 'Invalid resolution decision.' })
      if (error instanceof H2AReviewError) return reply([400, 403, 404, 409].includes(error.statusCode) ? error.statusCode : 500,
        { error: SAFE_MESSAGES.has(error.message) ? error.message : error.statusCode === 409
          ? 'This sample review changed. Refresh and confirm the resolution again.' : error.statusCode === 400 ? 'Invalid resolution decision.' : fallback })
      return reply(500, { error: fallback })
    }
  }
}

export const handler = createReviewResolutionHandler()
