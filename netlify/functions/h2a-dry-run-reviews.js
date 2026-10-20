import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { createH2AProviderClients, readOnlyH2ACapabilities } from './_h2a/providerClients.js'
import { H2AReviewError, createReviewRepositoryCapabilities, recheckDryRunReview, resolveReviewSample, reviewProgress } from './_h2a/reviewService.js'
import { createReviewReconciliationCapabilities, settleLiveReviewClose } from './_h2a/reviewResolutionService.js'
import { createLiveCloseCapabilities } from './_h2a/liveReview.js'
import { defaultDispatchResume } from './h2a-conflict-resolve.js'
import { REVIEW_REASONS, projectReviewRow, projectReviewEvent, safeReviewSnapshot } from './_h2a/review.js'
import { ApiError } from './_h2a/http.js'
import { currentResolutionProjection } from './h2a-dry-run-review-resolutions.js'
import { projectResolutionCapability } from './_h2a/resolutionCapability.js'
import { TRIAGE_BUCKETS, createTriageCapabilities, refreshReviewTriage } from './_h2a/triage.js'
import { prepareOrganizationReview } from './_h2a/organizationReview.js'
import { loadOrgFirstCreate, loadReviewResolutionOptions } from './_h2a/reviewResolutionOptions.js'
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
// Live merge following never captures a row: the survivor's live row appears when a sync reaches it.
export const LIVE_SURVIVOR_PENDING = 'The surviving record will appear here when the next sync reaches it.'
const emptyProgress = () => ({ total: 0, needsReview: 0, cleared: 0, noLongerInScope: 0, fullDryRunReady: false })
const isAdminAuth = auth => auth?.isSuperAdmin === true || auth?.role === 'admin'
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
  } else if (Object.keys(query).some(key => !['companyId', 'limit', 'cursor', 'status', 'objectType', 'reason', 'reviewId', 'kind', 'bucket'].includes(key))) fail(400, 'Unsupported query parameters.')
  const selectors = [query.companyId, body.companyId].filter(value => value !== undefined)
  if (selectors.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(selectors).size > 1) fail(400, 'A single company selector is required.')
  if (event.httpMethod === 'POST') return { companyId: selectors[0], ...body }
  if (query.reviewId !== undefined) {
    // A detail's kind comes from its stored row; an explicit kind is accepted but not trusted.
    if (!UUID.test(query.reviewId) || Object.keys(query).some(key => !['companyId', 'reviewId', 'kind'].includes(key)) ||
      query.kind !== undefined && !['sample', 'live'].includes(query.kind)) fail(400, 'Invalid sample review request.')
    return { companyId: selectors[0], reviewId: query.reviewId }
  }
  const limit = query.limit === undefined ? 25 : typeof query.limit === 'string' && /^\d{1,3}$/.test(query.limit) ? Number(query.limit) : NaN
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'Sample review page size must be between 1 and 100.')
  if (query.status !== undefined && !['needs_review', 'cleared', 'no_longer_in_scope'].includes(query.status) ||
    query.objectType !== undefined && !['contacts', 'companies'].includes(query.objectType) ||
    query.reason !== undefined && !REVIEW_REASONS.has(query.reason) ||
    query.kind !== undefined && !['sample', 'live'].includes(query.kind) ||
    query.bucket !== undefined && !TRIAGE_BUCKETS.includes(query.bucket)) fail(400, 'Unsupported sample review filters.')
  return { companyId: selectors[0], kind: query.kind ?? 'sample', filters: { limit, before: cursor(query.cursor), status: query.status ?? null,
    objectType: query.objectType ?? null, reason: query.reason ?? null, kind: query.kind ?? 'sample', bucket: query.bucket ?? null, includeCounts: true } }
}

