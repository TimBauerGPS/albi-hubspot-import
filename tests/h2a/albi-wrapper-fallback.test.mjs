import test from 'node:test'
import assert from 'node:assert/strict'
import { AlbiWrapperClient, readAlbiWrapperCredential, withAlbiActivityFallback } from '../../netlify/functions/_h2a/albiWrapperClient.js'
import { reserveDelivery } from '../../netlify/functions/_h2a/deliveries.js'
import { ApiError } from '../../netlify/functions/_h2a/http.js'
import { makeSourceMarker } from '../../netlify/functions/_h2a/keys.js'

const company = { data: [{ companyId: '1319', name: 'Allied' }] }
function wrapperFetch(pages, base = company) {
  const calls = []
  const fetch = async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, headers: options.headers })
    const body = parsed.pathname === '/v1/companies' ? base : pages.shift()
    return body?.statusCode ? new Response('{}', { status: body.statusCode }) : new Response(JSON.stringify(body))
  }
  return { fetch, calls }
}
const refused = () => { throw new ApiError('permission', { operation: 'listActivities', status: 403, requiredScope: 'Permissions.Activities.View' }) }
const publicApi = (listActivities, id = '1319') => ({ listActivities, verifyCredentials: async () => ({ company: { id } }), createActivity: async () => ({ id: '9' }) })

test('the wrapper reads a target’s activities with its own key and paging', async () => {
  const f = wrapperFetch([{ data: [{ id: 401, notes: 'Source: HubSpot call 7', source: 'hubspot' }], pagination: { page: 1, pageSize: 100, totalPages: 2, total: 101 } },
    { data: [{ id: 402 }], pagination: { page: 2, pageSize: 100, totalPages: 2, total: 101 } }])
  const client = new AlbiWrapperClient({ apiKey: 'wrapper-key', fetch: f.fetch })
  assert.deepEqual(await client.listActivities({ contactId: '101', page: 1 }),
    { records: [{ id: '401', notes: 'Source: HubSpot call 7', source: 'hubspot' }], cursor: '2' })
  assert.deepEqual(await client.listActivities({ contactId: '101', page: '2' }), { records: [{ id: '402', notes: '', source: null }], cursor: null })
  const read = f.calls.find(call => call.url.pathname.endsWith('/activities'))
  assert.equal(read.url.origin, 'https://albi.guardianrestoration.com')
  assert.equal(read.url.pathname, '/v1/companies/1319/activities')
  assert.equal(read.url.searchParams.get('contactId'), '101')
  assert.equal(read.headers['X-API-Key'], 'wrapper-key')
  assert.equal(read.headers.Authorization, undefined)
})

test('activity reads use the Public API when allowed and the wrapper only on its permission refusal', async () => {
  const wrapper = { company: async () => '1319', listActivities: async () => ({ records: [{ id: '5', notes: 'x' }], cursor: null }) }
  assert.equal(withAlbiActivityFallback(publicApi(refused), null).listActivities, refused)
  const allowed = withAlbiActivityFallback(publicApi(async () => ({ records: [], cursor: null })), { company: () => { throw Error('unused') }, listActivities: () => { throw Error('unused') } })
  assert.deepEqual(await allowed.listActivities({}), { records: [], cursor: null })
  assert.deepEqual((await withAlbiActivityFallback(publicApi(refused), wrapper).listActivities({ contactId: '1' })).records[0].id, '5')
  const busy = withAlbiActivityFallback(publicApi(async () => { throw new ApiError('rate_limit', { status: 429 }) }), wrapper)
  await assert.rejects(busy.listActivities({}), { category: 'rate_limit' })
  assert.deepEqual(await withAlbiActivityFallback(publicApi(refused), wrapper).createActivity({}), { id: '9' })
})

test('a wrapper key for another company is refused instead of reporting nothing found', async () => {
  const wrapper = { company: async () => '7777', listActivities: async () => ({ records: [], cursor: null }) }
  await assert.rejects(withAlbiActivityFallback(publicApi(refused), wrapper).listActivities({ contactId: '1' }), { code: 'company_access_invalid' })
})

