import test from 'node:test'
import assert from 'node:assert/strict'
import { withAlbiMirror, MIRROR_FULL_MS, MIRROR_MEMO_MS } from '../../netlify/functions/_h2a/albiMirror.js'
import { AlbiClient } from '../../netlify/functions/_h2a/albiClient.js'
import { ApiError } from '../../netlify/functions/_h2a/http.js'

function memoryStore() {
  const rows = new Map(), state = new Map(), calls = []
  const key = (company, kind) => `${company}:${kind}`
  return { rows, state, calls,
    async getAlbiMirrorState(company, kind) { return state.get(key(company, kind)) ?? null },
    async readAlbiMirror(company, kind) { calls.push('read'); return [...(rows.get(key(company, kind)) ?? new Map()).values()].map(entry => structuredClone(entry.record)) },
    async upsertAlbiMirror(company, kind, records, seenAt) {
      calls.push(['upsert', records.length])
      const map = rows.get(key(company, kind)) ?? new Map(); rows.set(key(company, kind), map)
      for (const record of records) map.set(record.id, { record: structuredClone(record), seenAt })
      state.set(key(company, kind), { ...state.get(key(company, kind)), synced_at: seenAt })
    },
    async replaceAlbiMirror(company, kind, records, seenAt) {
      calls.push(['replace', records.length])
      const map = new Map(records.map(record => [record.id, { record: structuredClone(record), seenAt }]))
      rows.set(key(company, kind), map)
      state.set(key(company, kind), { full_at: seenAt, synced_at: seenAt })
    },
  }
}
function fakeAlbi(pages) {
  const reads = []
  return { reads,
    async listContacts(args) { reads.push(structuredClone(args)); const list = typeof pages === 'function' ? pages(args) : pages
      const start = (Number(args.cursor ?? '1') - 1) * args.pageSize
      return { records: list.slice(start, start + args.pageSize), cursor: start + args.pageSize < list.length ? String(Number(args.cursor ?? '1') + 1) : null } },
    async listOrganizations() { return { records: [], cursor: null } },
    async createContact() { return { id: '9' } },
  }
}
const contact = (id, extra = {}) => ({ id, firstName: `F${id}`, lastName: 'L', ...extra })

test('the first read walks Albi once and stores it; later pages come from the copy', async () => {
  let clock = Date.parse('2026-11-03T10:00:00Z')
  const store = memoryStore(), albi = fakeAlbi(Array.from({ length: 150 }, (_, index) => contact(String(index + 1))))
  const mirrored = withAlbiMirror(albi, { store, companyId: 'c1', now: () => clock })
  const first = await mirrored.listContacts({ pageSize: 100 })
  const second = await mirrored.listContacts({ cursor: '2', pageSize: 100 })
  assert.deepEqual([first.records.length, first.cursor, second.records.length, second.cursor], [100, '2', 50, null])
  assert.equal(albi.reads.length, 2)
  assert.deepEqual(store.calls, [['replace', 150]])
  assert.deepEqual(await mirrored.createContact({}), { id: '9' })
  // After a write, the next read asks Albi for changes instead of reusing the copy it just read.
  await mirrored.listContacts({ pageSize: 100 })
  assert.equal(albi.reads.at(-1).changedSince, '2026-11-03T09:55:00.000Z')
})

test('a later read asks Albi only for what changed since the last read, with overlap', async () => {
  let clock = Date.parse('2026-11-03T10:00:00Z')
  const store = memoryStore()
  const albi = fakeAlbi(args => args.changedSince ? [contact('2', { phoneNumber: '555-111-2222' }), contact('3')] : [contact('1'), contact('2')])
  const mirrored = withAlbiMirror(albi, { store, companyId: 'c1', now: () => clock })
  await mirrored.listContacts({ pageSize: 100 })
  clock += MIRROR_MEMO_MS + 60000
  const next = await mirrored.listContacts({ pageSize: 100 })
  assert.equal(albi.reads.at(-1).changedSince, '2026-11-03T09:55:00.000Z')
  assert.deepEqual(next.records.map(record => [record.id, record.phoneNumber ?? null]), [['1', null], ['2', '555-111-2222'], ['3', null]])
})

test('once a day the read is a full walk, which drops records deleted in Albi', async () => {
  let clock = Date.parse('2026-11-03T10:00:00Z'), list = [contact('1'), contact('2')]
  const store = memoryStore(), albi = fakeAlbi(() => list)
  const mirrored = withAlbiMirror(albi, { store, companyId: 'c1', now: () => clock })
  await mirrored.listContacts({ pageSize: 100 })
  list = [contact('1')]
  clock += MIRROR_FULL_MS
  const next = await mirrored.listContacts({ pageSize: 100 })
  assert.equal(albi.reads.at(-1).changedSince, undefined)
  assert.deepEqual(next.records.map(record => record.id), ['1'])
})

test('reads go straight to Albi when the copy is unavailable, and Albi failures still surface', async () => {
  const store = memoryStore()
  store.getAlbiMirrorState = async () => { throw new Error('relation "h2a_albi_mirror_state" does not exist') }
  const albi = fakeAlbi([contact('1')])
  const mirrored = withAlbiMirror(albi, { store, companyId: 'c1' })
  assert.deepEqual((await mirrored.listContacts({ pageSize: 25 })).records.map(record => record.id), ['1'])
  assert.deepEqual((await mirrored.listContacts({ pageSize: 25 })).records.map(record => record.id), ['1'])
  const failing = withAlbiMirror({ listContacts: async () => { throw new ApiError('rate_limit', { status: 429 }) } }, { store: memoryStore(), companyId: 'c1' })
  await assert.rejects(failing.listContacts({ pageSize: 25 }), { category: 'rate_limit' })
  assert.equal(withAlbiMirror(albi, {}), albi)
})

test('the Albi client sends changedSince on every page of a walk and refuses a malformed one', async () => {
  const calls = []
  const fetch = async url => {
    calls.push(new URL(url))
    const path = new URL(url).pathname
    const body = path.endsWith('/relationship-statuses') ? { data: [{ id: '1', name: 'Active', companyId: '1319' }] }
      : path.startsWith('/api/v1/company/') ? { data: { id: '1319', name: 'Allied' } }
        : { data: [contact('5')], continuationToken: calls.filter(call => call.pathname === '/api/v1/contacts').length === 1 ? 'next' : null }
    return new Response(JSON.stringify(body))
  }
  const client = new AlbiClient({ apiKey: 'k', fetch })
  await client.listContacts({ pageSize: 1, changedSince: '2026-11-03T09:55:00.000Z' })
  await client.listContacts({ cursor: '2', pageSize: 1, changedSince: '2026-11-03T09:55:00.000Z' })
  const reads = calls.filter(call => call.pathname === '/api/v1/contacts')
  assert.deepEqual(reads.map(call => [call.searchParams.get('changedSince'), call.searchParams.get('continuationToken')]),
    [['2026-11-03T09:55:00.000Z', null], ['2026-11-03T09:55:00.000Z', 'next']])
  await assert.rejects(client.listContacts({ changedSince: 'yesterday' }), { category: 'validation' })
})
