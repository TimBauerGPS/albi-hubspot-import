import test from 'node:test'
import assert from 'node:assert/strict'
import { runReviewRecheckBatch } from '../../netlify/functions/_h2a/reviewService.js'

const batchId = '00000000-0000-4000-8000-0000000000b1'
const actorId = '00000000-0000-4000-8000-000000000002'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stamp = n => `2026-10-12T10:00:0${n}.123456Z`
const MUTATIONS = ['createContact', 'createOrganization', 'updateContact', 'updateCompany', 'updateOrganization',
  'addContactCompanyAssociation', 'saveMapping', 'saveCursor', 'recordConflict', 'finishRun', 'getCredentials']

// rows: [{ objectType, sourceId, email }]; HubSpot sources are read live per row, Albi lists once per batch.
function fixture({ rows = [], contacts = [], organizations = [], batch = {}, sampleId = 'current-run', resolutions = {} } = {}) {
  const calls = [], events = [], applied = [], updates = [], finished = [], closes = [], order = []
  const reviews = rows.map((row, index) => ({ id: id(index + 1), run_id: row.kind === 'live' ? 'live-run' : 'current-run', portal_id: '123',
    review_kind: row.kind ?? 'sample',
    object_type: row.objectType ?? 'contacts', source_id: row.sourceId ?? String(10 + index),
    reason: 'name_only_candidate', conflict_type: (row.objectType ?? 'contacts') === 'contacts' ? 'contact_match' : 'organization_match',
    status: 'needs_review', updated_at: stamp(index), source_snapshot: {} }))
  const sources = Object.fromEntries(rows.map((row, index) => [reviews[index].source_id, row.source === undefined
    ? { id: reviews[index].source_id, properties: (row.objectType ?? 'contacts') === 'contacts'
      ? { firstname: 'A', lastname: `Person${index}`, email: row.email ?? `p${index}@example.com` } : { name: `Org ${index}` } }
    : row.source]))
  const repository = {
    getConfig: async () => ({ initial_start_locked_at: '2026-10-01T00:00:00Z', portal_id: '123' }),
    getCurrentReviewSample: async () => ({ id: sampleId, review_capture_version: 1 }),
    getLatestCompletedSampleDryRun: async () => ({ id: sampleId, review_capture_version: 1 }),
    getDryRunReview: async (_company, _run, reviewId) => reviews.find(row => row.id === reviewId) ?? null,
    getReview: async (_company, reviewId) => reviews.find(row => row.id === reviewId) ?? null,
    listDryRunReviews: async (company, runId, filters) => {
      calls.push(['list', company, runId, filters])
      const open = reviews.filter(row => row.status === 'needs_review' && row.review_kind === (filters.kind ?? 'sample'))
      const start = filters.before ? open.findIndex(row => row.id === filters.before.id) + 1 : 0
      const items = open.slice(start, start + filters.limit)
      return { items, hasMore: start + filters.limit < open.length }
    },
    appendDryRunReviewEvent: async (...args) => { events.push([args[2], args[3].eventType, args[3].actorId]); return { id: 'event' } },
    getMappings: async () => ({ contacts: [], organizations: [], options: [] }),
    applyDryRunRecheck: async (company, payload) => {
      applied.push([company, payload]); order.push(['apply', payload.reviewId])
      const row = reviews.find(item => item.id === payload.reviewId)
      if (row.updated_at !== payload.expectedUpdatedAt) return { error: 'stale' }
      row.recheck_outcome = payload.outcome
      return { review: { ...row, status: payload.status, recheck_outcome: payload.outcome } }
    },
  }
  const hubspotRead = {
    getContacts: async ids => { calls.push(['hubspotContacts', ids]); return sources[ids[0]] ? [sources[ids[0]]] : [] },
    getCompanies: async ids => { calls.push(['hubspotCompanies', ids]); return sources[ids[0]] ? [sources[ids[0]]] : [] },
    getAssociations: async args => [{ fromId: args.objectIds[0], toObjectType: 'companies', toIds: [] }],
  }
  const albiRead = {
    listContacts: async args => { calls.push(['albiContacts', args.cursor]); return { records: contacts, cursor: null } },
    listOrganizations: async args => { calls.push(['albiOrganizations', args.cursor]); return { records: organizations, cursor: null } },
  }
  for (const object of [repository, hubspotRead, albiRead]) for (const name of MUTATIONS) {
    Object.defineProperty(object, name, { get() { throw Error(`Mutation capability accessed: ${name}`) } })
  }
  const batchRepository = {
    claimReviewRecheckBatch: async (company, claimedId) => {
      calls.push(['claim', company, claimedId])
      return { id: batchId, run_id: 'current-run', requested_by: actorId, status: 'running', ...batch }
    },
    updateReviewRecheckBatch: async (company, updatedId, patch) => { updates.push(patch); return true },
    finishReviewRecheckBatch: async (company, finishedId, patch) => { finished.push(patch); return true },
  }
  // Live rows close through the close RPC (one transaction per row) and read their resolution.
  const liveCloseRepository = {
    closeLiveReview: async (company, args) => {
      closes.push([company, args]); order.push(['close', args.reviewId])
      const row = reviews.find(item => item.id === args.reviewId)
      row.status = args.outcome === 'resolved' ? 'cleared' : 'no_longer_in_scope'
      return { closedConflictIds: [], resumeIds: [], replayed: false }
    },
  }
  const resolutionRepository = { getCurrentReviewResolution: async (_company, reviewId) => resolutions[reviewId] ?? null }
  const deps = { repository, batchRepository, liveCloseRepository, resolutionRepository, now: () => new Date('2026-10-12T12:00:00Z'), sleep: async () => {},
    getReadClients: async () => { calls.push(['clients']); return { hubspotRead, albiRead } } }
  return { deps, reviews, calls, events, applied, updates, finished, closes, order, hubspotRead, albiRead }
}

