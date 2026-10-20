// Small per-instance cache for slow, rarely changing provider reads (Albi option lists, HubSpot owners).
// Warm function instances reuse it, so a record's create checks stop re-reading the same lists every time.
// Failures are never cached; concurrent callers share one in-flight read.
const store = new Map()
export const READ_CACHE_TTL_MS = 5 * 60000

export async function cachedRead(key, load, { ttlMs = READ_CACHE_TTL_MS, now = Date.now } = {}) {
  if (!key) return load()
  const hit = store.get(key)
  if (hit && hit.expires > now()) return hit.promise
  const promise = Promise.resolve().then(load)
  store.set(key, { promise, expires: now() + ttlMs })
  try { return await promise } catch (error) { if (store.get(key)?.promise === promise) store.delete(key); throw error }
}

export function clearReadCache() { store.clear() }
