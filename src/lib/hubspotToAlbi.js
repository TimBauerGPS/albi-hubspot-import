const FUNCTION_BASE = '/.netlify/functions'
const SAFE_ERROR_CODES = Object.freeze({
  DUPLICATE_OPTION_MAPPING: 'Duplicate option mapping.',
  INVALID_CONFLICT_CURSOR: 'Invalid conflict cursor.',
  INVALID_CONFLICT_PAGE_SIZE: 'Invalid conflict page size.',
  INVALID_OPTION_MAPPING: 'Invalid option mapping.',
  INVALID_OPTION_MAPPING_SOURCE: 'Invalid option mapping source.',
})
const SAFE_SERVER_MESSAGES = Object.freeze({
  'A dry run is required before live activation.': 'A dry run is required before live activation.',
  'A completed dry run is required before live activation.': 'A completed dry run is required before live activation.',
  'A conflict ID is required.': 'A conflict ID is required.',
  'A conflict resolution is required.': 'A conflict resolution is required.',
  'A settings action is required.': 'A settings action is required.',
  'A single company selector is required.': 'A single company selector is required.',
  'A valid company is required.': 'A valid company is required.',
  'Backfill requires a date earlier than the fixed initial start date.': 'Backfill requires a date earlier than the fixed initial start date.',
  'Conflict not found.': 'Conflict not found.',
  'Conflict page size must be between 1 and 100.': 'Conflict page size must be between 1 and 100.',
  'Company ID is required.': 'Company ID is required.',
  'Complete option mappings are required.': 'Complete option mappings are required.',
  'Confirm contact and organization defaults and every activity type.': 'Confirm contact and organization defaults and every activity type.',
  'Disable live sync before starting a dry run.': 'Disable live sync before starting a dry run.',
  'Duplicate option mapping.': 'Duplicate option mapping.',
  'H2A configuration is not ready for this run.': 'H2A configuration is not ready for this run.',
  'H2A settings are changing. Run preflight again shortly.': 'H2A settings are changing. Run preflight again shortly.',
  'Invalid conflict cursor.': 'Invalid conflict cursor.',
  'Invalid conflict page size.': 'Invalid conflict page size.',
  'Invalid conflict resolution payload.': 'Invalid conflict resolution payload.',
  'Invalid option mapping source.': 'Invalid option mapping source.',
  'Invalid option mapping.': 'Invalid option mapping.',
  'Invalid request body.': 'Invalid request body.',
  'Invalid sync mode.': 'Invalid sync mode.',
  'Linking requires an explicit target ID.': 'Linking requires an explicit target ID.',
  'Many-to-one approval must be boolean.': 'Many-to-one approval must be boolean.',
  'Manual runs cannot resume or select a trigger.': 'Manual runs cannot resume or select a trigger.',
  'Notification recipients must be valid email addresses (up to 20).': 'Notification recipients must be valid email addresses (up to 20).',
  'Option mappings must use IDs from the latest tenant preflight options.': 'Option mappings must use IDs from the latest tenant preflight options.',
  'Resume requires a run ID.': 'Resume requires a run ID.',
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
  'Unsupported settings action.': 'Unsupported settings action.',
  'Unsupported settings fields.': 'Unsupported settings fields.',
  'Use request_earlier_backfill for an earlier date.': 'Use request_earlier_backfill for an earlier date.',
  'Valid credentials, successful preflight, and confirmed option mappings are required.': 'Valid credentials, successful preflight, and confirmed option mappings are required.',
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

async function parseJson(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
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

export function runH2ASync(session, companyId, mode, { signal } = {}) {
  return request(session, 'h2a-run', { method: 'POST', companyId, body: { mode }, signal })
}

export function getH2AOverview(session, companyId, { cursor, limit, signal } = {}) {
  return request(session, 'h2a-overview', { companyId, query: { cursor, limit }, signal })
}

export function getH2AConflicts(session, companyId, { cursor, limit, signal } = {}) {
  return request(session, 'h2a-conflicts', { companyId, query: { limit, cursor }, signal })
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
