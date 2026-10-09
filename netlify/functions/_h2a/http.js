// Errors intentionally contain no URL, response body, headers, token, or original cause.
export class ApiError extends Error {
  constructor(category, { operation = 'request', status = null, code = category, retryAfterMs = null, requiredScope = null } = {}) {
    super(`Provider request failed (${category}).`)
    this.name = 'ApiError'
    Object.assign(this, { category, operation, status, code, retryAfterMs, requiredScope })
  }
}

export function invalid(operation) { throw new ApiError('validation', { operation }) }
export function malformed(operation) { throw new ApiError('permanent', { operation, code: 'malformed_response' }) }
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
  maxRetries = 2, maxDelayMs = 5000, timeoutMs = 10000, now = Date.now } = {}) {
  const origin = new URL(baseUrl).origin
  const retries = Math.max(0, Math.min(3, Number.isInteger(maxRetries) ? maxRetries : 2))
  const delayCap = Math.max(1, Math.min(10000, maxDelayMs))
  const deadline = Math.max(1, Math.min(30000, timeoutMs))
  return async function request(path, { method = 'GET', body, operation = 'request', retrySafe = method === 'GET', statusOnly = false } = {}) {
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
              // Do not read or retain arbitrary provider error bodies.
              await response.body?.cancel().catch(() => {})
              throw new ApiError(classify(response.status), { operation, status: response.status, retryAfterMs })
            }
            if (statusOnly) {
              void response.body?.cancel().catch(() => {})
              return { status: response.status, allow: response.headers.get('allow') ?? '' }
            }
            try { return await response.json() } catch { malformed(operation) }
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new ApiError('transient', { operation, code: 'timeout' })) }, deadline)
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