function retryStore() {
  const row = { id: 'd1', state: 'reserved', attempt_count: 2 }, transitions = []
  return { transitions, reserve: async () => ({ acquired: true, isNew: false, row, previous: { state: 'failed', next_attempt_at: '2026-11-03T10:00:00Z' } }),
    transition: async ({ patch }) => { transitions.push(patch); return { updated: true, row: { ...row, ...patch } } } }
}
const identity = { companyId: 'c1', portalId: '123', objectType: 'calls', activityId: '77', albiTargetType: 'contact', albiTargetId: '101' }

test('a retried delivery found through the wrapper is reconciled and never resent; one not found may be sent', async () => {
  const marker = makeSourceMarker({ objectType: 'call', activityId: '77' })
  const found = withAlbiActivityFallback(publicApi(refused), { company: async () => '1319',
    listActivities: async () => ({ records: [{ id: '500', notes: `Subject: Hi\n${marker}` }], cursor: null }) })
  const store = retryStore()
  const result = await reserveDelivery({ identity, store, albi: found, now: '2026-11-03T11:00:00Z' })
  assert.equal(result.disposition, 'reconciled')
  assert.equal(store.transitions[0].albi_activity_id, '500')
  const absent = withAlbiActivityFallback(publicApi(refused), { company: async () => '1319', listActivities: async () => ({ records: [], cursor: null }) })
  assert.equal((await reserveDelivery({ identity, store: retryStore(), albi: absent, now: '2026-11-03T11:00:00Z' })).safeToCreate, true)
})

test('with neither read available a retry stops before sending', async () => {
  await assert.rejects(reserveDelivery({ identity, store: retryStore(), albi: publicApi(refused), now: '2026-11-03T11:00:00Z' }), { category: 'permission' })
  const failing = withAlbiActivityFallback(publicApi(refused), { company: async () => '1319', listActivities: async () => { throw new ApiError('auth', { status: 401 }) } })
  await assert.rejects(reserveDelivery({ identity, store: retryStore(), albi: failing, now: '2026-11-03T11:00:00Z' }), { category: 'auth' })
})

test('a wrapper credential that cannot be read counts as none', async () => {
  assert.equal(await readAlbiWrapperCredential({ rpc: async () => ({ error: { message: 'function does not exist' } }) }, 'c1'), null)
  assert.equal(await readAlbiWrapperCredential({ rpc: async () => { throw Error('down') } }, 'c1'), null)
  assert.equal(await readAlbiWrapperCredential({ rpc: async () => ({ data: null }) }, 'c1'), null)
  assert.deepEqual(await readAlbiWrapperCredential({ rpc: async () => ({ data: { ciphertext: 'x', iv: 'y', tag: 'z', key_version: 1 } }) }, 'c1'),
    { ciphertext: 'x', iv: 'y', tag: 'z', key_version: 1 })
})

test('the connection check passes activity reads through the wrapper, and names the wrapper scope when that fails', async () => {
  const { runPreflight } = await import('../../netlify/functions/_h2a/preflight.js')
  const capabilities = Object.fromEntries(['contacts_create', 'organizations_create', 'activities_create', 'contacts_update', 'organizations_update', 'contacts_associate_organization'].map(key => [key, 'verified_on_first_use']))
  const options = Object.fromEntries(['contactTypes', 'organizationTypes', 'relationshipTypes', 'referralSources', 'relationshipStatuses', 'activityTypes'].map(group => [group, [{ id: '1', label: 'Example' }]]))
  const clients = wrapper => ({
    hubspot: { getAccountInfo: async () => ({ portalId: '123' }), checkRead: async () => [], listActivities: async () => ({ records: [], after: null, total: 0 }) },
    albi: withAlbiActivityFallback({ ...publicApi(refused), verifyCredentials: async () => ({ authenticated: true, company: { id: '1319', name: 'Allied' }, capabilities }),
      listContacts: async () => ({ records: [], cursor: null }), listOrganizations: async () => ({ records: [], cursor: null }), listOptions: async () => structuredClone(options) }, wrapper),
  })
  const passing = await runPreflight(clients({ company: async () => '1319', listActivities: async () => ({ records: [], cursor: null }) }))
  assert.equal(passing.status, 'valid')
  const failing = await runPreflight(clients({ company: async () => '1319', listActivities: async () => { throw new ApiError('permission', { status: 403, requiredScope: 'activities:list' }) } }))
  const check = failing.details.albi.checks.find(item => item.capability === 'activities_read')
  assert.deepEqual([failing.status, check.reason, check.requiredScope], ['invalid', 'permission_denied', 'activities:list'])
})
