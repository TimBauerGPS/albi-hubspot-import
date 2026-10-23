import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunHandler } from '../../netlify/functions/h2a-run.js'
import { H2AAuthError } from '../../netlify/functions/_h2a/auth.js'
import { runCompanySync } from '../../netlify/functions/_h2a/orchestrator.js'
import { createH2AProviderClients } from '../../netlify/functions/_h2a/providerClients.js'
import { encryptSecret } from '../../netlify/functions/_h2a/crypto.js'
import { createH2ARepository } from '../../netlify/functions/_h2a/repository.js'

test('shared provider factory decrypts only selected tenant credentials and supplies working scoped readers', async () => {
  const keyring = { activeVersion: 1, keys: { 1: Buffer.alloc(32, 7) } }
  const envelope = secret => { const { keyVersion, ...value } = encryptSecret(secret, keyring); return { ...value, key_version: keyVersion } }
  const calls = []
  const clients = await createH2AProviderClients({ companyId: 'tenant-1', keyring,
    repository: { getCredentials: async company => { assert.equal(company, 'tenant-1'); return { hubspot_envelope: envelope('hubspot-token'), albi_envelope: envelope('albi-key') } } },
    fetch: async (url, options) => { calls.push([url, options.headers]); return new Response(JSON.stringify(url.includes('hubapi') ? { portalId: '123' } : { data: [{ companyId: 'trusted-company', name: 'Allied' }] }), { status: 200 }) },
  })
  assert.equal((await clients.hubspot.getAccountInfo()).portalId, '123')
  assert.equal((await clients.albi.verifyCredentials()).company.id, 'trusted-company')
  assert.equal(calls[0][1].Authorization, 'Bearer hubspot-token')
  assert.equal(calls[1][1]['X-API-Key'], 'albi-key')
  await assert.rejects(createH2AProviderClients({ companyId: 'tenant-1', repository: { getCredentials: async () => null }, keyring }), /H2A credentials are missing/)
})

test('background runs retain injected provider clients without reading stored credentials', async () => {
  const hubspot = {}, albi = {}
  const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'tenant-1' }),
    repository: { getCredentials: async () => { throw Error('must not read credentials') } },
    makeClients: async company => { assert.equal(company, 'tenant-1'); return { hubspot, albi } },
    runSync: async deps => { assert.equal(deps.hubspot, hubspot); assert.equal(deps.albi, albi); return { status: 'completed' } },
  }, { background: true })
  assert.equal((await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'tenant-1', mode: 'live' }) })).statusCode, 200)
})

test('background runs without injection use the shared tenant credential factory', async () => {
  const keyring = { activeVersion: 1, keys: { 1: Buffer.alloc(32, 7) } }
  const envelope = secret => { const { keyVersion, ...value } = encryptSecret(secret, keyring); return { ...value, key_version: keyVersion } }
  const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'tenant-1' }), keyring,
    repository: { getCredentials: async company => { assert.equal(company, 'tenant-1'); return { hubspot_envelope: envelope('hubspot-token'), albi_envelope: envelope('albi-key') } } },
    fetch: async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer hubspot-token'); return new Response(JSON.stringify({ portalId: '123' }), { status: 200 }) },
    runSync: async deps => { assert.equal((await deps.hubspot.getAccountInfo()).portalId, '123'); return { status: 'completed' } },
  }, { background: true })
  assert.equal((await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'tenant-1', mode: 'live' }) })).statusCode, 200)
})

test('manual run authorizes selected company and queues without invoking providers', async () => {
  const calls = []
  const handler = createRunHandler({
    requireRequest: async (_event, options) => { assert.equal(options.requireAdmin, true); return { companyId: 'c1', userId: 'u1' } },
    repository: { getConfig: async companyId => { assert.equal(companyId, 'c1'); return { state: 'live', preflight_status: 'valid', portal_id: '123' } },
      getActiveLease: async () => null, queueRun: async () => ({ id: 'run1' }) },
    dispatch: async payload => { calls.push(payload) },
  })
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', mode: 'live' }) })
  assert.equal(result.statusCode, 202)
  assert.deepEqual(calls, [{ companyId: 'c1', mode: 'live', trigger: 'resume', runId: 'run1' }])
})