const input = { companyId: 'tenant-1', batchId }

test('batch walks Albi contacts and organizations once and applies every open row against that snapshot', async () => {
  const f = fixture({ rows: [{ email: 'a@example.com' }, { email: 'nobody@example.com' }, { objectType: 'companies' }],
    contacts: [{ id: '20', firstName: 'A', lastName: 'Person0', email: 'a@example.com' }] })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'completed')
  assert.equal(f.calls.filter(call => call[0] === 'albiContacts').length, 1)
  assert.equal(f.calls.filter(call => call[0] === 'albiOrganizations').length, 1)
  assert.equal(f.calls.filter(call => call[0] === 'clients').length, 1)
  // HubSpot sources stay live per row.
  assert.equal(f.calls.filter(call => call[0] === 'hubspotContacts').length, 2)
  assert.equal(f.calls.filter(call => call[0] === 'hubspotCompanies').length, 1)
  assert.deepEqual(f.applied.map(([, payload]) => [payload.reviewId, payload.expectedUpdatedAt, payload.actorId]),
    f.reviews.map(row => [row.id, row.updated_at, actorId]))
  assert.equal(f.applied[0][1].outcome, 'safe_to_link')
  assert.equal(f.applied[1][1].outcome, 'still_needs_review')
  // Every row keeps the single-recheck audit trail under the requesting actor.
  assert.deepEqual(f.events.map(([reviewId, type, actor]) => [reviewId, type, actor]),
    f.reviews.map(row => [row.id, 'recheck_started', actorId]))
  assert.deepEqual(f.finished.at(-1), { status: 'completed', errorCode: null,
    counts: { total: 3, done: 3, cleared: 1, stillNeedsReview: 2, noLongerInScope: 0, stale: 0, failed: 0 } })
  assert.deepEqual(f.updates[0].counts, { total: 3, done: 0, cleared: 0, stillNeedsReview: 0, noLongerInScope: 0, stale: 0, failed: 0 })
  assert.equal(f.updates.at(-1).counts.done, 3)
})

