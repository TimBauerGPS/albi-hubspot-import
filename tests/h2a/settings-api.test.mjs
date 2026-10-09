import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsHandler } from '../../netlify/functions/h2a-settings.js'
import { createPreflightHandler } from '../../netlify/functions/h2a-preflight.js'
import { encryptSecret, decryptSecret } from '../../netlify/functions/_h2a/crypto.js'

const keyring = { activeVersion: 1, keys: { 1: Buffer.alloc(32, 7) } }
const now = '2026-10-02T10:00:00.000Z'
const hubspotToken = 'pat-na1-hubspot-private-token-1234'
const albiApiKey = 'albi-private-api-key-5678'
const activities = ['meetings', 'calls', 'emails', 'communications', 'notes']
const optionMappings = [
  { mappingKind: 'default_contact_type', sourceKey: 'default', albiId: 'contact-1', label: 'Contact' },
  { mappingKind: 'default_organization_type', sourceKey: 'default', albiId: 'org-1', label: 'Organization' },
  ...activities.map(sourceKey => ({ mappingKind: 'activity_type', sourceKey, albiId: `activity-${sourceKey}`, label: sourceKey })),
]
const preflightOptions = {
  contactTypes: [{ id: 'contact-1', label: 'Contact' }], organizationTypes: [{ id: 'org-1', label: 'Organization' }],
  activityTypes: activities.map(type => ({ id: `activity-${type}`, label: type })),
}
const dbMapping = mapping => ({
  company_id: 'company-a', mapping_kind: mapping.mappingKind, source_key: mapping.sourceKey,
  albi_id: mapping.albiId, label: mapping.label, confirmed_by: 'user-1', confirmed_at: now,
})
const toRpc = ({ keyVersion, ...rest }) => ({ ...rest, key_version: keyVersion })
const fromRpc = ({ key_version, ...rest }) => ({ ...rest, keyVersion: key_version })

