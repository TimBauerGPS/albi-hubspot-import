import { buildResolutionRequest } from '../features/hubspotToAlbi/sampleReviewResolution.js'

const FUNCTION_BASE = '/.netlify/functions'
const SAFE_ERROR_CODES = Object.freeze({
  DUPLICATE_OPTION_MAPPING: 'Duplicate option mapping.',
  INVALID_CONFLICT_CURSOR: 'Invalid conflict cursor.',
  INVALID_CONFLICT_PAGE_SIZE: 'Invalid conflict page size.',
  INVALID_OPTION_MAPPING: 'Invalid option mapping.',
  INVALID_OPTION_MAPPING_SOURCE: 'Invalid option mapping source.',
})
const SAFE_SERVER_MESSAGES = Object.freeze({
  'Invalid resolution request.': 'Invalid resolution request.',
  'Invalid resolution decision.': 'Invalid resolution decision.',
  'Review resolution is unavailable.': 'Review resolution is unavailable.',
  'Super administrator access is required.': 'Super administrator access is required.',
  'This sample review changed. Refresh and confirm the resolution again.': 'This sample review changed. Refresh and confirm the resolution again.',
  'This record changed. Refresh and confirm the resolution again.': 'This record changed. Refresh and confirm the resolution again.',
  'Unable to resolve this sample review.': 'Unable to resolve this sample review.',
  'A dry run is required before live activation.': 'A dry run is required before live activation.',
  'A completed dry run is required before live activation.': 'A completed dry run is required before live activation.',
  'A conflict ID is required.': 'A conflict ID is required.',
  'A conflict resolution is required.': 'A conflict resolution is required.',
  'A company must be selected.': 'A company must be selected.',
  'A settings action is required.': 'A settings action is required.',
  'A single company selector is required.': 'A single company selector is required.',
  'A valid company is required.': 'A valid company is required.',
  'Backfill requires a date earlier than the fixed initial start date.': 'Backfill requires a date earlier than the fixed initial start date.',
  'Conflict not found.': 'Conflict not found.',
  'Conflict page size must be between 1 and 100.': 'Conflict page size must be between 1 and 100.',
  'Company ID is required.': 'Company ID is required.',
  'Choose a sample or full dry run.': 'Choose a sample or full dry run.',
  'Run a fresh sample with no underlying review items before running the full dry run.': 'Run a fresh sample with no underlying review items before running the full dry run.',
  'Complete option mappings are required.': 'Complete option mappings are required.',
  'Confirm contact and organization defaults and every activity type.': 'Confirm contact and organization defaults and every activity type.',
  'Disable live sync before starting a dry run.': 'Disable live sync before starting a dry run.',
  'Duplicate option mapping.': 'Duplicate option mapping.',
  'H2A configuration is not ready for this run.': 'H2A configuration is not ready for this run.',
  'H2A settings are changing. Run preflight again shortly.': 'H2A settings are changing. Run preflight again shortly.',
  'Invalid conflict cursor.': 'Invalid conflict cursor.',
  'Invalid conflict page size.': 'Invalid conflict page size.',
  'Invalid overview cursor.': 'Invalid overview cursor.',
  'Invalid overview page size.': 'Invalid overview page size.',
  'Invalid conflict resolution payload.': 'Invalid conflict resolution payload.',
  'Invalid option mapping source.': 'Invalid option mapping source.',
  'Invalid option mapping.': 'Invalid option mapping.',
  'Invalid request body.': 'Invalid request body.',
  'Invalid sample review cursor.': 'Invalid sample review cursor.',
  'Invalid sample review request.': 'Invalid sample review request.',
  'Unable to start rechecking all reviews.': 'Unable to start rechecking all reviews.',
  'Invalid recheck request.': 'Invalid recheck request.',
  'Resolve this in the review workspace.': 'Resolve this in the review workspace.',
  'Unable to prepare open conflicts for review.': 'Unable to prepare open conflicts for review.',
  'Review item not found.': 'Review item not found.',
  'This review changed. Refresh it before rechecking.': 'This review changed. Refresh it before rechecking.',
  'Unable to recheck this review.': 'Unable to recheck this review.',
  'Skip is only available for live reviews.': 'Skip is only available for live reviews.',
  'Creating with the organization is not available for this record.': 'Creating with the organization is not available for this record.',
  'Unable to load recheck progress.': 'Unable to load recheck progress.',
  'Invalid sync mode.': 'Invalid sync mode.',
  'Linking requires an explicit target ID.': 'Linking requires an explicit target ID.',
  'Many-to-one approval must be boolean.': 'Many-to-one approval must be boolean.',
  'Manual runs cannot resume or select a trigger.': 'Manual runs cannot resume or select a trigger.',
  'Notification recipients must be valid email addresses (up to 20).': 'Notification recipients must be valid email addresses (up to 20).',
  'Overview page size must be between 1 and 100.': 'Overview page size must be between 1 and 100.',
  'Option mappings must use IDs from the latest tenant preflight options.': 'Option mappings must use IDs from the latest tenant preflight options.',
  'Resume requires a run ID.': 'Resume requires a run ID.',
  'Resolution was saved; its targeted resume remains pending for retry.': 'Resolution was saved; its targeted resume remains pending for retry.',
  'Save H2A credentials in Settings before running preflight.': 'Save H2A credentials in Settings before running preflight.',
  'Save H2A credentials in Settings first.': 'Save H2A credentials in Settings first.',
  'Settings changed concurrently. Reload and try again.': 'Settings changed concurrently. Reload and try again.',
  'Settings changed during preflight. Run preflight again.': 'Settings changed during preflight. Run preflight again.',
  'Settings changed while credentials were being replaced. Reload and try again.': 'Settings changed while credentials were being replaced. Reload and try again.',
  'Start date must be a valid Pacific date no later than today.': 'Start date must be a valid Pacific date no later than today.',
  'Start date must be a valid YYYY-MM-DD calendar date.': 'Start date must be a valid YYYY-MM-DD calendar date.',
  'Start date must be a valid YYYY-MM-DD date no later than today.': 'Start date must be a valid YYYY-MM-DD date no later than today.',
  'Supply both initial credentials or a nonempty replacement.': 'Supply both initial credentials or a nonempty replacement.',
  'Select valid fields for this conflict action.': 'Select valid fields for this conflict action.',
  'The initial start date is fixed and cannot move forward.': 'The initial start date is fixed and cannot move forward.',
  'This conflict cannot use that resolution action.': 'This conflict cannot use that resolution action.',
  'This conflict changed or is no longer open. Refresh it before resolving.': 'This conflict changed or is no longer open. Refresh it before resolving.',
  'This conflict is no longer open.': 'This conflict is no longer open.',
  'This source is already mapped to a different target.': 'This source is already mapped to a different target.',
  'This target is already mapped. Explicit many-to-one approval is required.': 'This target is already mapped. Explicit many-to-one approval is required.',
  'Unsupported conflict action.': 'Unsupported conflict action.',
  'Unsupported conflict resolution fields.': 'Unsupported conflict resolution fields.',
  'Unsupported query parameters.': 'Unsupported query parameters.',
  'Unsupported request fields.': 'Unsupported request fields.',
  'Unsupported sample review filters.': 'Unsupported sample review filters.',
  'Unsupported settings action.': 'Unsupported settings action.',
  'Unsupported settings fields.': 'Unsupported settings fields.',
  'Use request_earlier_backfill for an earlier date.': 'Use request_earlier_backfill for an earlier date.',
  'Valid credentials, successful preflight, and confirmed option mappings are required.': 'Valid credentials, successful preflight, and confirmed option mappings are required.',
  'Administrator access is required.': 'Administrator access is required.',
  'Authentication required.': 'Authentication required.',
  'Company not found.': 'Company not found.',
  'Invalid authentication token.': 'Invalid authentication token.',
  'Run a new sample to create detailed review data.': 'Run a new sample to create detailed review data.',
  'Sample review item not found.': 'Sample review item not found.',
  'Sample review page size must be between 1 and 100.': 'Sample review page size must be between 1 and 100.',
  'This sample review changed. Refresh it before rechecking.': 'This sample review changed. Refresh it before rechecking.',
  'This sample review is no longer current. Refresh before rechecking.': 'This sample review is no longer current. Refresh before rechecking.',
  'Unable to load sample reviews.': 'Unable to load sample reviews.',
  'Unable to recheck this sample review.': 'Unable to recheck this sample review.',
  'You are not authorized to access H2A.': 'You are not authorized to access H2A.',
  'You are not authorized to access the requested company.': 'You are not authorized to access the requested company.',
})
const SAFE_STATUS_MESSAGES = Object.freeze({
  400: 'HubSpot to Albi request could not be completed.',
  401: 'Your session has expired. Sign in and try again.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested HubSpot to Albi resource was not found.',
  409: 'HubSpot to Albi changed while you were working. Reload and try again.',
  429: 'HubSpot to Albi is busy. Try again shortly.',
  500: 'HubSpot to Albi is temporarily unavailable. Try again.',
  502: 'HubSpot to Albi is temporarily unavailable. Try again.',
  503: 'HubSpot to Albi is temporarily unavailable. Try again.',
  504: 'HubSpot to Albi is temporarily unavailable. Try again.',
})
const FALLBACK_ERROR_MESSAGE = 'HubSpot to Albi request could not be completed.'

