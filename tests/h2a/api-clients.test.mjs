import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { HubSpotClient } from '../../netlify/functions/_h2a/hubspotClient.js'
import { AlbiClient } from '../../netlify/functions/_h2a/albiClient.js'
import { createHttpClient } from '../../netlify/functions/_h2a/http.js'

const hs = JSON.parse(readFileSync(new URL('./fixtures/hubspot/responses.json', import.meta.url)))
const al = JSON.parse(readFileSync(new URL('./fixtures/albi/responses.json', import.meta.url)))
const contractMetadata = JSON.parse(readFileSync(new URL('./fixtures/metadata.json', import.meta.url)))
const accessibleCompany = { data: [{ companyId: '1319', name: 'Allied Restoration Services Inc' }] }
const start = '2026-10-01T07:00:00.000Z'
const end = '2026-10-02T07:00:00.000Z'
function transport(responses) {
  const calls = []
  const fetch = async (url, options) => {
    calls.push({ url: new URL(url), ...options, body: options.body ? JSON.parse(options.body) : undefined })
    const next = responses.shift()
    assert.ok(next, 'Unexpected extra network request')
    if (next instanceof Error) throw next
    const status = next.statusCode ?? 200
    const responseBody = [204, 205, 304].includes(status) ? null : JSON.stringify(next.body ?? next)
    return new Response(responseBody, { status, headers: next.headers })
  }
  return { fetch, calls }
}

test('contract metadata covers every adapter method and records unsupported Albi contracts', () => {
  assert.deepEqual(Object.keys(contractMetadata.hubspot.methods).sort(), [
    'estimateActivities', 'getAccountInfo', 'getActivity', 'getAssociations', 'getCompanies', 'getContacts', 'listActivities', 'listOwners',
  ])
  assert.deepEqual(Object.keys(contractMetadata.albi.methods).sort(), [
    'associateContact', 'createActivity', 'createContact', 'createOrganization', 'listActivities', 'listContacts', 'listOptions',
    'listOrganizations', 'updateContact', 'updateOrganization', 'verifyCredentials',
  ])
  for (const method of ['updateContact', 'updateOrganization', 'associateContact']) {
    assert.equal(contractMetadata.albi.methods[method].supported, false)
  }
})

test('owner cursors stay on the verified origin; account info normalizes portal ID', async () => {
  const f = transport([hs.account, hs.owners, hs.ownersLast])
  const client = new HubSpotClient({ token: 'private-token', fetch: f.fetch })
  assert.equal((await client.getAccountInfo()).portalId, '123456')
  assert.deepEqual((await client.listOwners()).map(x => x.id), ['42', '43'])
  assert.equal(f.calls[0].url.pathname, '/account-info/2026-09/details')
  assert.equal(f.calls[2].url.searchParams.get('after'), 'cursor-2')
  assert.ok(f.calls.every(call => call.url.origin === 'https://api.hubapi.com'))
})

test('direct CRM emails and SMS use occurrence filters, never marketing or createdAt', async () => {
  const f = transport([hs.activities, hs.communications])
  const client = new HubSpotClient({ token: 'private-token', fetch: f.fetch })
  const email = await client.listActivities({ objectType: 'emails', occurredAtGte: start, occurredAtLt: end, after: '100', limit: 50 })
  assert.equal(email.records[0].occurredAt, '2026-10-01T10:00:00.000Z')
  assert.equal(email.after, '200')
  assert.equal(f.calls[0].url.pathname, '/crm/objects/2026-09/emails/search')
  assert.deepEqual(f.calls[0].body.filterGroups, [{ filters: [
    { propertyName: 'hs_timestamp', operator: 'GTE', value: start },
    { propertyName: 'hs_timestamp', operator: 'LT', value: end },
  ] }])
  assert.equal(f.calls[0].body.after, '100')
  assert.equal(f.calls[0].body.limit, 50)
  const sms = await client.listActivities({ objectType: 'communications', occurredAtGte: start })
  assert.equal(sms.records[0].properties.hs_communication_channel_type, 'SMS')
  await assert.rejects(client.listActivities({ objectType: 'marketing_emails', occurredAtGte: start }), { category: 'validation' })
  assert.equal(f.calls.length, 2)
})

test('search estimates flag the 10000 result cap and reject malformed totals', async () => {
  const f = transport([{ ...hs.activities, total: 12000 }, { results: [], total: 'oops' }])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  assert.deepEqual(await c.estimateActivities({ objectType: 'notes', occurredAtGte: start }), { count: 10000, capped: true })
  assert.equal(f.calls[0].body.limit, 1)
  await assert.rejects(c.estimateActivities({ objectType: 'notes', occurredAtGte: start }), { code: 'malformed_response' })
})