function fixture({ role = 'admin', superAdmin = false, config = {}, credentials = true, mappings = [], runs = [], failure = null,
  concurrentConfig = false, rejectArrayEquality = false } = {}) {
  const tables = {
    companies: [{ id: 'company-a', name: 'Alpha' }, { id: 'company-b', name: 'Beta' }],
    company_members: [{ user_id: 'user-1', company_id: 'company-a', role }],
    super_admins: superAdmin ? [{ user_id: 'user-1' }] : [],
    h2a_company_config: config === null ? [] : [{
      company_id: 'company-a', state: 'disabled', selected_start_date: '2026-10-02', initial_start_locked_at: null,
      preflight_status: 'unchecked', preflight_details: { options: preflightOptions }, preflight_checked_at: null,
      option_confirmation_status: 'unconfirmed', options_confirmed_by: null, options_confirmed_at: null,
      updated_at: '2026-10-01T10:00:00.000Z', ...config,
    }],
    h2a_option_mappings: mappings.map(dbMapping), h2a_backfill_windows: [], h2a_cursors: [],
    h2a_sync_runs: runs.map((run, index) => ({
      id: `run-${index + 1}`, company_id: 'company-a', mode: 'dry_run', status: 'completed',
      totals: { dry_run: 7 }, created_at: '2026-10-02T10:00:01.000Z',
      finished_at: '2026-10-02T10:05:00.000Z', ...run,
    })),
  }
  const privateCredentials = new Map(credentials ? [['company-a', {
    hubspot_envelope: toRpc(encryptSecret(hubspotToken, keyring)),
    albi_envelope: toRpc(encryptSecret(albiApiKey, keyring)), updated_by: 'user-1', updated_at: now,
  }]] : [])
  const writes = []
  const rpcCalls = []
  let beforeCredentialWrite = async () => {}
  let afterCredentialWrite = async () => {}
  const supabase = {
    auth: { async getUser(jwt) { return jwt === 'valid-jwt' ? { data: { user: { id: 'user-1' } }, error: null } : { data: { user: null }, error: { message: 'bad token' } } } },
    from(table) {
      assert.ok(tables[table], `Unexpected public table ${table}`)
      let operation = 'read', values, filters = [], selected = false, orderedBy, ascending = true, rowLimit
      const matches = row => filters.every(([operator, column, value]) => operator === 'eq' ? row[column] === value : row[column] > value)
      const builder = {
        select() { selected = true; return builder },
        eq(column, value) { filters.push(['eq', column, value]); return builder },
        gt(column, value) { filters.push(['gt', column, value]); return builder },
        is(column, value) { filters.push(['eq', column, value]); return builder },
        insert(payload) { operation = 'insert'; values = payload; return builder },
        upsert(payload) { operation = 'upsert'; values = payload; return builder },
        update(payload) { operation = 'update'; values = payload; return builder },
        delete() { operation = 'delete'; return builder },
        order(column, options = {}) { orderedBy = column; ascending = options.ascending !== false; return builder },
        limit(value) { rowLimit = value; return builder },
        async maybeSingle() { const result = await execute(); return { ...result, data: result.data?.[0] ?? null } },
        async single() { return builder.maybeSingle() },
        then(resolve, reject) { return execute().then(resolve, reject) },
      }
      async function execute() {
        if (failure === table && operation !== 'read') return { data: null, error: { message: `${hubspotToken} ${albiApiKey}` } }
        if (rejectArrayEquality && operation === 'update' && filters.some(([, , value]) => Array.isArray(value))) {
          return { data: null, error: { message: 'PostgREST cannot compare a PostgreSQL array with this equality filter.' } }
        }
        if (concurrentConfig && table === 'h2a_company_config' && operation === 'update') tables[table][0].initial_start_locked_at = now
        if (operation === 'read') {
          let rows = tables[table].filter(matches)
          if (orderedBy) rows = [...rows].sort((left, right) => String(left[orderedBy]).localeCompare(String(right[orderedBy])) * (ascending ? 1 : -1))
          if (rowLimit !== undefined) rows = rows.slice(0, rowLimit)
          return { data: structuredClone(rows), error: null }
        }
        writes.push({ table, values: structuredClone(values) })
        let affected
        if (operation === 'delete') {
          affected = tables[table].filter(matches)
          tables[table] = tables[table].filter(row => !matches(row))
        } else if (operation === 'update') {
          affected = tables[table].filter(matches)
          for (const row of affected) Object.assign(row, values)
        } else {
          affected = []
          for (const value of Array.isArray(values) ? values : [values]) {
            let row = operation === 'upsert' && tables[table].find(existing => existing.company_id === value.company_id &&
              (table !== 'h2a_option_mappings' || (existing.mapping_kind === value.mapping_kind && existing.source_key === value.source_key)))
            if (row) Object.assign(row, value)
            else { row = { id: `row-${tables[table].length + 1}`, ...value }; tables[table].push(row) }
            affected.push(row)
          }
        }
        return { data: selected ? structuredClone(affected) : null, error: null }
      }
      return builder
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args: structuredClone(args) })
      if (name === 'h2a_get_credentials') return { data: structuredClone(privateCredentials.get(args.p_company_id) ?? null), error: null }
      assert.equal(name, 'h2a_put_credentials')
      const current = tables.h2a_company_config.find(row => row.company_id === args.p_company_id)
      assert.equal(current.state, 'disabled', 'private credential writes must follow public invalidation')
      assert.equal(current.preflight_status, 'running', 'preflight must remain blocked during the private credential write')
      if (failure === name) return { data: null, error: { message: `${hubspotToken} ${albiApiKey}` } }
      assert.ok(args.p_hubspot_envelope.key_version)
      assert.ok(args.p_albi_envelope.key_version)
      await beforeCredentialWrite()
      privateCredentials.set(args.p_company_id, { hubspot_envelope: args.p_hubspot_envelope, albi_envelope: args.p_albi_envelope, updated_by: args.p_updated_by, updated_at: now })
      await afterCredentialWrite()
      return { data: null, error: null }
    },
  }
  const handle = createSettingsHandler({ supabase, keyring, now: () => new Date(now) })
  async function request(httpMethod = 'GET', body, query = {}, jwt = 'valid-jwt') {
    const response = await handle({ httpMethod, headers: { authorization: `Bearer ${jwt}` }, queryStringParameters: query, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ...response, json: JSON.parse(response.body) }
  }
  return {
    request, handle, supabase, tables, privateCredentials, writes, rpcCalls,
    setBeforeCredentialWrite(fn) { beforeCredentialWrite = fn },
    setAfterCredentialWrite(fn) { afterCredentialWrite = fn },
  }
}

test('member GET returns masks, configuration, mappings and preflight without credentials/envelopes', async () => {
  const f = fixture({ role: 'member', mappings: optionMappings })
  const result = await f.request()
  assert.equal(result.statusCode, 200)
  assert.equal(result.json.hubspotTokenMask, 'pat-********1234')
  assert.equal(result.json.albiApiKeyMask, 'albi********5678')
  assert.equal(result.json.config.state, 'disabled')
  assert.equal(result.json.preflight.status, 'unchecked')
  assert.equal(result.json.optionMappings.length, 7)
  assert.equal(result.json.dryRunReviewReady, false)
  assert.equal(result.json.lastCompletedDryRun, null)
  assert.deepEqual(result.json.optionMappings[0], optionMappings[0])
  for (const forbidden of [hubspotToken, albiApiKey, 'ciphertext', 'key_version', 'hubspot_envelope', 'albi_envelope']) assert.equal(result.body.includes(forbidden), false)
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.equal(f.writes.length, 0)
})

