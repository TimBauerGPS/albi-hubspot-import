import assert from 'node:assert/strict'
import test from 'node:test'
import { createCreateBatchHandler, projectCreateBatch } from '../../netlify/functions/h2a-review-create-batch.js'

const BATCH_ID = '00000000-0000-4000-8000-0000000000b1'
const REVIEW_ID = '00000000-0000-4000-8000-000000000001'
const stamp = '2026-10-20T10:00:00.000Z'
function fixture(extra = {}) {
  const calls = []
  const batch = { id: BATCH_ID, review_kind: 'sample', status: 'queued', total: 1, done: 0, created: 0, skipped: 0, failed: 0, items: [], referral_source_id: '5' }
  const repository = {
    createReviewCreateBatch: async (...args) => { calls.push(['create', ...args]); return extra.active ? { error: 'active', batch: { ...batch, status: 'running' } } : { batch } },
    getLatestReviewCreateBatch: async () => batch,
    finishReviewCreateBatch: async (...args) => { calls.push(['finish', ...args]); return true },
  }
  const options = { repository, env: { H2A_REVIEW_RESOLUTION_MODE: 'admins' },
    requireRequest: async () => ({ companyId: 'company-1', userId: '00000000-0000-4000-8000-000000000002', role: 'admin', isSuperAdmin: false }),
    makeClients: async () => ({ hubspot: {}, albi: { listReferralSources: async () => [{ id: '5', label: 'Network' }] } }),
    dispatch: async payload => { calls.push(['dispatch', payload]); if (extra.dispatchFails) throw new Error('no') },
    now: () => new Date(stamp), ...extra.options }
  return { calls, handler: createCreateBatchHandler(options), options }
}
const post = body => ({ httpMethod: 'POST', body: JSON.stringify(body) })
const items = [{ reviewId: REVIEW_ID, expectedUpdatedAt: stamp }]

test('starting a create batch checks the referral source, queues it and hands it to the background', async () => {
  const f = fixture()
  const response = await f.handler(post({ companyId: 'company-1', kind: 'sample', referralSourceId: '5', items }))
  assert.equal(response.statusCode, 202)
  assert.equal(JSON.parse(response.body).batch.id, BATCH_ID)
  const [, company, input] = f.calls.find(call => call[0] === 'create')
  assert.equal(company, 'company-1')
  assert.deepEqual([input.kind, input.referralSourceId, input.items], ['sample', '5', items])
  assert.deepEqual(f.calls.find(call => call[0] === 'dispatch')[1], { companyId: 'company-1', batchId: BATCH_ID })
})

test('a create batch refuses an unknown referral source, bad items, and reports one already running', async () => {
  for (const body of [{ companyId: 'company-1', referralSourceId: '6', items }, { companyId: 'company-1', referralSourceId: '5', items: [] },
    { companyId: 'company-1', referralSourceId: '5', items: [{ reviewId: 'x', expectedUpdatedAt: stamp }] }, { companyId: 'company-1', referralSourceId: '5', items, extra: 1 }]) {
    const f = fixture()
    const response = await f.handler(post(body))
    assert.equal(response.statusCode, 400, JSON.stringify(body))
    assert.equal(f.calls.filter(call => call[0] === 'create').length, 0)
  }
  const running = fixture({ active: true })
  const body = JSON.parse((await running.handler(post({ companyId: 'company-1', referralSourceId: '5', items }))).body)
  assert.equal(body.status, 'already_running')
  const broken = fixture({ dispatchFails: true })
  assert.equal((await broken.handler(post({ companyId: 'company-1', referralSourceId: '5', items }))).statusCode, 502)
  assert.equal(broken.calls.find(call => call[0] === 'finish')[3].errorCode, 'dispatch_failed')
})

test('progress shows the latest batch and the Albi referral sources to choose from', async () => {
  const f = fixture()
  const body = JSON.parse((await f.handler({ httpMethod: 'GET', queryStringParameters: { companyId: 'company-1', kind: 'sample' } })).body)
  assert.deepEqual(body.referralSources, [{ id: '5', label: 'Network' }])
  assert.deepEqual(body.batch, projectCreateBatch({ id: BATCH_ID, review_kind: 'sample', status: 'queued', total: 1, done: 0, created: 0, skipped: 0, failed: 0 }))
  assert.deepEqual(Object.keys(body.batch).sort(), ['created', 'createdAt', 'done', 'errorCode', 'failed', 'finishedAt', 'id', 'kind', 'results', 'skipped', 'startedAt', 'status', 'total'])
})

test('a create batch can use each record\u2019s default referral source, with or without a fallback', async () => {
  const f = fixture()
  assert.equal((await f.handler(post({ companyId: 'company-1', useRecordDefaults: true, items }))).statusCode, 202)
  let input = f.calls.find(call => call[0] === 'create')[2]
  assert.deepEqual([input.useRecordDefaults, input.referralSourceId], [true, null])
  const g = fixture()
  assert.equal((await g.handler(post({ companyId: 'company-1', useRecordDefaults: true, referralSourceId: '5', items }))).statusCode, 202)
  input = g.calls.find(call => call[0] === 'create')[2]
  assert.deepEqual([input.useRecordDefaults, input.referralSourceId], [true, '5'])
  for (const body of [{ companyId: 'company-1', useRecordDefaults: true, referralSourceId: '6', items }, { companyId: 'company-1', useRecordDefaults: 'yes', items }, { companyId: 'company-1', items }]) {
    assert.equal((await fixture().handler(post(body))).statusCode, 400)
  }
})
