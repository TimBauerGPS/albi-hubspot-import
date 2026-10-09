import assert from 'node:assert/strict'
import test from 'node:test'
import { runPreflight } from '../../netlify/functions/_h2a/preflight.js'
import { createPreflightHandler } from '../../netlify/functions/h2a-preflight.js'
import { createEstimateHandler } from '../../netlify/functions/h2a-estimate.js'
import { encryptSecret } from '../../netlify/functions/_h2a/crypto.js'
import { ApiError } from '../../netlify/functions/_h2a/http.js'

const types = ['meetings', 'calls', 'emails', 'communications', 'notes']
const groups = ['contactTypes', 'organizationTypes', 'relationshipTypes', 'referralSources', 'relationshipStatuses', 'activityTypes']
const writes = ['contacts_create', 'organizations_create', 'contacts_update', 'organizations_update', 'contacts_associate_organization', 'activities_create']
const unsupportedWrites = ['contacts_update', 'organizations_update', 'contacts_associate_organization']
const createScopes = { contacts_create: 'contacts:create', organizations_create: 'organizations:create', activities_create: 'activities:create' }
const capabilityStates = Object.fromEntries(writes.map(key => [key,
  unsupportedWrites.includes(key) ? 'handled_through_conflicts' : 'verified_on_first_use']))
const options = Object.fromEntries(groups.map(group => [group, [{ id: '1', label: 'Example' }]]))
function clients({ missing, unavailableGroup, onRead = () => {} } = {}) {
  const calls = []
  const check = key => { calls.push(key); if (missing === key) throw new Error('private-token raw provider failure') }
  return {
    calls,
    hubspot: {
      async getAccountInfo() { onRead(); check('account'); return { portalId: '123' } },
      async checkRead(type) { check(`${type}_read`); return [] },
      async listActivities({ objectType }) { check(`${objectType}_read`); return { records: [], after: null, total: 0 } },
      async estimateActivities({ objectType, occurredAtGte }) { calls.push({ objectType, occurredAtGte }); return { count: objectType === 'notes' ? 10000 : 1, capped: objectType === 'notes' } },
    },
    albi: {
      async verifyCredentials() { check('credentials'); return { authenticated: true,
        company: { id: '1319', name: 'Allied Restoration Services Inc' }, capabilities: { ...capabilityStates } } },
      async listContacts() { check('albi_contacts_read'); return { records: [], cursor: null } },
      async listOrganizations() { check('organizations_read'); return { records: [], cursor: null } },
      async listActivities() { check('activities_read'); return { records: [], cursor: null } },
      async listOptions() { check('options_read'); return { ...structuredClone(options), ...(unavailableGroup ? { [unavailableGroup]: [] } : {}) } },
    },
  }
}

test('preflight allows activation when required reads pass and writes are informational', async () => {
  const result = await runPreflight(clients())
  assert.equal(result.status, 'valid')
  assert.deepEqual(result.details.albi.company, { id: '1319', name: 'Allied Restoration Services Inc' })
  assert.equal(result.details.albi.checks.find(check => check.capability === 'company_access').status, 'valid')
  for (const capability of ['contacts_create', 'organizations_create', 'activities_create']) {
    const check = result.details.albi.checks.find(item => item.capability === capability)
    assert.equal(check.status, 'informational')
    assert.equal(check.reason, 'verified_on_first_use')
    assert.equal(check.requiredScope, createScopes[capability])
  }
  for (const capability of unsupportedWrites) {
    const check = result.details.albi.checks.find(item => item.capability === capability)
    assert.equal(check.status, 'informational')
    assert.equal(check.reason, 'handled_through_conflicts')
  }
  assert.ok(!result.details.missing.includes('Albi contact updates'))

  for (const missing of [...types.map(type => `${type}_read`), 'contacts_read', 'companies_read', 'albi_contacts_read', 'organizations_read', 'activities_read', 'options_read', 'account', 'credentials']) {
    const result = await runPreflight(clients({ missing }))
    assert.equal(result.status, 'invalid', missing)
    assert.ok(!JSON.stringify(result).includes('private-token'))
  }
})

