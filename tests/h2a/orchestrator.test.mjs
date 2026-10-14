import test from 'node:test'
import assert from 'node:assert/strict'
import { runCompanySync } from '../../netlify/functions/_h2a/orchestrator.js'
import { ApiError } from '../../netlify/functions/_h2a/http.js'
import { createH2ARepository } from '../../netlify/functions/_h2a/repository.js'
import { createSettingsHandler } from '../../netlify/functions/h2a-settings.js'
import { presentDryRunTotals } from '../../src/features/hubspotToAlbi/dryRunTotals.js'
import { evaluateContactReview, evaluateOrganizationReview } from '../../netlify/functions/_h2a/review.js'

test('lease collision returns stable already-running result without provider access', async () => {
  const result = await runCompanySync({ repository: { claimLease: async () => false }, hubspot: { listActivities: () => { throw Error('provider touched') } } },
    { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.deepEqual(result, { status: 'already_running', companyId: 'c1' })
})

test('a persisted orchestrator failure carries only durable notification metadata to its caller', async () => {
  const transitions = []
  const repository = {
    claimLease: async () => true, releaseLease: async () => {},
    getConfig: async () => ({ state: 'live', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' }),
    startRun: async () => ({ id: 'run-failed' }),
    getMappings: async () => { throw Error('private provider detail') },
    totals: async () => ({ failed: 1 }),
    finishRun: async (_company, runId, status, totals) => { transitions.push({ runId, status, totals }) },
  }
  await assert.rejects(() => runCompanySync({ repository, albi: {}, hubspot: {} },
    { companyId: 'c1', mode: 'live', trigger: 'scheduled', runId: 'run-failed' }), error => {
      assert.deepEqual(error.h2aPersistedFailure, { runId: 'run-failed', totals: { failed: 1 }, newConflictCount: 0 })
      assert.equal(error.message, 'private provider detail')
      return true
    })
  assert.deepEqual(transitions, [{ runId: 'run-failed', status: 'failed', totals: { failed: 1 } }])
})

test('a failed resume keeps its persisted failure primary when requeue cleanup throws', async () => {
  const cleanupLogs = []
  const primary = Error('source operation failed')
  const repository = {
    claimLease: async () => true, releaseLease: async () => {},
    getConfig: async () => ({ state: 'live', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' }),
    startRun: async () => ({ id: 'run-resume', status: 'queued' }), getMappings: async () => { throw primary },
    totals: async () => ({ failed: 1 }), finishRun: async () => {},
    requeueConflictResume: async () => { throw Error('secret requeue details') },
  }
  await assert.rejects(() => runCompanySync({ repository, albi: {}, hubspot: {}, logger: { warn: (_message, data) => cleanupLogs.push(data) } },
    { companyId: 'c1', mode: 'live', trigger: 'conflict_resolution', resumeId: 'resume-1' }), error => {
      assert.equal(error, primary)
      assert.deepEqual(error.h2aPersistedFailure, { runId: 'run-resume', totals: { failed: 1 }, newConflictCount: 0 })
      return true
    })
  assert.deepEqual(cleanupLogs, [{ phase: 'resume_requeue', reason: 'error:operation_failed' }])
})

test('a failed run keeps its persisted failure primary when lease release throws', async () => {
  const cleanupLogs = []
  const primary = Error('source operation failed')
  const repository = {
    claimLease: async () => true, releaseLease: async () => { throw Error('secret lease details') },
    getConfig: async () => ({ state: 'live', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' }),
    startRun: async () => ({ id: 'run-release' }), getMappings: async () => { throw primary },
    totals: async () => ({ failed: 1 }), finishRun: async () => {},
  }
  await assert.rejects(() => runCompanySync({ repository, albi: {}, hubspot: {}, logger: { warn: (_message, data) => cleanupLogs.push(data) } },
    { companyId: 'c1', mode: 'live', trigger: 'scheduled' }), error => {
      assert.equal(error, primary)
      assert.deepEqual(error.h2aPersistedFailure, { runId: 'run-release', totals: { failed: 1 }, newConflictCount: 0 })
      return true
    })
  assert.deepEqual(cleanupLogs, [{ phase: 'lease_release', reason: 'error:operation_failed' }])
})

test('lease release failure remains observable when the run itself succeeded', async () => {
  const deps = liveFixture({ activities: [] })
  const cleanupLogs = []
  deps.repository.releaseLease = async () => { throw Error('lease release failed') }
  deps.logger = { warn: (_message, values) => cleanupLogs.push(values) }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' }), /lease release failed/)
  assert.ok(deps.events.includes('finish'))
  assert.deepEqual(cleanupLogs, [{ phase: 'lease_release', reason: 'error:operation_failed' }])
})

test('dry run records previews and leaves every live mutation unused', async () => {
  const items = []
  const repo = {
    claimLease: async () => true, releaseLease: async () => true,
    getConfig: async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' }),
    getMappings: async () => ({ contacts: [], organizations: [], options: [] }),
    startRun: async () => ({ id: 'run1' }), getCursor: async () => null,
    getRunCheckpoint: async () => null, saveRunCheckpoint: async () => {},
    recordItem: async (_company, row) => { items.push(row) },
    totals: async () => ({ dry_run: items.length }), finishRun: async () => {}, heartbeatLease: async () => true,
  }
  const result = await runCompanySync({ repository: repo,
    hubspot: { listActivities: async ({ objectType }) => ({ records: objectType === 'calls' ? [{ id: 'a1', occurredAt: '2026-10-02T12:00:00Z', properties: { hs_timestamp: '2026-10-02T12:00:00Z' } }] : [], after: null }) },
    albi: { listContacts: async () => ({ records: [], cursor: null }), listOrganizations: async () => ({ records: [], cursor: null }) },
  }, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.equal(items[0].outcome, 'dry_run')
})

test('sample dry run processes at most ten earliest records per activity type and ignores later pages', async () => {
  const deps = liveFixture({ contactIds: [], companyIds: [], activities: [] })
  deps.repository.getConfig = async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' })
  deps.repository.startRun = async () => ({ id: 'sample-run', sample_limit_per_type: 10 })
  const searches = []
  let processed = 0
  deps.hubspot.listActivities = async ({ objectType, limit, after }) => {
    searches.push({ objectType, limit, after: after ?? null })
    const records = Array.from({ length: 15 }, (_, index) => ({
      id: String(1000 + searches.length * 100 + index),
      occurredAt: `2026-10-02T12:${String(index).padStart(2, '0')}:00Z`,
      objectType,
      properties: objectType === 'emails' ? { hs_email_direction: 'EMAIL' } : {},
    }))
    return { records, after: 'later-page' }
  }
  deps.hubspot.getAssociations = async () => { processed += 1; return [] }

  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'sample-run' })

  assert.equal(result.status, 'completed')
  assert.equal(searches.length, 5)
  assert.deepEqual(searches.map(search => search.limit), [10, 10, 10, 10, 10])
  assert.deepEqual(searches.map(search => search.after), [null, null, null, null, null])
  assert.equal(processed, 50)
})

test('sample dry run pages past inbound emails until it finds ten direct emails', async () => {
  const deps = liveFixture({ contactIds: [], companyIds: [], activities: [] })
  deps.repository.getConfig = async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' })
  deps.repository.startRun = async () => ({ id: 'sample-run', sample_limit_per_type: 10 })
  const emailSearches = []
  const processed = []
  deps.hubspot.listActivities = async ({ objectType, after }) => {
    if (objectType !== 'emails') return { records: [], after: null }
    emailSearches.push(after ?? null)
    const direct = after === 'email-page-2'
    return {
      records: Array.from({ length: 10 }, (_, index) => ({
        id: String((direct ? 2000 : 1000) + index),
        occurredAt: `2026-10-02T12:${String(index).padStart(2, '0')}:00Z`,
        objectType: 'emails',
        properties: { hs_email_direction: direct ? 'EMAIL' : 'INCOMING_EMAIL' },
      })),
      after: direct ? 'email-page-3' : 'email-page-2',
    }
  }
  deps.hubspot.getAssociations = async ({ objectIds }) => { processed.push(objectIds[0]); return [] }

  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'sample-run' })

  assert.equal(result.status, 'completed')
  assert.deepEqual(emailSearches, [null, 'email-page-2'])
  assert.equal(processed.length, 10)
  assert.equal(deps.items.some(item => item.sanitized_details?.reason === 'not_verified_direct_crm_email'), false)
})

async function assertSampleContinuation(pageChanges) {
  const deps = liveFixture({ contactIds: [], companyIds: [], activities: [] })
  deps.repository.getConfig = async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' })
  deps.repository.startRun = async () => ({ id: 'sample-run', sample_limit_per_type: 10 })
  const checkpoints = new Map()
  deps.repository.getRunCheckpoint = async (_company, _run, type) => checkpoints.get(type) ?? null
  deps.repository.saveRunCheckpoint = async (_company, _run, type, checkpoint) => {
    checkpoints.set(type, structuredClone(checkpoint))
    return checkpoint
  }
  let invocation = 1
  let clock = 0
  const callLimits = []
  const processed = []
  deps.clockMs = () => clock
  deps.now = () => new Date('2026-10-09T20:00:00.000Z')
  deps.hubspot.listActivities = async ({ objectType, limit }) => {
    if (objectType !== 'calls') return { records: [], after: null }
    callLimits.push(limit)
    const count = 10
    const base = pageChanges && invocation > 1 ? 200 : 100
    const minuteOffset = pageChanges && invocation > 1 ? 10 : 0
    return { records: Array.from({ length: count }, (_, index) => ({
      id: String(base + index),
      occurredAt: `2026-10-02T12:${String(index + minuteOffset).padStart(2, '0')}:00Z`,
      objectType: 'calls', properties: {},
    })), after: 'provider-has-more' }
  }
  deps.hubspot.getAssociations = async ({ objectIds }) => { processed.push(objectIds[0]); return [] }
  const recordItem = deps.repository.recordItem
  deps.repository.recordItem = async (companyId, row) => {
    await recordItem(companyId, row)
    if (row.object_type === 'calls' && processed.length === 4) clock = 2000
  }
  deps.dispatchContinuation = async () => {}

  const first = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'sample-run', timeBudgetMs: 6000 })
  assert.equal(first.status, 'paused')
  assert.equal(checkpoints.get('calls')?.processedCount, 4)

  invocation = 2
  clock = 0
  const second = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'sample-run' })
  assert.equal(second.status, 'completed')
  assert.deepEqual(callLimits, [10, 10])
  assert.equal(processed.length, 10)
  assert.equal(checkpoints.get('calls')?.processedCount, 10)
  assert.equal(checkpoints.get('calls')?.completed, true)
}

test('resumed sample dry run fills its durable remaining count from a stable first page', async () => {
  await assertSampleContinuation(false)
})

test('resumed sample dry run never exceeds its durable remaining count when the first page changes', async () => {
  await assertSampleContinuation(true)
})

function liveFixture({ contactIds = ['10'], companyIds = ['20'], activities = [{ id: '50', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: { hs_timestamp: '2026-10-02T12:00:00Z' } }], albiContacts = [], albiOrganizations = [] } = {}) {
  const events = [], items = [], durableItems = [], cursors = [], persistedRuns = [], runCheckpoints = new Map()
  const totalsRepository = createH2ARepository({
    from(table) {
      assert.equal(table, 'h2a_item_results')
      const filters = []
      return { select() { return this }, eq(key, value) { filters.push([key, value]); return this },
        order() { return this }, range(start, end) {
          return Promise.resolve({ data: durableItems.filter(row => filters.every(([key, value]) => row[key] === value))
            .slice(start, end + 1), error: null })
        } }
    },
    rpc: async () => ({ data: true }),
  })
  const mappings = { contacts: [], organizations: [], options: [
    { mapping_kind: 'default_contact_type', source_key: 'default', albi_id: '1', confirmed_at: '2026-10-01T00:00:00Z' },
    { mapping_kind: 'default_organization_type', source_key: 'default', albi_id: '2', confirmed_at: '2026-10-01T00:00:00Z' },
    { mapping_kind: 'activity_type', source_key: 'calls', albi_id: '3', confirmed_at: '2026-10-01T00:00:00Z' },
  ] }
  const deliveries = new Map()
  const repository = {
    claimLease: async () => true, releaseLease: async () => { events.push('release') }, heartbeatLease: async () => true,
    getConfig: async () => ({ state: 'live', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' }),
    getMappings: async () => mappings, startRun: async () => ({ id: 'run1' }), getCursor: async () => null,
    getRunCheckpoint: async (_company, _run, type) => runCheckpoints.get(type) ?? null,
    saveRunCheckpoint: async (_company, _run, type, checkpoint) => { runCheckpoints.set(type, structuredClone(checkpoint)); return checkpoint },
    saveCursor: async (_company, type, cursor) => { cursors.push({ type, cursor }) },
    getItemOutcomes: async (_company, _run, type, id) => items.filter(row => row.object_type === type && row.source_id === id),
    recordItem: async (companyId, row) => {
      items.push(row)
      durableItems.push({ ...row, company_id: companyId, id: `item-${durableItems.length + 1}`,
        created_at: `2026-10-02T10:00:${String(durableItems.length).padStart(2, '0')}Z` })
      events.push(`item:${row.outcome}`)
    },
    saveMapping: async (_company, kind, row) => { events.push(`mapping:${kind}`); return row },
    recordConflict: async (_company, row) => { events.push(`conflict:${row.reason}`); return row },
    totals: (_company, runId, mode) => totalsRepository.totals('c1', runId, mode),
    finishRun: async (_company, runId, status, totals) => { persistedRuns.push({ id: runId, company_id: 'c1', runId, status, totals,
      mode: 'dry_run', sample_limit_per_type: null,
      created_at: '2026-10-02T10:00:01.000Z', finished_at: '2026-10-02T10:05:00.000Z' }); events.push('finish') },
    deliveryStore: () => ({
      reserve: async ({ identity }) => {
        const key = `${identity.objectType}:${identity.activityId}:${identity.albiTargetId}`
        if (deliveries.has(key)) return { acquired: false, row: deliveries.get(key) }
        const row = { id: key, state: 'reserved', attempt_count: 1 }
        deliveries.set(key, row)
        return { acquired: true, isNew: true, row }
      },
      transition: async ({ id, patch }) => {
        const row = { id, ...patch, attempt_count: 1 }
        deliveries.set(id, row)
        return { updated: true, row }
      },
    }),
  }
  const hubspot = {
    listActivities: async ({ objectType }) => ({ records: objectType === 'calls' ? activities : [], after: null }),
    getAssociations: async () => [ { toObjectType: 'contacts', toIds: contactIds }, { toObjectType: 'companies', toIds: companyIds } ],
    getContacts: async ids => ids.map(id => ({ id, properties: { firstname: `First${id}`, lastname: `Last${id}`, email: `${id}@example.com` } })),
    getCompanies: async ids => ids.map(id => ({ id, properties: { name: `Company${id}`, phone: '4155550123' } })),
  }
  const albi = {
    listContacts: async () => ({ records: albiContacts, cursor: null }),
    listOrganizations: async () => ({ records: albiOrganizations, cursor: null }),
    createOrganization: async () => { events.push('create:organization'); return { id: '100' } },
    createContact: async () => { events.push('create:contact'); return { id: '200' } },
    createActivity: async () => { events.push('create:activity'); return { id: '300' } },
  }
  return { repository, hubspot, albi, events, items, durableItems, cursors, mappings, persistedRuns, runCheckpoints }
}

test('live sync creates organization before contact and persists delivery before cursor', async () => {
  const deps = liveFixture()
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.ok(deps.events.indexOf('create:organization') < deps.events.indexOf('create:contact'))
  assert.ok(deps.events.indexOf('create:contact') < deps.events.indexOf('create:activity'))
  assert.equal(deps.items.filter(item => item.outcome === 'delivered').length, 1)
  assert.deepEqual(deps.cursors.find(row => row.type === 'calls')?.cursor, { timestamp: '2026-10-02T12:00:00.000Z', objectId: '50' })
})

test('missing name leaves a review conflict and does not create a contact', async () => {
  const deps = liveFixture({ companyIds: [] })
  deps.hubspot.getContacts = async ids => ids.map(id => ({ id, properties: { firstname: 'Only' } }))
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'partially_failed')
  assert.ok(deps.events.includes('conflict:missing_required_name'))
  assert.ok(!deps.events.includes('create:contact'))
  assert.equal(deps.cursors.length, 0)
})

test('first-use create scope denial fails the item and holds the checkpoint', async () => {
  const deps = liveFixture({ companyIds: [] })
  deps.albi.createContact = async () => {
    throw new ApiError('permission', { operation: 'createContact', status: 403, requiredScope: 'contacts:create' })
  }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'partially_failed')
  assert.equal(deps.cursors.length, 0)
  assert.ok(deps.items.some(item => item.outcome === 'failed' && item.sanitized_details.requiredScope === 'contacts:create'))
})

test('activity create scope denial keeps delivery disposition and names the required scope', async () => {
  const deps = liveFixture()
  deps.albi.createActivity = async () => {
    throw new ApiError('permission', { operation: 'createActivity', status: 403, requiredScope: 'activities:create' })
  }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  const failed = deps.items.find(item => item.object_type === 'calls' && item.outcome === 'failed')
  assert.equal(result.status, 'partially_failed')
  assert.equal(failed.sanitized_details.reason, 'failed')
  assert.equal(failed.sanitized_details.requiredScope, 'activities:create')
  assert.equal(deps.cursors.length, 0)
})

test('existing contact reassociation becomes a conflict without wrapper mutations', async () => {
  const deps = liveFixture({
    albiOrganizations: [{ id: '100', name: 'Company20', phoneNumber: '415-555-0123', organizationTypeIds: ['2'] }],
    albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10', email: '10@example.com', organizationId: '999' }],
  })
  let mutationCalls = 0
  deps.albi.updateContact = async () => { mutationCalls += 1; throw new Error('must not mutate') }
  deps.albi.updateOrganization = async () => { mutationCalls += 1; throw new Error('must not mutate') }
  deps.albi.associateContact = async () => { mutationCalls += 1; throw new Error('must not mutate') }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'partially_failed')
  assert.equal(mutationCalls, 0)
  assert.ok(deps.events.includes('conflict:albi_contact_association_contract_unverified'))
  assert.equal(deps.cursors.length, 0)
})

