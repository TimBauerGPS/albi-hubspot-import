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
  assert.deepEqual(result.details, { merged: true, mergedIntoSourceId: '99' })
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

const cleared = outcome => row({ status: 'cleared', recheck_outcome: outcome })
test('cleared safe_to_link without completed resolution is quick link', () => {
  assert.deepEqual(computeTriage({ row: cleared('safe_to_link'), ranking: none }), { bucket: 'quick', details: { quickKind: 'link' } })
})
test('cleared safe_to_create without completed resolution is quick create', () => {
  assert.deepEqual(computeTriage({ row: cleared('safe_to_create'), ranking: none }), { bucket: 'quick', details: { quickKind: 'create' } })
})
test('cleared safe_to_create with completed resolution is done', () => {
  assert.equal(computeTriage({ row: cleared('safe_to_create'), ranking: none, resolutionStatus: 'completed' }).bucket, 'done')
  assert.equal(computeTriage({ row: row({ status: 'no_longer_in_scope', recheck_outcome: 'source_missing' }), ranking: none }).bucket, 'done')
})
test('merge block carries over when mergedInto is unknown and clears when null', async () => {
  const writes = []
  const repository = { setReviewTriage: async (...args) => { writes.push(args) } }
  const blocked = storedRow({ triage_bucket: 'blocked', triage_details: { merged: true } })
  await refreshReviewTriage(repository, { companyId: 'c', row: blocked })
  assert.equal(writes.length, 0)
  await refreshReviewTriage(repository, { companyId: 'c', row: blocked, mergedInto: null })
  assert.equal(writes[0][2].bucket, 'decision')
})
test('waiting on Albi wins over a cleared safe recheck', () => {
  assert.deepEqual(computeTriage({ row: cleared('safe_to_link'), ranking: none, resolutionStatus: 'waiting_on_albi' }), { bucket: 'todo', details: {} })
  assert.equal(computeTriage({ row: cleared('safe_to_create'), ranking: none, resolutionStatus: 'waiting_on_albi' }).bucket, 'todo')
})

// A live row whose resolution completed but whose close did not land is still open: it must stay
// visible (Decision) so the next detail load, recheck or live batch settles its close.
test('an open live row with a completed resolution is decision with a pending close, not hidden in done', () => {
  assert.deepEqual(computeTriage({ row: row({ review_kind: 'live' }), ranking: one, resolutionStatus: 'completed' }),
    { bucket: 'decision', details: { closePending: true } })
  assert.equal(computeTriage({ row: row({ review_kind: 'live', status: 'cleared' }), ranking: one, resolutionStatus: 'completed' }).bucket, 'done')
  assert.equal(computeTriage({ row: row({ review_kind: 'sample' }), ranking: one, resolutionStatus: 'completed' }).bucket, 'done')
})

test('the pending-close marker survives storage and projection', async () => {
  const { projectReviewRow } = await import('../../netlify/functions/_h2a/review.js')
  const { createH2ARepository } = await import('../../netlify/functions/_h2a/repository.js')
  const written = []
  const query = { update(value) { written.push(value); return query }, eq() { return query },
    then: (resolve) => Promise.resolve({ data: null, error: null }).then(resolve) }
  await createH2ARepository({ from: () => query, rpc: async () => ({ data: null }) }).setReviewTriage('00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001',
    { bucket: 'decision', details: { closePending: true, other: 'x' } })
  assert.deepEqual(written[0], { triage_bucket: 'decision', triage_details: { closePending: true } })
  const projected = projectReviewRow({ id: '00000000-0000-4000-8000-000000000001', object_type: 'contacts', review_kind: 'live',
    status: 'needs_review', reason: 'name_only_candidate', triage_bucket: 'decision', triage_details: { closePending: true } })
  assert.deepEqual(projected.triageDetails, { closePending: true })
})

test('a stored survivor id is carried with the merge block and an unknown survivor is not invented', async () => {
  const { refreshReviewTriage } = await import('../../netlify/functions/_h2a/triage.js')
  const writes = []
  const repository = { setReviewTriage: async (_c, _id, next) => { writes.push(next) }, getCurrentReviewResolution: async () => null }
  const stored = { id: 'r', object_type: 'contacts', status: 'needs_review', reason: 'name_only_candidate', source_snapshot: {}, candidate_snapshots: [],
    triage_bucket: 'decision', triage_details: {} }
  await refreshReviewTriage(repository, { companyId: 'c', row: { ...stored, triage_details: { merged: true, mergedIntoSourceId: '77' } }, mergedInto: undefined })
  await refreshReviewTriage(repository, { companyId: 'c', row: { ...stored, triage_bucket: 'blocked', triage_details: { merged: true } } })
  assert.deepEqual(writes[0], { bucket: 'blocked', details: { merged: true, mergedIntoSourceId: '77' } })
  assert.equal(writes.length, 1, 'a legacy merge block without a survivor id is unchanged')
  assert.deepEqual(computeTriage({ row: row(), ranking: one, mergedInto: { sourceId: 'not-an-id' } }).details, { merged: true })
})
