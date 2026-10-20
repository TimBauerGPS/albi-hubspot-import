import assert from 'node:assert/strict'
import test from 'node:test'
import { runReviewCreateBatch } from '../../netlify/functions/_h2a/createBatch.js'
import { H2AReviewError } from '../../netlify/functions/_h2a/reviewService.js'

const stamp = '2026-10-20T10:00:00.000Z'
const row = (id, objectType = 'contacts', extra = {}) => ({ id, object_type: objectType, status: 'needs_review', reason: 'no_match',
  candidate_snapshots: [], updated_at: stamp, ...extra })

function fixture({ rows, items, outcomes = {}, ...extra } = {}) {
  const calls = [], counts = [], finished = []
  const batch = { id: 'batch-1', company_id: 'c', review_kind: 'sample', requested_by: 'actor', referral_source_id: '5',
    items: items ?? rows.map(item => ({ reviewId: item.id, expectedUpdatedAt: item.updated_at })) }
  const byId = new Map(rows.map(item => [item.id, item]))
  const deps = {
    repository: { getConfig: async () => ({ portal_id: '123' }), getReview: async (_c, id) => byId.get(id) ?? null },
    batchRepository: {
      claimReviewCreateBatch: async () => batch,
      updateReviewCreateBatch: async (_c, _id, { counts: value }) => { counts.push(value); return true },
      finishReviewCreateBatch: async (_c, _id, value) => { finished.push(value); return true },
    },
    getResolutionClients: async () => ({ albiRead: {
      listContacts: async () => { calls.push('albi-contacts'); return { records: [{ id: '900', firstName: 'Old', lastName: 'Person' }], cursor: null } },
      listOrganizations: async () => { calls.push('albi-organizations'); return { records: [], cursor: null } } } }),
    checkReadiness: async item => extra.readiness?.[item.id] ?? { ready: true },
    executeResolution: async (rowDeps, input) => {
      calls.push(['create', input.reviewId, input.decision, rowDeps.albiSnapshot.contacts.length])
      const outcome = outcomes[input.reviewId] ?? 'ready_to_recheck'
      if (outcome === 'changed') throw new H2AReviewError(409, 'This sample review changed. Refresh and confirm the resolution again.')
      if (outcome === 'boom') throw new Error('boom')
      if (outcome === 'ready_to_recheck') rowDeps.albiSnapshot.contacts.push({ id: `new-${input.reviewId}` })
      return { resolution: { status: outcome } }
    },
  }
  return { deps, calls, counts, finished, batch }
}

test('a create batch reads Albi once, creates organizations before contacts, and counts each outcome', async () => {
  const rows = [row('c1'), row('o1', 'companies'), row('c2'), row('c3'), row('c4')]
  const f = fixture({ rows, outcomes: { c2: 'failed', c3: 'changed', c4: 'boom' } })
  const result = await runReviewCreateBatch(f.deps, { companyId: 'c', batchId: 'batch-1' })
  assert.equal(result.status, 'completed')
  assert.equal(f.calls.filter(call => call === 'albi-contacts').length, 1)
  assert.equal(f.calls.filter(call => call === 'albi-organizations').length, 1)
  const creates = f.calls.filter(Array.isArray)
  assert.deepEqual(creates.map(call => call[1]), ['o1', 'c1', 'c2', 'c3', 'c4'])
  assert.deepEqual(creates[0][2], { action: 'create_albi', referralSourceId: '5' })
  // The shared read grows with each created record, so later records are checked against it.
  assert.deepEqual(creates.map(call => call[3]), [1, 2, 3, 3, 3])
  assert.deepEqual(f.finished.at(-1).counts, { total: 5, done: 5, created: 2, skipped: 1, failed: 2 })
  assert.equal(f.finished.at(-1).status, 'completed')
})

test('only records still ready to create are attempted; changed or ineligible ones are skipped', async () => {
  const rows = [row('ok'), row('changed', 'contacts', { updated_at: '2026-10-20T11:00:00.000Z' }),
    row('candidates', 'contacts', { candidate_snapshots: [{ id: '9' }] }), row('done', 'contacts', { status: 'cleared', recheck_outcome: 'safe_to_link' })]
  const items = rows.map(item => ({ reviewId: item.id, expectedUpdatedAt: stamp })).concat([{ reviewId: 'missing', expectedUpdatedAt: stamp }])
  const f = fixture({ rows, items })
  await runReviewCreateBatch(f.deps, { companyId: 'c', batchId: 'batch-1' })
  assert.deepEqual(f.calls.filter(Array.isArray).map(call => call[1]), ['ok'])
  assert.deepEqual(f.finished.at(-1).counts, { total: 5, done: 5, created: 1, skipped: 4, failed: 0 })
})

test('a batch that cannot read Albi fails without creating anything', async () => {
  const f = fixture({ rows: [row('c1')] })
  f.deps.getResolutionClients = async () => ({ albiRead: { listContacts: async () => { throw new Error('down') }, listOrganizations: async () => ({ records: [], cursor: null }) } })
  const result = await runReviewCreateBatch(f.deps, { companyId: 'c', batchId: 'batch-1' })
  assert.equal(result.status, 'failed')
  assert.equal(f.calls.filter(Array.isArray).length, 0)
})

test('each record is checked first; blocked ones are skipped with their reason and every outcome is recorded', async () => {
  const rows = [row('ok'), row('noorg'), row('changed', 'contacts', { updated_at: '2026-10-20T11:00:00.000Z' })]
  const items = rows.map(item => ({ reviewId: item.id, expectedUpdatedAt: stamp }))
  const f = fixture({ rows, items, readiness: { noorg: { ready: false, blockedReason: 'organization_not_synced' } } })
  await runReviewCreateBatch(f.deps, { companyId: 'c', batchId: 'batch-1' })
  assert.deepEqual(f.calls.filter(Array.isArray).map(call => call[1]), ['ok'])
  assert.deepEqual(f.finished.at(-1).results, [
    { reviewId: 'ok', outcome: 'created' },
    { reviewId: 'noorg', outcome: 'skipped', reason: 'organization_not_synced' },
    { reviewId: 'changed', outcome: 'skipped', reason: 'changed' }])
})
