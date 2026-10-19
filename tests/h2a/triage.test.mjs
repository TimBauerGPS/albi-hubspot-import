import test from 'node:test'
import assert from 'node:assert/strict'
import { computeTriage } from '../../netlify/functions/_h2a/triage.js'

const row = (extra = {}) => ({ status: 'needs_review', reason: 'name_only_candidate', ...extra })
const one = { candidates: [{ id: 'a' }], suggestedCandidateId: 'a' }
const none = { candidates: [], suggestedCandidateId: null }
const many = { candidates: [{ id: 'a' }, { id: 'b' }], suggestedCandidateId: null }

test('done when the row is no longer needs_review', () => {
  assert.deepEqual(computeTriage({ row: row({ status: 'cleared' }), ranking: one }), { bucket: 'done', details: {} })
})
test('done when the resolution is completed', () => {
  assert.equal(computeTriage({ row: row(), ranking: one, resolutionStatus: 'completed' }).bucket, 'done')
})
test('todo when waiting on Albi', () => {
  assert.equal(computeTriage({ row: row(), ranking: one, resolutionStatus: 'waiting_on_albi' }).bucket, 'todo')
})
test('merged record is blocked even with a strong candidate', () => {
  const result = computeTriage({ row: row(), ranking: one, mergedInto: { sourceId: '99' } })
  assert.equal(result.bucket, 'blocked')
})
test('blocked with copy-backed reason and no candidates', () => {
  const result = computeTriage({ row: row(), ranking: none, createReadiness: { ready: false, blockedReason: 'referrer_type_missing' } })
  assert.deepEqual(result, { bucket: 'blocked', details: { blockedReason: 'referrer_type_missing' } })
})
test('blocked reason with candidates is a decision', () => {
  assert.equal(computeTriage({ row: row(), ranking: many, createReadiness: { ready: false, blockedReason: 'referrer_type_missing' } }).bucket, 'decision')
})
test('unknown blocked reason does not block', () => {
  assert.equal(computeTriage({ row: row(), ranking: none, createReadiness: { ready: false, blockedReason: 'mystery' } }).bucket, 'decision')
})
test('quick link with a single suggested candidate', () => {
  assert.deepEqual(computeTriage({ row: row(), ranking: one }), { bucket: 'quick', details: { quickKind: 'link' } })
})
test('field and association reasons never quick-link', () => {
  for (const reason of ['nonblank_field_difference', 'organization_unresolved']) {
    assert.notEqual(computeTriage({ row: row({ reason }), ranking: one }).bucket, 'quick', reason)
  }
})
test('two candidates is a decision even with a suggestion', () => {
  assert.equal(computeTriage({ row: row(), ranking: { ...many, suggestedCandidateId: 'a' } }).bucket, 'decision')
})
test('quick create when no candidates and ready', () => {
  assert.deepEqual(computeTriage({ row: row(), ranking: none, createReadiness: { ready: true } }), { bucket: 'quick', details: { quickKind: 'create' } })
})
test('unknown readiness never yields quick create', () => {
  assert.equal(computeTriage({ row: row(), ranking: none }).bucket, 'decision')
  assert.equal(computeTriage({ row: row(), ranking: none, createReadiness: { ready: false } }).bucket, 'decision')
})

import { refreshReviewTriage } from '../../netlify/functions/_h2a/triage.js'

const storedRow = (extra = {}) => ({ id: 'r1', status: 'needs_review', reason: 'name_only_candidate', object_type: 'contacts',
  portal_id: '1', source_id: '42', source_snapshot: { email: 'a@example.com' }, candidate_snapshots: [],
  triage_bucket: 'decision', triage_details: {}, ...extra })

test('refreshReviewTriage writes only when the bucket changed', async () => {
  const writes = []
  const repository = { setReviewTriage: async (...args) => { writes.push(args) } }
  await refreshReviewTriage(repository, { companyId: 'c', row: storedRow(), createReadiness: { ready: true } })
  assert.deepEqual(writes, [['c', 'r1', { bucket: 'quick', details: { quickKind: 'create' } }]])
  await refreshReviewTriage(repository, { companyId: 'c', row: storedRow({ triage_bucket: 'quick', triage_details: { quickKind: 'create' } }),
    createReadiness: { ready: true } })
  assert.equal(writes.length, 1)
})

test('refreshReviewTriage keeps known readiness when not re-read and never throws', async () => {
  const writes = []
  const repository = { setReviewTriage: async (...args) => { writes.push(args) } }
  await refreshReviewTriage(repository, { companyId: 'c', row: storedRow({ triage_bucket: 'quick', triage_details: { quickKind: 'create' } }) })
  assert.equal(writes.length, 0)
  await refreshReviewTriage(repository, { companyId: 'c', row: storedRow(), resolutionStatus: 'waiting_on_albi' })
  assert.equal(writes[0][2].bucket, 'todo')
  assert.equal(await refreshReviewTriage({ setReviewTriage: async () => { throw new Error('db') } }, { companyId: 'c', row: storedRow(), resolutionStatus: 'completed' }), null)
  assert.equal(await refreshReviewTriage(undefined, { companyId: 'c', row: storedRow() }), null)
})