test('mixed contact targets deliver safe fan-out while unresolved target holds cursor', async () => {
  const deps = liveFixture({ contactIds: ['10', '11'], companyIds: [],
    albiContacts: [{ id: '201', firstName: 'First10', lastName: 'Last10', email: '10@example.com' }] })
  deps.hubspot.getContacts = async ids => ids.map(id => id === '11'
    ? { id, properties: { firstname: 'Only' } }
    : { id, properties: { firstname: 'First10', lastname: 'Last10', email: '10@example.com' } })
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'partially_failed')
  assert.equal(deps.items.filter(item => item.outcome === 'delivered').length, 1)
  assert.equal(deps.cursors.length, 0)
})

test('dry run evaluates associations and proposed creations without provider writes or durable mappings', async () => {
  const deps = liveFixture()
  deps.repository.getConfig = async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' })
  deps.repository.saveMapping = async () => { throw Error('mapping mutated') }
  deps.repository.recordConflict = async () => { throw Error('conflict mutated') }
  deps.repository.deliveryStore = () => { throw Error('delivery mutated') }
  deps.albi.createOrganization = async () => { throw Error('organization mutated') }
  deps.albi.createContact = async () => { throw Error('contact mutated') }
  deps.albi.createActivity = async () => { throw Error('activity mutated') }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.ok(deps.items.some(item => item.object_type === 'companies' && item.sanitized_details.proposedAction === 'create_organization'))
  assert.ok(deps.items.some(item => item.object_type === 'contacts' && item.sanitized_details.proposedAction === 'create_contact'))
  assert.deepEqual(deps.persistedRuns[0].totals, {
    created: 0, updated: 0, linked: 0, delivered: 0, reconciled: 0, skipped: 0, conflict: 0, failed: 0, dry_run: 4,
    would_create_organizations: 2,
    would_create_contacts: 1,
    would_link: 0,
    would_deliver_activities: 0,
    requires_review: 1,
    skipped: 0,
  })
  const tables = {
    companies: [{ id: 'c1', name: 'Alpha' }],
    super_admins: [],
    company_members: [{ user_id: 'user-1', company_id: 'c1', role: 'member' }],
    h2a_company_config: [{ company_id: 'c1', state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-02',
      initial_start_locked_at: '2026-10-02T10:00:00.000Z', preflight_status: 'valid', preflight_details: {},
      option_confirmation_status: 'confirmed', notification_recipients: [] }],
    h2a_option_mappings: [],
    h2a_sync_runs: deps.persistedRuns,
  }
  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from(table) {
      const filters = []
      let orderedBy, ascending = false, rowLimit
      const query = {
        select() { return this },
        eq(key, value) { filters.push(row => row[key] === value); return this },
        is(key, value) { filters.push(row => row[key] === value); return this },
        gt(key, value) { filters.push(row => row[key] > value); return this },
        order(key, options = {}) { orderedBy = key; ascending = options.ascending !== false; return this },
        limit(value) { rowLimit = value; return this },
        async maybeSingle() { const result = await execute(); return { data: result.data[0] ?? null, error: null } },
        then(resolve, reject) { return execute().then(resolve, reject) },
      }
      async function execute() {
        let rows = tables[table].filter(row => filters.every(filter => filter(row)))
        if (orderedBy) rows = [...rows].sort((left, right) => String(left[orderedBy]).localeCompare(String(right[orderedBy])) * (ascending ? 1 : -1))
        if (rowLimit !== undefined) rows = rows.slice(0, rowLimit)
        return { data: structuredClone(rows), error: null }
      }
      return query
    },
    rpc: async () => ({ data: null, error: null }),
  }
  const settingsHandler = createSettingsHandler({ supabase,
    keyring: { activeVersion: 1, keys: { 1: Buffer.alloc(32, 7) } },
    now: () => new Date('2026-10-02T10:06:00.000Z'),
  })
  const settingsResponse = await settingsHandler({ httpMethod: 'GET', headers: { authorization: 'Bearer test' } })
  const settings = JSON.parse(settingsResponse.body)
  assert.equal(settingsResponse.statusCode, 200)
  assert.deepEqual(presentDryRunTotals(settings.lastCompletedDryRun.totals), [
    { key: 'would_create_organizations', label: 'Would create organizations', value: 2 },
    { key: 'would_create_contacts', label: 'Would create contacts', value: 1 },
    { key: 'requires_review', label: 'Needs review', value: 1 },
  ])
  assert.equal(deps.cursors.length, 0)
})