test('missing permissions and individual option groups have fixed readable labels', async () => {
  const denied = await runPreflight(clients({ missing: 'emails_read' }))
  assert.ok(denied.details.missing.includes('HubSpot direct CRM email reads'))
  for (const [group, label] of [['contactTypes', 'Albi contact type options'], ['organizationTypes', 'Albi organization type options'], ['relationshipTypes', 'Albi relationship type options'], ['referralSources', 'Albi referral source options'], ['relationshipStatuses', 'Albi relationship status options'], ['activityTypes', 'Albi activity type options']]) {
    const result = await runPreflight(clients({ unavailableGroup: group }))
    assert.equal(result.status, 'invalid')
    assert.ok(result.details.missing.includes(label), group)
  }
  const readFailure = await runPreflight(clients({ missing: 'activities_read' }))
  assert.equal(readFailure.details.albi.checks.find(check => check.capability === 'activities_create').status, 'informational')
  assert.equal(readFailure.details.albi.checks.find(check => check.capability === 'activities_read').status, 'invalid')
})

test('Albi failures retain only safe actionable diagnostic reasons', async () => {
  const c = clients()
  c.albi.listContacts = async () => { throw new ApiError('auth', { operation: 'listContacts', status: 401 }) }
  c.albi.listOrganizations = async () => { throw new ApiError('permission', { operation: 'listOrganizations', status: 403 }) }
  c.albi.listActivities = async () => { throw new ApiError('transient', { operation: 'listActivities', status: 503 }) }
  c.albi.listOptions = async () => { throw new ApiError('permission', { operation: 'listActivityTypes', status: 403,
    requiredScope: 'options.activity-types:list', message: 'private-token raw provider failure' }) }

  const result = await runPreflight(c)
  assert.equal(result.status, 'invalid')
  const byCapability = Object.fromEntries(result.details.albi.checks.map(check => [check.capability, check]))
  assert.equal(byCapability.contacts_read.reason, 'permission_denied')
  assert.equal(byCapability.organizations_read.reason, 'permission_denied')
  assert.equal(byCapability.activities_read.reason, 'provider_unavailable')
  assert.equal(byCapability.options_read.reason, 'permission_denied')
  assert.equal(byCapability.options_read.requiredScope, 'options.activity-types:list')
  assert.equal(byCapability.contacts_create.reason, 'verified_on_first_use')
  assert.equal(byCapability.contacts_update.reason, 'handled_through_conflicts')
  assert.equal(JSON.stringify(result).includes('listContacts'), false)
  assert.equal(JSON.stringify(result).includes('503'), false)
  assert.equal(JSON.stringify(result).includes('private-token'), false)
})

test('Albi malformed responses retain only an allowlisted protocol issue', async () => {
  const c = clients()
  c.albi.listContacts = async () => { throw new ApiError('permanent', {
    operation: 'listContacts', code: 'malformed_response', protocolIssue: 'page_size_mismatch',
  }) }
  c.albi.listOrganizations = async () => { throw new ApiError('permanent', {
    operation: 'listOrganizations', code: 'malformed_response', protocolIssue: 'raw-provider-secret',
  }) }
  const result = await runPreflight(c)
  const byCapability = Object.fromEntries(result.details.albi.checks.map(check => [check.capability, check]))
  assert.equal(byCapability.contacts_read.protocolIssue, 'page_size_mismatch')
  assert.equal(Object.hasOwn(byCapability.organizations_read, 'protocolIssue'), false)
  assert.equal(JSON.stringify(result).includes('raw-provider-secret'), false)
})

test('authentication failure does not misreport informational wrapper operations as missing permissions', async () => {
  const c = clients()
  c.albi.verifyCredentials = async () => { throw new ApiError('auth', { operation: 'discoverCompany', status: 401 }) }
  c.albi.listContacts = async () => { throw new ApiError('auth', { operation: 'discoverCompany', status: 401 }) }
  c.albi.listOrganizations = c.albi.listContacts
  c.albi.listActivities = c.albi.listContacts
  c.albi.listOptions = c.albi.listContacts
  const result = await runPreflight(c)
  for (const capability of writes) {
    assert.equal(result.details.albi.checks.find(check => check.capability === capability).status, 'informational')
    assert.equal(result.details.missing.includes(result.details.albi.checks.find(check => check.capability === capability).label), false)
  }
})

