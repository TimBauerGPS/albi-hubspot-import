#!/usr/bin/env node
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { AlbiClient } from '../netlify/functions/_h2a/albiClient.js'
import { buildAlbiActivity } from '../netlify/functions/_h2a/activity.js'
import { HUBSPOT_ACTIVITY_TYPES } from '../netlify/functions/_h2a/constants.js'
import { completeDelivery, reserveDelivery } from '../netlify/functions/_h2a/deliveries.js'
import { HubSpotClient } from '../netlify/functions/_h2a/hubspotClient.js'
import { makeDeliveryKey, makeSourceMarker } from '../netlify/functions/_h2a/keys.js'
import { createDryRunReviewHandler } from '../netlify/functions/h2a-dry-run-reviews.js'
import { createRunHandler } from '../netlify/functions/h2a-run.js'
import { createH2ARepository } from '../netlify/functions/_h2a/repository.js'

const ISOLATION_ACK = 'I_CONFIRM_THIS_IS_AN_ISOLATED_ALBI_SANDBOX'
const ACTIVITY_CONTRACT_ACK = 'I_VERIFIED_ALBI_ACTIVITY_MARKER_READBACK'
const REQUIRED_PROVIDER_CREDENTIALS = ['H2A_TEST_HUBSPOT_TOKEN', 'H2A_TEST_ALBI_KEY']
const OVERRIDE_VARS = ['H2A_TEST_HUBSPOT_BASE_URL', 'H2A_TEST_ALBI_BASE_URL']
const REQUIRED_WRITE_CAPABILITIES = [
  'contacts_create', 'organizations_create', 'activities_create',
]
const cleanId = value => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-4).padStart(4, '*')
const output = message => process.stdout.write(`${message}\n`)

export function missingSmokeEnvironment(env = process.env) {
  return REQUIRED_PROVIDER_CREDENTIALS.filter(name => typeof env[name] !== 'string' || !env[name].trim())
}

export function smokeWriteBlockers(env = process.env, capabilities = null) {
  const blockers = []
  if (env.H2A_ALLOW_SANDBOX_WRITES !== 'true') blockers.push('H2A_ALLOW_SANDBOX_WRITES=true is required')
  if (env.H2A_SANDBOX_ISOLATION_ACK !== ISOLATION_ACK) blockers.push(`H2A_SANDBOX_ISOLATION_ACK=${ISOLATION_ACK} is required`)
  if (env.H2A_ALBI_ACTIVITY_CONTRACT_ACK !== ACTIVITY_CONTRACT_ACK) blockers.push(`H2A_ALBI_ACTIVITY_CONTRACT_ACK=${ACTIVITY_CONTRACT_ACK} is required after sandbox marker-readback verification`)
  if (!/^[A-Za-z0-9_-]{4,48}$/.test(env.H2A_SMOKE_RUN_ID ?? '')) blockers.push('H2A_SMOKE_RUN_ID with 4–48 letters, digits, underscores, or hyphens is required for repeatable records')
  for (const name of OVERRIDE_VARS) {
    if (env[name]) blockers.push(`${name} is unsupported; the production adapters use fixed official API hosts`)
  }
  if (capabilities) {
    for (const name of REQUIRED_WRITE_CAPABILITIES) {
      if (capabilities[name] !== 'verified_on_first_use') blockers.push(`Albi wrapper create contract is unavailable: ${name}`)
    }
  }
  return blockers
}

function exactMarkerMatches(records, marker) {
  return records.filter(record => String(record?.notes ?? '').split(/\r?\n/u).some(line => line.trim() === marker))
}

async function collectPages(readPage, label, maximum = 100) {
  const records = []
  let cursor = '1'
  for (let pageCount = 0; pageCount < maximum; pageCount++) {
    const result = await readPage(cursor)
    if (!result || !Array.isArray(result.records)) throw new Error(`Invalid ${label} response shape.`)
    records.push(...result.records)
    if (result.cursor == null) return records
    if (!/^\d+$/.test(result.cursor) || Number(result.cursor) <= Number(cursor)) throw new Error(`Invalid ${label} pagination contract.`)
    cursor = result.cursor
  }
  throw new Error(`${label} exceeded the bounded page limit.`)
}

