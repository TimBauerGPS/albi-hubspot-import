const FUNCTION_BASE = '/.netlify/functions'
const MAX_ERROR_LENGTH = 240

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

function safeErrorMessage(value, status) {
  const fallback = `HubSpot to Albi request failed (${status || 'network'}).`
  if (typeof value !== 'string') return fallback

  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b(?:authorization|bearer|hubspotToken|albiApiKey|api[_ -]?key|secret|password)\s*[:=]?\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()

  return (normalized || fallback).slice(0, MAX_ERROR_LENGTH)
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
  if (!response.ok) throw new H2ARequestError(safeErrorMessage(data?.error, response.status), response.status)
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
 * The existing authenticated admin endpoint is the only current company list.
 * Collapse its user-shaped response here so the module sees tenant IDs/names only.
 */
export async function getH2ACompanyOptions(session, { signal } = {}) {
  const data = await request(session, 'admin-list-users', { signal })
  if (!Array.isArray(data?.users)) throw new H2ARequestError('Unable to load company options.')

  const companies = new Map()
  for (const user of data.users) {
    if (typeof user?.company_id !== 'string' || !user.company_id ||
      typeof user?.company_name !== 'string' || !user.company_name.trim()) continue
    if (!companies.has(user.company_id)) {
      companies.set(user.company_id, { id: user.company_id, name: user.company_name.trim() })
    }
  }

  return [...companies.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}