test('manual sample dry run persists the server-owned ten-per-type limit and dispatches by run identity', async () => {
  const queued = []
  const dispatched = []
  const handler = createRunHandler({
    requireRequest: async () => ({ companyId: 'c1', userId: 'u1' }),
    repository: {
      getConfig: async () => ({ state: 'dry_run', preflight_status: 'valid', portal_id: '123',
        initial_start_locked_at: '2026-10-01T00:00:00.000Z' }),
      getActiveLease: async () => null,
      queueRun: async (_companyId, input) => { queued.push(input); return { id: 'sample-run' } },
    },
    dispatch: async payload => { dispatched.push(payload) },
  })

  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({
    companyId: 'c1', mode: 'dry_run', dryRunScope: 'sample',
  }) })

  assert.equal(result.statusCode, 202)
  assert.deepEqual(queued, [{ mode: 'dry_run', trigger: 'manual', requestedBy: 'u1', sampleLimitPerType: 10, reviewCaptureVersion: 1 }])
  assert.deepEqual(dispatched, [{ companyId: 'c1', mode: 'dry_run', trigger: 'resume', runId: 'sample-run' }])
})

test('manual dry runs require an explicit sample or full scope', async () => {
  let queued = 0
  const handler = createRunHandler({
    requireRequest: async () => ({ companyId: 'c1', userId: 'u1' }),
    repository: {
      getConfig: async () => ({ state: 'dry_run', preflight_status: 'valid', portal_id: '123',
        initial_start_locked_at: '2026-10-01T00:00:00.000Z' }),
      getActiveLease: async () => null,
      queueRun: async () => { queued += 1; return { id: 'run1' } },
    },
  })

  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', mode: 'dry_run' }) })
  assert.equal(response.statusCode, 400)
  assert.equal(JSON.parse(response.body).error, 'Choose a sample or full dry run.')
  assert.equal(queued, 0)
})

test('full dry run requires a fresh clean tenant sample after the initial start date was locked', async () => {
  const queued = []
  const checks = []
  const makeHandler = completed => createRunHandler({
    requireRequest: async () => ({ companyId: 'c1', userId: 'u1' }),
    repository: {
      getConfig: async () => ({ state: 'dry_run', preflight_status: 'valid', portal_id: '123',
        initial_start_locked_at: '2026-10-01T00:00:00.000Z' }),
      hasCleanReviewSampleDryRun: async (companyId, after) => { checks.push([companyId, after]); return completed },
      hasCompletedSampleDryRun: async () => { throw Error('Legacy gate must not be used') },
      getActiveLease: async () => null,
      queueRun: async (_companyId, input) => { queued.push(input); return { id: 'full-run' } },
    },
    dispatch: async () => {},
  })
  const body = JSON.stringify({ companyId: 'c1', mode: 'dry_run', dryRunScope: 'full' })

  const rejected = await makeHandler(false)({ httpMethod: 'POST', body })
  assert.equal(rejected.statusCode, 409)
  assert.equal(JSON.parse(rejected.body).error, 'Run a fresh sample with no underlying review items before running the full dry run.')
  assert.equal(queued.length, 0)

  const accepted = await makeHandler(true)({ httpMethod: 'POST', body })
  assert.equal(accepted.statusCode, 202)
  assert.deepEqual(checks, [
    ['c1', '2026-10-01T00:00:00.000Z'],
    ['c1', '2026-10-01T00:00:00.000Z'],
  ])
  assert.deepEqual(queued, [{ mode: 'dry_run', trigger: 'manual', requestedBy: 'u1', sampleLimitPerType: null, reviewCaptureVersion: null }])
})