test('new records write US phone in Albi format', async () => {
  const deps = liveFixture()
  let contactPayload, organizationPayload
  deps.albi.createOrganization = async payload => { organizationPayload = payload; return { id: '100' } }
  deps.albi.createContact = async payload => { contactPayload = payload; return { id: '200' } }
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(organizationPayload.phoneNumber, '415-555-0123')
  assert.equal(contactPayload.phoneNumber, undefined)
})

test('targeted conflict resume loads and processes only its persisted activity without moving cursors', async () => {
  const deps = liveFixture()
  const calls = []
  const intent = { id: 'resume-1', company_id: 'c1', status: 'pending', resolution_action: 'link_existing',
    source_object_type: 'contacts', source_id: '10', activity_object_type: 'calls', activity_id: '50' }
  deps.repository.getConflictResume = async (companyId, resumeId) => { assert.equal(companyId, 'c1'); assert.equal(resumeId, 'resume-1'); return intent }
  deps.repository.getResumeRun = async () => null
  deps.repository.startRun = async (_company, input) => { assert.equal(input.resumeId, 'resume-1'); return { id: 'run-resume', status: 'running' } }
  deps.repository.totals = async () => ({ delivered: 1 })
  deps.repository.isSkippedItem = async () => false
  deps.hubspot.listActivities = async () => { throw Error('targeted resume must not scan') }
  deps.hubspot.getActivity = async (type, id) => { calls.push([type, id]); return { id, objectType: type,
    occurredAt: '2026-10-02T12:00:00Z', properties: { hs_timestamp: '2026-10-02T12:00:00Z' } } }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'conflict_resolution', resumeId: 'resume-1' })
  assert.equal(result.status, 'completed')
  assert.deepEqual(calls, [['calls', '50']])
  assert.equal(deps.cursors.length, 0)
  assert.ok(deps.events.includes('create:activity'))
})

test('reviewer skip remains terminal in later broad cursor overlap', async () => {
  const deps = liveFixture()
  let created = false
  deps.repository.isSkippedItem = async (_company, _portal, type, id) => type === 'calls' && id === '50'
  deps.albi.createActivity = async () => { created = true; return { id: '300' } }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.equal(created, false)
  assert.ok(deps.items.some(item => item.source_id === '50' && item.outcome === 'skipped' && item.sanitized_details.reason === 'reviewer_skipped'))
})

test('same-timestamp page boundary does not advance cursor before next page is durable', async () => {
  const deps = liveFixture()
  let calls = 0
  deps.hubspot.listActivities = async ({ objectType }) => {
    if (objectType !== 'calls') return { records: [], after: null }
    calls += 1
    if (calls === 2) throw Error('page unavailable')
    return { records: [{ id: '51', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: {} }], after: 'next' }
  }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' }), /page unavailable/)
  assert.equal(deps.cursors.length, 0)
  assert.equal(deps.items.filter(item => item.outcome === 'delivered').length, 1)
})

test('continuation dispatch follows durable paused run and lease release exactly once', async () => {
  const deps = liveFixture()
  let dispatched = 0
  deps.dispatchContinuation = async payload => { dispatched += 1; deps.events.push('dispatch'); assert.equal(payload.runId, 'run1') }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual', timeBudgetMs: 1000 })
  assert.equal(result.status, 'paused')
  assert.equal(dispatched, 1)
  assert.ok(deps.events.indexOf('finish') < deps.events.indexOf('release'))
  assert.ok(deps.events.indexOf('release') < deps.events.indexOf('dispatch'))
})

test('requested cancellation stops a resumed run before provider reads and never dispatches another continuation', async () => {
  const transitions = []
  let dispatched = 0
  const repository = {
    claimLease: async () => true,
    releaseLease: async () => true,
    getConfig: async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' }),
    startRun: async () => ({ id: 'run-cancelled', status: 'paused', cancel_requested_at: '2026-10-09T20:00:00.000Z' }),
    totals: async () => ({ dry_run: 12, requires_review: 3 }),
    finishRun: async (_companyId, runId, status, totals) => {
      transitions.push({ runId, status, totals })
      return { id: runId, status }
    },
  }
  const result = await runCompanySync({
    repository,
    albi: { listContacts: async () => { throw Error('Albi must not be read after cancellation') } },
    hubspot: { listActivities: async () => { throw Error('HubSpot must not be read after cancellation') } },
    dispatchContinuation: async () => { dispatched += 1 },
  }, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'run-cancelled' })
  assert.deepEqual(result, {
    status: 'cancelled', companyId: 'c1', runId: 'run-cancelled',
    totals: { dry_run: 12, requires_review: 3 }, newConflictCount: 0, continuation: false,
  })
  assert.deepEqual(transitions, [{ runId: 'run-cancelled', status: 'cancelled', totals: { dry_run: 12, requires_review: 3 } }])
  assert.equal(dispatched, 0)
})

test('dry-run continuation resumes from a durable per-run checkpoint instead of restarting', async () => {
  const activities = [
    { id: '50', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: {} },
    { id: '51', occurredAt: '2026-10-02T12:01:00Z', objectType: 'calls', properties: {} },
  ]
  const deps = liveFixture({ contactIds: [], companyIds: [], activities })
  deps.repository.getConfig = async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' })
  const checkpoints = new Map()
  deps.repository.getRunCheckpoint = async (_companyId, _runId, objectType) => checkpoints.get(objectType) ?? null
  deps.repository.saveRunCheckpoint = async (_companyId, _runId, objectType, checkpoint) => {
    checkpoints.set(objectType, structuredClone(checkpoint))
    return checkpoint
  }
  let clock = 0
  deps.clockMs = () => clock
  deps.now = () => new Date('2026-10-09T20:00:00.000Z')
  const processed = []
  deps.hubspot.getAssociations = async ({ objectType, objectIds }) => {
    if (objectType === 'calls') processed.push(objectIds[0])
    return []
  }
  const recordItem = deps.repository.recordItem
  deps.repository.recordItem = async (companyId, row) => {
    await recordItem(companyId, row)
    if (row.object_type === 'calls' && row.source_id === '50') clock = 2000
  }
  let dispatched = 0
  deps.dispatchContinuation = async () => { dispatched += 1 }

  const first = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual', timeBudgetMs: 6000 })
  assert.equal(first.status, 'paused')
  assert.equal(dispatched, 1)
  assert.deepEqual(checkpoints.get('calls'), {
    upperBound: '2026-10-09T20:00:00.001Z', pageAfter: null,
    processedCount: 0, timestamp: '2026-10-02T12:00:00.000Z', objectId: '50', completed: false,
  })

  clock = 0
  const second = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'run1' })
  assert.equal(second.status, 'completed')
  assert.deepEqual(processed, ['50', '51'])
  assert.deepEqual(checkpoints.get('calls'), {
    upperBound: '2026-10-09T20:00:00.001Z', pageAfter: null, processedCount: 0, completed: true,
  })
})

