// Albi contacts and organizations served from a per-company copy (supabase/h2a-albi-mirror.sql) instead of a walk
// of Albi's whole list. A read first asks Albi for what changed since the last read (changedSince, with a few
// minutes' overlap), so the copy is as current as a full walk. Albi reports no deletes, so once a day the read is a
// full walk that rebuilds the copy. Callers keep paging with numbered cursors; pages come from the copy.
// If the copy cannot be read or written (for example before the SQL is applied), reads go straight to Albi.
export const MIRROR_FULL_MS = 24 * 60 * 60000
export const MIRROR_OVERLAP_MS = 5 * 60000
// Reads within a few seconds of each other in one function share one refresh.
export const MIRROR_MEMO_MS = 15000
const PAGE = 100
const KINDS = Object.freeze({ contacts: 'listContacts', organizations: 'listOrganizations' })

async function walk(read, filters = {}) {
  const records = []
  const seen = new Set()
  for (let cursor = '1'; cursor !== null;) {
    if (seen.has(cursor) || seen.size > 10000) throw new Error('Albi pagination loop')
    seen.add(cursor)
    const page = await read({ cursor, pageSize: PAGE, ...filters })
    if (!Array.isArray(page?.records)) throw new Error('Albi returned an invalid page')
    records.push(...page.records)
    cursor = page.cursor ?? null
  }
  return records
}

export function withAlbiMirror(albi, { store, companyId, now = Date.now } = {}) {
  if (!store || typeof store.readAlbiMirror !== 'function' || !companyId) return albi
  const memo = new Map()
  let broken = false
  const refresh = async kind => {
    const read = args => albi[KINDS[kind]](args)
    const startedAt = new Date(now()).toISOString()
    const state = await store.getAlbiMirrorState(companyId, kind)
    const fullAt = Date.parse(state?.full_at ?? '')
    const syncedAt = Date.parse(state?.synced_at ?? '')
    if (!Number.isFinite(fullAt) || !Number.isFinite(syncedAt) || now() - fullAt >= MIRROR_FULL_MS) {
      const records = await walk(read)
      await store.replaceAlbiMirror(companyId, kind, records, startedAt)
      return records
    }
    const changedSince = new Date(syncedAt - MIRROR_OVERLAP_MS).toISOString()
    const changed = await walk(read, { changedSince })
    await store.upsertAlbiMirror(companyId, kind, changed, startedAt)
    return store.readAlbiMirror(companyId, kind)
  }
  const snapshot = async kind => {
    const held = memo.get(kind)
    if (held && now() - held.at < MIRROR_MEMO_MS) return held.promise
    const promise = refresh(kind)
    memo.set(kind, { at: now(), promise })
    try { return await promise } catch (error) { memo.delete(kind); throw error }
  }
  const list = kind => async (args = {}) => {
    const { cursor = '1', pageSize = 25, ...rest } = args ?? {}
    // A filtered read, or any read once the copy has failed, goes straight to Albi.
    if (broken || Object.keys(rest).length) return albi[KINDS[kind]](args)
    const page = Number(cursor)
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return albi[KINDS[kind]](args)
    let records
    try {
      // Page 1 starts a fresh read; later pages of the same walk reuse it.
      if (page === 1) memo.delete(`${kind}:walk`)
      const held = memo.get(`${kind}:walk`)
      records = held ?? await snapshot(kind)
      memo.set(`${kind}:walk`, records)
    } catch (error) {
      if (error?.category) throw error
      broken = true
      return albi[KINDS[kind]](args)
    }
    const start = (page - 1) * pageSize
    return { records: structuredClone(records.slice(start, start + pageSize)), cursor: start + pageSize < records.length ? String(page + 1) : null }
  }
  // Every other method (creates, updates, options, activities) is Albi's own.
  return new Proxy(albi, {
    get(target, property) {
      if (property === 'listContacts') return list('contacts')
      if (property === 'listOrganizations') return list('organizations')
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      // A write makes the next read ask Albi again (a create or update must be visible to the read that verifies it).
      if (typeof property === 'string' && /^(create|update|associate)/.test(property)) {
        return async (...args) => { try { return await value.apply(target, args) } finally { memo.clear() } }
      }
      return value.bind(target)
    },
  })
}