// Read-only for members (Conflicts inspection): provider reads gate on canResolve, and the stored
// triage refresh is written only for an admin.
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
  // "Create organization and contact": advisory, so any failure or timeout simply leaves it unavailable.
  let orgFirstCreate = { eligible: false }
  if (resolutionCapability.canResolve && row.object_type === 'contacts' &&
    resolutionOptions.createReadiness?.blockedReason === 'organization_not_synced') {
    try {
      orgFirstCreate = await advisoryWithin(async () => {
        const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
          companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
        if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) return null
        return loadOrgFirstCreate({ row: { ...row, company_id: companyId }, readiness: resolutionOptions.createReadiness, repository,
          reads: readOnlyH2ACapabilities(clients) })
      }, Number.isFinite(options.detailDeadlineMs) ? Math.min(10000, Math.max(1, options.detailDeadlineMs)) : 5000) ?? orgFirstCreate
    } catch { orgFirstCreate = { eligible: false } }
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
        const merge = providerId(survivor) ? await survivorReview(repository, companyId, runId, row, survivor) : null
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
  // Detail knows the live create readiness and merge state, so refresh the stored bucket (written only when changed).
  const projectedRow = projectReviewRow(row, { detail: true, mappings: mappings ?? [] })
  const refreshed = isAdminAuth(auth) ? await refreshReviewTriage(repository, { companyId, row, resolutionStatus: projected.resolution?.status ?? null,
    createReadiness: resolutionCapability.canResolve ? resolutionOptions.createReadiness : undefined, mergedInto }) : null
  if (refreshed) { projectedRow.triageBucket = refreshed.bucket; projectedRow.triageDetails = refreshed.details }
  return { ...projectedRow, resolutionStatus: projected.resolution?.status ?? null,
    events: events.map(projectReviewEvent), resolution: projected.resolution,
    resolutionCapability, hubspotOrganizations, orgFirstCreate, ...(mergedInto ? { mergedInto } : {}), ...resolutionOptions }
}

// The review a merged-away source's survivor is handled in: for a live row, the survivor's one open
// live row (or a waiting message); for a sample row, its review in the same run.
async function survivorReview(repository, companyId, runId, row, survivor) {
  if (row.review_kind === 'live') {
    const open = await repository.findOpenLiveReviewBySource(companyId, row.portal_id, row.object_type, survivor)
    return open?.id ? { sourceId: survivor, reviewId: open.id } : { sourceId: survivor, reviewId: null, message: LIVE_SURVIVOR_PENDING }
  }
  return { sourceId: survivor, reviewId: (await repository.findDryRunReviewBySource?.(companyId, runId, row.object_type, survivor))?.id ?? null }
}

async function readClients(options, repository, companyId, config) {
  const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
    companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
  if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission')
  return clients
}

// "Review the surviving record" for a live row opens the survivor's open live row. There is no live
// prepare/capture path (live rows are only captured by sync), so without one the reply says so.
async function followLiveMergedSurvivor({ repository, options, companyId, input, row }) {
  const config = await repository.getConfig(companyId)
  if (!config?.portal_id || row.portal_id !== config.portal_id || !['contacts', 'companies'].includes(row.object_type)) fail(404, 'Sample review item not found.')
  if (row.updated_at !== input.expectedUpdatedAt) fail(409, 'This sample review changed. Refresh it first.')
  const clients = await readClients(options, repository, companyId, config)
  const survivor = typeof clients.hubspot.getMergedInto === 'function' ? await clients.hubspot.getMergedInto(row.object_type, row.source_id) : null
  if (!providerId(survivor)) fail(409, 'HubSpot does not list this record as merged into another one.')
  return survivorReview(repository, companyId, row.run_id, row, survivor)
}