test('dry-run continuation persists the next HubSpot page cursor at a budget boundary', async () => {
  const deps = liveFixture({ contactIds: [], companyIds: [], activities: [] })
  deps.repository.getConfig = async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' })
  const checkpoints = new Map()
  deps.repository.getRunCheckpoint = async (_companyId, _runId, objectType) => checkpoints.get(objectType) ?? null
  deps.repository.saveRunCheckpoint = async (_companyId, _runId, objectType, checkpoint) => {
    checkpoints.set(objectType, structuredClone(checkpoint))
    return checkpoint
  }
  let clock = 0
  deps.clockMs = () => clock
  deps.now = () => new Date('2026-10-09T20:00:00.000Z')
  const processed = [], upperBounds = []
  deps.hubspot.getAssociations = async ({ objectType, objectIds }) => {
    if (objectType === 'calls') processed.push(objectIds[0])
    return []
  }
  deps.hubspot.listActivities = async ({ objectType, after, occurredAtLt }) => {
    if (objectType !== 'calls') return { records: [], after: null }
    upperBounds.push(occurredAtLt)
    if (!after) return { records: [{ id: '50', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: {} }], after: 'page-2' }
    assert.equal(after, 'page-2')
    return { records: [{ id: '51', occurredAt: '2026-10-02T12:01:00Z', objectType: 'calls', properties: {} }], after: null }
  }
  const recordItem = deps.repository.recordItem
  deps.repository.recordItem = async (companyId, row) => {
    await recordItem(companyId, row)
    if (row.object_type === 'calls' && row.source_id === '50') clock = 2000
  }
  deps.dispatchContinuation = async () => {}

  const first = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual', timeBudgetMs: 6000 })
  assert.equal(first.status, 'paused')
  assert.equal(checkpoints.get('calls')?.pageAfter, 'page-2')

  clock = 0
  const second = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'run1' })
  assert.equal(second.status, 'completed')
  assert.deepEqual(processed, ['50', '51'])
  assert.equal(new Set(upperBounds).size, 1)
})

test('backfill divides a seeded range into Pacific day reads across spring DST', async () => {
  const deps = liveFixture({ activities: [] })
  const ranges = [], saved = []
  deps.repository.listBackfillWindows = async (_company, objectType) => objectType === 'calls' ? [{
    id: 'window1', object_type: 'calls', start_at: '2026-03-07T08:00:00.000Z', end_at: '2026-03-10T07:00:00.000Z',
    status: 'pending', checkpoint_timestamp: null, checkpoint_object_id: null,
  }] : []
  deps.repository.saveBackfillWindow = async (_company, id, patch) => { saved.push({ id, patch }) }
  deps.hubspot.listActivities = async args => { ranges.push([args.occurredAtGte, args.occurredAtLt]); return { records: [], after: null } }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'backfill', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.deepEqual(ranges, [
    ['2026-03-07T08:00:00.000Z', '2026-03-08T08:00:00.000Z'],
    ['2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z'],
    ['2026-03-09T07:00:00.000Z', '2026-03-10T07:00:00.000Z'],
  ])
  assert.deepEqual(saved.at(-1), { id: 'window1', patch: { status: 'completed', run_id: 'run1' } })
})

test('an already delivered identity stays terminal when the source body changes', async () => {
  const deps = liveFixture({ companyIds: [], albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10', email: '10@example.com' }] })
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  deps.hubspot.listActivities = async ({ objectType }) => ({ records: objectType === 'calls' ? [{ id: '50',
    occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: { hs_call_body: 'Edited after delivery' } }] : [], after: null })
  deps.albi.createActivity = async () => { throw Error('duplicate write') }
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(deps.items.filter(item => item.outcome === 'delivered').length, 1)
  assert.ok(deps.items.some(item => item.outcome === 'skipped' && item.sanitized_details.reason === 'already_delivered'))
})

test('read rate limits honor bounded retry metadata and continue the same run', async () => {
  const deps = liveFixture({ activities: [] })
  let attempts = 0, delay
  deps.hubspot.listActivities = async ({ objectType }) => {
    if (objectType === 'calls' && attempts++ === 0) throw { category: 'rate_limit', retryAfterMs: 1200 }
    return { records: [], after: null }
  }
  deps.sleep = async ms => { delay = ms }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.equal(delay, 1200)
  assert.ok(attempts >= 2)
})

test('long provider Retry-After is deferred instead of retried early', async () => {
  const deps = liveFixture({ activities: [] })
  let attempts = 0, sleeps = 0
  deps.hubspot.listActivities = async () => { attempts += 1; throw { category: 'rate_limit', retryAfterMs: 20000 } }
  deps.sleep = async () => { sleeps += 1 }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' }))
  assert.equal(attempts, 1)
  assert.equal(sleeps, 0)
})

test('run error summary cannot persist an arbitrary provider code or secret', async () => {
  const deps = liveFixture({ activities: [] })
  let summary
  deps.hubspot.listActivities = async () => { throw { category: 'permanent', code: 'pat-private-token' } }
  deps.repository.finishRun = async (_company, _run, _status, _totals, errorSummary) => { summary = errorSummary }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' }))
  assert.ok(!summary.includes('pat-private-token'))
})

test('contact association chooses its own organization when activity has several companies', async () => {
  const deps = liveFixture({ companyIds: ['20', '21'] })
  let nextId = 100, contactPayload
  deps.albi.createOrganization = async () => ({ id: String(nextId++) })
  deps.albi.createContact = async payload => { contactPayload = payload; return { id: '200' } }
  deps.hubspot.getAssociations = async ({ objectType }) => objectType === 'contacts'
    ? [{ fromId: '10', toObjectType: 'companies', toIds: ['20'] }]
    : [{ toObjectType: 'contacts', toIds: ['10'] }, { toObjectType: 'companies', toIds: ['20', '21'] }]
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(contactPayload.organizationId, '100')
})

function reviewedSyncFixture() {
  const deps = liveFixture({ companyIds: ['20', '21'], albiOrganizations: [
    { id: '100', name: 'Company20', phoneNumber: '4155550123' },
    { id: '101', name: 'Company21', phoneNumber: '4155550123' },
  ] })
  deps.mappings.organizations.push({ portal_id: '123', hubspot_id: '20', albi_organization_id: '100' },
    { portal_id: '123', hubspot_id: '21', albi_organization_id: '101' })
  deps.choice = { company_id: 'c1', portal_id: '123', hubspot_contact_id: '10', hubspot_company_id: '21' }
  deps.directIds = ['20', '21']; deps.choiceReads = []
  deps.repository.getContactOrganizationChoice = async (...args) => { deps.choiceReads.push(args); return deps.choice }
  deps.hubspot.getAssociations = async ({ objectType }) => objectType === 'contacts'
    ? [{ fromId: '10', toObjectType: 'companies', toIds: deps.directIds }]
    : [{ toObjectType: 'contacts', toIds: ['10'] }, { toObjectType: 'companies', toIds: ['20', '21'] }]
  deps.albi.createContact = async payload => { deps.contactPayload = payload; return { id: '200' } }
  for (const object of [deps.hubspot, deps.albi]) for (const name of ['removeAssociation', 'removeContactCompanyAssociation', 'updateContact', 'associateContact']) {
    Object.defineProperty(object, name, { get() { throw Error(`Forbidden capability: ${name}`) } })
  }
  return deps
}

test('broad sync uses tenant-scoped reviewed context, preserves associations, and caches portal plus contact choices', async () => {
  const deps = reviewedSyncFixture()
  deps.hubspot.listActivities = async ({ objectType }) => ({ records: objectType === 'calls' ? [
    { id: '50', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: {} },
    { id: '51', occurredAt: '2026-10-02T12:01:00Z', objectType: 'calls', properties: {} },
  ] : [], after: null })
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(deps.contactPayload?.organizationId, '101')
  assert.deepEqual(deps.directIds, ['20', '21'])
  assert.deepEqual(deps.choiceReads, [['c1', '123', '10']])
  assert.equal(deps.events.includes('conflict:multiple_associated_organizations'), false)
})

test('a failed reviewed choice lookup is cached and never permits contact processing', async () => {
  const deps = reviewedSyncFixture()
  let reads = 0
  deps.repository.getContactOrganizationChoice = async () => { reads++; throw Error('choice storage unavailable') }
  deps.hubspot.listActivities = async ({ objectType }) => ({ records: objectType === 'calls' ? [
    { id: '50', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: {} },
    { id: '51', occurredAt: '2026-10-02T12:01:00Z', objectType: 'calls', properties: {} },
  ] : [], after: null })
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(reads, 1)
  assert.equal(deps.contactPayload, undefined)
  assert.ok(deps.items.some(item => item.object_type === 'contacts' && item.outcome === 'failed'))
})

test('broad sync permits an explicitly added company only after a new direct association read contains it', async () => {
  const deps = reviewedSyncFixture()
  let associationReads = 0
  deps.hubspot.getAssociations = async ({ objectType }) => {
    if (objectType !== 'contacts') return [{ toObjectType: 'contacts', toIds: ['10'] }, { toObjectType: 'companies', toIds: ['20', '21'] }]
    associationReads++
    return [{ fromId: '10', toObjectType: 'companies', toIds: associationReads === 1 ? ['20', '22'] : ['20', '21', '22'] }]
  }
  deps.hubspot.listActivities = async ({ objectType }) => ({ records: objectType === 'calls' ? [
    { id: '50', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: {} },
    { id: '51', occurredAt: '2026-10-02T12:01:00Z', objectType: 'calls', properties: {} },
  ] : [], after: null })
  deps.albi.createContact = async payload => {
    assert.equal(associationReads, 2)
    deps.contactPayload = payload
    return { id: '200' }
  }
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.ok(deps.events.includes('conflict:multiple_associated_organizations'))
  assert.equal(deps.contactPayload?.organizationId, '101')
  assert.deepEqual(deps.choiceReads, [['c1', '123', '10']])
})

for (const invalid of ['absent', 'missing', 'deleted', 'cross-tenant', 'wrong portal', 'wrong contact', 'no longer associated', 'activity only']) {
  test(`broad sync ignores ${invalid} organization choice`, async () => {
    const deps = reviewedSyncFixture()
    if (invalid === 'absent') deps.choice = null
    if (invalid === 'missing') deps.hubspot.getCompanies = async () => [{ id: '20', properties: { name: 'Company20', phone: '4155550123' } }]
    if (invalid === 'deleted') deps.hubspot.getCompanies = async () => [
      { id: '20', properties: { name: 'Company20', phone: '4155550123' } }, { id: '21', archived: true, properties: {} }]
    if (invalid === 'cross-tenant') deps.choice.company_id = 'other'
    if (invalid === 'wrong portal') deps.choice.portal_id = '456'
    if (invalid === 'wrong contact') deps.choice.hubspot_contact_id = '99'
    if (invalid === 'no longer associated') deps.choice.hubspot_company_id = '22'
    if (invalid === 'activity only') deps.directIds = []
    await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
    assert.equal(deps.contactPayload, undefined)
    assert.ok(deps.events.includes('conflict:multiple_associated_organizations'))
  })
}

test('reviewed broad context cannot bypass organization field review', async () => {
  const deps = reviewedSyncFixture()
  deps.albi.listOrganizations = async () => ({ records: [
    { id: '100', name: 'Company20', phoneNumber: '4155550123' },
    { id: '101', name: 'Other', phoneNumber: '4155550123' },
  ], cursor: null })
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(deps.contactPayload, undefined)
  assert.ok(deps.events.includes('conflict:organization_unresolved'))
})

for (const existing of [true, false]) test(`reviewed dry-run company creation ${existing ? 'cannot preview an existing contact link' : 'permits new contact creation'}`, async () => {
  const deps = reviewedSyncFixture()
  deps.repository.getConfig = async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' })
  deps.mappings.organizations.length = 0
  deps.albi.listOrganizations = async () => ({ records: [], cursor: null })
  deps.albi.listContacts = async () => ({ records: existing ? [{ id: '200', firstName: 'First10', lastName: 'Last10',
    email: '10@example.com', organizationId: 'old-org' }] : [], cursor: null })
  await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  const item = deps.items.find(item => item.object_type === 'contacts' && item.source_id === '10')
  assert.equal(item.sanitized_details.proposedAction, existing ? 'review_conflict' : 'create_contact')
  if (existing) assert.equal(item.sanitized_details.reason, 'albi_contact_association_contract_unverified')
  assert.ok(deps.items.some(item => item.object_type === 'companies' && item.source_id === '21' &&
    item.sanitized_details.proposedAction === 'create_organization'))
  assert.equal(deps.contactPayload, undefined)
  assert.deepEqual(deps.directIds, ['20', '21'])
})

test('missing association records are reviewed instead of falling back to an organization activity', async () => {
  const deps = liveFixture()
  deps.hubspot.getContacts = async () => []
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'partially_failed')
  assert.ok(!deps.events.includes('create:activity'))
  assert.equal(deps.cursors.length, 0)
})

test('unverified blank-field updates create review records with safe side-by-side values', async () => {
  const deps = liveFixture({ companyIds: [], albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10',
    email: '10@example.com', city: '' }] })
  deps.hubspot.getContacts = async ids => ids.map(id => ({ id, properties: { firstname: 'First10', lastname: 'Last10',
    email: '10@example.com', city: 'San Francisco' } }))
  const conflicts = []
  deps.repository.recordConflict = async (_company, row) => { conflicts.push(row) }
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  const captured = conflicts.find(row => row.reason === 'albi_contact_update_contract_unverified')
  assert.equal(captured.reason, 'albi_contact_update_contract_unverified')
  assert.equal(captured.source_snapshot.email, '10@example.com')
  assert.equal(captured.candidate_snapshots[0].email, '10@example.com')
  assert.equal(captured.proposed_changes.updates.city, 'San Francisco')
  assert.ok(!deps.events.includes('create:activity'))
})