test('admins can manage a tenant-scoped, normalized notification recipient list', async () => {
  const f = fixture()
  const saved = await f.request('PUT', { action: 'save_notification_recipients', notificationRecipients: [' Ops@Example.com ', 'ops@example.com'] })
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(f.tables.h2a_company_config[0].notification_recipients, ['ops@example.com'])
  assert.deepEqual(saved.json.config.notification_recipients, ['ops@example.com'])
  assert.equal((await f.request('PUT', { action: 'save_notification_recipients', notificationRecipients: ['not-an-email'] })).statusCode, 400)
  assert.equal((await f.request('PUT', { action: 'save_notification_recipients', notificationRecipients: [], otherTenant: 'x' })).statusCode, 400)
})

test('option confirmation and live activation reject IDs absent from tenant preflight options', async () => {
  const f = fixture({ config: { preflight_status: 'valid', option_confirmation_status: 'confirmed', state: 'dry_run', initial_start_locked_at: now }, mappings: optionMappings })
  const unavailable = optionMappings.map(mapping => ({ ...mapping, albiId: 'other-tenant-option' }))
  assert.equal((await f.request('PUT', { action: 'confirm_option_mappings', optionMappings: unavailable })).statusCode, 400)
  f.tables.h2a_option_mappings[0].albi_id = 'deleted-option'
  assert.equal((await f.request('PUT', { action: 'activate_live' })).statusCode, 409)
})

test('malformed stored option groups fail closed without turning mapping validation into a server error', async () => {
  const config = { preflight_status: 'valid', option_confirmation_status: 'unconfirmed', preflight_details: {
    options: { ...preflightOptions, activityTypes: { id: 'not-a-list' } },
  } }
  const f = fixture({ config })
  const result = await f.request('PUT', { action: 'confirm_option_mappings', optionMappings })
  assert.equal(result.statusCode, 400)
  assert.equal(f.writes.length, 0)
})

test('settings safe projection retains distinct activity reads and required option labels', async () => {
  const f = fixture({ config: { preflight_details: {
    missing: ['Albi activity reads', 'Albi contact type options', 'Albi organization type options', 'Albi activity type options', 'raw failure'],
    albi: { status: 'invalid', checks: [{ capability: 'activities_read', status: 'invalid', error: 'private' }] },
  } } })
  const result = await f.request()
  assert.deepEqual(result.json.preflight.details.missing, ['Albi activity reads', 'Albi contact type options', 'Albi organization type options', 'Albi activity type options'])
  assert.deepEqual(result.json.preflight.details.albi.checks, [{ capability: 'activities_read', status: 'invalid', label: 'Albi activity reads' }])
})

test('first GET defaults to the current Pacific date without writing configuration', async () => {
  const f = fixture({ config: null, credentials: false })
  const result = await f.request()
  assert.equal(result.json.config.selected_start_date, '2026-10-02')
  assert.equal(result.json.config.state, 'disabled')
  assert.equal(result.json.hubspotTokenMask, null)
  assert.equal(result.json.albiApiKeyMask, null)
  assert.equal(f.writes.length, 0)
})

test('member PUT is forbidden before any public or private settings write', async () => {
  const f = fixture({ role: 'member' })
  assert.equal((await f.request('PUT', { action: 'replace_credentials', hubspotToken, albiApiKey })).statusCode, 403)
  assert.equal(f.writes.length, 0)
  assert.equal(f.rpcCalls.length, 0)
})

test('GET rejects invalid auth and cross-company selectors', async () => {
  const f = fixture()
  assert.equal((await f.request('GET', undefined, {}, 'invalid')).statusCode, 401)
  assert.equal((await f.request('GET', undefined, { companyId: 'company-b' })).statusCode, 403)
  assert.equal(f.rpcCalls.length, 0)
})

test('super admin GET and PUT use the server-authorized selected company', async () => {
  const f = fixture({ superAdmin: true })
  const get = await f.request('GET', undefined, { companyId: 'company-b' })
  assert.equal(get.statusCode, 200)
  assert.equal(get.json.companyId, 'company-b')
  assert.equal(get.json.hubspotTokenMask, null)
  const put = await f.request('PUT', { action: 'replace_credentials', companyId: 'company-b', hubspotToken, albiApiKey })
  assert.equal(put.statusCode, 200)
  assert.equal(f.privateCredentials.has('company-b'), true)
  assert.equal(f.tables.h2a_company_config.find(row => row.company_id === 'company-a').preflight_status, 'unchecked')
})

