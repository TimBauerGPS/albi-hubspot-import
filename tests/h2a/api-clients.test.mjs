import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { HubSpotClient } from '../../netlify/functions/_h2a/hubspotClient.js'
import * as hubspotAdapter from '../../netlify/functions/_h2a/hubspotClient.js'
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
    'addContactCompanyAssociation', 'estimateActivities', 'getAccountInfo', 'getActivity', 'getAssociations', 'getCompanies', 'getCompany', 'getContact', 'getContacts', 'listActivities', 'listOwners', 'updateCompany', 'updateContact',
  ])
  assert.deepEqual(Object.keys(contractMetadata.albi.methods).sort(), [
    'associateContact', 'createActivity', 'createContact', 'createOrganization', 'listActivities', 'listContacts', 'listOptions',
    'listOrganizations', 'updateContact', 'updateOrganization', 'verifyCredentials',
  ])
  for (const method of ['updateContact', 'updateOrganization', 'associateContact']) {
    assert.equal(contractMetadata.albi.methods[method].supported, false)
  }
})

test('HubSpot review updates send sorted allowlisted PATCH properties and project responses', async () => {
  const f = transport([{ ...hs.updateContact, id: 123 }, hs.updateCompany])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  assert.deepEqual(await c.updateContact('123', { phone: '5551112222', email: 'person@example.invalid', address2: '' }), {
    id: '123', properties: { address2: '', email: 'person@example.invalid', phone: '5551112222' },
  })
  assert.deepEqual(await c.updateCompany(456, { name: 'Example', domain: 'example.invalid', address2: '' }), {
    id: '456', properties: { address2: '', domain: 'example.invalid', name: 'Example' },
  })
  assert.deepEqual(f.calls.map(call => [call.method, call.url.toString(), call.body]), [
    ['PATCH', 'https://api.hubapi.com/crm/v3/objects/contacts/123', { properties: { address2: '', email: 'person@example.invalid', phone: '5551112222' } }],
    ['PATCH', 'https://api.hubapi.com/crm/v3/objects/companies/456', { properties: { address2: '', domain: 'example.invalid', name: 'Example' } }],
  ])
  assert.deepEqual(Object.keys(f.calls[0].body.properties), ['address2', 'email', 'phone'])
  assert.deepEqual(Object.keys(f.calls[1].body.properties), ['address2', 'domain', 'name'])
  assert.equal(f.calls[0].headers.Authorization, 'Bearer token')
})

test('HubSpot adds only the default contact-to-company association with a bodyless PUT', async () => {
  const f = transport([{ arbitrary: { secret: 'private' } }])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  assert.deepEqual(await c.addContactCompanyAssociation('123', '456'), { contactId: '123', companyId: '456' })
  assert.equal(hubspotAdapter.HUBSPOT_CONTACT_TO_COMPANY_ASSOCIATION_TYPE, 279)
  assert.equal(f.calls[0].method, 'PUT')
  assert.equal(f.calls[0].url.toString(), 'https://api.hubapi.com/crm/v3/objects/contacts/123/associations/companies/456/279')
  assert.equal(f.calls[0].body, undefined)
})

test('write adapter rejects accessor, symbol and custom prototype properties before network', async () => {
  const f = transport([]), c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  const accessor = Object.defineProperty({}, 'phone', { enumerable: true, get() { throw Error('must not read') } })
  const symbol = { phone: '555' }; symbol[Symbol('hidden')] = 'secret'
  const custom = Object.assign(Object.create({ inherited: true }), { phone: '555' })
  for (const value of [accessor, symbol, custom]) {
    await assert.rejects(c.updateContact('123', value), { category: 'validation' })
  }
  assert.equal(f.calls.length, 0)
})

test('write adapter accepts exactly 500 characters without truncation', async () => {
  const f = transport([{ id: '123', properties: { phone: 'x'.repeat(500) } }])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  assert.equal((await c.updateContact('123', { phone: 'x'.repeat(500) })).properties.phone.length, 500)
  assert.equal(f.calls[0].body.properties.phone.length, 500)
})