function makeEphemeralDeliveryStore(existing = null) {
  const rows = new Map()
  if (existing) rows.set(existing.key, { id: 'local-smoke-delivery', state: 'reserved', attempt_count: 1,
    last_attempt_at: new Date(0).toISOString(), next_attempt_at: null })
  return {
    async reserve({ key, now }) {
      let row = rows.get(key)
      if (!row) {
        row = { id: `local-${rows.size + 1}`, state: 'reserved', attempt_count: 1, last_attempt_at: now, next_attempt_at: null }
        rows.set(key, row)
        return { acquired: true, isNew: true, row }
      }
      if (row.state === 'reserved' && row.last_attempt_at === new Date(0).toISOString()) {
        row = { ...row, attempt_count: row.attempt_count + 1, last_attempt_at: now }
        rows.set(key, row)
        return { acquired: true, isNew: false, previous: { state: 'reserved', last_attempt_at: new Date(0).toISOString(), next_attempt_at: null }, row }
      }
      return { acquired: false, row }
    },
    async transition({ id, expectedVersion, patch }) {
      const entry = [...rows.entries()].find(([, row]) => row.id === id)
      if (!entry || entry[1].state !== 'reserved' || entry[1].attempt_count !== expectedVersion) return { updated: false, row: entry?.[1] }
      const row = { ...entry[1], ...patch }
      rows.set(entry[0], row)
      return { updated: true, row }
    },
  }
}

function makeSelfTestAdapters() {
  const calls = []
  const organizations = []
  const contacts = []
  const activities = []
  const hubspot = {
    async getAccountInfo() { calls.push('hubspot:account'); return { portalId: '123456' } },
    async listActivities({ objectType }) { calls.push(`hubspot:search:${objectType}`); return { records: [], after: null, total: 0 } },
    async getAssociations() { calls.push('hubspot:associations'); return [] },
  }
  const albi = {
    async listOptions() {
      calls.push('albi:options')
      return { contactTypes: [{ id: '1', label: 'Person' }], organizationTypes: [{ id: '1', label: 'Organization' }], activityTypes: [{ id: '1', label: 'Note' }] }
    },
    async listContacts({ cursor = '1', pageSize = 25 } = {}) {
      calls.push('albi:contacts:read')
      const start = (Number(cursor) - 1) * pageSize
      const records = contacts.slice(start, start + pageSize)
      return { records, cursor: records.length === pageSize ? String(Number(cursor) + 1) : null }
    },
    async listOrganizations({ cursor = '1', pageSize = 25 } = {}) {
      calls.push('albi:organizations:read')
      const start = (Number(cursor) - 1) * pageSize
      const records = organizations.slice(start, start + pageSize)
      return { records, cursor: records.length === pageSize ? String(Number(cursor) + 1) : null }
    },
    async listActivities({ contactId, page = 1 } = {}) {
      calls.push('albi:activities:read')
      const matching = activities.filter(item => contactId == null || String(item.contactId) === String(contactId))
      const records = matching.slice((page - 1) * 25, page * 25)
      return { records, cursor: records.length === 25 ? String(page + 1) : null }
    },
    async verifyCredentials() {
      calls.push('albi:capabilities:read')
      return { authenticated: true, company: { id: '1319', name: 'Allied Restoration Services Inc' },
        capabilities: Object.fromEntries(REQUIRED_WRITE_CAPABILITIES.map(name => [name, 'verified_on_first_use'])) }
    },
    async createOrganization(payload) {
      calls.push('albi:organizations:create')
      const record = { id: '1001', name: payload.name }
      organizations.push(record)
      return { id: record.id }
    },
    async createContact(payload) {
      calls.push('albi:contacts:create')
      const record = { id: '2001', firstName: payload.firstName, lastName: payload.lastName, organizationId: payload.organizationId }
      contacts.push(record)
      return { id: record.id }
    },
    async createActivity(payload) {
      calls.push('albi:activities:create')
      const record = { id: '3001', ...payload }
      activities.push(record)
      return { id: record.id }
    },
  }
  return { calls, hubspot, albi, activities, counts: () => ({ organizations: organizations.length, contacts: contacts.length, activities: activities.length }) }
}

