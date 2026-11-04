import { createHash } from 'node:crypto'

// Saved Albi lookups (supabase/h2a-albi-cache.sql), so a fresh function doesn't ask Albi again for what rarely changes.
// Tied to a fingerprint of the key, so a new key starts clean. A failure of any kind is a miss: the read goes to Albi.
export const albiKeyFingerprint = apiKey => createHash('sha256').update(String(apiKey)).digest('hex')

export function createAlbiCache({ store, companyId, apiKey, now = Date.now } = {}) {
  if (typeof store?.getAlbiCacheEntry !== 'function' || !companyId) return null
  const fingerprint = albiKeyFingerprint(apiKey)
  return {
    async get(name) {
      try {
        const row = await store.getAlbiCacheEntry(companyId, name)
        if (!row || row.key_fingerprint !== fingerprint) return null
        if (row.expires_at && Date.parse(row.expires_at) <= now()) return null
        return row.value ?? null
      } catch { return null }
    },
    async set(name, value, ttlMs = null) {
      try {
        await store.putAlbiCacheEntry(companyId, { name, key_fingerprint: fingerprint, value,
          expires_at: ttlMs ? new Date(now() + ttlMs).toISOString() : null })
      } catch { /* Only a saving lost: the next read asks Albi. */ }
    },
  }
}