for (const [label, samples, statuses, expected] of [
  ['no completed sample', [], [], 409],
  ['historical sample', [{ review_capture_version: null }], [], 409],
  ['newer historical sample after an older clean version-one sample', [{}, { review_capture_version: null, created_at: '2026-10-03T00:00:00Z' }], [], 409],
  ['failed version-one sample without a completed sample', [{ status: 'failed' }], [], 409],
  ['open review rows', [{}], ['needs_review'], 409],
  ['all rows individually cleared or removed from scope', [{}], ['cleared', 'no_longer_in_scope'], 409],
  ['completed version-one sample with zero captured rows', [{}], [], 202],
  ['prior clean completed set retained after a failed attempt', [{}, { status: 'failed', created_at: '2026-10-03T00:00:00Z' }], [], 202],
]) {
  test(`full dry-run HTTP gate handles ${label}`, async () => {
    const runs = samples.map((sample, index) => ({ id: `sample-${index}`, company_id: 'c1', mode: 'dry_run',
      sample_limit_per_type: 10, review_capture_version: 1, status: 'completed', created_at: '2026-10-02T00:00:00Z', ...sample }))
    const rows = statuses.map(status => ({ company_id: 'c1', run_id: 'sample-0', status }))
    const supabase = { rpc() {}, from(table) {
      let filters = [], orders = [], head = false
      const query = {
        select(_fields, options) { head = options?.head === true; return query },
        eq(key, value) { filters.push(row => row[key] === value); return query },
        gt(key, value) { filters.push(row => row[key] > value); return query },
        order(key) { orders.push(key); return query }, limit() { return query },
        maybeSingle: async () => ({ data: selected()[0] ?? null, error: null }),
        then(resolve, reject) { return Promise.resolve(head ? { count: selected().length, error: null } : { data: selected(), error: null }).then(resolve, reject) },
      }
      function selected() { return (table === 'h2a_sync_runs' ? runs : rows).filter(row => filters.every(filter => filter(row)))
        .sort((left, right) => { for (const key of orders) { const diff = String(right[key]).localeCompare(String(left[key])); if (diff) return diff } return 0 }) }
      return query
    } }
    const repository = createH2ARepository(supabase)
    let queued = 0
    repository.getConfig = async () => ({ state: 'dry_run', preflight_status: 'valid', portal_id: '123', initial_start_locked_at: '2026-10-01T00:00:00Z' })
    repository.getActiveLease = async () => null
    repository.queueRun = async () => { queued++; return { id: 'full' } }
    const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'c1', userId: 'u1' }), repository, dispatch: async () => {} })
    const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ mode: 'dry_run', dryRunScope: 'full' }) })
    assert.equal(response.statusCode, expected)
    assert.equal(queued, expected === 202 ? 1 : 0)
    if (expected === 409) assert.equal(JSON.parse(response.body).error, 'Run a fresh sample with no underlying review items before running the full dry run.')
  })
}

test('dry-run scope is restricted to manual dry runs and fixed supported values', async () => {
  let queued = 0
  const handler = createRunHandler({
    requireRequest: async () => ({ companyId: 'c1', userId: 'u1' }),
    repository: {
      getConfig: async () => ({ state: 'live', preflight_status: 'valid', portal_id: '123' }),
      getActiveLease: async () => null,
      queueRun: async () => { queued += 1; return { id: 'run1' } },
    },
  })

  for (const body of [
    { companyId: 'c1', mode: 'live', dryRunScope: 'sample' },
    { companyId: 'c1', mode: 'dry_run', dryRunScope: 'tiny' },
  ]) {
    assert.equal((await handler({ httpMethod: 'POST', body: JSON.stringify(body) })).statusCode, 400)
  }
  assert.equal(queued, 0)
})

test('internal resume requires explicit company and secret through shared auth', async () => {
  const handler = createRunHandler({
    requireRequest: async (_event, options) => { assert.equal(options.internalJob, true); return { companyId: 'c1' } },
    repository: {}, runSync: async (_deps, input) => ({ status: 'completed', companyId: input.companyId, runId: input.runId }),
    makeClients: async () => ({ hubspot: {}, albi: {} }),
  }, { background: true })
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', mode: 'live', runId: 'run1' }) })
  assert.equal(result.statusCode, 200)
  assert.equal(JSON.parse(result.body).runId, 'run1')
})