test('batch lists only open rows of the server-selected sample in pages', async () => {
  const f = fixture({ rows: Array.from({ length: 105 }, () => ({ source: null })) })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.counts.total, 105)
  assert.equal(result.counts.noLongerInScope, 105)
  const lists = f.calls.filter(call => call[0] === 'list')
  assert.equal(lists.length, 2)
  for (const [, company, runId, filters] of lists) {
    assert.equal(company, 'tenant-1')
    assert.equal(runId, 'current-run')
    assert.equal(filters.status, 'needs_review')
    assert.equal(filters.limit, 100)
  }
  // The Albi snapshot is still taken once, however many rows share it.
  assert.equal(f.calls.filter(call => call[0] === 'albiContacts').length, 1)
})

test('a row edited since listing is counted stale and the rest still apply', async () => {
  const f = fixture({ rows: [{}, {}] })
  const originalList = f.deps.repository.listDryRunReviews
  f.deps.repository.listDryRunReviews = async (...args) => {
    const page = await originalList(...args)
    const listed = page.items.map(row => ({ ...row }))
    f.reviews[0].updated_at = '2026-10-12T11:00:00.000000Z'
    return { ...page, items: listed }
  }
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.stale, 1)
  assert.equal(result.counts.stillNeedsReview + result.counts.cleared, 1)
  assert.equal(f.applied.length, 1)
})

test('an Albi walk failure fails the batch closed before any row changes', async () => {
  const f = fixture({ rows: [{}, {}] })
  f.albiRead.listContacts = async () => { throw Object.assign(new Error('boom secret'), { category: 'permanent', code: 'malformed_response' }) }
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'failed')
  assert.equal(f.applied.length, 0)
  assert.equal(f.events.length, 0)
  assert.deepEqual(f.finished.at(-1), { status: 'failed', errorCode: 'malformed_response',
    counts: { total: 2, done: 0, cleared: 0, stillNeedsReview: 0, noLongerInScope: 0, stale: 0, failed: 0 } })
  assert.equal(JSON.stringify(f.finished).includes('secret'), false)
})

test('a per-row provider failure is audited on that row and the batch continues', async () => {
  const f = fixture({ rows: [{}, {}] })
  const original = f.hubspotRead.getContacts
  f.hubspotRead.getContacts = async ids => {
    if (ids[0] === f.reviews[0].source_id) throw Object.assign(new Error('nope'), { category: 'permanent' })
    return original(ids)
  }
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.failed, 1)
  assert.equal(result.counts.done, 2)
  assert.ok(f.events.some(([reviewId, type]) => reviewId === f.reviews[0].id && type === 'recheck_failed'))
  assert.equal(f.applied.length, 1)
})

test('a superseded sample stops the batch without touching later rows', async () => {
  const f = fixture({ rows: [{}, {}, {}] })
  let reads = 0
  f.deps.repository.getLatestCompletedSampleDryRun = async () => (++reads > 4 ? { id: 'newer-run', review_capture_version: 1 }
    : { id: 'current-run', review_capture_version: 1 })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'superseded')
  assert.ok(f.applied.length < 3)
})

test('a batch for another sample fails as superseded without reading providers', async () => {
  const f = fixture({ rows: [{}], batch: { run_id: 'older-run' } })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.errorCode, 'superseded')
  assert.equal(f.calls.some(call => call[0] === 'clients'), false)
  assert.equal(f.applied.length, 0)
})

test('an unclaimable batch (already running, finished, or retried) is a no-op', async () => {
  const f = fixture({ rows: [{}] })
  f.deps.batchRepository.claimReviewRecheckBatch = async () => null
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'not_claimed')
  assert.equal(f.calls.some(call => call[0] === 'list'), false)
  assert.equal(f.finished.length, 0)
})

test('the batch stops at its own deadline and reports how far it got', async () => {
  const f = fixture({ rows: [{}, {}, {}] })
  let now = 0
  f.deps.clockMs = () => now
  f.deps.batchDeadlineMs = 1000
  const original = f.deps.repository.applyDryRunRecheck
  f.deps.repository.applyDryRunRecheck = async (...args) => { now += 600; return original(...args) }
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'timeout')
  assert.equal(result.counts.done, 2)
})

