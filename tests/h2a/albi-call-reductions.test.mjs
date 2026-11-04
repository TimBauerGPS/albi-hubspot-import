import test from 'node:test'
import assert from 'node:assert/strict'
import { AlbiClient, HOURLY_FLOOR, MINUTE_WAIT_MS } from '../../netlify/functions/_h2a/albiClient.js'
import { createAlbiCache } from '../../netlify/functions/_h2a/albiCache.js'
import { withAlbiMirror, MIRROR_FULL_MS, MIRROR_MEMO_MS } from '../../netlify/functions/_h2a/albiMirror.js'
import { outboxPaceFor } from '../../netlify/functions/_h2a/outbox.js'
import { ApiError } from '../../netlify/functions/_h2a/http.js'
import { createWeeklyCopyScheduler, rebuildDue } from '../../netlify/functions/h2a-albi-copy-weekly.js'
import { createCopyRebuildHandler } from '../../netlify/functions/h2a-albi-copy-rebuild-background.js'

// Unique per test: rate budgets are kept per key in the process.
let keys = 0
const uniqueKey = () => `reduction-key-${keys++}`
function albiFetch({ headers = {} } = {}) {
  const calls = []
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url); calls.push({ method: options.method ?? 'GET', path: parsed.pathname, search: parsed.searchParams })
    const path = parsed.pathname
    const body = path.endsWith('/relationship-statuses') ? { data: [{ id: '2', name: 'Active', companyId: '1319' }] }
      : path.endsWith('/relationship-types') ? { data: [{ id: '12', name: 'Referrer', companyId: '1319' }] }
        : path.endsWith('/salespeople') ? { data: [{ id: '5', name: 'Pat Lee', companyId: '1319' }] }
          : path.startsWith('/api/v1/company/') ? { data: { id: '1319', name: 'Allied' } }
            : options.method === 'POST' ? { status: 1, data: { id: '700', firstName: 'New', lastName: 'Person', contactTypeIds: ['12'] } }
              : options.method === 'PUT' ? { status: 1, data: { id: '20', firstName: 'A', lastName: 'B', phoneNumber: '555-111-2222' } }
                : { data: [{ id: '20', firstName: 'A', lastName: 'B' }], continuationToken: null }
    return new Response(JSON.stringify(body), { headers })
  }
  return { fetch, calls }
}
function memoryCacheStore() {
  const rows = new Map()
  return { rows, getAlbiCacheEntry: async (_company, name) => rows.get(name) ?? null, putAlbiCacheEntry: async (_company, entry) => { rows.set(entry.name, entry) } }
}

test('a fresh client reuses the saved company and option lists, and a new key starts clean', async () => {
  const store = memoryCacheStore(), key = uniqueKey()
  const run = async apiKey => {
    const f = albiFetch()
    const client = new AlbiClient({ apiKey, fetch: f.fetch, cache: createAlbiCache({ store, companyId: 'c1', apiKey }) })
    const options = await client.listCreateOptions()
    assert.deepEqual(options.salespeople, [{ id: '5', label: 'Pat Lee' }])
    return { client, calls: f.calls }
  }
  assert.equal((await run(key)).calls.length, 5) // company (2), then the three lists
  const second = await run(key)
  assert.equal(second.calls.length, 0)
  assert.deepEqual((await second.client.verifyCredentials()).company, { id: '1319', name: 'Allied' })
  assert.equal((await run(uniqueKey())).calls.length, 5)
})

test('saved lookups expire, a failing store is only a miss, and an uncached client always asks Albi', async () => {
  let clock = Date.parse('2026-11-04T10:00:00Z')
  const store = memoryCacheStore(), cache = createAlbiCache({ store, companyId: 'c1', apiKey: 'k', now: () => clock })
  await cache.set('options:x', [1], 1000)
  assert.deepEqual(await cache.get('options:x'), [1])
  clock += 1001
  assert.equal(await cache.get('options:x'), null)
  const broken = createAlbiCache({ store: { getAlbiCacheEntry: async () => { throw Error('relation does not exist') }, putAlbiCacheEntry: async () => { throw Error('no') } }, companyId: 'c1', apiKey: 'k' })
  assert.equal(await broken.get('company'), null)
  await broken.set('company', {})
  assert.equal(createAlbiCache({ store: {}, companyId: 'c1', apiKey: 'k' }), null)
})