function makeReviewSelfTestFixture() {
  const companyId = '00000000-0000-4000-8000-000000000010'
  const reviewId = '00000000-0000-4000-8000-000000000011'
  const stamp = '2026-10-12T10:00:00.000Z'
  const adminId = '00000000-0000-4000-8000-000000000012'
  const memberId = '00000000-0000-4000-8000-000000000013'
  const injected = { authorization: 'fixture-secret-authorization', apiKey: 'fixture-secret-key',
    notes: 'fixture-activity-body', hs_email_text: 'fixture-activity-body', hs_note_body: 'fixture-activity-body',
    message: 'fixture-provider-error' }
  const row = { id: reviewId, company_id: companyId, run_id: '00000000-0000-4000-8000-000000000015',
    portal_id: '123', object_type: 'contacts', source_id: '10', reason: 'name_only_candidate', conflict_type: 'contact_match',
    status: 'needs_review', created_at: stamp, updated_at: stamp,
    source_snapshot: { id: '10', firstName: 'Fixture', lastName: 'Person', email: 'fixture@example.test', ...injected },
    candidate_snapshots: [{ id: '20', firstName: 'Fixture', lastName: 'Person', ...injected }],
    match_evidence: { evidence: ['name_only', injected.message], ...injected },
    proposed_changes: { updates: { firstName: 'Fixture', ...injected }, ...injected }, ...injected }
  const runs = [{ id: row.run_id, company_id: companyId, mode: 'dry_run', status: 'completed',
    sample_limit_per_type: 10, review_capture_version: 1, created_at: stamp, finished_at: stamp, totals: { requires_review: 1 } }]
  const events = [{ id: 'captured-fixture', company_id: companyId, review_id: reviewId,
    event_type: 'recheck_failed', created_at: stamp, sanitized_details: { category: 'permission', code: 'operation_failed', ...injected } }]
  const tables = {
    companies: [{ id: companyId, name: 'Fixture Company' }], super_admins: [],
    company_members: [{ user_id: adminId, company_id: companyId, role: 'admin' },
      { user_id: memberId, company_id: companyId, role: 'member' }],
    h2a_company_config: [{ company_id: companyId, state: 'dry_run', preflight_status: 'valid', portal_id: '123',
      initial_start_locked_at: '2026-10-01T00:00:00.000Z' }],
    h2a_sync_runs: runs, h2a_dry_run_reviews: [row], h2a_dry_run_review_events: events,
    h2a_contact_mappings: [], h2a_organization_mappings: [], h2a_option_mappings: [], h2a_execution_leases: [],
    h2a_contact_organization_choices: [], h2a_dry_run_review_resolutions: [],
  }
  const fixture = { companyId, reviewId, row, runs, dispatched: [], mutationAccesses: 0, providerFailure: false }
  // Only the external storage boundary is doubled. Real auth, repository queries,
  // response projections, evaluator, recheck service, and full-run gate execute.
  const supabase = {
    auth: { getUser: async token => ({ data: { user: ['admin', 'member'].includes(token) ?
      { id: token === 'admin' ? adminId : memberId } : null }, error: null }) },
    from(table) {
      assert.ok(Object.hasOwn(tables, table), `unexpected table ${table}`)
      const filters = [], orders = []
      let maximum = Infinity, range = null, head = false, inserted = null
      function result() {
        const rows = inserted ?? tables[table].filter(item => filters.every(filter => filter(item)))
          .sort((a, b) => { for (const [key, ascending] of orders) {
            const difference = String(a[key]).localeCompare(String(b[key]))
            if (difference) return ascending ? difference : -difference
          } return 0 })
        const data = rows.slice(0, maximum)
        return { data: range ? data.slice(range[0], range[1] + 1) : data, count: rows.length, error: null }
      }
      const query = {
        select(_fields, options) { head = options?.head === true; return query },
        eq(key, value) { filters.push(item => item[key] === value); return query },
        gt(key, value) { filters.push(item => item[key] > value); return query },
        order(key, { ascending = true } = {}) { orders.push([key, ascending]); return query },
        limit(value) { maximum = value; return query },
        range(start, end) { range = [start, end]; return query },
        insert(payload) {
          assert.ok(['h2a_dry_run_review_events', 'h2a_sync_runs'].includes(table), `unexpected write to ${table}`)
          inserted = [{ id: `fixture-insert-${tables[table].length}`, ...payload }]
          tables[table].push(...inserted)
          return query
        },
        async maybeSingle() { const response = result(); return { ...response, data: response.data[0] ?? null } },
        async single() { const response = result(); assert.equal(response.data.length, 1); return { ...response, data: response.data[0] } },
        then(resolve, reject) { const response = result(); return Promise.resolve(head ?
          { count: response.count, error: null } : response).then(resolve, reject) },
      }
      return query
    },
    async rpc(name, input) {
      assert.equal(name, 'h2a_apply_dry_run_recheck', 'only diagnostic recheck RPC is allowed')
      assert.equal(input.p_company_id, companyId)
      assert.equal(input.p_review_id, reviewId)
      assert.equal(input.p_expected_updated_at, row.updated_at)
      assert.equal(input.p_actor_id, adminId)
      Object.assign(row, { status: input.p_status, recheck_outcome: input.p_recheck_outcome,
        reason: input.p_reason, conflict_type: input.p_conflict_type, source_snapshot: input.p_source_snapshot,
        candidate_snapshots: input.p_candidate_snapshots, match_evidence: input.p_match_evidence,
        proposed_changes: input.p_proposed_changes, last_rechecked_at: input.p_now,
        last_rechecked_by: input.p_actor_id, updated_at: input.p_now })
      events.push({ id: `terminal-${events.length}`, company_id: companyId, review_id: reviewId,
        actor_id: adminId, event_type: input.p_event_type, reason: input.p_reason,
        sanitized_details: input.p_event_details, created_at: input.p_now })
      return { data: { review: structuredClone(row) }, error: null }
    },
  }
  const hubspot = {
    async getContacts(ids) {
      assert.deepEqual(ids, ['10'])
      if (fixture.providerFailure) throw Error('fixture-provider-error with fixture-secret-key')
      return [{ id: '10', properties: { firstname: 'Fixture', lastname: 'Person', email: 'fixture@example.test', ...injected } }]
    },
    async getCompanies() { throw Error('unexpected company read') },
    async getAssociations(input) {
      assert.deepEqual(input, { objectType: 'contacts', objectIds: ['10'], toObjectTypes: ['companies'] })
      return [{ fromId: '10', toObjectType: 'companies', toIds: [] }]
    },
  }
  const albi = {
    async listContacts(input) {
      assert.deepEqual(input, { cursor: '1', pageSize: 100 })
      return { records: [{ id: '20', firstName: 'Fixture', lastName: 'Person', email: 'fixture@example.test', ...injected }], cursor: null }
    },
    async listOrganizations() { throw Error('unexpected organization read') },
  }
  const repository = createH2ARepository(supabase)
  for (const object of [hubspot, albi, repository]) {
    for (const name of ['createContact', 'createOrganization', 'createActivity', 'updateContact', 'updateOrganization',
      'associateContact', 'saveMapping', 'saveCursor', 'reserveDelivery', 'deliveryStore', 'recordConflict', 'recordItem', 'dispatch', 'getCredentials']) {
      Object.defineProperty(object, name, { get() {
        fixture.mutationAccesses++
        throw Error(`forbidden capability: ${name}`)
      } })
    }
  }
  fixture.options = { supabase, repository, now: () => new Date('2026-10-12T11:00:00.000Z'),
    makeClients: async company => { assert.equal(company, companyId); return { hubspot, albi } },
    fetch: async () => { throw Error('self-test must never access provider transport') } }
  return fixture
}

