import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutboxHandler, projectOutboxItem } from '../../netlify/functions/h2a-review-outbox.js'

const UUID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const TIME = '2026-10-23T12:00:00.000Z'
const action = { kind: 'resolution', decision: { action: 'create_albi', referralSourceId: '5' } }

function fixture({ mode = 'super_admin', role = 'admin', isSuperAdmin = true } = {}) {
  const triage = [], dispatched = [], enqueued = []
  const repository = {
    getReview: async (_c, id) => ({ id, company_id: 'c1', review_kind: 'live', object_type: 'contacts', status: 'needs_review',
      triage_bucket: 'outbox', source_snapshot: { firstName: 'Costa', lastName: 'Costa' }, candidate_snapshots: [] }),
    enqueueOutboxItems: async (_c, items, { actorId }) => { enqueued.push({ items, actorId })
      return items.map((item, index) => ({ row: { id: UUID(50 + index), review_id: item.reviewId, status: 'queued' }, queued: true })) },
    setReviewTriage: async (_c, id, next) => { triage.push([id, next]) },
    listOutboxItems: async () => [
      { id: UUID(50), review_id: UUID(1), status: 'failed', attempts: 8, error_code: 'albi_busy', action, next_attempt_at: TIME, updated_at: TIME,
        review: { object_type: 'contacts', source_snapshot: { firstName: 'Costa', lastName: 'Costa' } } },
      { id: UUID(51), review_id: UUID(2), status: 'queued', attempts: 0, action: { kind: 'create_with_organization', referralSourceId: '5' },
        next_attempt_at: TIME, updated_at: TIME, review: { object_type: 'contacts', source_snapshot: { name: 'Acme' } } }],
    retryOutboxItems: async (_c, ids) => ids.map(id => ({ id, review_id: UUID(1) })),
    cancelOutboxItems: async (_c, ids) => ids.map(id => ({ id, review_id: UUID(1) })),
    getCurrentReviewResolution: async () => null,
  }
  const handler = createOutboxHandler({ repository, env: { H2A_REVIEW_RESOLUTION_MODE: mode },
    requireRequest: async () => ({ companyId: 'c1', userId: UUID(999), role, isSuperAdmin }),
    dispatch: async payload => { dispatched.push(payload) } })
  return { handler, triage, dispatched, enqueued }
}
const post = body => ({ httpMethod: 'POST', body: JSON.stringify({ companyId: 'c1', ...body }) })

test('queueing actions moves the records to the Outbox tab and starts the worker', async () => {
  const f = fixture()
  const response = await f.handler(post({ op: 'enqueue', items: [{ reviewId: UUID(1), expectedUpdatedAt: TIME, clientRequestId: UUID(21), action }] }))
  assert.equal(response.statusCode, 202)
  assert.deepEqual(JSON.parse(response.body).items, [{ id: UUID(50), reviewId: UUID(1), status: 'queued' }])
  assert.equal(f.enqueued[0].actorId, UUID(999))
  assert.equal(f.enqueued[0].items[0].reviewKind, 'live')
  assert.deepEqual(f.triage, [[UUID(1), { bucket: 'outbox', details: { outbox: 'queued' } }]])
  assert.deepEqual(f.dispatched, [{ companyId: 'c1' }])
})

test('queueing rejects malformed or unknown actions and respects the resolution mode', async () => {
  const f = fixture()
  for (const body of [{ op: 'enqueue', items: [] }, { op: 'enqueue', items: [{ reviewId: 'x', expectedUpdatedAt: TIME, clientRequestId: UUID(21), action }] },
    { op: 'enqueue', items: [{ reviewId: UUID(1), expectedUpdatedAt: TIME, clientRequestId: UUID(21), action: { kind: 'resolution', decision: { action: 'nope' } } }] },
    { op: 'other' }]) assert.equal((await f.handler(post(body))).statusCode, 400)
  const disabled = fixture({ mode: 'disabled' })
  assert.equal((await disabled.handler(post({ op: 'retry', ids: [UUID(50)] }))).statusCode, 409)
  assert.equal(disabled.dispatched.length, 0)
})

test('the outbox lists each action with its record name, status and failure reason', async () => {
  const f = fixture()
  const body = JSON.parse((await f.handler({ httpMethod: 'GET', queryStringParameters: { companyId: 'c1', kind: 'live' } })).body)
  assert.deepEqual(body.items.map(item => [item.name, item.action, item.status, item.errorCode]),
    [['Costa Costa', 'create_albi', 'failed', 'albi_busy'], ['Acme', 'create_with_organization', 'queued', null]])
  assert.deepEqual({ queued: body.summary.queued, failed: body.summary.failed }, { queued: 1, failed: 1 })
  assert.equal(projectOutboxItem({ id: 'x', status: 'sent', error_code: 'Bad!', review: null }).errorCode, null)
})

test('retry puts failed actions back in line; return sends records back to review', async () => {
  const f = fixture()
  assert.deepEqual(JSON.parse((await f.handler(post({ op: 'retry', ids: [UUID(50)] }))).body), { retried: 1 })
  assert.deepEqual(f.triage.at(-1), [UUID(1), { bucket: 'outbox', details: { outbox: 'queued' } }])
  assert.equal(f.dispatched.length, 1)
  assert.deepEqual(JSON.parse((await f.handler(post({ op: 'return', ids: [UUID(50)] }))).body), { returned: 1 })
  assert.notEqual(f.triage.at(-1)[1].bucket, 'outbox')
})
