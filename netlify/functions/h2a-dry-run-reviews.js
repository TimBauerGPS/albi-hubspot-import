import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { createH2AProviderClients, readOnlyH2ACapabilities } from './_h2a/providerClients.js'
import { H2AReviewError, createReviewRepositoryCapabilities, recheckDryRunReview, resolveReviewSample, reviewProgress } from './_h2a/reviewService.js'
import { createReviewReconciliationCapabilities } from './_h2a/reviewResolutionService.js'
import { REVIEW_REASONS, projectReviewRow, projectReviewEvent, safeReviewSnapshot } from './_h2a/review.js'
import { ApiError } from './_h2a/http.js'
import { currentResolutionProjection } from './h2a-dry-run-review-resolutions.js'
import { projectResolutionCapability } from './_h2a/resolutionCapability.js'
import { loadReviewResolutionOptions } from './_h2a/reviewResolutionOptions.js'
import { getH2AReviewActions } from '../../shared/h2aReviewReasons.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const validTime = value => typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10)
const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const fail = (status, message) => { throw new H2AReviewError(status, message) }
const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: JSON.stringify(body) })
const emptyProgress = () => ({ total: 0, needsReview: 0, cleared: 0, noLongerInScope: 0, fullDryRunReady: false })
const AUTH_MESSAGES = new Set(['Authentication required.', 'Invalid authentication token.', 'Administrator access is required.',
  'You are not authorized to access H2A.', 'You are not authorized to access the requested company.', 'A company must be selected.', 'Company not found.'])

async function advisoryWithin(call, timeoutMs) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(call), new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

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
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['companyId', 'reviewId', 'expectedUpdatedAt', 'prepareOrganization', 'prepareMergedSurvivor'].includes(key))) fail(400, 'Unsupported request fields.')
    if (Object.hasOwn(body, 'prepareMergedSurvivor') && body.prepareMergedSurvivor !== true) fail(400, 'Invalid sample review request.')
    if (Object.hasOwn(body, 'prepareOrganization') && body.prepareOrganization !== true) fail(400, 'Invalid sample review request.')
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
  const actions = getH2AReviewActions(row.reason, row.object_type)
  let resolutionOptions = { organizationOptions: [], createReadiness: { ready: false }, forceCreateReadiness: { eligible: false, ready: false } }
  if (resolutionCapability.canResolve && (row.status === 'needs_review' || row.status === 'cleared' && row.recheck_outcome === 'safe_to_create') &&
    (actions.includes('choose_organization') || actions.includes('create_albi') &&
      Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length === 0 ||
      actions.includes('force_create_albi') && Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length > 0)) {
    try {
      const timeoutMs = Number.isFinite(options.detailDeadlineMs)
        ? Math.min(10000, Math.max(1, options.detailDeadlineMs)) : 5000
      const loaded = await advisoryWithin(async () => {
        const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
          companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
        const optionsPromise = loadReviewResolutionOptions({ row: { ...row, company_id: companyId }, repository,
          reads: readOnlyH2ACapabilities(clients) })
        if (options.makeClients) return optionsPromise
        const [account, loadedOptions] = await Promise.all([clients.hubspot.getAccountInfo(), optionsPromise])
        return account.portalId === config.portal_id ? loadedOptions : null
      }, timeoutMs)
      if (loaded) resolutionOptions = loaded
    } catch { /* The chooser remains disabled when live evidence cannot be read. */ }
  }
  // Live association names (the contact's own snapshot only carries a free-text company property).
  // null means unknown, [] means HubSpot has none.
  let hubspotOrganizations = null, mergedInto = null
  if (resolutionCapability.canResolve) {
    try {
      const loaded = await advisoryWithin(async () => {
        const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
          companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
        if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) return null
        // HubSpot merges move a record to a new ID; follow it so the survivor's data is shown.
        const survivor = typeof clients.hubspot.getMergedInto === 'function' ? await clients.hubspot.getMergedInto(row.object_type, row.source_id) : null
        const merge = providerId(survivor) ? { sourceId: survivor,
          reviewId: (await repository.findDryRunReviewBySource?.(companyId, runId, row.object_type, survivor))?.id ?? null } : null
        if (row.object_type !== 'contacts') return { organizations: null, merge }
        const contactId = merge?.sourceId ?? row.source_id
        const associations = await clients.hubspot.getAssociations({ objectType: 'contacts', objectIds: [contactId], toObjectTypes: ['companies'] })
        if (!Array.isArray(associations) || associations.length !== 1 || associations[0]?.fromId !== contactId ||
          associations[0]?.toObjectType !== 'companies' || !Array.isArray(associations[0].toIds)) return { organizations: null, merge }
        const found = []
        for (const sourceId of [...new Set(associations[0].toIds)].filter(providerId).slice(0, 5)) {
          const companies = await clients.hubspot.getCompanies([sourceId])
          const company = Array.isArray(companies) && companies.length === 1 && companies[0]?.id === sourceId && companies[0]?.archived !== true ? companies[0] : null
          const name = typeof company?.properties?.name === 'string' ? company.properties.name.trim().slice(0, 200) : ''
          found.push({ sourceId, name: name || 'Unnamed organization' })
        }
        return { organizations: found, merge }
      }, Number.isFinite(options.detailDeadlineMs) ? Math.min(10000, Math.max(1, options.detailDeadlineMs)) : 5000)
      hubspotOrganizations = loaded?.organizations ?? null
      mergedInto = loaded?.merge ?? null
    } catch { hubspotOrganizations = null }
  }
  const mappings = row.candidate_snapshots?.length ? await repository.getMappings(companyId).catch(() => null) : null
  return { ...projectReviewRow(row, { detail: true, mappings: mappings ?? [] }), resolutionStatus: projected.resolution?.status ?? null,
    events: events.map(projectReviewEvent), resolution: projected.resolution,
    resolutionCapability, hubspotOrganizations, ...(mergedInto ? { mergedInto } : {}), ...resolutionOptions }
}