test('background request without cron secret cannot reach the orchestrator', async () => {
  let invoked = false
  const handler = createRunHandler({
    supabase: { from: () => { throw Error('unauthorized lookup') } }, internalCronSecret: 'server-secret',
    repository: {}, runSync: async () => { invoked = true },
  }, { background: true })
  const result = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ companyId: 'c1', mode: 'live', runId: 'run1' }) })
  assert.equal(result.statusCode, 401)
  assert.equal(invoked, false)
})

test('manual company selection is passed to authorization and cannot be replaced afterward', async () => {
  let selected, queued = false
  const handler = createRunHandler({
    requireRequest: async (_event, options) => { selected = options.requestedCompanyId; throw new H2AAuthError(403, 'Forbidden') },
    repository: { queueRun: async () => { queued = true } },
  })
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'other-company', mode: 'live' }) })
  assert.equal(selected, 'other-company')
  assert.equal(queued, false)
  assert.equal(result.statusCode, 403)
})

test('failed background enqueue marks the durable queued run failed', async () => {
  let marked
  const handler = createRunHandler({
    requireRequest: async () => ({ companyId: 'c1', userId: 'u1' }),
    repository: { getConfig: async () => ({ state: 'live', preflight_status: 'valid', portal_id: '123' }),
      getActiveLease: async () => null, queueRun: async () => ({ id: 'run1' }),
      markQueueFailed: async (companyId, runId) => { marked = [companyId, runId] } },
    dispatch: async () => { throw Error('transport unavailable') },
  })
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', mode: 'live' }) })
  assert.equal(result.statusCode, 502)
  assert.deepEqual(marked, ['c1', 'run1'])
})

test('background setup failure does not leave an accepted run queued forever', async () => {
  let marked
  const handler = createRunHandler({
    requireRequest: async () => ({ companyId: 'c1' }), repository: {
      markQueueFailed: async (companyId, runId) => { marked = [companyId, runId] },
    },
    makeClients: async () => { throw Error('credential envelope unavailable') },
  }, { background: true })
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', mode: 'live', runId: 'run1' }) })
  assert.equal(result.statusCode, 502)
  assert.deepEqual(marked, ['c1', 'run1'])
})

test('background lease collision retires a queued duplicate run', async () => {
  let retired
  const handler = createRunHandler({
    requireRequest: async () => ({ companyId: 'c1' }), repository: {
      markRunCollision: async (companyId, runId) => { retired = [companyId, runId] },
    }, makeClients: async () => ({ hubspot: {}, albi: {} }),
    runSync: async () => ({ status: 'already_running', companyId: 'c1' }),
  }, { background: true })
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', mode: 'live', runId: 'run1' }) })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(retired, ['c1', 'run1'])
})

test('internal targeted resume validates persisted identity and invokes only the resume consumer', async () => {
  const resumeId = '00000000-0000-4000-8000-000000000001'
  const accepted = []
  const intent = { id: resumeId, company_id: 'c1', status: 'pending', resolution_action: 'create_new',
    source_object_type: 'contacts', source_id: '10', activity_object_type: 'calls', activity_id: '50',
    originating_run_id: null, activity_delivery_id: null }
  const handler = createRunHandler({
    requireRequest: async (_event, args) => { assert.equal(args.internalJob, true); return { companyId: 'c1', supabase: {} } },
    repository: { getConflictResume: async (companyId, id) => { assert.equal(companyId, 'c1'); assert.equal(id, resumeId); return intent } },
    makeClients: async () => ({ hubspot: {}, albi: {} }), runSync: async (_deps, input) => { accepted.push(input); return { status: 'completed' } },
  }, { background: true })
  const response = await handler({ httpMethod: 'POST', headers: { 'X-Internal-Cron-Secret': 'secret' }, body: JSON.stringify({
    companyId: 'c1', mode: 'live', trigger: 'conflict_resolution', resumeId, sourceObjectType: 'contacts', sourceId: '10',
    activityObjectType: 'calls', activityId: '50',
  }) })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(accepted, [{ companyId: 'c1', mode: 'live', trigger: 'conflict_resolution', resumeId }])
})