test('a low hourly budget stops requests before Albi refuses them, across clients on the key, until the reset', async () => {
  let clock = Date.parse('2026-11-04T10:00:00Z')
  const apiKey = uniqueKey(), reset = Math.floor(clock / 1000) + 600
  const headers = { 'x-ratelimit-remaining-hour': '4000', 'x-ratelimit-reset-hour': String(reset), 'x-ratelimit-remaining': '140' }
  const f = albiFetch({ headers })
  const client = new AlbiClient({ apiKey, fetch: f.fetch, now: () => clock })
  await client.verifyCredentials()
  headers['x-ratelimit-remaining-hour'] = String(HOURLY_FLOOR)
  await client.listContacts({ pageSize: 1 })
  assert.deepEqual(client.rateBudget(), { remainingHour: HOURLY_FLOOR, resetHourAt: reset * 1000 })
  const sent = f.calls.length
  await assert.rejects(new AlbiClient({ apiKey, fetch: f.fetch, now: () => clock }).createContact({ firstName: 'A', lastName: 'B', contactTypeIds: [1] }),
    error => error.category === 'rate_limit' && error.retryAfterMs === 600000)
  assert.equal(f.calls.length, sent)
  clock = reset * 1000 + 1
  assert.equal(client.rateBudget(), null)
  headers['x-ratelimit-remaining-hour'] = '5000'
  await client.listContacts({ pageSize: 1 })
  assert.ok(f.calls.length > sent)
})

test('near the minute limit a request waits once instead of being refused', async () => {
  const slept = [], apiKey = uniqueKey()
  const f = albiFetch({ headers: { 'x-ratelimit-remaining': '5' } })
  const client = new AlbiClient({ apiKey, fetch: f.fetch, sleep: async ms => { slept.push(ms) } })
  await client.listContacts({ pageSize: 1 })
  assert.ok(slept.includes(MINUTE_WAIT_MS))
})

test('a long refusal stops later requests from spending quota', async () => {
  const apiKey = uniqueKey(); let requests = 0
  const fetch = async () => { requests++; return new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } }) }
  const client = new AlbiClient({ apiKey, fetch, sleep: async () => {} })
  await assert.rejects(client.listContacts(), { category: 'rate_limit' })
  const spent = requests
  await assert.rejects(new AlbiClient({ apiKey, fetch }).listContacts(), { category: 'rate_limit' })
  assert.equal(requests, spent)
})

test('the Outbox slows as the hourly budget falls and keeps its pace when it is unknown', () => {
  assert.deepEqual([null, { remainingHour: 4000 }, { remainingHour: 2000 }, { remainingHour: 1000 }, { remainingHour: 300 }].map(budget => outboxPaceFor(1500, budget)),
    [1500, 1500, 3000, 6000, 12000])
})

function mirrorStore() {
  const rows = new Map(), calls = []
  return { rows, calls,
    getAlbiMirrorState: async () => ({ full_at: new Date(Date.now() - 86400000).toISOString(), synced_at: new Date(Date.now() - 60000).toISOString() }),
    readAlbiMirror: async () => { calls.push('read'); return [...rows.values()].map(row => structuredClone(row)) },
    upsertAlbiMirror: async (_company, _kind, records) => { for (const record of records) rows.set(record.id, record) },
    upsertAlbiMirrorRecord: async (_company, kind, record) => { calls.push(['saved', kind, record.id]); rows.set(record.id, record) },
    deleteAlbiMirrorRecord: async (_company, kind, id) => { calls.push(['deleted', kind, id]); rows.delete(id) },
    replaceAlbiMirror: async (_company, kind, records) => { calls.push(['replaced', kind, records.length]) },
  }
}

test('Albi’s reply to a write goes into the copy, so the next read asks Albi nothing', async () => {
  const f = albiFetch(), store = mirrorStore()
  const albi = withAlbiMirror(new AlbiClient({ apiKey: uniqueKey(), fetch: f.fetch }), { store, companyId: 'c1' })
  await albi.listContacts({ pageSize: 100 })
  const reads = () => f.calls.filter(call => call.method === 'GET' && call.path === '/api/v1/contacts').length
  const before = reads()
  await albi.updateContact('20', { phoneNumber: '555-111-2222' })
  await albi.createContact({ firstName: 'New', lastName: 'Person', contactTypeIds: [12] })
  assert.deepEqual(store.calls.filter(Array.isArray), [['saved', 'contacts', '20'], ['saved', 'contacts', '700']])
  const page = await albi.listContacts({ pageSize: 100 })
  assert.equal(reads(), before)
  assert.equal(page.records.find(record => record.id === '20').phoneNumber, '555-111-2222')
  assert.ok(page.records.some(record => record.id === '700'))
})

test('without a saved reply the next read asks Albi, and an update refused as not found removes the record', async () => {
  const store = mirrorStore()
  store.rows.set('20', { id: '20' })
  const reads = []
  const fake = { listContacts: async args => { reads.push(args); return { records: [], cursor: null } }, listOrganizations: async () => ({ records: [], cursor: null }),
    updateContact: async () => { throw new ApiError('permanent', { status: 404 }) } }
  const albi = withAlbiMirror(fake, { store, companyId: 'c1' })
  await albi.listContacts({ pageSize: 100 })
  await assert.rejects(albi.updateContact('20', { city: 'A' }), { status: 404 })
  assert.deepEqual(store.calls.filter(Array.isArray), [['deleted', 'contacts', '20']])
  await albi.listContacts({ pageSize: 100 })
  assert.equal(reads.length, 2)
})