test('associations traverse all pages and normalize IDs; contacts/companies use batch reads', async () => {
  const f = transport([hs.associations, hs.associationsLast, hs.contacts, hs.companies])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  assert.deepEqual(await c.getAssociations({ objectType: 'emails', objectIds: ['101'], toObjectTypes: ['contacts'] }), [
    { fromId: '101', toObjectType: 'contacts', toIds: ['201', '202'] },
  ])
  assert.equal(f.calls[1].url.searchParams.get('after'), 'next-association')
  assert.equal((await c.getContacts(['201']))[0].properties.email, 'contact@example.invalid')
  assert.equal((await c.getCompanies(['301']))[0].id, '301')
  assert.equal(f.calls[2].url.pathname, '/crm/objects/2026-09/contacts/batch/read')
  assert.deepEqual(f.calls[2].body.inputs, [{ id: '201' }])
})

test('targeted activity read requests exactly the conflict activity identity', async () => {
  const activity = hs.activities.results[0]
  const f = transport([{ status: 'COMPLETE', numErrors: 0, results: [activity] }])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  assert.equal((await c.getActivity('emails', '101')).occurredAt, '2026-10-01T10:00:00.000Z')
  assert.equal(f.calls[0].url.pathname, '/crm/objects/2026-09/emails/batch/read')
  assert.deepEqual(f.calls[0].body.inputs, [{ id: '101' }])
  assert.equal(f.calls[0].body.properties.includes('hs_email_direction'), true)
  await assert.rejects(c.getActivity('marketing_emails', '101'), { category: 'validation' })
  assert.equal(f.calls.length, 1)
})

test('HTTP honors Retry-After then bounded transient retry, without exposing provider text', async () => {
  const f = transport([{ statusCode: 429, headers: { 'Retry-After': '2' } }, { statusCode: 500 }, hs.account])
  const delays = []
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch, sleep: async ms => delays.push(ms), random: () => 0 })
  assert.equal((await c.getAccountInfo()).portalId, '123456')
  assert.deepEqual(delays, [2000, 500])
  assert.equal(f.calls.length, 3)
  for (const [statusCode, category] of [[401, 'auth'], [403, 'permission'], [400, 'validation'], [404, 'permanent']]) {
    const bad = transport([{ statusCode, body: { message: 'private-token raw exception' } }])
    await assert.rejects(new HubSpotClient({ token: 'private-token', fetch: bad.fetch }).getAccountInfo(), error => {
      assert.equal(error.category, category)
      assert.ok(!JSON.stringify(error).includes('private-token'))
      assert.ok(!error.message.includes('raw exception'))
      return true
    })
    assert.equal(bad.calls.length, 1)
  }
})

test('retries stop at bound and long Retry-After is deferred without an early request', async () => {
  const f = transport([{ statusCode: 503 }, { statusCode: 503 }, { statusCode: 503 }])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch, sleep: async () => {} })
  await assert.rejects(c.getAccountInfo(), { category: 'transient' })
  assert.equal(f.calls.length, 3)
  const limited = transport([{ statusCode: 429, headers: { 'Retry-After': '120' } }])
  await assert.rejects(new HubSpotClient({ token: 'token', fetch: limited.fetch }).getAccountInfo(), { category: 'rate_limit', retryAfterMs: 120000 })
  assert.equal(limited.calls.length, 1)
})

test('HTTP deadline sanitizes hung fetch and JSON parsing errors', async () => {
  const client = createHttpClient({ baseUrl: 'https://api.hubapi.com', fetch: async () => new Promise(() => {}), timeoutMs: 5, maxRetries: 0 })
  await assert.rejects(client('/test', { operation: 'read' }), { category: 'transient' })
  const invalid = createHttpClient({ baseUrl: 'https://api.hubapi.com', fetch: async () => new Response('token raw invalid JSON'), maxRetries: 0 })
  await assert.rejects(invalid('/test'), { code: 'malformed_response' })
})

test('malformed records, invalid input and repeating pagination fail closed', async () => {
  const f = transport([{ results: [{ properties: {} }], total: 1 }, hs.owners, hs.owners])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  await assert.rejects(c.listActivities({ objectType: 'emails', occurredAtGte: start }), { code: 'malformed_response' })
  await assert.rejects(c.listOwners(), { code: 'pagination_loop' })
  await assert.rejects(c.getContacts(['../steal']), { category: 'validation' })
})