test('replacing existing credentials does not use PostgREST array equality in the concurrency guard', async () => {
  const f = fixture({
    rejectArrayEquality: true,
    config: { notification_recipients: ['ops@example.com'] },
  })
  const result = await f.request('PUT', {
    action: 'replace_credentials',
    hubspotToken: 'replacement-hubspot-token',
    albiApiKey: 'replacement-albi-key',
  })

  assert.equal(result.statusCode, 200)
  assert.equal(decryptSecret(fromRpc(f.privateCredentials.get('company-a').hubspot_envelope), keyring), 'replacement-hubspot-token')
  assert.equal(decryptSecret(fromRpc(f.privateCredentials.get('company-a').albi_envelope), keyring), 'replacement-albi-key')
})

for (const field of ['hubspotToken', 'albiApiKey']) {
  test(`replacing ${field} encrypts it and invalidates preflight before saving credentials`, async () => {
    const f = fixture({ config: { state: 'live', preflight_status: 'valid', preflight_details: { ok: true }, preflight_checked_at: now, option_confirmation_status: 'confirmed' } })
    const old = structuredClone(f.privateCredentials.get('company-a'))
    const replacement = 'new-private-credential-987654321'
    const result = await f.request('PUT', { action: 'replace_credentials', [field]: replacement })
    assert.equal(result.statusCode, 200)
    assert.equal(result.json.preflight.status, 'unchecked')
    assert.equal(f.tables.h2a_company_config[0].state, 'disabled')
    assert.equal(f.tables.h2a_company_config[0].preflight_checked_at, null)
    assert.deepEqual(f.tables.h2a_company_config[0].preflight_details, {})
    assert.equal(f.tables.h2a_company_config[0].option_confirmation_status, 'unconfirmed')
    const stored = f.privateCredentials.get('company-a')
    const changed = field === 'hubspotToken' ? 'hubspot_envelope' : 'albi_envelope'
    const unchanged = field === 'hubspotToken' ? 'albi_envelope' : 'hubspot_envelope'
    assert.equal(decryptSecret(fromRpc(stored[changed]), keyring), replacement)
    assert.deepEqual(stored[unchanged], old[unchanged])
    for (const secret of [replacement, hubspotToken, albiApiKey]) {
      assert.equal(result.body.includes(secret), false)
      assert.equal(JSON.stringify(f.writes).includes(secret), false)
      assert.equal(JSON.stringify(f.rpcCalls).includes(secret), false)
    }
  })
}

test('preflight started during credential replacement cannot persist old credentials results', async () => {
  const f = fixture({ config: {
    state: 'live', portal_id: '111', preflight_status: 'valid', preflight_details: { options: preflightOptions },
    preflight_checked_at: now, option_confirmation_status: 'confirmed',
  }, mappings: optionMappings })
  const availableOptions = Object.fromEntries(Object.keys(preflightOptions).map(group => [group, [{ id: '2', label: 'Other tenant option' }]]))
  let clientsCreated = 0
  const runPreflightDuringReplacement = createPreflightHandler({
    supabase: f.supabase, keyring, now: () => new Date(now),
    makeClients() {
      clientsCreated += 1
      return {
        hubspot: {
          async getAccountInfo() { return { portalId: '222' } },
          async checkRead() { return [] },
          async listActivities() { return { records: [], after: null, total: 0 } },
        },
        albi: {
          async verifyCredentials() { return { authenticated: true, capabilities: {
            contacts_create: true, organizations_create: true, activities_create: true,
            contacts_update: true, organizations_update: true, contacts_associate_organization: true,
          } } },
          async listContacts() { return { records: [], cursor: null } },
          async listOrganizations() { return { records: [], cursor: null } },
          async listActivities() { return { records: [], cursor: null } },
          async listOptions() { return availableOptions },
        },
      }
    },
  })
  let interleavedPreflight
  f.setBeforeCredentialWrite(async () => {
    interleavedPreflight = await runPreflightDuringReplacement({
      httpMethod: 'POST', headers: { authorization: 'Bearer valid-jwt' }, body: '{}',
    })
  })
  f.setAfterCredentialWrite(async () => {
    // Model a preflight that raced through the first invalidation before the replacement completed.
    Object.assign(f.tables.h2a_company_config[0], {
      state: 'disabled', portal_id: '222', preflight_status: 'valid', preflight_checked_at: now,
      preflight_details: { options: availableOptions }, option_confirmation_status: 'unconfirmed',
    })
  })

  const result = await f.request('PUT', { action: 'replace_credentials', hubspotToken: 'new-hubspot-token' })

  assert.equal(result.statusCode, 200)
  assert.equal(interleavedPreflight.statusCode, 409)
  assert.equal(clientsCreated, 0)
  assert.equal(f.tables.h2a_company_config[0].state, 'disabled')
  assert.equal(f.tables.h2a_company_config[0].preflight_status, 'unchecked')
  assert.deepEqual(f.tables.h2a_company_config[0].preflight_details, {})
  assert.equal(f.tables.h2a_company_config[0].portal_id, null)
})