test('near budget boundary stops after a durable item and queues one continuation', async () => {
  const deps = liveFixture({ companyIds: [], activities: [
    { id: '50', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: {} },
    { id: '51', occurredAt: '2026-10-02T12:01:00Z', objectType: 'calls', properties: {} },
  ], albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10', email: '10@example.com' }] })
  let clock = 0, dispatched = 0
  deps.clockMs = () => clock
  deps.albi.createActivity = async () => { clock = 2000; return { id: '300' } }
  deps.dispatchContinuation = async () => { dispatched += 1 }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual', timeBudgetMs: 6000 })
  assert.equal(result.status, 'paused')
  assert.equal(deps.items.filter(item => item.outcome === 'delivered').length, 1)
  assert.equal(dispatched, 1)
})

test('stale post-write delivery reconciles as a durable recovered outcome', async () => {
  const deps = liveFixture({ companyIds: [], albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10', email: '10@example.com' }] })
  deps.repository.deliveryStore = () => ({
    reserve: async () => ({ acquired: true, isNew: false,
      previous: { state: 'reserved', last_attempt_at: '2020-01-01T00:00:00Z', next_attempt_at: null },
      row: { id: 'delivery-1', state: 'reserved', attempt_count: 2 } }),
    transition: async ({ patch }) => ({ updated: true, row: { id: 'delivery-1', ...patch } }),
  })
  deps.albi.listActivities = async () => ({ records: [{ id: '300', notes: 'Prior write\nSource: HubSpot call 50' }], cursor: null })
  deps.albi.createActivity = async () => { throw Error('duplicate create') }
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(deps.items.filter(item => item.outcome === 'reconciled').length, 1)
})

test('organization conflict holds the activity checkpoint while safe contact still delivers', async () => {
  const deps = liveFixture({ albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10', email: '10@example.com' }] })
  deps.hubspot.getCompanies = async ids => ids.map(id => ({ id, properties: { name: '' } }))
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'partially_failed')
  assert.equal(deps.items.filter(item => item.outcome === 'delivered').length, 1)
  assert.equal(deps.cursors.length, 0)
})

test('new organization confirmed type inheritance selects contact type before the fallback', async () => {
  const deps = liveFixture()
  deps.mappings.options.push({ mapping_kind: 'organization_to_contact_type', source_key: '2', albi_id: '9',
    confirmed_at: '2026-10-01T00:00:00Z' })
  let contactPayload
  deps.albi.createContact = async payload => { contactPayload = payload; return { id: '200' } }
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.deepEqual(contactPayload.contactTypeIds, ['9'])
})

test('dry preview shows inherited contact type without creating records', async () => {
  const deps = liveFixture()
  deps.repository.getConfig = async () => ({ state: 'dry_run', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' })
  deps.mappings.options.push({ mapping_kind: 'organization_to_contact_type', source_key: '2', albi_id: '9',
    confirmed_at: '2026-10-01T00:00:00Z' })
  await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(deps.items.find(item => item.object_type === 'contacts')?.sanitized_details.contactTypeId, '9')
  assert.ok(!deps.events.includes('create:contact'))
})

test('activity payload includes a known HubSpot owner name', async () => {
  const deps = liveFixture({ companyIds: [], activities: [{ id: '50', occurredAt: '2026-10-02T12:00:00Z',
    objectType: 'calls', properties: { hubspot_owner_id: '5' } }],
    albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10', email: '10@example.com' }] })
  deps.hubspot.listOwners = async () => [{ id: '5', firstName: 'Ali', lastName: 'Brown' }]
  let payload
  deps.albi.createActivity = async value => { payload = value; return { id: '300' } }
  await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.match(payload.notes, /Owner: Ali Brown/)
})

function storedReviewRepository(deps) {
  return createH2ARepository({ rpc: async () => ({}), from(table) {
    assert.ok(['h2a_sync_runs', 'h2a_dry_run_reviews'].includes(table))
    const filters = [], orders = []
    let rowLimit, rangeStart = 0, rangeEnd, countOnly = false, deleting = false
    function execute() {
      let rows = table === 'h2a_sync_runs' ? deps.persistedRuns : [...deps.reviewRows.values()]
      rows = rows.filter(row => filters.every(filter => filter(row)))
      if (deleting) for (const [key, row] of deps.reviewRows) {
        if (filters.every(filter => filter(row))) deps.reviewRows.delete(key)
      }
      rows = [...rows].sort((left, right) => {
        for (const [key, ascending] of orders) {
          const result = String(left[key]).localeCompare(String(right[key])) * (ascending ? 1 : -1)
          if (result) return result
        }
        return 0
      })
      return { data: countOnly ? null : rows.slice(0, rowLimit).slice(rangeStart, rangeEnd), count: rows.length, error: null }
    }
    return {
      select(_fields, options) { countOnly = options?.head === true; return this },
      eq(key, value) { filters.push(row => row[key] === value); return this },
      neq(key, value) { filters.push(row => row[key] !== value); return this },
      in(key, values) { filters.push(row => values.includes(row[key])); return this },
      gt(key, value) { filters.push(row => Date.parse(row[key]) > Date.parse(value)); return this },
      order(key, options) { orders.push([key, options.ascending]); return this },
      limit(value) { rowLimit = value; return this },
      range(start, end) { rangeStart = start; rangeEnd = end + 1; return this },
      delete() { assert.equal(table, 'h2a_dry_run_reviews'); deleting = true; return this },
      maybeSingle: async () => ({ data: execute().data[0] ?? null, error: null }),
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject) },
    }
  } })
}

function reviewSampleFixture(options = {}, runOverrides = {}) {
  const deps = liveFixture(options)
  const captures = [], prunes = [], transitions = [], rows = new Map()
  const run = { id: 'sample-run', mode: 'dry_run', sample_limit_per_type: 10, review_capture_version: 1,
    created_at: '2026-10-02T12:00:00Z', ...runOverrides }
  deps.repository.getConfig = async () => ({ state: run.mode === 'dry_run' ? 'dry_run' : 'live', portal_id: '123',
    selected_start_date: '2026-10-01', preflight_status: 'valid', initial_start_locked_at: '2026-10-01T00:00:00Z' })
  deps.repository.startRun = async () => run
  const getAssociations = deps.hubspot.getAssociations
  deps.hubspot.getAssociations = async input => {
    const associations = await getAssociations(input)
    return input.objectType === 'contacts'
      ? input.objectIds.map(fromId => ({ fromId, toObjectType: 'companies',
        toIds: associations.find(row => row.toObjectType === 'companies')?.toIds ?? [] }))
      : associations
  }
  deps.repository.getItemOutcomes = async (_company, id, type, sourceId) => deps.items
    .filter(row => row.run_id === id && row.object_type === type && row.source_id === sourceId)
    .map(row => ({ ...row, albi_target_type: row.albi_target_type ?? null, albi_target_id: row.albi_target_id ?? null }))
  deps.repository.recordDryRunReview = async (company, row) => {
    captures.push({ company, row: structuredClone(row) })
    rows.set([company, row.run_id, row.portal_id, row.object_type, row.source_id].join(':'), { company_id: company, ...structuredClone(row) })
    return row
  }
  deps.repository.finishRun = async (_company, id, status, totals) => {
    transitions.push({ id, status, totals })
    const stored = { ...run, status, totals, company_id: 'c1' }
    const index = deps.persistedRuns.findIndex(item => item.id === id)
    if (index === -1) deps.persistedRuns.push(stored)
    else deps.persistedRuns[index] = stored
    deps.events.push(`finish:${status}`)
  }
  deps.repository.pruneSupersededDryRunReviews = async (company, keepId) => {
    prunes.push({ company, keepId })
    deps.events.push('prune')
    return storedReviewRepository(deps).pruneSupersededDryRunReviews(company, keepId)
  }
  deps.repository.getCurrentReviewSample = async (company, after) => {
    assert.equal(company, 'c1')
    assert.equal(after, '2026-10-01T00:00:00Z')
    deps.events.push('current_sample')
    return storedReviewRepository(deps).getCurrentReviewSample(company, after)
  }
  return Object.assign(deps, { captures, prunes, transitions, reviewRows: rows, sampleRun: run })
}

const twoReviewActivities = [
  { id: '50', objectType: 'calls', occurredAt: '2026-10-02T12:00:00Z', properties: { hs_call_body: 'private activity body' } },
  { id: '51', objectType: 'calls', occurredAt: '2026-10-02T12:01:00Z', properties: { hs_call_body: 'another private body' } },
]

test('version-one sample captures one sanitized contact and organization despite repeated activity encounters', async () => {
  const deps = reviewSampleFixture({ activities: twoReviewActivities,
    albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10', notes: 'private candidate notes', apiKey: 'private-key' }],
    albiOrganizations: [{ id: '100', name: 'Company20', notes: 'private notes', authorization: 'private-token' }],
  })
  const getContacts = deps.hubspot.getContacts, getCompanies = deps.hubspot.getCompanies
  deps.hubspot.getContacts = async ids => (await getContacts(ids)).map(row => ({ ...row,
    properties: { ...row.properties, hs_note_body: 'private source body', authorization: 'private-token' } }))
  deps.hubspot.getCompanies = async ids => (await getCompanies(ids)).map(row => ({ ...row,
    properties: { ...row.properties, apiKey: 'private-key', arbitrary: { notes: 'private' } } }))
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'sample-run' })
  assert.equal(result.status, 'completed')
  assert.equal(deps.captures.length, 2)
  assert.deepEqual(deps.captures.map(({ company, row }) => [company, row.run_id, row.portal_id, row.object_type, row.source_id]), [
    ['c1', 'sample-run', '123', 'companies', '20'], ['c1', 'sample-run', '123', 'contacts', '10'],
  ])
  assert.ok(deps.captures.every(({ row }) => row.reason === 'name_only_candidate'))
  assert.equal(deps.captures[1].row.source_snapshot.email, '10@example.com')
  assert.deepEqual(deps.captures[1].row.candidate_snapshots, [{ id: '200', firstName: 'First10', lastName: 'Last10' }])
  assert.deepEqual(deps.captures[1].row.match_evidence, { evidence: [] })
  assert.doesNotMatch(JSON.stringify(deps.captures), /private|notes|authorization|apiKey|hs_call_body|hs_note_body/)
  assert.equal(deps.reviewRows.size, 2)
  assert.ok(deps.items.some(row => row.object_type === 'calls' && row.sanitized_details.proposedAction === 'review_conflict'))
  assert.equal(deps.items.filter(row => ['contacts', 'companies'].includes(row.object_type)).length, 2)
  assert.ok(!deps.events.some(event => /mapping:|create:|conflict:/.test(event)))
  assert.equal(deps.cursors.length, 0)
})

test('activity-only sample findings never persist detailed activity content', async () => {
  const deps = reviewSampleFixture({ contactIds: [], companyIds: [], activities: twoReviewActivities })
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.equal(deps.captures.length, 0)
  assert.deepEqual(deps.prunes, [{ company: 'c1', keepId: 'sample-run' }])
  assert.ok(deps.items.some(row => row.object_type === 'calls' && row.sanitized_details.proposedAction === 'review_conflict'))
})

test('capture eligibility comes exclusively from persisted dry-run mode, exact sample limit and version', async () => {
  for (const runOverrides of [
    { sample_limit_per_type: null }, { sample_limit_per_type: 9 }, { review_capture_version: null },
    { review_capture_version: undefined }, { review_capture_version: 2 }, { review_capture_version: '1' },
    { mode: undefined }, { mode: 'live', sample_limit_per_type: null },
  ]) {
    const deps = reviewSampleFixture({ companyIds: [], albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10' }] }, runOverrides)
    const mode = runOverrides.mode === 'live' ? 'live' : 'dry_run'
    await runCompanySync(deps, { companyId: 'c1', mode, trigger: 'manual', sampleLimitPerType: 10, reviewCaptureVersion: 1 })
    assert.equal(deps.captures.length, 0)
    assert.equal(deps.prunes.length, 0)
  }
})

for (const objectType of ['contacts', 'companies']) test(`${objectType} capture failure fails the sample before checkpoint or publication`, async () => {
  const deps = reviewSampleFixture({ companyIds: objectType === 'companies' ? ['20'] : [],
    albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10' }],
    albiOrganizations: [{ id: '100', name: 'Company20' }],
  })
  deps.repository.recordDryRunReview = async (_company, row) => {
    assert.equal(row.object_type, objectType)
    throw Error('private capture database details')
  }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' }))
  assert.deepEqual(deps.transitions.map(row => row.status), ['failed'])
  assert.equal(deps.prunes.length, 0)
  assert.equal(deps.runCheckpoints.has('calls'), false)
  assert.ok(!deps.items.some(row => row.sanitized_details.proposedAction === 'review_conflict'))
})

test('review-capable sample provider read failure cannot publish an empty clean set', async () => {
  const deps = reviewSampleFixture()
  deps.hubspot.getAssociations = async () => { throw new ApiError('auth', { code: 'application_error' }) }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' }))
  assert.deepEqual(deps.transitions.map(row => row.status), ['failed'])
  assert.equal(deps.prunes.length, 0)
})

test('sample completion is durable before old details are pruned, including zero-review samples', async () => {
  const deps = reviewSampleFixture({ activities: [] })
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.deepEqual(deps.prunes, [{ company: 'c1', keepId: 'sample-run' }])
  assert.ok(deps.events.indexOf('finish:completed') < deps.events.indexOf('prune'))
  assert.ok(deps.events.indexOf('finish:completed') < deps.events.indexOf('current_sample'))
  assert.ok(deps.events.indexOf('current_sample') < deps.events.indexOf('prune'))
  assert.ok(deps.events.indexOf('prune') < deps.events.indexOf('release'))
})

test('an older paused or queued sample completing later preserves newer reviews and blocked readiness', async () => {
  const olderId = '00000000-0000-4000-8000-000000000001'
  const newerId = '00000000-0000-4000-8000-000000000002'
  for (const status of ['paused', 'queued']) for (const sameCreatedAt of [false, true]) {
    const deps = reviewSampleFixture({ activities: [] }, { id: olderId, status,
      created_at: sameCreatedAt ? '2026-10-03T12:00:00Z' : '2026-10-02T12:00:00Z' })
    deps.persistedRuns.push({ id: newerId, company_id: 'c1', mode: 'dry_run', status: 'completed',
      sample_limit_per_type: 10, review_capture_version: 1, created_at: '2026-10-03T12:00:00Z' })
    deps.reviewRows.set(`c1:${newerId}:123:contacts:30`, { company_id: 'c1', run_id: newerId,
      portal_id: '123', object_type: 'contacts', source_id: '30', status: 'needs_review' })
    const repository = storedReviewRepository(deps)
    const after = '2026-10-01T00:00:00Z'
    assert.equal((await repository.getCurrentReviewSample('c1', after)).id, newerId)
    assert.equal(await repository.hasCleanReviewSampleDryRun('c1', after), false)
    const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: olderId })
    assert.equal(result.status, 'completed')
    assert.equal(await repository.countDryRunReviews('c1', newerId), 1)
    assert.equal((await repository.getCurrentReviewSample('c1', after)).id, newerId)
    assert.equal(await repository.hasCleanReviewSampleDryRun('c1', after), false)
    assert.equal(deps.prunes.length, 0)
  }
})

test('current-sample resolution failure preserves completed result and all review rows with fixed cleanup log', async () => {
  const deps = reviewSampleFixture({ activities: [] })
  deps.reviewRows.set('c1:prior:123:contacts:30', { company_id: 'c1', run_id: 'prior' })
  const logs = []
  deps.logger = { warn: (_message, data) => logs.push(data) }
  deps.repository.getCurrentReviewSample = async () => { throw { category: 'private-category', code: 'private-key', message: 'private-body' } }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.equal(deps.reviewRows.size, 1)
  assert.equal(deps.prunes.length, 0)
  assert.deepEqual(deps.transitions.map(row => row.status), ['completed'])
  assert.deepEqual(logs, [{ phase: 'dry_run_review_cleanup', reason: 'error:operation_failed' }])
})

test('a finishing sample outside the current-sample cutoff cannot prune review data', async () => {
  const deps = reviewSampleFixture({ activities: [] }, { created_at: '2026-09-30T12:00:00Z' })
  deps.reviewRows.set('c1:prior:123:contacts:30', { company_id: 'c1', run_id: 'prior' })
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'sample-run' })
  assert.equal(result.status, 'completed')
  assert.equal(deps.prunes.length, 0)
  assert.equal(deps.reviewRows.size, 1)
})

test('a missing initial date lock skips pruning without querying an undefined cutoff', async () => {
  const deps = reviewSampleFixture({ activities: [] })
  const config = await deps.repository.getConfig()
  delete config.initial_start_locked_at
  deps.repository.getConfig = async () => config
  deps.repository.getCurrentReviewSample = async () => { throw Error('undefined cutoff queried') }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.equal(deps.prunes.length, 0)
})

test('older completion preserves a newer paused sample capture through its later completed resume', async () => {
  const deps = reviewSampleFixture({ activities: [] }, { id: 'older-A' })
  const newer = { id: 'newer-B', company_id: 'c1', mode: 'dry_run', status: 'paused',
    sample_limit_per_type: 10, review_capture_version: 1, created_at: '2026-10-03T12:00:00Z' }
  deps.persistedRuns.push(newer)
  deps.reviewRows.set('c1:newer-B:123:contacts:30', { company_id: 'c1', run_id: 'newer-B',
    portal_id: '123', object_type: 'contacts', source_id: '30', status: 'needs_review' })
  const repository = storedReviewRepository(deps)
  const first = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual', runId: 'older-A' })
  assert.equal(first.status, 'completed')
  assert.equal(await repository.countDryRunReviews('c1', 'newer-B'), 1)
  Object.assign(deps.sampleRun, newer)
  const second = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'newer-B' })
  assert.equal(second.status, 'completed')
  assert.equal((await repository.getCurrentReviewSample('c1', '2026-10-01T00:00:00Z')).id, 'newer-B')
  assert.equal(await repository.countDryRunReviews('c1', 'newer-B'), 1)
  assert.equal(await repository.hasCleanReviewSampleDryRun('c1', '2026-10-01T00:00:00Z'), false)
})

test('newer completion prunes only terminal capable sets and preserves every older resumable set', async () => {
  const deps = reviewSampleFixture({ activities: [] }, { id: 'newest-D', created_at: '2026-10-04T12:00:00Z' })
  const retained = ['queued', 'running', 'paused', 'partially_failed', 'failed']
  const states = [...retained, 'completed', 'cancelled']
  for (const status of states) {
    const id = `old-${status}`
    deps.persistedRuns.push({ id, company_id: 'c1', mode: 'dry_run', status,
      sample_limit_per_type: 10, review_capture_version: 1, created_at: '2026-10-02T12:00:00Z' })
    deps.reviewRows.set(`c1:${id}:123:contacts:30`, { company_id: 'c1', run_id: id, status: 'needs_review' })
  }
  deps.persistedRuns.push({ id: 'other-tenant', company_id: 'c2', mode: 'dry_run', status: 'completed',
    sample_limit_per_type: 10, review_capture_version: 1, created_at: '2026-10-02T12:00:00Z' })
  deps.reviewRows.set('c2:other-tenant:123:contacts:30', { company_id: 'c2', run_id: 'other-tenant' })
  deps.persistedRuns.push({ id: 'historical', company_id: 'c1', mode: 'dry_run', status: 'completed',
    sample_limit_per_type: 10, review_capture_version: null, created_at: '2026-10-02T12:00:00Z' })
  deps.reviewRows.set('c1:historical:123:contacts:30', { company_id: 'c1', run_id: 'historical' })
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.deepEqual([...deps.reviewRows.values()].map(row => row.run_id).sort(), [
    'historical', 'old-failed', 'old-partially_failed', 'old-paused', 'old-queued', 'old-running', 'other-tenant',
  ])
  assert.deepEqual(deps.prunes, [{ company: 'c1', keepId: 'newest-D' }])
})

test('failure to durably finish a sample prevents pruning', async () => {
  const deps = reviewSampleFixture({ activities: [] })
  const finishRun = deps.repository.finishRun
  deps.repository.finishRun = async (...args) => {
    if (args[2] === 'completed') throw Error('database unavailable')
    return finishRun(...args)
  }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' }))
  assert.equal(deps.prunes.length, 0)
  assert.deepEqual(deps.transitions.map(row => row.status), ['failed'])
})

test('prune failures log fixed sanitized cleanup data and preserve successful completed results', async () => {
  const deps = reviewSampleFixture({ activities: [] })
  const logs = []
  deps.logger = { warn: (_message, data) => logs.push(data) }
  deps.repository.pruneSupersededDryRunReviews = async () => { throw { category: 'private-category', code: 'private-token', message: 'private body' } }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.deepEqual(deps.transitions.map(row => row.status), ['completed'])
  assert.deepEqual(logs, [{ phase: 'dry_run_review_cleanup', reason: 'error:operation_failed' }])
})

test('failed, partial, paused and cancelled samples never prune old details', async () => {
  for (const state of ['failed', 'partially_failed', 'paused', 'cancelled']) {
    const deps = reviewSampleFixture({ activities: [] }, state === 'cancelled' ? { cancel_requested_at: '2026-10-02T12:00:00Z' } : {})
    if (state === 'failed') deps.repository.getMappings = async () => { throw Error('read failed') }
    if (state === 'partially_failed') deps.repository.totals = async () => ({ failed: 1 })
    if (state === 'paused') deps.clockMs = (() => { let calls = 0; return () => calls++ ? 2000 : 0 })()
    if (state === 'failed') await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' }))
    else assert.equal((await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual', timeBudgetMs: 6000 })).status, state)
    assert.equal(deps.prunes.length, 0)
    assert.deepEqual(deps.transitions.map(row => row.status), [state])
  }
})

test('continuation reuses source identity while a later failed sample leaves the prior completed set current', async () => {
  const deps = reviewSampleFixture({ companyIds: [], activities: twoReviewActivities,
    albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10' }],
  })
  let clock = 0
  deps.clockMs = () => clock
  const recordItem = deps.repository.recordItem
  deps.repository.recordItem = async (...args) => { await recordItem(...args); if (args[1].object_type === 'calls') clock = 2000 }
  const first = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual', timeBudgetMs: 6000 })
  assert.equal(first.status, 'paused')
  assert.equal(deps.prunes.length, 0)
  clock = 0
  deps.repository.recordItem = recordItem
  const second = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'sample-run' })
  assert.equal(second.status, 'completed')
  assert.equal(deps.reviewRows.size, 1)
  assert.equal(deps.captures.length, 2)
  assert.deepEqual(deps.captures.map(({ row }) => [row.run_id, row.portal_id, row.object_type, row.source_id]), [
    ['sample-run', '123', 'contacts', '10'], ['sample-run', '123', 'contacts', '10'],
  ])
  const completed = structuredClone(deps.persistedRuns[0])
  deps.sampleRun.id = 'later-failed-sample'
  deps.sampleRun.created_at = '2026-10-03T12:00:00Z'
  deps.runCheckpoints.clear()
  deps.repository.recordDryRunReview = async () => { throw Error('later capture failed') }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' }))
  assert.deepEqual(deps.persistedRuns[0], completed)
  assert.equal(deps.persistedRuns[1].status, 'failed')
  assert.deepEqual(deps.prunes, [{ company: 'c1', keepId: 'sample-run' }])
  assert.equal([...deps.reviewRows.values()][0].run_id, 'sample-run')
  // Use the real current-sample query against persisted run states, not a fixture selector.
  const repository = createH2ARepository({ rpc: async () => ({}), from() { const filters = []; return {
    select() { return this }, eq(key, value) { filters.push(row => row[key] === value); return this },
    gt(key, value) { filters.push(row => row[key] > value); return this }, order() { return this }, limit() { return this },
    maybeSingle: async () => ({ data: [...deps.persistedRuns].reverse().find(row => filters.every(filter => filter(row))) ?? null, error: null }),
  } } })
  assert.equal((await repository.getCurrentReviewSample('c1', '2026-10-01T00:00:00Z')).id, 'sample-run')
})

test('sample phone and unresolved-organization decisions agree with shared recheck evaluators', async () => {
  for (const objectType of ['contacts', 'companies']) {
    const deps = reviewSampleFixture({ companyIds: objectType === 'companies' ? ['20'] : [] })
    const source = objectType === 'contacts'
      ? { id: '10', properties: { firstname: 'New', lastname: 'Person', phone: '+442079460123' } }
      : { id: '20', properties: { name: 'New Organization', phone: '+442079460123' } }
    if (objectType === 'contacts') deps.hubspot.getContacts = async () => [source]
    else deps.hubspot.getCompanies = async () => [source]
    await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
    const evaluation = objectType === 'contacts'
      ? evaluateContactReview({ source, optionMappings: deps.mappings.options })
      : evaluateOrganizationReview({ source, optionMappings: deps.mappings.options })
    const captured = deps.captures.find(({ row }) => row.object_type === objectType)?.row
    assert.equal(captured?.reason, 'unsupported_international_format')
    assert.equal(captured.reason, evaluation.reason)
    assert.equal(captured.conflict_type, evaluation.conflictType)
    if (objectType === 'companies') assert.equal(deps.captures.find(({ row }) => row.object_type === 'contacts').row.reason, 'organization_unresolved')
  }
})

test('diagnostic candidates are bounded while live mapping and dry-link actions retain original long IDs', async () => {
  for (const mode of ['live', 'dry_run']) {
    const contactId = 'c'.repeat(520), organizationId = 'o'.repeat(520)
    const deps = reviewSampleFixture({
      albiContacts: [{ id: contactId, firstName: 'First10', lastName: 'Last10', email: '10@example.com', organizationId }],
      albiOrganizations: [{ id: organizationId, name: 'Company20', phoneNumber: '415-555-0123', organizationTypeIds: ['2'] }],
    }, { mode, sample_limit_per_type: mode === 'dry_run' ? 10 : null, review_capture_version: mode === 'dry_run' ? 1 : null })
    const saved = []
    deps.repository.saveMapping = async (_company, kind, row) => { saved.push({ kind, row }); return row }
    const result = await runCompanySync(deps, { companyId: 'c1', mode, trigger: 'manual' })
    assert.equal(result.status, 'completed')
    assert.equal(deps.items.find(row => row.object_type === 'contacts').albi_target_id, contactId)
    assert.equal(deps.items.find(row => row.object_type === 'companies').albi_target_id, organizationId)
    assert.equal(deps.items.find(row => row.object_type === 'calls').albi_target_id, contactId)
    if (mode === 'live') {
      assert.equal(saved.find(item => item.kind === 'contact').row.albi_contact_id, contactId)
      assert.equal(saved.find(item => item.kind === 'organization').row.albi_organization_id, organizationId)
    } else assert.equal(saved.length, 0)
  }
  const deps = reviewSampleFixture({ companyIds: [], albiContacts: Array.from({ length: 15 }, (_, i) => ({
    id: `candidate-${i}-${'x'.repeat(520)}`, firstName: 'First10', lastName: 'Last10', email: '10@example.com',
  })) })
  await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(deps.captures[0].row.candidate_snapshots.length, 10)
  assert.ok(deps.captures[0].row.candidate_snapshots.every(row => row.id.length === 500))
})

test('colliding capped target prefixes fail closed instead of linking or publishing a clean sample', async () => {
  for (const mode of ['live', 'dry_run']) for (const suffix of ['b', '']) {
    const prefix = 'x'.repeat(500)
    const deps = reviewSampleFixture({ companyIds: [], albiContacts: [
      { id: `${prefix}a`, firstName: 'First10', lastName: 'Last10', email: '10@example.com' },
      { id: `${prefix}${suffix}`, firstName: 'Other', lastName: 'Person', email: 'other@example.com' },
    ] }, { mode, sample_limit_per_type: mode === 'dry_run' ? 10 : null, review_capture_version: mode === 'dry_run' ? 1 : null })
    const result = await runCompanySync(deps, { companyId: 'c1', mode, trigger: 'manual' })
    assert.equal(result.status, 'partially_failed')
    assert.equal(deps.prunes.length, 0)
    assert.ok(deps.items.some(row => row.object_type === 'contacts' && row.outcome === 'failed'))
    assert.ok(!deps.items.some(row => row.albi_target_id === prefix))
    assert.ok(!deps.events.some(event => /mapping:|create:/.test(event)))
  }
})

test('safe creates use the same boolean-confirmed original organization type accepted by evaluation', async () => {
  const deps = liveFixture()
  deps.mappings.options = deps.mappings.options.map(row => row.mapping_kind === 'default_organization_type'
    ? { mapping_kind: row.mapping_kind, source_key: 'default', albi_id: '2', confirmed: true } : row)
  let organizationPayload
  deps.albi.createOrganization = async payload => { organizationPayload = payload; return { id: '100' } }
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.deepEqual(organizationPayload.organizationTypeIds, ['2'])
})

test('sample missing HubSpot organization captures its underlying identity even without contacts', async () => {
  const deps = reviewSampleFixture({ contactIds: [], companyIds: ['20'] })
  deps.hubspot.getCompanies = async () => []
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.equal(deps.captures.length, 1)
  assert.deepEqual(deps.captures[0], { company: 'c1', row: {
    run_id: 'sample-run', portal_id: '123', object_type: 'companies', source_id: '20',
    reason: 'missing_hubspot_company', conflict_type: 'missing_source', source_snapshot: { id: '20' },
    candidate_snapshots: [], match_evidence: { evidence: [] }, proposed_changes: { updates: {}, conflicts: {}, unchanged: [] },
  } })
})

test('failed HubSpot company reads never become missing-company diagnostic rows', async () => {
  const deps = reviewSampleFixture({ contactIds: [], companyIds: ['20'] })
  deps.hubspot.getCompanies = async () => { throw new ApiError('permission', { code: 'application_error' }) }
  await assert.rejects(() => runCompanySync(deps, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' }))
  assert.equal(deps.captures.length, 0)
  assert.equal(deps.prunes.length, 0)
  assert.deepEqual(deps.transitions.map(row => row.status), ['failed'])
})

test('sample missing contact and association ambiguity retain full source identity for correction', async () => {
  const missing = reviewSampleFixture({ companyIds: [] })
  missing.hubspot.getContacts = async () => []
  await runCompanySync(missing, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(missing.captures[0].row.reason, 'missing_hubspot_contact')
  assert.deepEqual(missing.captures[0].row.source_snapshot, { id: '10' })
  const ambiguous = reviewSampleFixture({ companyIds: ['20', '21'] })
  await runCompanySync(ambiguous, { companyId: 'c1', mode: 'dry_run', trigger: 'manual' })
  assert.equal(ambiguous.captures.length, 1)
  assert.equal(ambiguous.captures[0].row.reason, 'multiple_associated_organizations')
  assert.equal(ambiguous.captures[0].row.source_snapshot.email, '10@example.com')
})

test('existing mapped long targets remain full IDs even when absent from the provider index', async () => {
  for (const mode of ['live', 'dry_run']) {
    const contactId = 'c'.repeat(520), organizationId = 'o'.repeat(520)
    const deps = reviewSampleFixture({}, { mode, sample_limit_per_type: mode === 'dry_run' ? 10 : null,
      review_capture_version: mode === 'dry_run' ? 1 : null })
    deps.mappings.contacts.push({ portal_id: '123', hubspot_id: '10', albi_contact_id: contactId })
    deps.mappings.organizations.push({ portal_id: '123', hubspot_id: '20', albi_organization_id: organizationId })
    deps.repository.saveMapping = async () => { throw Error('existing mapping overwritten') }
    const result = await runCompanySync(deps, { companyId: 'c1', mode, trigger: 'manual' })
    assert.equal(result.status, 'completed')
    assert.equal(deps.items.find(row => row.object_type === 'contacts').albi_target_id, contactId)
    assert.equal(deps.items.find(row => row.object_type === 'companies').albi_target_id, organizationId)
    assert.equal(deps.items.find(row => row.object_type === 'calls').albi_target_id, contactId)
  }
})

test('a different portal mapping with the same source ID does not change safe current-portal linking', async () => {
  const deps = liveFixture({ companyIds: [], albiContacts: [{ id: '200', firstName: 'First10', lastName: 'Last10', email: '10@example.com' }] })
  deps.mappings.contacts.push({ portal_id: '999', hubspot_id: '10', albi_contact_id: 'other-portal-target' })
  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })
  assert.equal(result.status, 'completed')
  assert.equal(deps.items.find(row => row.object_type === 'contacts').albi_target_id, '200')
})