// Captures (or finds) a review for the HubSpot record a merged-away source now points to, in the current run.
async function prepareMergedSurvivorReview({ repository, options, companyId, input }) {
  const { config, sample } = await resolveReviewSample(repository, companyId)
  if (!sample) fail(409, 'Run a new sample to create detailed review data.')
  const row = await repository.getDryRunReview(companyId, sample.id, input.reviewId)
  if (!row) fail(404, 'Sample review item not found.')
  if (row.updated_at !== input.expectedUpdatedAt) fail(409, 'This sample review changed. Refresh it first.')
  const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
    companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
  if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission')
  const survivor = typeof clients.hubspot.getMergedInto === 'function' ? await clients.hubspot.getMergedInto(row.object_type, row.source_id) : null
  if (!providerId(survivor)) fail(409, 'HubSpot does not list this record as merged into another one.')
  const existing = await repository.findDryRunReviewBySource(companyId, sample.id, row.object_type, survivor)
  if (existing) return { sourceId: survivor, reviewId: existing.id }
  const record = row.object_type === 'contacts' ? await clients.hubspot.getContact(survivor) : await clients.hubspot.getCompany(survivor)
  if (!record || record.id !== survivor || record.archived === true) fail(409, 'The surviving HubSpot record is not available.')
  const created = await repository.recordDryRunReview(companyId, { run_id: sample.id, portal_id: row.portal_id, object_type: row.object_type,
    source_id: survivor, reason: 'no_match', conflict_type: row.object_type === 'contacts' ? 'contact_match' : 'organization_match',
    source_snapshot: safeReviewSnapshot(record, row.object_type), candidate_snapshots: [], match_evidence: { evidence: [] }, proposed_changes: {} })
  return { sourceId: survivor, reviewId: created.id }
}

// Captures (or finds) the review for a contact's one unmapped organization so it can be created and
// audited on its own. Reads HubSpot only; the Albi create is a separate resolution on that review.
async function prepareOrganizationReview({ repository, options, auth, companyId, input }) {
  const { config, sample } = await resolveReviewSample(repository, companyId)
  if (!sample) fail(409, 'Run a new sample to create detailed review data.')
  const row = await repository.getDryRunReview(companyId, sample.id, input.reviewId)
  if (!row) fail(404, 'Sample review item not found.')
  if (row.object_type !== 'contacts' || row.updated_at !== input.expectedUpdatedAt ||
    !(row.status === 'needs_review' || row.status === 'cleared' && row.recheck_outcome === 'safe_to_create')) {
    fail(409, 'This sample review changed. Refresh it before preparing the organization.')
  }
  const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
    companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
  if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission')
  const hubspotRead = { getAssociations: args => clients.hubspot.getAssociations(args), getCompanies: ids => clients.hubspot.getCompanies(ids) }
  const associations = await hubspotRead.getAssociations({ objectType: 'contacts', objectIds: [row.source_id], toObjectTypes: ['companies'] })
  const toIds = Array.isArray(associations) && associations.length === 1 && associations[0]?.fromId === row.source_id &&
    associations[0]?.toObjectType === 'companies' && Array.isArray(associations[0].toIds) ? [...new Set(associations[0].toIds)] : null
  if (!toIds || toIds.length !== 1 || !providerId(toIds[0])) fail(409, 'This contact needs exactly one associated organization.')
  const [sourceId] = toIds
  const mappings = await repository.getMappings(companyId)
  const mapped = (mappings?.organizations ?? []).some(item => item?.portal_id === row.portal_id && item?.hubspot_id === sourceId)
  const existing = await repository.findDryRunReviewBySource(companyId, sample.id, 'companies', sourceId)
  if (mapped || existing) return { sourceId, reviewId: existing?.id ?? null, mapped }
  const companies = await hubspotRead.getCompanies([sourceId])
  if (!Array.isArray(companies) || companies.length !== 1 || companies[0]?.id !== sourceId || companies[0]?.archived === true ||
    !companies[0]?.properties || typeof companies[0].properties !== 'object') fail(409, 'The associated organization is no longer available in HubSpot.')
  const created = await repository.recordDryRunReview(companyId, { run_id: sample.id, portal_id: row.portal_id, object_type: 'companies',
    source_id: sourceId, reason: 'no_match', conflict_type: 'organization_match',
    source_snapshot: safeReviewSnapshot(companies[0], 'companies'), candidate_snapshots: [], match_evidence: { evidence: [] }, proposed_changes: {} })
  return { sourceId, reviewId: created.id, mapped: false }
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
      if (isRecheck && input.prepareMergedSurvivor === true) {
        return reply(200, { survivor: await prepareMergedSurvivorReview({ repository, options, companyId, input }) })
      }
      if (isRecheck && input.prepareOrganization === true) {
        return reply(200, { organization: await prepareOrganizationReview({ repository, options, auth, companyId, input }) })
      }
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
      const resolutionStatuses = typeof repository.getCurrentReviewResolution === 'function'
        ? await Promise.all(page.items.map(async row => {
          const resolution = await repository.getCurrentReviewResolution(companyId, row.id)
          return resolution?.run_id === sample.id || resolution?.run_id === undefined ? resolution?.status : null
        })) : []
      const last = page.items.at(-1)
      return reply(200, { sample: metadata, progress: await reviewProgress(repository, companyId, sample, config.initial_start_locked_at),
        items: page.items.map((row, index) => projectReviewRow({ ...row, resolution_status: resolutionStatuses[index] })), nextCursor: page.hasMore && last
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