async function runReviewSelfTest(log) {
  // Removing admin enforcement, positive projections, read-only capabilities, or the
  // all-captured-row gate must fail these real handler/service assertions.
  const f = makeReviewSelfTestFixture()
  const handler = createDryRunReviewHandler(f.options)
  const get = (role, detail = false) => ({ httpMethod: 'GET', headers: { Authorization: `Bearer ${role}` },
    queryStringParameters: { companyId: f.companyId, ...(detail ? { reviewId: f.reviewId } : {}) } })
  const recheck = () => ({ httpMethod: 'POST', headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({ companyId: f.companyId, reviewId: f.reviewId, expectedUpdatedAt: f.row.updated_at }) })
  let checks = 0
  function safeResponse(response, status, label) {
    assert.equal(response.statusCode, status, label)
    assert.equal(response.headers['Cache-Control'], 'no-store', `${label}: no cached PII`)
    assert.doesNotMatch(response.body, /authorization|apiKey|hs_email_text|hs_note_body|fixture-secret|fixture-activity-body|fixture-provider-error/i,
      `${label}: secret, activity, and provider text never reach response bodies`)
    checks++
    return JSON.parse(response.body)
  }
  for (const detail of [false, true]) {
    safeResponse(await handler(get('member', detail)), 403, `member ${detail ? 'detail' : 'list'} rejected`)
    const body = safeResponse(await handler(get('admin', detail)), 200, `admin ${detail ? 'detail' : 'list'} accepted`)
    assert.equal(detail ? body.item.id : body.items[0].id, f.reviewId)
    if (detail) {
      assert.equal(body.item.sourceSnapshot.email, 'fixture@example.test')
      assert.equal(body.item.candidateSnapshots[0].id, '20')
      assert.equal(body.item.events[0].details.category, 'permission')
    } else assert.deepEqual(body.progress, { total: 1, needsReview: 1, cleared: 0, noLongerInScope: 0, fullDryRunReady: false })
  }
  const totals = structuredClone(f.runs[0].totals)
  f.providerFailure = true
  safeResponse(await handler(recheck()), 502, 'provider failure remains sanitized')
  assert.equal(f.row.status, 'needs_review', 'provider failure cannot clear a record')
  f.providerFailure = false
  const cleared = safeResponse(await handler(recheck()), 200, 'exact-match recheck clears diagnostic state')
  assert.equal(cleared.item.status, 'cleared')
  assert.equal(cleared.item.recheckOutcome, 'safe_to_link')
  assert.deepEqual(cleared.progress, { total: 1, needsReview: 0, cleared: 1, noLongerInScope: 0, fullDryRunReady: false })
  assert.deepEqual(f.runs[0].totals, totals, 'original run totals stay immutable')
  assert.equal(f.mutationAccesses, 0, 'recheck cannot even access provider/sync write capabilities')
  const run = createRunHandler({ ...f.options, dispatch: async payload => { f.dispatched.push(payload) } })
  const full = { httpMethod: 'POST', headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({ companyId: f.companyId, mode: 'dry_run', dryRunScope: 'full' }) }
  safeResponse(await run(full), 409, 'cleared old sample still blocks full dry run')
  assert.equal(f.runs.filter(item => item.status === 'queued').length, 0)
  assert.deepEqual(f.dispatched, [], 'blocked full run cannot dispatch')
  f.runs.push({ ...f.runs[0], id: '00000000-0000-4000-8000-000000000014',
    created_at: '2026-10-12T12:00:00.000Z', finished_at: '2026-10-12T12:01:00.000Z', totals: { requires_review: 0 } })
  const fresh = safeResponse(await handler(get('admin')), 200, 'fresh zero-row sample is ready')
  assert.deepEqual(fresh.items, [])
  assert.deepEqual(fresh.progress, { total: 0, needsReview: 0, cleared: 0, noLongerInScope: 0, fullDryRunReady: true })
  const accepted = safeResponse(await run(full), 202, 'fresh zero-row sample queues full dry run')
  const queued = f.runs.filter(item => item.status === 'queued')
  assert.equal(queued.length, 1)
  assert.equal(queued[0].mode, 'dry_run')
  assert.equal(queued[0].sample_limit_per_type, undefined)
  assert.equal(queued[0].review_capture_version, undefined)
  assert.deepEqual(f.dispatched, [{ companyId: f.companyId, mode: 'dry_run', trigger: 'resume', runId: accepted.runId }])
  assert.equal(f.mutationAccesses, 0)
  log(`H2A sample review self-test passed: ${checks} response checks; member/admin authorization, safe projections, read-only recheck, immutable totals, and fresh zero-row full-run gate.`)
}