test('first credential save requires both secrets; malformed or absent replacements are rejected', async () => {
  for (const body of [{ hubspotToken }, {}, { hubspotToken: '' }, { hubspotToken: 1 }, { hubspotToken: '   ' }]) {
    const f = fixture({ credentials: false })
    assert.equal((await f.request('PUT', { action: 'replace_credentials', ...body })).statusCode, 400)
    assert.equal(f.writes.length, 0)
  }
})

test('failed credential write leaves preflight disabled/unchecked and returns a sanitized error', async () => {
  const f = fixture({ failure: 'h2a_put_credentials', config: { state: 'live', preflight_status: 'valid' } })
  const result = await f.request('PUT', { action: 'replace_credentials', hubspotToken, albiApiKey })
  assert.equal(result.statusCode, 500)
  assert.equal(f.tables.h2a_company_config[0].preflight_status, 'unchecked')
  assert.equal(f.tables.h2a_company_config[0].state, 'disabled')
  assert.equal(result.body.includes(hubspotToken), false)
  assert.equal(result.body.includes(albiApiKey), false)
})

test('invalid encryption config or authentication tags fail closed with sanitized errors', async () => {
  const f = fixture()
  f.privateCredentials.get('company-a').hubspot_envelope.tag = Buffer.alloc(16).toString('base64')
  assert.equal((await f.request()).statusCode, 500)
  const valid = fixture()
  const handler = createSettingsHandler({ supabase: valid.supabase, keyring: { activeVersion: 1, keys: {} } })
  const result = await handler({ httpMethod: 'GET', headers: { authorization: 'Bearer valid-jwt' } })
  assert.equal(result.statusCode, 500)
  assert.equal(result.body.includes(hubspotToken), false)
  assert.equal(result.body.includes(albiApiKey), false)
})

test('GET suppresses accidentally stored credentials and envelopes in preflight details', async () => {
  const f = fixture({ config: { preflight_details: { missing: ['Albi activity creation'], error: `failed using ${hubspotToken}`, token: hubspotToken,
    provider: { albiApiKey, ciphertext: 'encrypted-data', iv: 'some-iv' } } } })
  const result = await f.request()
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json.preflight.details, { missing: ['Albi activity creation'] })
  assert.equal(result.body.includes(hubspotToken), false)
  assert.equal(result.body.includes(albiApiKey), false)
})

test('preflight read schema drops prefixed envelopes and arbitrary message/error strings at every depth', async () => {
  const f = fixture({ config: { preflight_details: {} } })
  const stored = f.privateCredentials.get('company-a')
  const unsafe = {
    hubspot_ciphertext: stored.hubspot_envelope.ciphertext, hubspot_iv: stored.hubspot_envelope.iv,
    hubspot_tag: stored.hubspot_envelope.tag, hubspot_key_version: 1,
    albi_ciphertext: stored.albi_envelope.ciphertext, albi_iv: stored.albi_envelope.iv,
    albi_tag: stored.albi_envelope.tag, albi_key_version: 1,
    message: 'PostgREST raw database error: credential-like-value-unknown-to-this-keyring',
    error: `Authorization: Bearer unrelated-secret-token; ${hubspotToken}`,
  }
  f.tables.h2a_company_config[0].preflight_details = {
    ...unsafe, unexpected: [{ nested: unsafe }],
    hubspot: { status: 'valid', authenticated: true, ...unsafe,
      checks: [{ capability: 'contacts_read', status: 'valid', ...unsafe, extra: [unsafe] }, unsafe] },
    albi: { status: 'invalid', authenticated: true, checks: [{ capability: 'activities_create', status: 'invalid', ...unsafe }] },
  }
  const result = await f.request()
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json.preflight.details, {
    hubspot: { status: 'valid', authenticated: true, checks: [{ capability: 'contacts_read', status: 'valid', label: 'HubSpot contact reads' }] },
    albi: { status: 'invalid', authenticated: true, checks: [{ capability: 'activities_create', status: 'invalid', label: 'Albi activity creation' }] },
  })
  for (const value of [hubspotToken, albiApiKey, ...Object.values(stored.hubspot_envelope).filter(value => typeof value === 'string'),
    ...Object.values(stored.albi_envelope).filter(value => typeof value === 'string'), 'PostgREST', 'unrelated-secret-token']) {
    assert.equal(result.body.includes(value), false, value)
  }
})