export class H2ARequestError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'H2ARequestError'
    this.status = status
  }
}

function sessionToken(session) {
  const token = session?.access_token
  if (typeof token !== 'string' || !token.trim()) {
    throw new H2ARequestError('Your session has expired. Sign in and try again.', 401)
  }
  return token
}

function withoutNullish(values = {}) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== ''))
}

function safeErrorMessage(code, message, status) {
  if (typeof code === 'string' && Object.hasOwn(SAFE_ERROR_CODES, code)) {
    return SAFE_ERROR_CODES[code]
  }
  if (typeof message === 'string' && Object.hasOwn(SAFE_SERVER_MESSAGES, message)) {
    return SAFE_SERVER_MESSAGES[message]
  }
  return SAFE_STATUS_MESSAGES[status] ?? FALLBACK_ERROR_MESSAGE
}

const TIMED_OUT_MESSAGE = 'This took too long to answer, but it may still finish. Wait a moment, then reload the record.'

async function parseJson(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    // Netlify's gateway answers a slow function with an HTML "Inactivity Timeout" page; the function may still finish.
    if (response.status === 504 || /inactivity timeout/i.test(text.slice(0, 2000))) {
      throw Object.assign(new H2ARequestError(TIMED_OUT_MESSAGE, response.status), { timedOut: true })
    }
    throw new H2ARequestError('HubSpot to Albi returned an invalid response.', response.status)
  }
}