const keyring = { activeVersion: 1, keys: { 1: Buffer.alloc(32, 7) } }
const rpcEnvelope = value => { const { keyVersion, ...rest } = encryptSecret(value, keyring); return { ...rest, key_version: keyVersion } }
function fixture({ role = 'admin', selectedCompany, stale, confirmed = false, invalidMapping = false } = {}) {
  const tables = {
    companies: [{ id: 'a', name: 'Alpha' }], company_members: [{ user_id: 'user', company_id: 'a', role }], super_admins: [],
    h2a_company_config: [{ company_id: 'a', updated_at: 'before', state: confirmed ? 'live' : 'disabled', preflight_status: 'unchecked', option_confirmation_status: confirmed ? 'confirmed' : 'unconfirmed', selected_start_date: '2026-10-01', initial_start_locked_at: null }],
    h2a_option_mappings: confirmed ? [
      { company_id: 'a', mapping_kind: 'default_contact_type', source_key: 'default', albi_id: invalidMapping ? '99' : '1', confirmed_at: 'before' },
      { company_id: 'a', mapping_kind: 'default_organization_type', source_key: 'default', albi_id: '1', confirmed_at: 'before' },
      ...types.map(type => ({ company_id: 'a', mapping_kind: 'activity_type', source_key: type, albi_id: '1', confirmed_at: 'before' })),
    ] : [],
  }
  const credentials = { hubspot_envelope: rpcEnvelope('private-token'), albi_envelope: rpcEnvelope('private-key'), updated_at: 'before' }
  const mutations = []
  const c = clients({ onRead() {
    if (stale === 'config') tables.h2a_company_config[0].updated_at = 'changed'
    if (stale === 'credentials') credentials.updated_at = 'changed'
    if (stale === 'envelope') credentials.hubspot_envelope = rpcEnvelope('new-token')
  } })
  const supabase = {
    auth: { async getUser(jwt) { return { data: { user: jwt === 'valid' ? { id: 'user' } : null } } } },
    async rpc(name, args) { assert.equal(name, 'h2a_get_credentials'); assert.equal(args.p_company_id, 'a'); return { data: structuredClone(credentials) } },
    from(table) {
      assert.ok(tables[table], `Unexpected table ${table}`)
      const filters = [], builder = {}; let patch
      Object.assign(builder, {
        select() { return builder }, eq(key, value) { filters.push([key, value]); return builder }, is(key, value) { filters.push([key, value]); return builder },
        update(value) { patch = value; return builder },
        async maybeSingle() { const result = await execute(); return { data: result.data[0] ?? null } },
        then(resolve, reject) { return execute().then(resolve, reject) },
      })
      async function execute() {
        if (patch && stale === 'cas') tables.h2a_company_config[0].updated_at = 'raced'
        const rows = tables[table].filter(row => filters.every(([key, value]) => row[key] === value))
        if (patch) { for (const row of rows) Object.assign(row, patch); mutations.push({ table, patch, count: rows.length }) }
        return { data: structuredClone(rows) }
      }
      return builder
    },
  }
  let decrypted = false
  const config = { supabase, keyring, now: () => new Date('2026-10-02T06:30:00Z'), makeClients(secrets) { assert.equal(secrets.hubspotToken, 'private-token'); assert.equal(secrets.albiApiKey, 'private-key'); decrypted = true; return c } }
  async function request(kind = 'preflight', body = {}, jwt = 'valid', method = 'POST') {
    const handler = kind === 'estimate' ? createEstimateHandler(config) : createPreflightHandler(config)
    const result = await handler({ httpMethod: method, headers: { Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ ...body, ...(selectedCompany ? { companyId: selectedCompany } : {}) }) })
    return { ...result, json: JSON.parse(result.body) }
  }
  return { request, tables, mutations, c, credentials, isDecrypted: () => decrypted }
}