test('an empty queue completes without reading providers', async () => {
  const f = fixture({ rows: [] })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.total, 0)
  assert.equal(f.calls.some(call => call[0] === 'clients'), false)
})

test('a batch that loses its row (expired and replaced) stops before rechecking more rows', async () => {
  const f = fixture({ rows: [{}, {}, {}] })
  let beats = 0
  f.deps.batchRepository.updateReviewRecheckBatch = async () => ++beats < 2
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'lost')
  assert.equal(f.applied.length, 1)
  assert.equal(f.finished.length, 0)
})

test('batch with reviewIds rechecks only those rows with one Albi walk', async () => {
  const f = fixture({ rows: [{}, {}, {}, { objectType: 'companies' }] })
  const missing = id(99)
  f.deps.batchRepository.claimReviewRecheckBatch = async () => ({ id: batchId, run_id: 'current-run', review_kind: 'sample',
    review_ids: [f.reviews[0].id, f.reviews[2].id, missing], requested_by: actorId, status: 'running' })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'completed')
  assert.deepEqual(f.applied.map(([, payload]) => payload.reviewId), [f.reviews[0].id, f.reviews[2].id])
  assert.equal(f.calls.filter(call => call[0] === 'albiContacts').length, 1)
  assert.equal(f.calls.filter(call => call[0] === 'albiOrganizations').length, 1)
  assert.equal(f.calls.filter(call => call[0] === 'clients').length, 1)
  assert.equal(f.calls.some(call => call[0] === 'hubspotCompanies'), false, 'untargeted rows are never read')
  // An id that is no longer open in this queue is reported stale, never rechecked.
  assert.deepEqual(result.counts, { total: 3, done: 3, cleared: 0, stillNeedsReview: 2, noLongerInScope: 0, stale: 1, failed: 0 })
})

test('a live batch runs without a sample run and only over live rows', async () => {
  const f = fixture({ rows: [{}, { kind: 'live', email: 'a@example.com' }, { kind: 'live' }],
    contacts: [{ id: '20', firstName: 'A', lastName: 'Person1', email: 'a@example.com' }] })
  f.deps.repository.getCurrentReviewSample = async () => null
  f.deps.repository.getLatestCompletedSampleDryRun = async () => null
  f.deps.batchRepository.claimReviewRecheckBatch = async () => ({ id: batchId, run_id: null, review_kind: 'live', review_ids: null,
    requested_by: actorId, status: 'running' })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'completed')
  const [, , runId, filters] = f.calls.find(call => call[0] === 'list')
  assert.deepEqual([runId, filters.kind, filters.status], [null, 'live', 'needs_review'])
  assert.deepEqual(f.applied.map(([, payload]) => [payload.reviewId, payload.kind]), [[f.reviews[1].id, 'live'], [f.reviews[2].id, 'live']])
  // The exact match now auto-links: the live row closes as resolved_by_sync; the other stays open.
  assert.deepEqual(f.closes.map(([, args]) => [args.reviewId, args.outcome]), [[f.reviews[1].id, 'resolved_by_sync']])
  assert.deepEqual(result.counts, { total: 2, done: 2, cleared: 0, stillNeedsReview: 1, noLongerInScope: 1, stale: 0, failed: 0 })
})

test('live and sample batches can run at the same time', async () => {
  const f = fixture({ rows: [{}, {}, { kind: 'live' }, { kind: 'live' }] })
  const batches = {
    [id(201)]: { id: id(201), run_id: 'current-run', review_kind: 'sample', review_ids: null, requested_by: actorId, status: 'running' },
    [id(202)]: { id: id(202), run_id: null, review_kind: 'live', review_ids: null, requested_by: actorId, status: 'running' },
  }
  const finishedBy = {}
  f.deps.batchRepository.claimReviewRecheckBatch = async (_company, claimed) => batches[claimed] ?? null
  f.deps.batchRepository.finishReviewRecheckBatch = async (_company, finishedId, patch) => { finishedBy[finishedId] = patch; return true }
  const [sample, live] = await Promise.all([runReviewRecheckBatch(f.deps, { companyId: 'tenant-1', batchId: id(201) }),
    runReviewRecheckBatch(f.deps, { companyId: 'tenant-1', batchId: id(202) })])
  assert.equal(sample.status, 'completed')
  assert.equal(live.status, 'completed')
  assert.equal(finishedBy[id(201)].counts.total, 2)
  assert.equal(finishedBy[id(202)].counts.total, 2)
  assert.deepEqual(f.applied.map(([, payload]) => payload.reviewId).sort(), f.reviews.map(row => row.id).sort())
  assert.equal(f.applied.filter(([, payload]) => payload.kind === 'live').length, 2)
})