test('a targeted resume that finds a sync already running goes back in the queue instead of being dropped', async () => {
  const resumeId = '00000000-0000-4000-8000-000000000001'
  const requeued = []
  const intent = { id: resumeId, company_id: 'c1', status: 'dispatched', resolution_action: 'create_new',
    source_object_type: 'contacts', source_id: '10', activity_object_type: 'calls', activity_id: '50',
    originating_run_id: null, activity_delivery_id: null }
  const handler = createRunHandler({
    requireRequest: async () => ({ companyId: 'c1', supabase: {} }),
    repository: { getConflictResume: async () => intent, requeueConflictResume: async (companyId, id) => { requeued.push([companyId, id]); return true } },
    makeClients: async () => ({ hubspot: {}, albi: {} }), runSync: async () => ({ status: 'already_running', companyId: 'c1' }),
  }, { background: true })
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({
    companyId: 'c1', mode: 'live', trigger: 'conflict_resolution', resumeId, sourceObjectType: 'contacts', sourceId: '10',
    activityObjectType: 'calls', activityId: '50' }) })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).status, 'requeued')
  assert.deepEqual(requeued, [['c1', resumeId]])
})

test('targeted resume rejects tampered or extra payload fields before processing', async () => {
  let invoked = false
  const resumeId = '00000000-0000-4000-8000-000000000001'
  const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'c1' }), repository: {
    getConflictResume: async () => ({ id: resumeId, company_id: 'c1', status: 'pending', resolution_action: 'link_existing',
      source_object_type: 'contacts', source_id: '10', activity_object_type: null, activity_id: null }),
  }, runSync: async () => { invoked = true } }, { background: true })
  const payload = { companyId: 'c1', mode: 'live', trigger: 'conflict_resolution', resumeId,
    sourceObjectType: 'contacts', sourceId: 'other' }
  const mismatch = await handler({ httpMethod: 'POST', body: JSON.stringify(payload) })
  assert.equal(mismatch.statusCode, 409)
  const extra = await handler({ httpMethod: 'POST', body: JSON.stringify({ ...payload, fullCompanyScan: true }) })
  assert.equal(extra.statusCode, 400)
  assert.equal(invoked, false)
})

test('duplicate targeted resume with a completed persisted run is acknowledged without reprocessing', async () => {
  const resumeId = '00000000-0000-4000-8000-000000000001'
  let invoked = false
  const intent = { id: resumeId, company_id: 'c1', status: 'dispatched', resolution_action: 'link_existing',
    source_object_type: 'contacts', source_id: '10', activity_object_type: null, activity_id: null,
    originating_run_id: null, activity_delivery_id: null }
  const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'c1' }), repository: {
    getConflictResume: async () => intent, getResumeRun: async () => ({ id: 'run1', status: 'completed' }),
  }, runSync: async () => { invoked = true } }, { background: true })
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', mode: 'live', trigger: 'conflict_resolution',
    resumeId, sourceObjectType: 'contacts', sourceId: '10' }) })
  assert.equal(JSON.parse(response.body).status, 'already_accepted')
  assert.equal(invoked, false)
})

test('scheduled background dispatch checks the stable run, tenant and Pacific business date', async () => {
  const claimId = '00000000-0000-4000-8000-000000000001'
  let invoked = 0
  const repository = { getRun: async (companyId, id) => ({ id, company_id: companyId, trigger: 'scheduled', business_date: '2026-10-05', status: 'queued' }) }
  const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'c1' }), repository,
    makeClients: async () => ({ hubspot: {}, albi: {} }), runSync: async () => { invoked += 1; return { status: 'completed' } } }, { background: true })
  const body = { companyId: 'c1', mode: 'live', trigger: 'scheduled', runId: claimId, schedulerClaimId: claimId, businessDate: '2026-10-05' }
  assert.equal((await handler({ httpMethod: 'POST', body: JSON.stringify(body) })).statusCode, 200)
  assert.equal((await handler({ httpMethod: 'POST', body: JSON.stringify({ ...body, businessDate: '2026-02-30' }) })).statusCode, 400)
  assert.equal(invoked, 1)
})