test('preflight endpoint requires admin and authorized company before decrypting or external calls', async () => {
  for (const args of [{ role: 'member' }, { selectedCompany: 'b' }]) {
    const f = fixture(args)
    assert.equal((await f.request()).statusCode, 403)
    assert.equal(f.isDecrypted(), false)
    assert.equal(f.mutations.length, 0)
  }
  assert.equal((await fixture().request('preflight', {}, 'bad')).statusCode, 401)
})

test('preflight persists safe wrapper company, checklist, and tenant options', async () => {
  const f = fixture()
  const result = await f.request()
  assert.equal(result.statusCode, 200)
  assert.equal(result.json.preflight.status, 'valid')
  assert.equal(result.headers['Cache-Control'], 'no-store')
  const saved = f.tables.h2a_company_config[0]
  assert.equal(saved.portal_id, '123')
  assert.equal(saved.preflight_checked_at, '2026-10-02T06:30:00.000Z')
  assert.equal(saved.option_confirmation_status, 'unconfirmed')
  assert.deepEqual(saved.preflight_details.options.contactTypes, [{ id: '1', label: 'Example' }])
  assert.deepEqual(saved.preflight_details.albi.company, { id: '1319', name: 'Allied Restoration Services Inc' })
  assert.deepEqual(Object.keys(saved.preflight_details).sort(), ['albi', 'hubspot', 'missing', 'options'])
  assert.ok(!JSON.stringify(f.mutations).includes('private-token'))
})

test('preflight rejects stale config, credential timestamp/envelope, or conditional persistence race', async () => {
  for (const stale of ['config', 'credentials', 'envelope', 'cas']) {
    const f = fixture({ stale })
    const result = await f.request()
    assert.equal(result.statusCode, 409, stale)
    assert.equal(f.tables.h2a_company_config[0].preflight_status, 'unchecked')
  }
})

test('fresh options invalidate previously confirmed stale tenant mappings and disable live state', async () => {
  const f = fixture({ confirmed: true, invalidMapping: true })
  assert.equal((await f.request()).statusCode, 200)
  assert.equal(f.tables.h2a_company_config[0].state, 'disabled')
  assert.equal(f.tables.h2a_company_config[0].option_confirmation_status, 'unconfirmed')
  const valid = fixture({ confirmed: true })
  assert.equal((await valid.request()).statusCode, 200)
  assert.equal(valid.tables.h2a_company_config[0].option_confirmation_status, 'confirmed')
})

test('estimate uses proposed Pacific midnight for all activity types and makes zero writes', async () => {
  const f = fixture()
  const result = await f.request('estimate', { startDate: '2026-03-08' })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json, { total: 10004, byObjectType: { meetings: 1, calls: 1, emails: 1, communications: 1, notes: 10000 }, capped: true })
  assert.deepEqual(f.c.calls, types.map(objectType => ({ objectType, occurredAtGte: '2026-03-08T08:00:00.000Z' })))
  assert.equal(f.mutations.length, 0)
  assert.equal(f.tables.h2a_company_config[0].selected_start_date, '2026-10-01')
})

test('estimate rejects invalid/future Pacific date, member and cross-tenant access', async () => {
  for (const startDate of ['2026-02-30', '2026-10-02', 'tomorrow', null, '0000-01-01']) {
    const f = fixture()
    assert.equal((await f.request('estimate', { startDate })).statusCode, 400)
    assert.equal(f.mutations.length, 0)
    assert.equal(f.c.calls.length, 0)
  }
  assert.equal((await fixture({ role: 'member' }).request('estimate', { startDate: '2026-10-01' })).statusCode, 403)
  assert.equal((await fixture({ selectedCompany: 'b' }).request('estimate', { startDate: '2026-10-01' })).statusCode, 403)
})

test('POST endpoints reject unsupported fields, conflicting selectors, and GET', async () => {
  for (const kind of ['preflight', 'estimate']) {
    const f = fixture()
    assert.equal((await f.request(kind, { companyId: 'a', company_id: 'b' })).statusCode, 400)
    assert.equal((await f.request(kind, { unknown: true })).statusCode, 400)
    assert.equal((await f.request(kind, {}, 'valid', 'GET')).statusCode, 405)
    assert.equal(f.isDecrypted(), false)
  }
})