test('preflight read schema retains safe checklist and option data while rejecting unknown and malformed nested entries', async () => {
  const f = fixture({ config: { preflight_details: {} } })
  const stored = f.privateCredentials.get('company-a')
  f.tables.h2a_company_config[0].preflight_details = {
    missing: ['Albi activity creation', 'unknown-free-text-error', { label: 'Albi activity creation' }, ['Albi activity creation']],
    hubspot: { status: 'valid', authenticated: true, checks: [
      { capability: 'notes_read', status: 'valid', label: hubspotToken, message: 'raw error' },
      { capability: 'activities_create', status: 'valid' },
      { capability: 'contacts_read', status: 'some-arbitrary-error' }, [{ capability: 'contacts_read', status: 'valid' }],
    ] },
    albi: { status: 'PostgREST failure', authenticated: 'Bearer unknown-secret', checks: 'malformed' },
    options: {
      contactTypes: [{ id: '101', label: 'Property Manager', hubspot_iv: stored.hubspot_envelope.iv, error: 'raw error' },
        { id: '102', label: hubspotToken }, { id: '103', label: stored.albi_envelope.ciphertext },
        { id: '104', label: `Authorization: Bearer other-private-value` }, [{ id: '105', label: 'Wrong nesting' }], null],
      organizationTypes: [{ id: '201', label: 'Commercial' }],
      activityTypes: [{ id: '301', label: 'Meeting', unknown: { message: 'raw database error' } }],
      unknownTypes: [{ id: '401', label: 'Unknown' }], error: 'raw provider error',
    },
  }
  const result = await f.request()
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json.preflight.details, {
    missing: ['Albi activity creation'],
    hubspot: { status: 'valid', authenticated: true, checks: [{ capability: 'notes_read', status: 'valid', label: 'HubSpot note reads' }] },
    albi: {},
    options: {
      contactTypes: [{ id: '101', label: 'Property Manager' }],
      organizationTypes: [{ id: '201', label: 'Commercial' }], activityTypes: [{ id: '301', label: 'Meeting' }],
    },
  })
})

test('preflight read schema fails closed on non-object roots and unknown-only data', async () => {
  for (const details of [null, 'raw error', [hubspotToken], { mystery: { message: 'raw error' } }]) {
    const f = fixture({ config: { preflight_details: details } })
    assert.deepEqual((await f.request()).json.preflight.details, {})
  }
})

test('failed public invalidation never saves replacement credentials', async () => {
  const f = fixture({ failure: 'h2a_company_config' })
  const result = await f.request('PUT', { action: 'replace_credentials', hubspotToken })
  assert.equal(result.statusCode, 500)
  assert.equal(f.rpcCalls.some(call => call.name === 'h2a_put_credentials'), false)
})

test('a concurrent dry-run date lock prevents a stale start-date update', async () => {
  const f = fixture({ concurrentConfig: true })
  const result = await f.request('PUT', { action: 'save_start_date', startDate: '2026-09-01' })
  assert.equal(result.statusCode, 409)
  assert.equal(f.tables.h2a_company_config[0].selected_start_date, '2026-10-02')
  assert.equal(f.tables.h2a_company_config[0].initial_start_locked_at, now)
})

test('save_start_date validates real YYYY-MM-DD dates and rejects future dates', async () => {
  for (const startDate of ['2026-02-30', '2026-2-01', 'not-a-date', '2026-10-03', null, '0000-01-01']) {
    const f = fixture()
    assert.equal((await f.request('PUT', { action: 'save_start_date', startDate })).statusCode, 400, String(startDate))
    assert.equal(f.writes.length, 0)
  }
  const f = fixture({ config: null })
  const valid = await f.request('PUT', { action: 'save_start_date', startDate: '2024-02-29' })
  assert.equal(valid.statusCode, 200)
  assert.equal(f.tables.h2a_company_config[0].selected_start_date, '2024-02-29')
})

test('a fixed start date cannot move forward or silently rewind; an identical save is harmless', async () => {
  const f = fixture({ config: { selected_start_date: '2026-09-01', initial_start_locked_at: now } })
  for (const startDate of ['2026-09-02', '2026-08-01']) {
    assert.equal((await f.request('PUT', { action: 'save_start_date', startDate })).statusCode, 409)
  }
  assert.equal((await f.request('PUT', { action: 'save_start_date', startDate: '2026-09-01' })).statusCode, 200)
  assert.equal(f.tables.h2a_company_config[0].selected_start_date, '2026-09-01')
})

test('saving the displayed default date persists an existing unset start date', async () => {
  const f = fixture({ config: { selected_start_date: null } })
  const result = await f.request('PUT', { action: 'save_start_date', startDate: '2026-10-02' })
  assert.equal(result.statusCode, 200)
  assert.equal(f.tables.h2a_company_config[0].selected_start_date, '2026-10-02')
})