async function request(session, path, {
  method = 'GET',
  companyId,
  query,
  body,
  signal,
} = {}) {
  const token = sessionToken(session)
  const { companyId: _ignoredQueryCompany, ...safeQuery } = query ?? {}
  const search = new URLSearchParams(withoutNullish({ ...(method === 'GET' ? { companyId } : {}), ...safeQuery }))
  const url = `${FUNCTION_BASE}/${path}${search.size ? `?${search.toString()}` : ''}`
  const headers = { Authorization: `Bearer ${token}` }
  const options = { method, headers, signal }

  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(withoutNullish({ ...body, companyId }))
  }

  let response
  try {
    response = await fetch(url, options)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new H2ARequestError('Unable to reach HubSpot to Albi. Check your connection and try again.')
  }

  const data = await parseJson(response)
  if (!response.ok) throw new H2ARequestError(safeErrorMessage(data?.code, data?.error, response.status), response.status)
  return data
}

export function getH2ASettings(session, companyId, { signal } = {}) {
  return request(session, 'h2a-settings', { companyId, signal })
}

export function saveH2ASettings(session, companyId, update, { signal } = {}) {
  return request(session, 'h2a-settings', { method: 'PUT', companyId, body: update, signal })
}

export function runH2APreflight(session, companyId, { signal } = {}) {
  return request(session, 'h2a-preflight', { method: 'POST', companyId, signal })
}

// The estimate handler uses POST for bounded input, but performs no writes.
export function estimateH2AActivities(session, companyId, startDate, { signal } = {}) {
  return request(session, 'h2a-estimate', { method: 'POST', companyId, body: { startDate }, signal })
}

export function runH2ASync(session, companyId, mode, { signal, dryRunScope } = {}) {
  return request(session, 'h2a-run', { method: 'POST', companyId,
    body: { mode, ...(dryRunScope ? { dryRunScope } : {}) }, signal })
}

export function getH2AOverview(session, companyId, { cursor, limit, signal } = {}) {
  return request(session, 'h2a-overview', { companyId, query: { cursor, limit }, signal })
}

export function getH2AConflicts(session, companyId, { cursor, limit, signal } = {}) {
  return request(session, 'h2a-conflicts', { companyId, query: { limit, cursor }, signal })
}

export function getH2AConflict(session, companyId, conflictId, { signal } = {}) {
  return request(session, 'h2a-conflicts', { companyId, query: { conflictId }, signal })
}

// Query order is stable so cached URLs and tests stay comparable; unknown keys never serialize.
const REVIEW_FILTERS = Object.freeze(['limit', 'cursor', 'status', 'objectType', 'reason', 'kind', 'bucket'])