// Captures (or finds) a review for the HubSpot record a merged-away source now points to, in the current run.
async function prepareMergedSurvivorReview({ repository, options, companyId, input }) {
  const stored = typeof repository.getReview === 'function' ? await repository.getReview(companyId, input.reviewId) : null
  if (stored?.review_kind === 'live') return followLiveMergedSurvivor({ repository, options, companyId, input, row: stored })
  const { config, sample } = await resolveReviewSample(repository, companyId)
  if (!sample) fail(409, 'Run a new sample to create detailed review data.')
  const row = await repository.getDryRunReview(companyId, sample.id, input.reviewId)
  if (!row) fail(404, 'Sample review item not found.')
  if (row.updated_at !== input.expectedUpdatedAt) fail(409, 'This sample review changed. Refresh it first.')
  const clients = await readClients(options, repository, companyId, config)
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

export function createDryRunReviewHandler(options = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return reply(200, {})
    if (!['GET', 'POST'].includes(event.httpMethod)) return reply(405, { error: 'Method not allowed.' })
    const isRecheck = event.httpMethod === 'POST'
    try {
      const input = request(event)
      // Live list and detail are member-readable, as the legacy conflicts GET was (Conflicts is
      // member-reachable). A detail's kind comes from its stored row, so admin is enforced below for
      // a sample detail. The sample list and every POST stay admin-only.
      const memberReadable = !isRecheck && (input.kind === 'live' || input.reviewId !== undefined)
      const auth = await (options.requireRequest ?? requireH2ARequest)(event, { supabase: options.supabase,
        getSupabase: options.getSupabase, requireAdmin: !memberReadable, requestedCompanyId: input.companyId })
      const admin = !memberReadable || isAdminAuth(auth)
      const repository = options.repository ?? createH2ARepository(auth.supabase)
      const companyId = auth.companyId
      if (isRecheck && input.prepareMergedSurvivor === true) {
        return reply(200, { survivor: await prepareMergedSurvivorReview({ repository, options, companyId, input }) })
      }
      if (isRecheck && input.prepareOrganization === true) {
        return reply(200, { organization: await prepareOrganizationReview({ repository, options, companyId, input }) })
      }
      if (isRecheck) {
        const resolutionRepository = ['getCurrentReviewResolution', 'claimReviewResolution', 'finishReviewResolution', 'getContactOrganizationChoice']
          .every(method => typeof repository[method] === 'function') ? createReviewReconciliationCapabilities(repository) : undefined
        const result = await recheckDryRunReview({ repository: createReviewRepositoryCapabilities(repository), resolutionRepository,
          triageRepository: createTriageCapabilities(repository),
          // Live rows close through the close RPC when a recheck finds them resolved or gone.
          liveCloseRepository: createLiveCloseCapabilities(repository),
          dispatchResume: options.dispatchResume ?? (intent => defaultDispatchResume(intent, options)),
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
        if (!result.sample) return reply(200, { item: await detail(repository, companyId, result.review.run_id, result.review, auth, options, result.config) })
        return reply(200, { item: await detail(repository, companyId, result.sample.id, result.review, auth, options, result.config),
          progress: await reviewProgress(repository, companyId, result.sample, result.config.initial_start_locked_at) })
      }
      if (input.reviewId) {
        const stored = typeof repository.getReview === 'function' ? await repository.getReview(companyId, input.reviewId) : null
        if (stored?.review_kind === 'live') {
          const config = await repository.getConfig(companyId)
          if (!config?.portal_id || stored.portal_id !== config.portal_id || !['contacts', 'companies'].includes(stored.object_type)) {
            fail(404, 'Sample review item not found.')
          }
          // A completed resolution whose close failed earlier is closed now (best effort; idempotent).
          // That is a write, so only an admin's load settles it; a member sees the row as stored.
          let row = stored
          if (admin) try {
            const settled = await settleLiveReviewClose({ repository,
              dispatchResume: options.dispatchResume ?? (intent => defaultDispatchResume(intent, options)) },
            { companyId, row: stored, actorId: auth.userId })
            if (settled?.review) row = settled.review
          } catch { /* The open row stays the retry marker for the next detail load or recheck. */ }
          return reply(200, { item: await detail(repository, companyId, row.run_id, row, auth, options, config) })
        }
        if (!admin) fail(403, 'Administrator access is required.')
      }
      if (input.kind === 'live') {
        // Live rows are scoped to the configured portal; without one there is nothing to list.
        const config = await repository.getConfig(companyId)
        if (!config?.portal_id) return reply(200, { items: [], nextCursor: null })
        const page = await repository.listDryRunReviews(companyId, null, { ...input.filters, portalId: config.portal_id })
        const resolutionStatuses = typeof repository.getCurrentReviewResolution === 'function'
          ? await Promise.all(page.items.map(async row => (await repository.getCurrentReviewResolution(companyId, row.id))?.status ?? null)) : []
        const last = page.items.at(-1)
        return reply(200, { items: page.items.map((row, index) => projectReviewRow({ ...row, resolution_status: resolutionStatuses[index] })),
          nextCursor: page.hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null,
          ...(page.bucketCounts ? { bucketCounts: page.bucketCounts } : {}) })
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
          ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null,
        ...(page.bucketCounts ? { bucketCounts: page.bucketCounts } : {}) })
    } catch (error) {
      const typed = error instanceof H2AReviewError || error instanceof H2AAuthError
      const fallback = isRecheck ? 'Unable to recheck this sample review.' : 'Unable to load sample reviews.'
      return reply(typed ? error.statusCode : 500, { error: error instanceof H2AReviewError ? error.message
        : error instanceof H2AAuthError && AUTH_MESSAGES.has(error.message) ? error.message : fallback })
    }
  }
}

export const handler = createDryRunReviewHandler()