test('earlier backfill seeds five durable pending ranges without rewinding the date or cursors', async () => {
  const f = fixture({ config: { state: 'live', selected_start_date: '2026-09-01', initial_start_locked_at: now, preflight_status: 'valid' } })
  f.tables.h2a_cursors.push({ company_id: 'company-a', object_type: 'notes', cursor_timestamp: now, cursor_object_id: '7' })
  const cursors = structuredClone(f.tables.h2a_cursors)
  const result = await f.request('PUT', { action: 'request_earlier_backfill', startDate: '2026-03-07' })
  assert.equal(result.statusCode, 200)
  const windows = f.tables.h2a_backfill_windows
  assert.equal(windows.length, 5)
  assert.deepEqual(new Set(windows.map(row => row.object_type)), new Set(activities))
  assert.equal(new Set(windows.map(row => row.request_id)).size, 1)
  assert.equal(result.json.backfillRequestId, windows[0].request_id)
  for (const row of windows) {
    assert.equal(row.start_at, '2026-03-07T08:00:00.000Z')
    assert.equal(row.end_at, '2026-09-01T07:00:00.000Z')
    assert.equal(row.status, 'pending')
    assert.equal(row.requested_by, 'user-1')
    assert.equal(row.requested_start_date, '2026-03-07')
    assert.equal(row.company_id, 'company-a')
  }
  assert.equal(f.tables.h2a_company_config[0].selected_start_date, '2026-09-01')
  assert.deepEqual(f.tables.h2a_cursors, cursors)
})

test('backfill requires a locked initial date and an earlier valid date', async () => {
  for (const config of [{}, { initial_start_locked_at: now }]) {
    const f = fixture({ config })
    assert.equal((await f.request('PUT', { action: 'request_earlier_backfill', startDate: '2026-10-02' })).statusCode, 409)
    assert.equal(f.tables.h2a_backfill_windows.length, 0)
  }
})

test('confirmed mappings persist the actor and exact tenant-specific IDs and permit ready state', async () => {
  const f = fixture({ config: { preflight_status: 'valid' } })
  const result = await f.request('PUT', { action: 'confirm_option_mappings', optionMappings })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json.config.option_confirmation_status, 'confirmed')
  assert.equal(result.json.config.state, 'ready')
  assert.equal(f.tables.h2a_option_mappings.length, 7)
  for (const row of f.tables.h2a_option_mappings) {
    assert.equal(row.confirmed_by, 'user-1')
    assert.equal(row.confirmed_at, now)
    assert.equal(row.company_id, 'company-a')
  }
})

test('mapping confirmation rejects missing, duplicate and unsupported mapping kinds', async () => {
  for (const optionMappings of [[], [{ mappingKind: 'evil' }], [dbMapping({})],
    [...Array.from({ length: 2 }, () => ({ mappingKind: 'activity_type', sourceKey: 'notes', albiId: '1', label: 'Note' }))],
  ]) {
    const f = fixture()
    assert.equal((await f.request('PUT', { action: 'confirm_option_mappings', optionMappings })).statusCode, 400)
    assert.equal(f.writes.length, 0)
  }
})

test('confirming a replacement mapping set removes omitted inheritance mappings for only this company', async () => {
  const oldInheritance = { mappingKind: 'organization_to_contact_type', sourceKey: 'old-org', albiId: 'old-contact', label: 'Old inheritance' }
  const f = fixture({ mappings: [...optionMappings, oldInheritance], config: { preflight_status: 'valid' } })
  f.tables.h2a_option_mappings.push({ ...dbMapping(oldInheritance), company_id: 'company-b' })
  const result = await f.request('PUT', { action: 'confirm_option_mappings', optionMappings })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json.optionMappings.length, 7)
  assert.equal(f.tables.h2a_option_mappings.some(row => row.company_id === 'company-a' && row.mapping_kind === 'organization_to_contact_type'), false)
  assert.equal(f.tables.h2a_option_mappings.some(row => row.company_id === 'company-b' && row.mapping_kind === 'organization_to_contact_type'), true)
})

test('enter_dry_run requires valid preflight, credentials and complete confirmed options', async () => {
  for (const options of [{}, { config: { preflight_status: 'valid' } }, { credentials: false, config: { preflight_status: 'valid', option_confirmation_status: 'confirmed' }, mappings: optionMappings }]) {
    const f = fixture(options)
    assert.equal((await f.request('PUT', { action: 'enter_dry_run' })).statusCode, 409)
    assert.equal(f.tables.h2a_company_config[0].initial_start_locked_at, null)
  }
})