test('a live batch sweeps a completed resolution whose close failed, even outside the targeted rows', async () => {
  const f = fixture({ rows: [{ kind: 'live' }, { kind: 'live' }],
    resolutions: { [id(2)]: { id: id(102), review_id: id(2), action: 'link_existing', status: 'completed', created_by: actorId } } })
  f.deps.batchRepository.claimReviewRecheckBatch = async () => ({ id: batchId, run_id: null, review_kind: 'live',
    review_ids: [id(1)], requested_by: actorId, status: 'running' })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'completed')
  assert.deepEqual(f.applied.map(([, payload]) => payload.reviewId), [id(1)])
  // The stranded row closes as the reviewer's own link, without any provider read for it.
  assert.deepEqual(f.closes.map(([, args]) => [args.reviewId, args.outcome, args.resolutionAction]), [[id(2), 'resolved', 'link_existing']])
  assert.equal(f.calls.filter(call => call[0] === 'hubspotContacts').length, 1)
  assert.equal(f.reviews[1].status, 'cleared')
  assert.equal(result.settled, 1)
  assert.equal(result.counts.total, 1)
  // The sweep runs after the targeted rechecks, so it can never use up their deadline.
  assert.deepEqual(f.order, [['apply', id(1)], ['close', id(2)]])
})

test('a targeted live batch that runs out of time skips the sweep', async () => {
  const f = fixture({ rows: [{ kind: 'live' }, { kind: 'live' }],
    resolutions: { [id(2)]: { id: id(102), review_id: id(2), action: 'link_existing', status: 'completed', created_by: actorId } } })
  let now = 0
  f.deps.clockMs = () => now
  f.deps.batchDeadlineMs = 1000
  f.deps.batchRepository.claimReviewRecheckBatch = async () => ({ id: batchId, run_id: null, review_kind: 'live',
    review_ids: [id(1)], requested_by: actorId, status: 'running' })
  const original = f.deps.repository.applyDryRunRecheck
  f.deps.repository.applyDryRunRecheck = async (...args) => { now += 2000; return original(...args) }
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.counts.done, 1)
  assert.equal(f.closes.length, 0)
  assert.equal(result.settled, 0)
})

test('a full live batch settles a stranded row instead of re-evaluating it', async () => {
  const f = fixture({ rows: [{ kind: 'live' }],
    resolutions: { [id(1)]: { id: id(101), review_id: id(1), action: 'create_albi', status: 'completed', created_by: actorId } } })
  f.deps.batchRepository.claimReviewRecheckBatch = async () => ({ id: batchId, run_id: null, review_kind: 'live',
    review_ids: null, requested_by: actorId, status: 'running' })
  const result = await runReviewRecheckBatch(f.deps, input)
  assert.equal(result.status, 'completed')
  assert.deepEqual(f.closes.map(([, args]) => [args.reviewId, args.outcome, args.resolutionAction]), [[id(1), 'resolved', 'create_new']])
  assert.equal(f.applied.length, 0)
  assert.equal(result.counts.cleared, 1)
})

test('a live batch lists only the configured portal\'s open live rows', async () => {
  const f = fixture({ rows: [{ kind: 'live' }], batch: { run_id: null, review_kind: 'live' } })
  await runReviewRecheckBatch(f.deps, input)
  const lists = f.calls.filter(call => call[0] === 'list')
  assert.ok(lists.length > 0)
  assert.ok(lists.every(([, , runId, filters]) => runId === null && filters.kind === 'live' && filters.portalId === '123'))
})
