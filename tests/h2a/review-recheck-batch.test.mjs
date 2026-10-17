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
function fixture({ rows = [], contacts = [], organizations = [], batch = {}, sampleId = 'current-run' } = {}) {
  const calls = [], events = [], applied = [], updates = [], finished = []
  const reviews = rows.map((row, index) => ({ id: id(index + 1), run_id: 'current-run', portal_id: '123',
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
    listDryRunReviews: async (company, runId, filters) => {
      calls.push(['list', company, runId, filters])
      const open = reviews.filter(row => row.status === 'needs_review')
      const start = filters.before ? open.findIndex(row => row.id === filters.before.id) + 1 : 0
      const items = open.slice(start, start + filters.limit)
      return { items, hasMore: start + filters.limit < open.length }
    },
    appendDryRunReviewEvent: async (...args) => { events.push([args[2], args[3].eventType, args[3].actorId]); return { id: 'event' } },
    getMappings: async () => ({ contacts: [], organizations: [], options: [] }),
    applyDryRunRecheck: async (company, payload) => {
      applied.push([company, payload])
      const row = reviews.find(item => item.id === payload.reviewId)
      if (row.updated_at !== payload.expectedUpdatedAt) return { error: 'stale' }
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
  const deps = { repository, batchRepository, now: () => new Date('2026-10-12T12:00:00Z'), sleep: async () => {},
    getReadClients: async () => { calls.push(['clients']); return { hubspotRead, albiRead } } }
  return { deps, reviews, calls, events, applied, updates, finished, hubspotRead, albiRead }
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
