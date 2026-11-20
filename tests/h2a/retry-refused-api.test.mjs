import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetryRefusedHandler } from '../../netlify/functions/h2a-retry-refused.js'
import { H2AAuthError } from '../../netlify/functions/_h2a/auth.js'

const handlerWith = ({ requireRequest, repository } = {}) => createRetryRefusedHandler({
  requireRequest: requireRequest ?? (async (_event, options) => { assert.equal(options.requireAdmin, true); return { companyId: 'c1', supabase: {} } }),
  repository: repository ?? { retryRefusedActivities: async companyId => { assert.equal(companyId, 'c1'); return { queued: 27 } } },
})

test('an admin queues every refused activity for another send', async () => {
  const result = await handlerWith()({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1' }) })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(JSON.parse(result.body), { queued: 27 })
})

test('only POST with at most a company selector is accepted, and auth failures keep their status', async () => {
  assert.equal((await handlerWith()({ httpMethod: 'GET' })).statusCode, 405)
  assert.equal((await handlerWith()({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', extra: 1 }) })).statusCode, 400)
  assert.equal((await handlerWith()({ httpMethod: 'POST', body: '{bad' })).statusCode, 400)
  const denied = handlerWith({ requireRequest: async () => { throw new H2AAuthError(403, 'Admins only.') } })
  assert.equal((await denied({ httpMethod: 'POST', body: '{}' })).statusCode, 403)
  const broken = handlerWith({ repository: { retryRefusedActivities: async () => { throw Error('db secret detail') } } })
  const failed = await broken({ httpMethod: 'POST', body: '{}' })
  assert.equal(failed.statusCode, 500)
  assert.equal(failed.body.includes('secret'), false)
})