export async function runSelfTest({ log = output } = {}) {
  assert.deepEqual(missingSmokeEnvironment({}), REQUIRED_PROVIDER_CREDENTIALS)
  assert.equal(cleanId('123456789'), '6789')
  const marker = makeSourceMarker({ objectType: 'meeting', activityId: 'self-test-01' })
  assert.equal(exactMarkerMatches([{ notes: `Subject: Smoke\n${marker}` }, { notes: `prefix ${marker}` }], marker).length, 1)

  const fixture = makeSelfTestAdapters()
  const env = { H2A_TEST_HUBSPOT_TOKEN: 'fixture-token', H2A_TEST_ALBI_KEY: 'fixture-key', H2A_SMOKE_RUN_ID: 'self-test-01' }
  const makeClients = () => ({ hubspot: fixture.hubspot, albi: fixture.albi })
  await runSmoke(env, { makeClients, log })
  assert.equal(fixture.calls.filter(call => call.startsWith('hubspot:search:')).length, HUBSPOT_ACTIVITY_TYPES.length, 'read-only plan uses all five HubSpot activity searches')
  assert.deepEqual(fixture.counts(), { organizations: 0, contacts: 0, activities: 0 }, 'read-only plan does not create provider records')

  const writeEnv = { ...env, H2A_ALLOW_SANDBOX_WRITES: 'true', H2A_SANDBOX_ISOLATION_ACK: ISOLATION_ACK,
    H2A_ALBI_ACTIVITY_CONTRACT_ACK: ACTIVITY_CONTRACT_ACK }
  await runSmoke(writeEnv, { makeClients, log })
  await runSmoke(writeEnv, { makeClients, log })
  assert.deepEqual(fixture.counts(), { organizations: 1, contacts: 1, activities: 1 }, 'real smoke orchestration creates exactly one of each record across rerun')
  assert.equal(exactMarkerMatches(fixture.activities, makeSourceMarker({ objectType: 'meeting', activityId: 'smoke-self-test-01' })).length, 1)

  for (const missing of ['H2A_SANDBOX_ISOLATION_ACK', 'H2A_ALBI_ACTIVITY_CONTRACT_ACK', 'H2A_SMOKE_RUN_ID']) {
    const invalid = { ...writeEnv }
    delete invalid[missing]
    let transportCalls = 0
    await assert.rejects(runSmoke(invalid, {
      makeClients: ({ fetch }) => ({ hubspot: new HubSpotClient({ token: invalid.H2A_TEST_HUBSPOT_TOKEN, fetch }), albi: new AlbiClient({ apiKey: invalid.H2A_TEST_ALBI_KEY, fetch }) }),
      fetch: async () => { transportCalls += 1; throw new Error('unexpected provider transport') },
      log,
    }), new RegExp(missing))
    assert.equal(transportCalls, 0)
  }
  log('H2A smoke orchestration self-test passed: read-only plan, guarded create and rerun exactly-once, and zero-transport write-guard ordering.')
  await runReviewSelfTest(log)
}