test('scheduled lease collision is retryable and leaves the stable queued run reclaimable', async () => {
  const claimId = '00000000-0000-4000-8000-000000000001'
  let retired = false
  const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'c1' }), repository: {
    getRun: async (companyId, id) => ({ id, company_id: companyId, trigger: 'scheduled', business_date: '2026-10-05', status: 'queued' }),
    markRunCollision: async () => { retired = true },
  }, makeClients: async () => ({ hubspot: {}, albi: {} }),
  runSync: async () => ({ status: 'already_running', companyId: 'c1' }) }, { background: true })
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', mode: 'live', trigger: 'scheduled',
    runId: claimId, schedulerClaimId: claimId, businessDate: '2026-10-05' }) })
  assert.equal(response.statusCode, 409)
  assert.equal(JSON.parse(response.body).status, 'retryable')
  assert.equal(retired, false)
})

test('thrown persisted failure attempts one tenant-scoped notification without masking the sanitized 502', async () => {
  const runId = '00000000-0000-4000-8000-000000000002'
  const notifications = []
  const error = Object.assign(new Error('sensitive provider response'), { h2aPersistedFailure: {
    runId, totals: { failed: 1 }, newConflictCount: 0,
  } })
  const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'tenant-1', companyName: 'Tenant One', supabase: {} }),
    repository: {}, makeClients: async () => ({ hubspot: {}, albi: {} }), runSync: async () => { throw error },
    notifyRunExceptions: async (options, input) => { notifications.push({ options, input }); throw Error('email secret') },
  }, { background: true })
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'tenant-1', mode: 'live', trigger: 'scheduled',
    runId, schedulerClaimId: runId, businessDate: '2026-10-05' }) })
  assert.equal(response.statusCode, 502)
  assert.deepEqual(JSON.parse(response.body), { error: 'Unable to start H2A sync.' })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].input.companyId, 'tenant-1')
  assert.deepEqual(notifications[0].input.run, { id: runId, status: 'failed', totals: { failed: 1 } })
  assert.equal(JSON.stringify(response).includes('sensitive provider response'), false)
})

test('persisted failure notification survives both resume-requeue and lease-release cleanup failures', async () => {
  const resumeId = '00000000-0000-4000-8000-000000000003'
  const notifications = []
  const logs = []
  const intent = { id: resumeId, company_id: 'tenant-1', status: 'pending', resolution_action: 'link_existing',
    source_object_type: 'contacts', source_id: '10', activity_object_type: null, activity_id: null,
    originating_run_id: null, activity_delivery_id: null }
  const repository = {
    getConflictResume: async () => intent,
    claimLease: async () => true, releaseLease: async () => { throw Error('secret release detail') },
    getConfig: async () => ({ state: 'live', portal_id: '123', selected_start_date: '2026-10-01', preflight_status: 'valid' }),
    startRun: async () => ({ id: 'run-failed', status: 'queued' }),
    getMappings: async () => { throw Error('sensitive source failure') },
    totals: async () => ({ failed: 1 }), finishRun: async () => {},
    requeueConflictResume: async () => { throw Error('secret requeue detail') },
  }
  const handler = createRunHandler({ requireRequest: async () => ({ companyId: 'tenant-1', supabase: {} }), repository,
    makeClients: async () => ({ hubspot: {}, albi: {} }), runSync: runCompanySync,
    logger: { warn: (message, values) => logs.push({ message, values }) },
    notifyRunExceptions: async (_options, input) => { notifications.push(input); throw Error('secret mail detail') },
  }, { background: true })
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'tenant-1', mode: 'live', trigger: 'conflict_resolution',
    resumeId, sourceObjectType: 'contacts', sourceId: '10' }) })
  assert.equal(response.statusCode, 502)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].companyId, 'tenant-1')
  assert.deepEqual(notifications[0].run, { id: 'run-failed', status: 'failed', totals: { failed: 1 } })
  assert.deepEqual(logs.map(log => log.values), [
    { phase: 'resume_requeue', reason: 'error:operation_failed' },
    { phase: 'lease_release', reason: 'error:operation_failed' },
  ])
  assert.equal(JSON.stringify(response).includes('sensitive source failure'), false)
  assert.equal(JSON.stringify(response).includes('secret'), false)
})
