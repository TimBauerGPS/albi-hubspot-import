// Errors intentionally contain no URL, headers, token, or original cause. The only response-derived
// field is providerReason: a sanitized, capped validation message for 400/422 rejections.
export class ApiError extends Error {
  constructor(category, { operation = 'request', status = null, code = category, retryAfterMs = null, requiredScope = null, protocolIssue = null, providerReason = null, providerShape = null } = {}) {
    super(`Provider request failed (${category}).`)
    this.name = 'ApiError'
    Object.assign(this, { category, operation, status, code, retryAfterMs, requiredScope, protocolIssue, providerReason, providerShape })
  }
}

const REASON_LIMIT = 200
// Names only, never values: the top-level keys (and first detail item's keys) of a JSON error body.
export function providerBodyShape(body) {
  if (!isRecord(body)) return null
  const names = value => Object.keys(value).filter(key => /^\w{1,30}$/.test(key)).slice(0, 10).join(',')
  const list = body.validationErrors ?? body.detail
  const first = Array.isArray(list) ? list[0] : isRecord(list) ? list : null
  const shape = `resp=${names(body)}${isRecord(first) ? `;item=${names(first)}` : ''}`
  return shape.length > 1 ? shape.slice(0, 120) : null
}
const redact = text => text
  .replace(/[^\s@'"]+@[^\s@'"]+/g, '[email]')
  .replace(/'[^']*'|"[^"]*"/g, '[value]')
  .replace(/\d{3,}/g, '[number]')
// Keeps field names and validator messages; never echoes request input.
const FIELD_KEYS = ['field', 'fieldName', 'propertyName', 'property']
const MESSAGE_KEYS = ['message', 'errorMessage', 'error', 'msg', 'description']
function collectReasons(value, parts, depth = 0) {
  if (parts.length >= 5 || depth > 3 || value == null) return
  if (typeof value === 'string') parts.push(redact(value))
  else if (Array.isArray(value)) value.slice(0, 5).forEach(item => collectReasons(item, parts, depth + 1))
  else if (isRecord(value)) {
    const message = MESSAGE_KEYS.map(key => value[key]).find(item => typeof item === 'string')
    if (message !== undefined) {
      const fieldKey = FIELD_KEYS.find(key => typeof value[key] === 'string' && /^[\w.\[\]]{1,40}$/.test(value[key]))
      const loc = Array.isArray(value.loc) ? value.loc.filter(part => typeof part === 'string' && /^\w+$/.test(part)).join('.') : ''
      const field = fieldKey ? value[fieldKey] : loc
      parts.push(`${field ? `${field}: ` : ''}${redact(message)}`)
    } else for (const [key, item] of Object.entries(value).slice(0, 5)) {
      const inner = []
      collectReasons(item, inner, depth + 1)
      if (/^[\w.\[\]]{1,40}$/.test(key)) inner.forEach(text => parts.push(`${key}: ${text}`))
    }
  }
}
export function sanitizeProviderReason(body) {
  const parts = []
  if (isRecord(body)) {
    collectReasons(body.validationErrors ?? body.errors, parts)
    if (parts.length === 0) collectReasons(body.detail ?? body.message ?? body.error, parts)
  }
  const reason = parts.join('; ').slice(0, REASON_LIMIT)
  return reason || null
}

export function invalid(operation) { throw new ApiError('validation', { operation }) }
export function malformed(operation, protocolIssue = null) { throw new ApiError('permanent', { operation, code: 'malformed_response', protocolIssue }) }
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function id(value, operation = 'response') {
  if ((typeof value !== 'string' && !Number.isSafeInteger(value)) || !/^[1-9][0-9]*$/.test(String(value))) invalid(operation)
  return String(value)
}
export function responseId(value, operation) {
  try { return id(value, operation) } catch { malformed(operation) }
}
const classify = status => status === 429 ? 'rate_limit' : status === 401 ? 'auth' : status === 403 ? 'permission' :
  [400, 409, 422].includes(status) ? 'validation' : status === 408 || status >= 500 ? 'transient' : 'permanent'

export function createHttpClient({ baseUrl, headers = {}, fetch = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random,
  maxRetries = 2, maxDelayMs = 5000, timeoutMs = 10000, now = Date.now, captureValidationReason = false } = {}) {
  const origin = new URL(baseUrl).origin
  const retries = Math.max(0, Math.min(3, Number.isInteger(maxRetries) ? maxRetries : 2))
  const delayCap = Math.max(1, Math.min(10000, maxDelayMs))
  const deadline = Math.max(1, Math.min(30000, timeoutMs))
  return async function request(path, { method = 'GET', body, operation = 'request', retrySafe = method === 'GET', statusOnly = false, timeoutMs: requestTimeoutMs } = {}) {
    // A single slow write may wait longer than reads (an abandoned create leaves its outcome unknown).
    const limit = Number.isFinite(requestTimeoutMs) ? Math.max(1, Math.min(30000, requestTimeoutMs)) : deadline
    const url = new URL(path, baseUrl)
    if (url.origin !== origin || url.username || url.password) invalid(operation)
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      let timer
      let error
      try {
        return await Promise.race([
          (async () => {
            const response = await fetch(url.toString(), {
              method, headers: { Accept: 'application/json', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
              body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error',
            })
            if (!response.ok) {
              const raw = response.headers.get('retry-after')
              let retryAfterMs = null
              if (raw !== null) {
                const delay = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now()
                if (Number.isFinite(delay)) retryAfterMs = Math.max(0, delay)
              }
              // Only validation rejections yield a sanitized reason; other bodies are never read.
              let providerReason = null, providerShape = null
              if (captureValidationReason && [400, 422].includes(response.status)) {
                try { const parsed = JSON.parse((await response.text()).slice(0, 4000)); providerReason = sanitizeProviderReason(parsed); providerShape = providerBodyShape(parsed) } catch { providerReason = null }
              } else await response.body?.cancel().catch(() => {})
              throw new ApiError(classify(response.status), { operation, status: response.status, retryAfterMs, providerReason, providerShape })
            }
            if (statusOnly) {
              void response.body?.cancel().catch(() => {})
              return { status: response.status, allow: response.headers.get('allow') ?? '' }
            }
            try { return await response.json() } catch { malformed(operation) }
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new ApiError('transient', { operation, code: 'timeout' })) }, limit)
          }),
        ])
      } catch (caught) {
        error = caught instanceof ApiError ? caught : new ApiError('transient', { operation, code: 'network' })
      } finally { clearTimeout(timer) }
      if (!retrySafe || attempt >= retries || !['transient', 'rate_limit'].includes(error.category)) throw error
      // A long server delay belongs in the durable job scheduler, never an early retry.
      if (error.retryAfterMs > delayCap) throw error
      const jitter = Math.max(0, Math.min(1, random()))
      await sleep(Math.max(error.retryAfterMs ?? 0, Math.min(delayCap, 250 * (2 ** attempt) * (1 + jitter))))
    }
  }
}
