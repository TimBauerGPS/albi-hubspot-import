import test from 'node:test'
import assert from 'node:assert/strict'
import { runCompanySync } from '../../netlify/functions/_h2a/orchestrator.js'

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

function liveFixture({ contactIds = ['10'], companyIds = ['20'], activities = [{ id: '50', occurredAt: '2026-10-02T12:00:00Z', objectType: 'calls', properties: { hs_timestamp: '2026-10-02T12:00:00Z' } }], albiContacts = [], albiOrganizations = [] } = {}) {
  const events = [], items = [], cursors = []
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
    saveCursor: async (_company, type, cursor) => { cursors.push({ type, cursor }) },
    getItemOutcomes: async (_company, _run, type, id) => items.filter(row => row.object_type === type && row.source_id === id),
    recordItem: async (_company, row) => { items.push(row); events.push(`item:${row.outcome}`) },
    saveMapping: async (_company, kind, row) => { events.push(`mapping:${kind}`); return row },
    recordConflict: async (_company, row) => { events.push(`conflict:${row.reason}`); return row },
    totals: async () => Object.fromEntries([...new Set(items.map(item => item.outcome))].map(outcome => [outcome, items.filter(item => item.outcome === outcome).length])),
    finishRun: async () => { events.push('finish') },
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
  return { repository, hubspot, albi, events, items, cursors, mappings }
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