test('HubSpot review mutations reject invalid IDs and properties before requesting', async () => {
  const f = transport([])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  for (const method of ['updateContact', 'updateCompany']) {
    for (const value of [{}, null, [], 'name', { unknown: 'x' }, { phone: {} }, { phone: [] }, { phone: null }, { phone: 1 }, { phone: true }, { phone: undefined }, { phone: 'x'.repeat(501) }, { constructor: 'x' }, { email: 'x', name: 'x' }]) {
      await assert.rejects(c[method]('123', value), { category: 'validation', operation: method })
    }
    for (const targetId of ['', '0', '../123', '1?x=y', '01', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      await assert.rejects(c[method](targetId, { phone: 'x' }), { category: 'validation', operation: method })
    }
  }
  for (const [contactId, companyId] of [['../123', '456'], ['123', '0'], ['123', null]]) {
    await assert.rejects(c.addContactCompanyAssociation(contactId, companyId), { category: 'validation' })
  }
  for (const method of ['deleteContact', 'deleteCompany', 'removeContactCompanyAssociation', 'mergeContacts', 'archiveContact']) assert.equal(c[method], undefined)
  assert.equal(f.calls.length, 0)
})

test('HubSpot review mutation failures are sanitized and never retried', async () => {
  for (const method of ['updateContact', 'updateCompany', 'addContactCompanyAssociation']) {
    for (const failure of [new Error('private-token raw provider error'), { statusCode: 503 }, { statusCode: 429, headers: { 'Retry-After': '1' } }]) {
      const f = transport([failure])
      const delays = []
      const c = new HubSpotClient({ token: 'private-token', fetch: f.fetch, maxRetries: 3, sleep: async ms => delays.push(ms) })
      await assert.rejects(c[method]('123', method === 'addContactCompanyAssociation' ? '456' : { phone: 'x' }), error => {
        assert.ok(['transient', 'rate_limit'].includes(error.category))
        assert.equal(error.operation, method)
        assert.equal(JSON.stringify(error).includes('private-token'), false)
        return true
      })
      assert.equal(f.calls.length, 1)
      assert.deepEqual(delays, [])
    }
  }
})

test('HubSpot review mutation responses fail closed for malformed IDs or writable values', async () => {
  for (const response of [{ id: '../123', properties: {} }, { id: '123' }, { id: '123', properties: { phone: {} } }, { id: '123', properties: { phone: null } }, { id: '123', properties: { phone: 'x'.repeat(501) } }]) {
    const f = transport([response])
    await assert.rejects(new HubSpotClient({ token: 'token', fetch: f.fetch }).updateContact('123', { phone: 'x' }), { code: 'malformed_response' })
    assert.equal(f.calls.length, 1)
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
  assert.equal(f.calls[0].body.properties.includes('hs_email_direction'), true)
  assert.equal(f.calls[0].body.after, '100')
  assert.equal(f.calls[0].body.limit, 50)
  const sms = await client.listActivities({ objectType: 'communications', occurredAtGte: start })
  assert.equal(sms.records[0].properties.hs_communication_channel_type, 'SMS')
  assert.equal(f.calls[1].body.filterGroups[0].filters.some(filter => filter.propertyName === 'hs_email_direction'), false)
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

test('targeted contact and company reads use the direct record endpoint', async () => {
  const f = transport([hs.contacts.results[0], hs.companies.results[0], { statusCode: 404 }])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  assert.equal((await c.getContact('201')).properties.email, 'contact@example.invalid')
  assert.equal((await c.getCompany('301')).id, '301')
  assert.equal(await c.getContact('999'), null)
  assert.equal(f.calls[0].url.pathname, '/crm/objects/2026-09/contacts/201')
  assert.equal(f.calls[0].url.searchParams.get('archived'), 'false')
  assert.equal(f.calls[0].url.searchParams.get('properties').includes('email'), true)
  assert.equal(f.calls[1].url.pathname, '/crm/objects/2026-09/companies/301')
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
    { data: [], pagination: null },
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

test('Albi wrapper uses bounded short-page pagination when the documented list omits pagination metadata', async () => {
  const full = transport([accessibleCompany, { data: [al.contacts.data[0]] }])
  assert.deepEqual(await new AlbiClient({ apiKey: 'key', fetch: full.fetch }).listContacts({ cursor: '2', pageSize: 1 }), {
    records: [{ id: '101', firstName: 'Test', lastName: 'Contact', email: 'contact@example.invalid', phoneNumber: '555-555-0100',
      mobileNumber: null, organizationId: '201', contactTypeIds: ['11616'], referralSourceID: '8287', relationshipStatusID: '522' }],
    cursor: '3',
  })

  const last = transport([accessibleCompany, { data: [] }])
  assert.deepEqual(await new AlbiClient({ apiKey: 'key', fetch: last.fetch }).listContacts({ pageSize: 1 }), {
    records: [], cursor: null,
  })

  const oversized = transport([accessibleCompany, { data: [al.contacts.data[0], al.contacts.data[0]] }])
  await assert.rejects(new AlbiClient({ apiKey: 'key', fetch: oversized.fetch }).listContacts({ pageSize: 1 }), {
    code: 'malformed_response', protocolIssue: 'record_count_mismatch',
  })
})

test('Albi wrapper identifies the failed response invariant without retaining provider data', async () => {
  const cases = [
    [{ data: [], pagination: null }, 'pagination_missing'],
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

test('validation rejections expose only a sanitized, capped provider reason', async () => {
  const body = { detail: [{ loc: ['body', 'phoneNumber'], msg: "Invalid phone '555-111-2222' for john@example.com", type: 'value_error', input: 'secret-input' }] }
  const client = createHttpClient({ baseUrl: 'https://albi.example.com', maxRetries: 0, captureValidationReason: true,
    fetch: async () => new Response(JSON.stringify(body), { status: 400 }) })
  const error = await client('/x', { method: 'POST', body: {}, operation: 'createContact' }).catch(e => e)
  assert.equal(error.status, 400)
  assert.equal(error.providerReason, 'body.phoneNumber: Invalid phone [value] for [email]')
  assert.equal(JSON.stringify(error).includes('secret'), false)
  const plain = createHttpClient({ baseUrl: 'https://albi.example.com', maxRetries: 0, captureValidationReason: true,
    fetch: async () => new Response(JSON.stringify({ detail: 'x'.repeat(1000) + ' 123456789' }), { status: 422 }) })
  assert.ok((await plain('/x', { operation: 'o' }).catch(e => e)).providerReason.length <= 200)
  const server = createHttpClient({ baseUrl: 'https://albi.example.com', maxRetries: 0, captureValidationReason: true,
    fetch: async () => new Response(JSON.stringify({ detail: 'boom' }), { status: 500 }) })
  assert.equal((await server('/x', { operation: 'o' }).catch(e => e)).providerReason, null)
  const junk = createHttpClient({ baseUrl: 'https://albi.example.com', maxRetries: 0, captureValidationReason: true,
    fetch: async () => new Response('<html>nope', { status: 400 }) })
  assert.equal((await junk('/x', { operation: 'o' }).catch(e => e)).providerReason, null)
})

test('validation reason capture is opt-in so other providers never retain bodies', async () => {
  const client = createHttpClient({ baseUrl: 'https://api.example.com', maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({ detail: 'private' }), { status: 400 }) })
  assert.equal((await client('/x', { operation: 'o' }).catch(e => e)).providerReason, null)
})

test('Albi create failures add a value-free request and response shape', async () => {
  const f = transport([accessibleCompany, { statusCode: 400, body: { detail: 'Invalid request.', trace: 'secret-trace' } }])
  const albi = new AlbiClient({ apiKey: 'k', fetch: f.fetch })
  const error = await albi.createContact({ firstName: 'Jo', lastName: 'Ro', contactTypeIds: [12], phoneNumber: '555-111-2222' }).catch(e => e)
  assert.equal(error.providerReason, 'Invalid request.')
  assert.equal(error.providerShape, 'sent=firstName,lastName,contactTypeIds,phoneNumber;phone=999-999-9999;types=1x99;resp=detail,trace')
  assert.equal(JSON.stringify(error).includes('secret'), false)
  assert.equal(JSON.stringify(error).includes('Jo'), false)
})

test('Albi validationErrors are reduced to field names and redacted messages', async () => {
  const mk = body => createHttpClient({ baseUrl: 'https://albi.example.com', maxRetries: 0, captureValidationReason: true,
    fetch: async () => new Response(JSON.stringify(body), { status: 400 }) })
  const run = async body => (await mk(body)('/x', { operation: 'o' }).catch(e => e)).providerReason
  assert.equal(await run({ message: 'Invalid request.', validationErrors: [{ field: 'phoneNumber', message: "Phone '555-1234' is not valid" }] }),
    'phoneNumber: Phone [value] is not valid')
  assert.equal(await run({ message: 'Invalid request.', validationErrors: { email: ['Email jo@x.com exists'] } }), 'email: Email [email] exists')
  assert.equal(await run({ message: 'Invalid request.', validationErrors: ['Contact type is required'] }), 'Contact type is required')
  assert.equal(await run({ message: 'Invalid request.', validationErrors: [] }), 'Invalid request.')
})

test('Albi create options load types, statuses and salespeople by name', async () => {
  const f = transport([accessibleCompany,
    [{ id: 12, name: 'Referrer' }], [{ id: 2, name: 'Active' }],
    [{ id: 70, name: 'Ali Brown' }, { id: 71, firstName: 'Sam', lastName: 'Green' }]])
  const options = await new AlbiClient({ apiKey: 'k', fetch: f.fetch }).listCreateOptions()
  assert.deepEqual(options.salespeople, [{ id: '70', label: 'Ali Brown' }, { id: '71', label: 'Sam Green' }])
  assert.deepEqual(options.relationshipTypes, [{ id: '12', label: 'Referrer' }])
  assert.deepEqual(options.relationshipStatuses, [{ id: '2', label: 'Active' }])
  assert.deepEqual(f.calls.slice(1).map(call => call.url.pathname.split('/').at(-1)), ['relationship-types', 'relationship-statuses', 'salespeople'])
})

test('HubSpot owner lookup reads only the owner property and tolerates unowned records', async () => {
  const f = transport([{ id: '42', properties: { hubspot_owner_id: '5' } }, { id: '43', properties: { hubspot_owner_id: null } }])
  const c = new HubSpotClient({ token: 'token', fetch: f.fetch })
  assert.equal(await c.getOwnerId('contacts', '42'), '5')
  assert.equal(await c.getOwnerId('companies', '43'), null)
  assert.equal(f.calls[0].url.searchParams.get('properties'), 'hubspot_owner_id')
  await assert.rejects(c.getOwnerId('deals', '1'))
})

test('an intermittent Albi list failure is retried; persistent ones name the failing page', async () => {
  const flaky = { statusCode: 400, body: { message: 'There was an unexpected error getting contacts according to this search criteria', validationErrors: [] } }
  const ok = { data: [{ id: 5, firstName: 'A', lastName: 'B' }] }
  const delays = []
  const retried = transport([accessibleCompany, flaky, flaky, ok])
  const client = new AlbiClient({ apiKey: 'k', fetch: retried.fetch, sleep: async ms => delays.push(ms), random: () => 0 })
  assert.deepEqual((await client.listContacts({ cursor: '3', pageSize: 100 })).records.map(record => record.id), ['5'])
  assert.equal(retried.calls.length, 4)
  assert.equal(delays.length, 2)
  const failing = transport([accessibleCompany, flaky, flaky, flaky])
  const error = await new AlbiClient({ apiKey: 'k', fetch: failing.fetch, sleep: async () => {}, random: () => 0 })
    .listContacts({ cursor: '7', pageSize: 100 }).catch(e => e)
  assert.equal(error.status, 400)
  assert.match(error.providerShape, /^list=contacts;page=7/)
  const other = transport([accessibleCompany, { statusCode: 400, body: { message: 'Invalid request.' } }])
  await new AlbiClient({ apiKey: 'k', fetch: other.fetch, sleep: async () => {} }).listContacts().catch(() => {})
  assert.equal(other.calls.length, 2)
})

test('a HubSpot record merged into another reads as missing instead of malformed', async () => {
  const merged = { id: '570263829186', properties: { firstname: 'Jaime', hs_merged_object_ids: '535984814798;570263828217' } }
  const direct = transport([merged])
  const c = new HubSpotClient({ token: 'token', fetch: direct.fetch })
  assert.equal(await c.getContact('535984814798'), null)
  const batch = transport([{ status: 'COMPLETE', results: [merged, { id: '42', properties: { firstname: 'Kept' } }] }])
  const records = await new HubSpotClient({ token: 'token', fetch: batch.fetch }).getContacts(['535984814798', '42'])
  assert.deepEqual(records.map(record => record.id), ['42'])
})