test('Albi wrapper discovers exactly one company and scopes every read to it', async () => {
  const f = transport([accessibleCompany, al.contacts, al.organizations, al.relationshipTypes, al.referralSources, al.relationshipStatuses, al.activityTypes])
  const c = new AlbiClient({ apiKey: 'private-key', fetch: f.fetch })
  assert.deepEqual(await c.verifyCredentials(), {
    authenticated: true,
    company: { id: '1319', name: 'Allied Restoration Services Inc' },
    capabilities: {
      contacts_create: 'verified_on_first_use',
      organizations_create: 'verified_on_first_use',
      activities_create: 'verified_on_first_use',
      contacts_update: 'handled_through_conflicts',
      organizations_update: 'handled_through_conflicts',
      contacts_associate_organization: 'handled_through_conflicts',
    },
  })
  const contacts = await c.listContacts({ cursor: '2', pageSize: 1 })
  assert.equal(contacts.records[0].id, '101')
  assert.equal(contacts.cursor, '3')
  assert.equal(f.calls[0].url.pathname, '/v1/companies')
  assert.equal(f.calls[0].headers['X-API-Key'], 'private-key')
  assert.equal(f.calls[0].headers.ApiKey, undefined)
  assert.equal(f.calls[1].url.searchParams.get('page'), '2')
  assert.equal((await c.listOrganizations({ pageSize: 25 })).cursor, null)
  const options = await c.listOptions()
  assert.deepEqual(options.contactTypes, [{ id: '11616', label: 'Customer' }, { id: '11611', label: 'Referrer' }])
  assert.deepEqual(options.organizationTypes, options.relationshipTypes)
  assert.equal(options.activityTypes[2].label, 'Text Message')
  assert.ok(f.calls.slice(1).every(call => call.url.pathname.startsWith('/v1/companies/1319/')))
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/companies').length, 1)
})

test('Albi wrapper fails closed for zero, multiple, or malformed authorized companies', async () => {
  const invalid = [
    { data: [] },
    { data: [{ companyId: '1319', name: 'Allied' }, { companyId: '1351', name: 'Sandbox' }] },
    { data: 'not-an-array' },
    { data: [{ companyId: '', name: 'Allied' }] },
    { data: [{ companyId: '../1319', name: 'Allied' }] },
    { data: [{ companyId: '1319', name: `${'a'.repeat(201)}` }] },
    { data: [{ companyId: '1319', name: 'Allied\u0000' }] },
  ]
  for (const response of invalid) {
    const f = transport([response])
    const client = new AlbiClient({ apiKey: 'private-key', fetch: f.fetch })
    await assert.rejects(client.listContacts(), { category: 'permanent', code: 'company_access_invalid' })
    assert.equal(f.calls.length, 1)
  }
})

test('Albi wrapper reports authentication rejection from company discovery', async () => {
  const f = transport([{ statusCode: 401, body: { detail: 'private-key raw provider text' } }])
  await assert.rejects(new AlbiClient({ apiKey: 'private-key', fetch: f.fetch }).verifyCredentials(), error => {
    assert.equal(error.category, 'auth')
    assert.equal(error.status, 401)
    assert.equal(JSON.stringify(error).includes('private-key'), false)
    return true
  })
  assert.equal(f.calls.length, 1)
})

test('Albi creates validate payloads, preserve source fields, and normalize success IDs', async () => {
  const f = transport([accessibleCompany, al.createContact, al.createOrganization, al.createActivity, al.activities])
  const c = new AlbiClient({ apiKey: 'key', fetch: f.fetch })
  await assert.rejects(c.createContact({ firstName: 'Test', contactTypeIds: [11616] }), { category: 'validation', operation: 'createContact' })
  await assert.rejects(c.createOrganization({ name: 'Example' }), { category: 'validation', operation: 'createOrganization' })
  await assert.rejects(c.createActivity({ typeId: 6711, date: start }), { category: 'validation', operation: 'createActivity' })
  assert.deepEqual(await c.createContact({ firstName: 'Test', lastName: 'Contact', contactTypeIds: [11616] }), { id: '102' })
  assert.deepEqual(await c.createOrganization({ name: 'Example', organizationTypeIds: [11616] }), { id: '202' })
  assert.deepEqual(await c.createActivity({ contactId: 101, typeId: 6711, date: start, notes: 'Test', source: 'hubspot', sourceId: 102 }), { id: '402' })
  assert.equal(f.calls[3].body.sourceId, 102)
  assert.equal(f.calls[3].body.source, 'hubspot')
  assert.equal(f.calls[3].url.pathname, '/v1/companies/1319/activities')
  const activities = await c.listActivities({ contactId: '101', startDate: '2024-06-01', endDate: '2024-06-06', page: 2 })
  assert.equal(activities.records[0].sourceId, '102')
  assert.equal(activities.cursor, null)
  assert.equal(f.calls[4].url.searchParams.get('page'), '2')
  assert.deepEqual(f.calls.slice(1, 4).map(call => call.method), ['POST', 'POST', 'POST'])
})