function makeRunId(env) {
  return env.H2A_SMOKE_RUN_ID || `read-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
}

async function readAndReport(hubspot, albi, runId, log) {
  const account = await hubspot.getAccountInfo()
  const verification = await albi.verifyCredentials()
  const options = await albi.listOptions()
  const [contacts, organizations, albiActivities] = await Promise.all([
    albi.listContacts({ pageSize: 1 }), albi.listOrganizations({ pageSize: 1 }), albi.listActivities({ page: 1 }),
  ])
  log(`HubSpot account authenticated (portal ending ${cleanId(account.portalId)}).`)
  log(`Guardian Albi wrapper authenticated for ${verification.company.name} (company ${verification.company.id}).`)
  log(`Albi options loaded: contacts=${options.contactTypes.length}, organizations=${options.organizationTypes.length}, activities=${options.activityTypes.length}.`)
  log(`Albi read shapes passed: contacts=${contacts.records.length ? 'sample available' : 'empty'}, organizations=${organizations.records.length ? 'sample available' : 'empty'}, activities=${albiActivities.records.length ? 'sample available' : 'empty'}.`)

  const lower = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const activityCounts = {}
  const associationChecks = {}
  for (const objectType of HUBSPOT_ACTIVITY_TYPES) {
    const page = await hubspot.listActivities({ objectType, occurredAtGte: lower, limit: 20 })
    activityCounts[objectType] = page.records.length
    const sampleIds = page.records.slice(0, 5).map(record => record.id)
    if (sampleIds.length) {
      const associations = await hubspot.getAssociations({ objectType, objectIds: sampleIds, toObjectTypes: ['contacts', 'companies'] })
      associationChecks[objectType] = associations.length
    } else associationChecks[objectType] = 0
    if (objectType === 'emails') {
      const allowed = page.records.filter(record => record.properties.hs_email_direction === 'EMAIL').length
      const excluded = page.records.length - allowed
      log(`HubSpot direct CRM email contract: records=${page.records.length}, direction EMAIL=${allowed}, other/unknown direction excluded=${excluded}.`)
    }
  }
  log(`HubSpot date-versioned activity reads passed: ${Object.entries(activityCounts).map(([type, count]) => `${type}=${count}`).join(', ')}.`)
  log(`HubSpot association traversal samples: ${Object.entries(associationChecks).map(([type, count]) => `${type}=${count}`).join(', ')}.`)
  log(`Planned isolated record prefix: H2A-SMOKE-${runId}. No provider response bodies or full record identifiers were printed.`)
  return { options, account, activityCounts, associationChecks }
}

async function findUnique(records, predicate, label) {
  const matches = records.filter(predicate)
  if (matches.length > 1) throw new Error(`More than one matching smoke ${label} exists; refusing to guess.`)
  return matches[0] ?? null
}

async function runGuardedWrite(albi, hubspotAccount, options, env, runId, log) {
  const verification = await albi.verifyCredentials()
  const blockers = smokeWriteBlockers(env, verification.capabilities)
  if (blockers.length) {
    throw new Error(`Sandbox write stopped before the first POST. ${blockers.join('; ')}.`)
  }
  const contractBlockers = []
  if (!options.organizationTypes.length || !options.contactTypes.length || !options.activityTypes.length) contractBlockers.push('required Albi option lists are empty')
  if (!verification.authenticated) contractBlockers.push('Albi read authentication is not valid')
  if (contractBlockers.length) throw new Error(`Sandbox write stopped before the first POST. ${contractBlockers.join('; ')}.`)

  const prefix = `H2A-SMOKE-${runId}`
  const organizationName = `${prefix} Organization`
  const contacts = await collectPages(cursor => albi.listContacts({ cursor, pageSize: 100 }), 'contact list')
  const organizations = await collectPages(cursor => albi.listOrganizations({ cursor, pageSize: 100 }), 'organization list')
  let organization = await findUnique(organizations, record => record?.name === organizationName, 'organization')
  if (!organization) organization = await albi.createOrganization({ name: organizationName, organizationTypeIds: [options.organizationTypes[0].id] })
  const firstName = 'H2A'
  const lastName = `Smoke ${runId}`
  let contact = await findUnique(contacts, record => record?.firstName === firstName && record?.lastName === lastName, 'contact')
  if (contact && String(contact.organizationId ?? '') !== String(organization.id)) {
    throw new Error('The matching smoke contact is linked to a different organization; refusing to change it.')
  }
  if (!contact) contact = await albi.createContact({ firstName, lastName, contactTypeIds: [options.contactTypes[0].id], organizationId: organization.id })
  if (!contact?.id || !organization?.id) throw new Error('Albi create response did not return a record ID; stop and inspect the isolated tenant manually.')

  const activityMarker = makeSourceMarker({ objectType: 'meeting', activityId: `smoke-${runId}` })
  const existingActivities = await collectPages(cursor => albi.listActivities({ contactId: contact.id, page: Number(cursor) }), 'activity list')
  const existing = exactMarkerMatches(existingActivities, activityMarker)
  if (existing.length > 1) throw new Error('Duplicate smoke activity markers already exist; no further write was attempted.')
  const identity = { companyId: `sandbox-${runId}`, portalId: hubspotAccount.portalId, objectType: 'meetings', activityId: `smoke-${runId}`, albiTargetType: 'contact', albiTargetId: contact.id }
  const store = makeEphemeralDeliveryStore(existing[0] ? { key: makeDeliveryKey(identity) } : null)
  const reservation = await reserveDelivery({ identity, store, albi })
  let activityResult = null
  let disposition = reservation.disposition
  if (reservation.safeToCreate === true) {
    const payload = buildAlbiActivity({ objectType: 'meetings', activityId: identity.activityId, occurredAt: new Date().toISOString(),
      activityTypeId: options.activityTypes[0].id, target: { type: 'contact', id: contact.id }, subject: `${prefix} one-time activity` })
    activityResult = await albi.createActivity(payload)
    const completed = await completeDelivery({ reservation, store, result: activityResult })
    disposition = completed.disposition
  }
  const retry = await reserveDelivery({ identity, store, albi })
  if (!['delivered', 'reconciled'].includes(retry.disposition)) throw new Error('Retry did not resolve to one terminal activity delivery.')
  const after = await collectPages(cursor => albi.listActivities({ contactId: contact.id, page: Number(cursor) }), 'activity readback')
  const markerMatches = exactMarkerMatches(after, activityMarker)
  if (markerMatches.length !== 1) throw new Error(`Expected exactly one marker-matched activity after retry; found ${markerMatches.length}.`)
  log(`Guarded Albi smoke write passed: organization …${cleanId(organization.id)}, contact …${cleanId(contact.id)}, activity …${cleanId(activityResult?.id ?? markerMatches[0].id)} (${disposition}; retry=${retry.disposition}; marker matches=${markerMatches.length}).`)
  log('No records were deleted. Manually remove the H2A-SMOKE record set from the isolated Albi tenant after review.')
}

export async function runSmoke(env = process.env, { makeClients = ({ env: values, fetch }) => ({
  hubspot: new HubSpotClient({ token: values.H2A_TEST_HUBSPOT_TOKEN, fetch }),
  albi: new AlbiClient({ apiKey: values.H2A_TEST_ALBI_KEY, fetch }),
}), fetch = globalThis.fetch, log = output } = {}) {
  const missing = missingSmokeEnvironment(env)
  if (missing.length) {
    log(`H2A sandbox smoke skipped safely; missing environment variables: ${missing.join(', ')}.`)
    return
  }
  if (env.H2A_ALLOW_SANDBOX_WRITES === 'true') {
    const blockers = smokeWriteBlockers(env)
    if (blockers.length) throw new Error(`Sandbox write stopped before any provider request. ${blockers.join('; ')}.`)
  }
  const overrides = OVERRIDE_VARS.filter(name => env[name])
  if (overrides.length) throw new Error(`Refusing unsupported provider URL overrides before provider requests: ${overrides.join(', ')}.`)
  const runId = makeRunId(env)
  const { hubspot, albi } = makeClients({ env, fetch })
  const result = await readAndReport(hubspot, albi, runId, log)
  if (env.H2A_ALLOW_SANDBOX_WRITES !== 'true') {
    log('Read-only mode complete. No provider writes were attempted. Set both documented sandbox acknowledgements and rerun with an isolated Albi sandbox to enable the guarded write path.')
    return
  }
  await runGuardedWrite(albi, result.account, result.options, env, runId, log)
}

async function main(env = process.env) {
  if (process.argv.includes('--self-test')) return runSelfTest()
  await runSmoke(env)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    // Only fixed gate messages and adapter-safe errors are allowed here.
    output(`H2A sandbox smoke stopped safely: ${error?.message?.slice(0, 500) ?? 'unknown local failure'}`)
    process.exitCode = 1
  })
}