test('a read rebuilds only when the copy is missing or the weekly job has been gone for 10 days', async () => {
  let clock = Date.parse('2026-11-04T10:00:00Z')
  const store = mirrorStore()
  store.getAlbiMirrorState = async () => ({ full_at: new Date(clock - 8 * 86400000).toISOString(), synced_at: new Date(clock - 60000).toISOString() })
  const reads = []
  const fake = { listContacts: async args => { reads.push(args); return { records: [], cursor: null } }, listOrganizations: async () => ({ records: [], cursor: null }) }
  await withAlbiMirror(fake, { store, companyId: 'c1', now: () => clock }).listContacts({ pageSize: 100 })
  assert.ok(reads[0].changedSince)
  assert.equal(MIRROR_FULL_MS, 10 * 86400000)
  store.getAlbiMirrorState = async () => ({ full_at: new Date(clock - MIRROR_FULL_MS).toISOString(), synced_at: new Date(clock - 60000).toISOString() })
  await withAlbiMirror(fake, { store, companyId: 'c1', now: () => clock + MIRROR_MEMO_MS }).listContacts({ pageSize: 100 })
  assert.equal(reads.at(-1).changedSince, undefined)
})

test('the weekly job rebuilds a stale copy and leaves a recent one alone', async () => {
  const clock = Date.parse('2026-11-04T10:00:00Z')
  const store = mirrorStore()
  store.getAlbiMirrorState = async () => ({ full_at: new Date(clock - 7 * 86400000).toISOString(), synced_at: new Date(clock).toISOString() })
  const fake = { listContacts: async () => ({ records: [{ id: '1' }], cursor: null }), listOrganizations: async () => ({ records: [], cursor: null }) }
  const albi = withAlbiMirror(fake, { store, companyId: 'c1', now: () => clock })
  assert.deepEqual(await albi.rebuildAlbiCopy(), { contacts: 'rebuilt', organizations: 'rebuilt' })
  assert.deepEqual(store.calls.filter(Array.isArray), [['replaced', 'contacts', 1], ['replaced', 'organizations', 0]])
  store.getAlbiMirrorState = async () => ({ full_at: new Date(clock - 86400000).toISOString(), synced_at: new Date(clock).toISOString() })
  assert.deepEqual(await albi.rebuildAlbiCopy(), { contacts: 'current', organizations: 'current' })
})

test('the rebuild runs early Wednesday Pacific, in even hours only, across daylight saving', () => {
  assert.equal(rebuildDue(new Date('2026-11-04T10:25:00Z')), true) // Wed 2:25 AM PST
  assert.equal(rebuildDue(new Date('2026-11-04T12:25:00Z')), true) // Wed 4:25 AM PST
  assert.equal(rebuildDue(new Date('2026-11-04T11:25:00Z')), false) // odd hour
  assert.equal(rebuildDue(new Date('2026-07-01T09:25:00Z')), true) // Wed 2:25 AM PDT
  assert.equal(rebuildDue(new Date('2026-11-07T09:25:00Z')), false) // Saturday
})

test('the scheduler queues active companies only when due, and the job needs the internal secret', async () => {
  const posts = []
  const supabase = { from: () => ({ select: () => ({ in: async (_field, states) => { assert.deepEqual(states, ['live', 'dry_run']); return { data: [{ company_id: 'c1' }], error: null } } }) }) }
  const options = { supabase, siteUrl: 'https://example.test', internalCronSecret: 's', fetch: async (url, init) => { posts.push([url, init.headers['X-Internal-Cron-Secret'], init.body]); return new Response('') } }
  await createWeeklyCopyScheduler({ ...options, now: () => new Date('2026-11-05T10:25:00Z') })()
  assert.equal(posts.length, 0)
  await createWeeklyCopyScheduler({ ...options, now: () => new Date('2026-11-04T10:25:00Z') })()
  assert.deepEqual(posts, [['https://example.test/.netlify/functions/h2a-albi-copy-rebuild-background', 's', '{"companyId":"c1"}']])
  const run = createCopyRebuildHandler({ requireRequest: async (_event, args) => { assert.equal(args.internalJob, true); return { companyId: 'c1', supabase: {} } }, repository: {},
    makeClients: async () => ({ albi: { rebuildAlbiCopy: async () => ({ contacts: 'rebuilt', organizations: 'current' }) } }) })
  assert.deepEqual(JSON.parse((await run({ httpMethod: 'POST', body: '{"companyId":"c1"}' })).body), { status: 'ok', contacts: 'rebuilt', organizations: 'current' })
  const failed = createCopyRebuildHandler({ requireRequest: async () => ({ companyId: 'c1', supabase: {} }), repository: {},
    makeClients: async () => ({ albi: { rebuildAlbiCopy: async () => { throw new ApiError('rate_limit', { status: 429 }) } } }) })
  assert.equal((await failed({ httpMethod: 'POST', body: '{"companyId":"c1"}' })).statusCode, 500)
})