test('first dry run locks the selected date and activation waits for a later completed dry-run run', async () => {
  const f = fixture({ config: { state: 'ready', preflight_status: 'valid', option_confirmation_status: 'confirmed' }, mappings: optionMappings })
  assert.equal((await f.request('PUT', { action: 'enter_dry_run' })).statusCode, 200)
  assert.equal(f.tables.h2a_company_config[0].state, 'dry_run')
  assert.equal(f.tables.h2a_company_config[0].initial_start_locked_at, now)
  assert.equal((await f.request('PUT', { action: 'activate_live' })).statusCode, 409)
  f.tables.h2a_sync_runs.push({
    id: 'run-ready', company_id: 'company-a', mode: 'dry_run', status: 'completed', totals: { dry_run: 12 },
    created_at: '2026-10-02T10:00:01.000Z', finished_at: '2026-10-02T10:05:00.000Z',
  })
  assert.equal((await f.request('PUT', { action: 'activate_live' })).statusCode, 200)
  assert.equal(f.tables.h2a_company_config[0].state, 'live')
  assert.equal((await f.request('PUT', { action: 'disable' })).statusCode, 200)
  assert.equal(f.tables.h2a_company_config[0].state, 'disabled')
  assert.equal(f.tables.h2a_company_config[0].initial_start_locked_at, now)
  assert.equal(f.tables.h2a_cursors.length, 0)
})

test('GET exposes only a tenant-scoped completed dry-run summary created after the date lock', async () => {
  const f = fixture({ config: { state: 'dry_run', initial_start_locked_at: now }, runs: [
    { id: 'old', created_at: '2026-10-02T09:59:59.000Z', finished_at: '2026-10-02T10:01:00.000Z', totals: { dry_run: 99 } },
    { id: 'failed', status: 'failed', created_at: '2026-10-02T10:01:00.000Z', finished_at: '2026-10-02T10:02:00.000Z' },
    { id: 'other-tenant', company_id: 'company-b', created_at: '2026-10-02T10:03:00.000Z', finished_at: '2026-10-02T10:04:00.000Z' },
    { id: 'ready', created_at: '2026-10-02T10:02:00.000Z', finished_at: '2026-10-02T10:05:00.000Z', totals: {
      dry_run: 12,
      would_create_organizations: 2,
      would_create_contacts: 3,
      would_link: 4,
      would_deliver_activities: 5,
      requires_review: 1,
      skipped: 0,
      created: 99,
      updated: Number.MAX_SAFE_INTEGER + 1,
      provider_error: 'secret-provider-detail',
      raw_snapshot: { email: 'private@example.com' },
    } },
  ] })
  const result = await f.request()
  assert.equal(result.statusCode, 200)
  assert.equal(result.json.dryRunReviewReady, true)
  assert.deepEqual(result.json.lastCompletedDryRun, {
    id: 'ready', createdAt: '2026-10-02T10:02:00.000Z', finishedAt: '2026-10-02T10:05:00.000Z',
    totals: {
      would_create_organizations: 2,
      would_create_contacts: 3,
      would_link: 4,
      would_deliver_activities: 5,
      requires_review: 1,
    },
  })
  assert.equal(result.body.includes('error_summary'), false)
  assert.equal(result.body.includes('provider_error'), false)
  assert.equal(result.body.includes('secret-provider-detail'), false)
  assert.equal(result.body.includes('raw_snapshot'), false)
  assert.equal(result.body.includes('private@example.com'), false)
})

test('activation rejects completed dry runs that predate the initial lock or belong to another tenant', async () => {
  for (const runs of [
    [{ id: 'old', created_at: '2026-10-02T09:59:59.000Z' }],
    [{ id: 'other', company_id: 'company-b', created_at: '2026-10-02T10:00:01.000Z' }],
    [{ id: 'partial', status: 'partially_failed', created_at: '2026-10-02T10:00:01.000Z' }],
  ]) {
    const f = fixture({ config: { state: 'dry_run', initial_start_locked_at: now, preflight_status: 'valid', option_confirmation_status: 'confirmed' }, mappings: optionMappings, runs })
    const result = await f.request('PUT', { action: 'activate_live' })
    assert.equal(result.statusCode, 409)
    assert.equal(f.tables.h2a_company_config[0].state, 'dry_run')
  }
})

test('activate_live cannot bypass the first dry run or a failed preflight', async () => {
  for (const config of [{ state: 'ready', preflight_status: 'valid' }, { state: 'dry_run', initial_start_locked_at: now, preflight_status: 'invalid' }]) {
    const f = fixture({ config: { option_confirmation_status: 'confirmed', ...config }, mappings: optionMappings })
    assert.equal((await f.request('PUT', { action: 'activate_live' })).statusCode, 409)
  }
})

test('unsupported actions and fields cannot set state or submit credentials through generic settings', async () => {
  for (const body of [{ action: 'set_state', state: 'live' }, { action: 'disable', preflight_status: 'valid' },
    { action: 'save_start_date', startDate: '2026-09-01', hubspotToken }, { action: 'replace_credentials', hubspotToken, state: 'live' }]) {
    const f = fixture()
    assert.equal((await f.request('PUT', body)).statusCode, 400)
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  assert.equal((await f.handle({ httpMethod: 'PUT', headers: { authorization: 'Bearer valid-jwt' }, body: 'bad-json' })).statusCode, 400)
  assert.equal((await f.request('POST', {})).statusCode, 405)
})
