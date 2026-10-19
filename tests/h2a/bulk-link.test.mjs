import test from 'node:test'
import assert from 'node:assert/strict'
import { H2AReviewError } from '../../netlify/functions/_h2a/reviewService.js'

const path = '../../netlify/functions/_h2a/bulkLink.js'
const { executeBulkLink } = await import(path).catch(() => ({}))
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stamp = '2026-10-14T10:00:00.123456Z'
const actorId = uuid(900)

const makeRow = (n, extra = {}) => ({ id: uuid(n), company_id: 'c1', object_type: 'contacts', portal_id: '123', source_id: `s${n}`,
  review_kind: 'live', status: 'needs_review', reason: 'name_only_candidate', updated_at: stamp,
  triage_bucket: 'quick', triage_details: { quickKind: 'link' },
  source_snapshot: { id: `s${n}`, email: `p${n}@x.com`, firstName: 'A', lastName: 'B' },
  candidate_snapshots: [{ id: `a${n}`, email: `p${n}@x.com`, firstName: 'A', lastName: 'B' }], ...extra })
const item = (n, extra = {}) => ({ reviewId: uuid(n), candidateId: `a${n}`, expectedUpdatedAt: stamp, clientRequestId: uuid(100 + n), ...extra })

function setup(rows, { mappings = { contacts: [], organizations: [], options: [] }, run } = {}) {
  const calls = []
  const deps = { repository: { getReview: async (company, id) => { assert.equal(company, 'c1'); return rows.find(r => r.id === id) ?? null },
    getMappings: async () => mappings },
  executeResolution: async (_deps, args) => { calls.push(args); return run ? run(args) : { resolution: { id: 'r' } } } }
  return { deps, calls, go: items => executeBulkLink(deps, { companyId: 'c1', actorId, items }) }
}

test('links eligible items one by one with their own request ids', async () => {
  const { calls, go } = setup([makeRow(1), makeRow(2)])
  const { results } = await go([item(1), item(2)])
  assert.deepEqual(results, [{ reviewId: uuid(1), status: 'done' }, { reviewId: uuid(2), status: 'done' }])
  assert.deepEqual(calls.map(c => c.clientRequestId), [uuid(101), uuid(102)])
  assert.deepEqual(calls[0], { companyId: 'c1', actorId, reviewId: uuid(1), expectedUpdatedAt: stamp, clientRequestId: uuid(101),
    decision: { action: 'link_existing', candidateId: 'a1', approveManyToOne: false, ignoreContactDifferences: true } })
})

test('item whose target became linked elsewhere is skipped linked_elsewhere', async () => {
  const mappings = { contacts: [{ hubspot_id: 'other', albi_contact_id: 'a1', portal_id: '123' }], organizations: [], options: [] }
  const { calls, go } = setup([makeRow(1), makeRow(2)], { mappings })
  const { results } = await go([item(1), item(2)])
  assert.deepEqual(results, [{ reviewId: uuid(1), status: 'skipped', reason: 'linked_elsewhere' }, { reviewId: uuid(2), status: 'done' }])
  assert.equal(calls.length, 1)
})

test('changed item is skipped changed and others continue', async () => {
  const rows = [makeRow(1), makeRow(2), makeRow(3, { updated_at: '2026-10-14T11:00:00.000000Z' })]
  const { calls, go } = setup(rows, { run: async args => { if (args.reviewId === uuid(2)) throw new H2AReviewError(409, 'x'); return { resolution: {} } } })
  const { results } = await go([item(1), item(2), item(3)])
  assert.deepEqual(results.map(r => [r.status, r.reason]), [['done', undefined], ['skipped', 'changed'], ['skipped', 'changed']])
  assert.equal(calls.length, 2)
})

test('an unexpected error fails that item only without leaking the message', async () => {
  const { go } = setup([makeRow(1), makeRow(2)], { run: async args => { if (args.reviewId === uuid(1)) throw Error('provider secret'); return {} } })
  const { results } = await go([item(1), item(2)])
  assert.deepEqual(results, [{ reviewId: uuid(1), status: 'failed', reason: 'error' }, { reviewId: uuid(2), status: 'done' }])
  assert.equal(JSON.stringify(results).includes('secret'), false)
})

test('rejects more than 25 items and empty lists', async () => {
  const { go } = setup([])
  await assert.rejects(go(Array.from({ length: 26 }, (_, i) => item(i + 1))), error => error instanceof H2AReviewError && error.statusCode === 400)
  await assert.rejects(go([]), error => error instanceof H2AReviewError && error.statusCode === 400)
})

test('never sends approveManyToOne true', async () => {
  const { calls, go } = setup([makeRow(1), makeRow(2)])
  await go([item(1), item(2)])
  assert.equal(calls.length, 2)
  assert.equal(calls.every(c => c.decision.approveManyToOne === false), true)
})

test('non-quick item is skipped not_eligible', async () => {
  const rows = [makeRow(1, { triage_bucket: 'decision', triage_details: {} }), makeRow(2, { triage_details: { quickKind: 'create' } }),
    makeRow(3, { candidate_snapshots: [] }), null]
  const { calls, go } = setup(rows.filter(Boolean))
  const { results } = await go([item(1), item(2), item(3), item(4)])
  assert.deepEqual(results.map(r => [r.status, r.reason]), [['skipped', 'not_eligible'], ['skipped', 'not_eligible'], ['skipped', 'not_eligible'], ['skipped', 'not_eligible']])
  assert.equal(calls.length, 0)
})

test('cleared safe-to-link row without a suggestion is not eligible unless it matches the suggestion', async () => {
  const cleared = makeRow(1, { status: 'cleared', recheck_outcome: 'safe_to_link', candidate_snapshots: [{ id: 'a1', email: 'zzz@x.com' }] })
  const { calls, go } = setup([cleared])
  assert.equal((await go([item(1)])).results[0].reason, 'not_eligible')
  assert.equal(calls.length, 0)
})

test('ignoreContactDifferences is only sent when same_email is a match reason', async () => {
  const row = makeRow(1, { source_snapshot: { id: 's1', email: 'q@x.com', additionalEmails: 'p1@x.com', firstName: 'A', lastName: 'B' } })
  const { calls, go } = setup([row, makeRow(2)])
  const { results } = await go([item(1), item(2)])
  assert.deepEqual(results.map(r => r.status), ['done', 'done'])
  assert.equal('ignoreContactDifferences' in calls[0].decision, false)
  assert.equal(calls[1].decision.ignoreContactDifferences, true)
})