// The review list for either queue: kind 'sample' (default on the server) or 'live', filtered by bucket.
export function getH2AReviews(session, companyId, { signal, limit = 100, ...values } = {}) {
  const filters = { ...values, limit }
  const query = Object.fromEntries(REVIEW_FILTERS.filter(key => Object.hasOwn(filters, key)).map(key => [key, filters[key]]))
  return request(session, 'h2a-dry-run-reviews', { companyId, query, signal })
}

export function getH2ADryRunReview(session, companyId, reviewId, { signal } = {}) {
  return request(session, 'h2a-dry-run-reviews', { companyId, query: { reviewId }, signal })
}

export function recheckH2ADryRunReview(session, companyId, input = {}, { signal } = {}) {
  return request(session, 'h2a-dry-run-reviews', {
    method: 'POST', companyId,
    body: { reviewId: input?.reviewId, expectedUpdatedAt: input?.expectedUpdatedAt }, signal,
  })
}

// Queues one background recheck of every open review of a kind (the current sample, or the open live
// rows), or only up to 200 reviewIds; poll getH2ARecheckAll with the same kind for progress.
export function startH2ARecheckAll(session, companyId, { kind = 'sample', reviewIds, signal } = {}) {
  return request(session, 'h2a-dry-run-review-recheck-all', { method: 'POST', companyId,
    body: { kind, ...(Array.isArray(reviewIds) ? { reviewIds: [...reviewIds] } : {}) }, signal })
}

export function getH2ARecheckAll(session, companyId, { kind, signal } = {}) {
  return request(session, 'h2a-dry-run-review-recheck-all', { companyId, query: { kind }, signal })
}

// Captures (or finds) the one associated organization's own review so it can be created before the contact.
export function prepareH2AOrganizationReview(session, companyId, input = {}, { signal } = {}) {
  return request(session, 'h2a-dry-run-reviews', {
    method: 'POST', companyId,
    body: { reviewId: input?.reviewId, expectedUpdatedAt: input?.expectedUpdatedAt, prepareOrganization: true }, signal,
  })
}

// Captures (or finds) the review for the HubSpot record a merged-away source now points to.
export function prepareH2AMergedSurvivorReview(session, companyId, input = {}, { signal } = {}) {
  return request(session, 'h2a-dry-run-reviews', {
    method: 'POST', companyId,
    body: { reviewId: input?.reviewId, expectedUpdatedAt: input?.expectedUpdatedAt, prepareMergedSurvivor: true }, signal,
  })
}

function resolutionCompany(companyId) {
  if (companyId !== undefined && companyId !== null && (typeof companyId !== 'string' || !companyId.trim() || companyId.length > 200)) {
    throw new TypeError('A single company selector is required.')
  }
  return companyId
}

export function getH2ADryRunReviewResolution(session, companyId, reviewId, { signal } = {}) {
  if (typeof reviewId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewId)) {
    throw new TypeError('Invalid resolution request.')
  }
  return request(session, 'h2a-dry-run-review-resolutions', { companyId: resolutionCompany(companyId), query: { reviewId }, signal })
}

export function resolveH2ADryRunReview(session, companyId, input, { signal } = {}) {
  return request(session, 'h2a-dry-run-review-resolutions', { method: 'POST', companyId: resolutionCompany(companyId),
    body: buildResolutionRequest(input), signal })
}

const pick = (input, keys) => Object.fromEntries(keys.filter(key => input?.[key] !== undefined).map(key => [key, input[key]]))

// Links up to 25 exact-match rows, each with its own version and request ID; the server reports each row.
// "Create selected": the latest create batch of a kind plus Albi's referral sources to choose from.
export function getH2ACreateBatch(session, companyId, kind = 'sample', { signal } = {}) {
  return request(session, 'h2a-review-create-batch', { companyId, query: { kind: kind === 'live' ? 'live' : 'sample' }, signal })
}

// Starts a background batch creating the selected reviewed records in Albi with one referral source.
export function startH2ACreateBatch(session, companyId, input = {}, { signal } = {}) {
  const items = (Array.isArray(input?.items) ? input.items : []).map(item => pick(item, ['reviewId', 'expectedUpdatedAt']))
  return request(session, 'h2a-review-create-batch', { method: 'POST', companyId,
    body: { kind: input?.kind === 'live' ? 'live' : 'sample', referralSourceId: input?.referralSourceId, items }, signal })
}

