import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunHandler } from '../../netlify/functions/h2a-run.js'
import { H2AAuthError } from '../../netlify/functions/_h2a/auth.js'

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
