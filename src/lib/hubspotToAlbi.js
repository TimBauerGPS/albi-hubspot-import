const FUNCTION_BASE = '/.netlify/functions'
const SAFE_ERROR_CODES = Object.freeze({
  DUPLICATE_OPTION_MAPPING: 'Duplicate option mapping.',
  INVALID_CONFLICT_CURSOR: 'Invalid conflict cursor.',
  INVALID_CONFLICT_PAGE_SIZE: 'Invalid conflict page size.',
  INVALID_OPTION_MAPPING: 'Invalid option mapping.',
  INVALID_OPTION_MAPPING_SOURCE: 'Invalid option mapping source.',
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

function safeErrorMessage(code, status) {
  if (typeof code === 'string' && Object.hasOwn(SAFE_ERROR_CODES, code)) {
    return SAFE_ERROR_CODES[code]
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
  if (!response.ok) throw new H2ARequestError(safeErrorMessage(data?.code, response.status), response.status)
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