export function bulkLinkH2AReviews(session, companyId, items, { signal } = {}) {
  const clean = (Array.isArray(items) ? items : []).map(item => pick(item, ['reviewId', 'candidateId', 'expectedUpdatedAt', 'clientRequestId']))
  return request(session, 'h2a-dry-run-review-resolutions', { method: 'POST', companyId: resolutionCompany(companyId),
    body: { op: 'bulk_link', items: clean }, signal })
}

// "Create organization and contact": one referral source for both records. The response's contact.error
// reports a contact step that failed after the organization was created.
export function createH2AOrganizationThenContact(session, companyId, input, { signal } = {}) {
  return request(session, 'h2a-dry-run-review-resolutions', { method: 'POST', companyId: resolutionCompany(companyId),
    body: { op: 'create_with_organization', ...pick(input, ['reviewId', 'expectedUpdatedAt', 'clientRequestId', 'referralSourceId',
      'organizationReviewId', 'organizationExpectedUpdatedAt']) }, signal })
}

// The review outbox: one workspace action is queued and sent to Albi in the background at a steady pace.
// Takes the same fields as resolveH2ADryRunReview / createH2AOrganizationThenContact (op 'create_with_organization').
export function queueH2AOutbox(session, companyId, input = {}, { signal } = {}) {
  const { op, organizationReviewId, organizationExpectedUpdatedAt, ...rest } = input ?? {}
  let item
  if (op === 'create_with_organization') {
    const { reviewId, expectedUpdatedAt, clientRequestId, referralSourceId } = rest
    item = { reviewId, expectedUpdatedAt, clientRequestId,
      action: withoutNullish({ kind: 'create_with_organization', referralSourceId, organizationReviewId, organizationExpectedUpdatedAt }) }
  } else {
    const { reviewId, expectedUpdatedAt, clientRequestId, ...decision } = buildResolutionRequest(rest)
    item = { reviewId, expectedUpdatedAt, clientRequestId, action: { kind: 'resolution', decision } }
  }
  return request(session, 'h2a-review-outbox', { method: 'POST', companyId: resolutionCompany(companyId), body: { op: 'enqueue', items: [item] }, signal })
}

export function getH2AOutbox(session, companyId, kind = 'live', { signal } = {}) {
  return request(session, 'h2a-review-outbox', { companyId, query: { kind: kind === 'sample' ? 'sample' : 'live' }, signal })
}

export function retryH2AOutbox(session, companyId, ids, { signal } = {}) {
  return request(session, 'h2a-review-outbox', { method: 'POST', companyId: resolutionCompany(companyId), body: { op: 'retry', ids }, signal })
}

export function returnH2AOutbox(session, companyId, ids, { signal } = {}) {
  return request(session, 'h2a-review-outbox', { method: 'POST', companyId: resolutionCompany(companyId), body: { op: 'return', ids }, signal })
}

// Skip on a live row: an audited resolution that marks every linked conflict skipped.
export function skipH2ALiveReview(session, companyId, { reviewId, expectedUpdatedAt, clientRequestId } = {}, { signal } = {}) {
  return resolveH2ADryRunReview(session, companyId, { reviewId, expectedUpdatedAt, clientRequestId, action: 'skip_live' }, { signal })
}

// "Prepare open conflicts for review": one backfill page; repeat with nextCursor until it is null.
export function prepareH2ALiveReviews(session, companyId, { cursor, signal } = {}) {
  return request(session, 'h2a-conflicts', { method: 'POST', companyId, body: { op: 'prepare_live_reviews', cursor }, signal })
}

export function resolveH2AConflict(session, companyId, resolution, { signal } = {}) {
  return request(session, 'h2a-conflict-resolve', { method: 'POST', companyId, body: resolution, signal })
}

/**
 * The dedicated endpoint returns only super-admin-authorized company IDs/names.
 * Validate and reduce again at the browser boundary before exposing options.
 */
export async function getH2ACompanyOptions(session, { signal } = {}) {
  const data = await request(session, 'h2a-companies', { signal })
  if (!Array.isArray(data?.companies)) throw new H2ARequestError('Unable to load company options.')

  const companies = new Map()
  for (const company of data.companies) {
    if (typeof company?.id !== 'string' || !company.id ||
      typeof company?.name !== 'string' || !company.name.trim()) continue
    if (!companies.has(company.id)) {
      companies.set(company.id, { id: company.id, name: company.name.trim() })
    }
  }

  return [...companies.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}