test('Albi wrapper validates empty and malformed list pagination envelopes', async () => {
  const empty = transport([accessibleCompany, {
    data: [], pagination: { page: 1, pageSize: 25, totalPages: 1, total: 0 },
  }])
  assert.deepEqual(await new AlbiClient({ apiKey: 'key', fetch: empty.fetch }).listContacts(), {
    records: [], cursor: null,
  })

  for (const response of [
    { data: [] },
    { data: [], pagination: { page: 2, pageSize: 25, totalPages: 2, total: 26 } },
    { data: [], pagination: { page: 1, pageSize: 100, totalPages: 1, total: 0 } },
    { data: [], pagination: { page: 1, pageSize: 25, totalPages: 2, total: 0 } },
  ]) {
    const malformed = transport([accessibleCompany, response])
    await assert.rejects(new AlbiClient({ apiKey: 'key', fetch: malformed.fetch }).listContacts(), {
      code: 'malformed_response',
    })
  }
})

test('Albi wrapper identifies the failed response invariant without retaining provider data', async () => {
  const cases = [
    [{ data: [] }, 'pagination_missing'],
    [{ data: [], pagination: { page: 2, pageSize: 25, totalPages: 2, total: 26 } }, 'page_mismatch'],
    [{ data: [], pagination: { page: 1, pageSize: 100, totalPages: 1, total: 0 } }, 'page_size_mismatch'],
    [{ data: [{}], pagination: { page: 1, pageSize: 25, totalPages: 1, total: 1 } }, 'record_id_invalid'],
  ]
  for (const [response, protocolIssue] of cases) {
    const malformed = transport([accessibleCompany, response])
    await assert.rejects(new AlbiClient({ apiKey: 'key', fetch: malformed.fetch }).listContacts(), error => {
      assert.equal(error.code, 'malformed_response')
      assert.equal(error.protocolIssue, protocolIssue)
      assert.equal(Object.hasOwn(error, 'response'), false)
      assert.equal(Object.hasOwn(error, 'body'), false)
      return true
    })
  }
})

test('Albi never retries ambiguous create responses; application errors and malformed IDs fail', async () => {
  for (const response of [{ statusCode: 503 }, { status: 2, data: 0, message: 'private-key' }, { status: 1 }]) {
    const f = transport([accessibleCompany, response])
    await assert.rejects(new AlbiClient({ apiKey: 'private-key', fetch: f.fetch }).createContact({ firstName: 'Test', lastName: 'Contact', contactTypeIds: [1] }))
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  }
})

test('Albi wrapper attaches only the known required scope to permission failures', async () => {
  const f = transport([accessibleCompany, { statusCode: 403, body: { detail: 'private-key raw provider text' } }])
  const client = new AlbiClient({ apiKey: 'private-key', fetch: f.fetch })
  await assert.rejects(
    client.createContact({ firstName: 'A', lastName: 'B', contactTypeIds: [1] }),
    error => error.category === 'permission' && error.requiredScope === 'contacts:create' &&
      !JSON.stringify(error).includes('private-key'),
  )
  assert.equal(f.calls.length, 2)
})

test('Albi unverified update/association contracts fail without network calls', async () => {
  const f = transport([])
  const c = new AlbiClient({ apiKey: 'key', fetch: f.fetch })
  for (const promise of [c.updateContact('101', {}), c.updateOrganization('201', {}), c.associateContact({ contactId: '101', organizationId: '201' })]) {
    await assert.rejects(promise, { category: 'permanent', code: 'unsupported_contract' })
  }
  assert.equal(f.calls.length, 0)
})

test('Albi payload and list validation rejects undocumented fields, unsafe IDs, and invalid dates before fetch', async () => {
  const f = transport([]), c = new AlbiClient({ apiKey: 'key', fetch: f.fetch })
  for (const work of [
    () => c.createContact({ firstName: 'A', lastName: 'B', contactTypeIds: [1], unexpected: true }),
    () => c.createActivity({ contactId: 1, typeId: 2, date: '2026-02-30', notes: 'Example' }),
    () => c.listContacts({ cursor: '0' }),
    () => c.listContacts({ arbitraryQuery: 'secret' }),
    () => c.listActivities({ startDate: '2026-99-99' }),
    () => c.createActivity({ contactId: 1, typeId: 2, date: start, notes: 'Example', sourceId: 9007199254740992 }),
  ]) await assert.rejects(work, { category: 'validation' })
  assert.equal(f.calls.length, 0)
})
