import test from 'node:test'
import assert from 'node:assert/strict'
import { createH2ARepository } from '../../netlify/functions/_h2a/repository.js'
import { backfillLiveReviews, captureLiveReview, closeLiveReview } from '../../netlify/functions/_h2a/liveReview.js'
import { dispatchConflictResumes } from '../../netlify/functions/_h2a/conflicts.js'
import { liveCloseStore } from './live-close-fixture.mjs'

// In-memory double of the two tables, enforcing the real unique keys (including the
// per-run key that still applies to live rows and the live partial index).
const UNIQUE = {
  h2a_dry_run_reviews: [
    { name: 'h2a_dry_run_reviews_company_id_run_id_portal_id_object_type_source_id_key',
      cols: ['company_id', 'run_id', 'portal_id', 'object_type', 'source_id'] },
    { name: 'h2a_live_review_open_source_idx', cols: ['company_id', 'portal_id', 'object_type', 'source_id'],
      where: row => row.review_kind === 'live' && row.status === 'needs_review' },
  ],
  h2a_live_review_conflicts: [{ name: 'h2a_live_review_conflicts_company_id_conflict_id_key', cols: ['company_id', 'conflict_id'] }],
}

function memorySupabase() {
  const tables = { h2a_dry_run_reviews: [], h2a_live_review_conflicts: [] }
  let sequence = 0, tick = 0
  const stamp = () => `2026-10-19T12:00:${String(tick++).padStart(2, '0')}.000Z`
  const violation = (table, candidate) => (UNIQUE[table] ?? []).find(key => (!key.where || key.where(candidate)) &&
    tables[table].some(row => row.id !== candidate.id && (!key.where || key.where(row)) && key.cols.every(col => row[col] === candidate[col])))
  const duplicate = key => ({ data: null, error: { code: '23505', constraint: key.name,
    message: `duplicate key value violates unique constraint "${key.name}"` } })
  function from(table) {
    const filters = []
    let op = 'select', payload = null
    const run = mode => {
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, created_at: stamp(), ...structuredClone(payload) }
        row.updated_at ??= row.created_at
        const key = violation(table, row)
        if (key) return duplicate(key)
        tables[table].push(row)
        return { data: structuredClone(row), error: null }
      }
      const matches = tables[table].filter(row => filters.every(([col, value]) => row[col] === value))
      if (op === 'update') {
        for (const row of matches) {
          const next = { ...row, ...structuredClone(payload) }
          const key = violation(table, next)
          if (key) return duplicate(key)
          Object.assign(row, next)
        }
      }
      if (mode === 'many') return { data: structuredClone(matches), error: null }
      if (matches.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } }
      if (mode === 'single' && !matches.length) return { data: null, error: { code: 'PGRST116', message: 'no rows' } }
      return { data: matches[0] ? structuredClone(matches[0]) : null, error: null }
    }
    const query = {
      select() { return query },
      insert(value) { op = 'insert'; payload = value; return query },
      update(value) { op = 'update'; payload = value; return query },
      eq(col, value) { filters.push([col, value]); return query },
      order() { return query },
      limit() { return query },
      single: async () => run('single'),
      maybeSingle: async () => run('maybe'),
      then: (resolve, reject) => Promise.resolve().then(() => run('many')).then(resolve, reject),
    }
    return query
  }
  return { tables, client: { from, rpc: async () => { throw Error('unexpected rpc') } } }
}

const base = {
  companyId: 'company-1', runId: 'run-1', portalId: '123', objectType: 'contacts', sourceId: '10',
  reason: 'new_record_needs_review', conflictType: 'identity',
  source: { id: '10', properties: { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com' } },
  candidates: [], evidence: [], proposedChanges: {}, mappings: [],
}
function fixture() {
  const db = memorySupabase()
  return { db, deps: { repository: createH2ARepository(db.client) } }
}

test('two captures of the same source make one open row with both conflicts linked', async () => {
  const { db, deps } = fixture()
  const first = await captureLiveReview(deps, { ...base, conflictId: 'conflict-a' })
  const second = await captureLiveReview(deps, { ...base, runId: 'run-2', conflictId: 'conflict-b' })
  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.equal(second.reviewId, first.reviewId)
  const rows = db.tables.h2a_dry_run_reviews
  assert.equal(rows.length, 1)
  assert.equal(rows[0].review_kind, 'live')
  assert.equal(rows[0].status, 'needs_review')
  assert.equal(rows[0].run_id, 'run-1', 'run_id keeps the run that first captured the row')
  assert.equal(rows[0].reason, 'new_record_needs_review')
  assert.equal(rows[0].conflict_type, 'identity')
  assert.equal(rows[0].triage_bucket, 'decision', 'create readiness is not known at capture time')
  assert.deepEqual(db.tables.h2a_live_review_conflicts.map(link => [link.review_id, link.conflict_id]),
    [[first.reviewId, 'conflict-a'], [first.reviewId, 'conflict-b']])
  // Re-linking an already linked conflict is a no-op.
  const again = await captureLiveReview(deps, { ...base, conflictId: 'conflict-a' })
  assert.equal(again.reviewId, first.reviewId)
  assert.equal(db.tables.h2a_live_review_conflicts.length, 2)
  const stored = await deps.repository.getReview('company-1', first.reviewId)
  assert.equal(stored.review_kind, 'live')
})

test('capture refreshes evidence on the existing open row', async () => {
  const { db, deps } = fixture()
  const first = await captureLiveReview(deps, { ...base, reason: 'name_only_candidate', conflictType: 'contact_match',
    candidates: [{ id: '200', firstName: 'Ada', lastName: 'Lovelace' }], evidence: ['name'], conflictId: 'conflict-a' })
  const before = structuredClone(db.tables.h2a_dry_run_reviews[0])
  const second = await captureLiveReview(deps, { ...base, reason: 'unique_exact_match', conflictType: 'contact_match',
    source: { id: '10', properties: { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@new.example.com' } },
    candidates: [{ id: '200', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@new.example.com' }],
    evidence: ['email', 'name', 'not-allowed'], runId: 'run-2', conflictId: 'conflict-b' })
  assert.equal(second.reviewId, first.reviewId)
  assert.equal(second.inserted, false)
  const row = db.tables.h2a_dry_run_reviews[0]
  assert.equal(db.tables.h2a_dry_run_reviews.length, 1)
  assert.equal(row.reason, 'unique_exact_match')
  assert.equal(row.source_snapshot.email, 'ada@new.example.com')
  assert.equal(row.candidate_snapshots[0].email, 'ada@new.example.com')
  assert.deepEqual(row.match_evidence, { evidence: ['email', 'name'] })
  assert.equal(row.triage_bucket, 'quick', 'triage is recomputed with the refreshed ranking')
  assert.deepEqual(row.triage_details, { quickKind: 'link' })
  assert.notEqual(row.updated_at, before.updated_at, 'refresh moves the row version')
  assert.equal(row.run_id, 'run-1')
  // An identical capture leaves the row version alone.
  const version = row.updated_at
  await captureLiveReview(deps, { ...base, reason: 'unique_exact_match', conflictType: 'contact_match',
    source: { id: '10', properties: { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@new.example.com' } },
    candidates: [{ id: '200', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@new.example.com' }],
    evidence: ['email', 'name'], runId: 'run-2', conflictId: 'conflict-b' })
  assert.equal(db.tables.h2a_dry_run_reviews[0].updated_at, version)
})

test('a source whose previous live row is cleared gets a new row', async () => {
  const { db, deps } = fixture()
  const first = await captureLiveReview(deps, { ...base, conflictId: 'conflict-a' })
  db.tables.h2a_dry_run_reviews[0].status = 'cleared'
  const second = await captureLiveReview(deps, { ...base, runId: 'run-2', conflictId: 'conflict-b' })
  assert.equal(second.inserted, true)
  assert.notEqual(second.reviewId, first.reviewId)
  const rows = db.tables.h2a_dry_run_reviews
  assert.deepEqual(rows.map(row => [row.status, row.run_id]), [['cleared', 'run-1'], ['needs_review', 'run-2']])
  assert.deepEqual(db.tables.h2a_live_review_conflicts.map(link => [link.review_id, link.conflict_id]),
    [[first.reviewId, 'conflict-a'], [second.reviewId, 'conflict-b']])
})

test('a closed live row in the same run stays closed and is reported as already handled', async () => {
  const { db, deps } = fixture()
  const first = await captureLiveReview(deps, { ...base, conflictId: 'conflict-a' })
  db.tables.h2a_dry_run_reviews[0].status = 'no_longer_in_scope'
  const second = await captureLiveReview(deps, { ...base, conflictId: 'conflict-b' })
  assert.deepEqual(second, { reviewId: first.reviewId, inserted: false, closed: true, linked: false })
  assert.equal(db.tables.h2a_dry_run_reviews.length, 1)
  assert.equal(db.tables.h2a_dry_run_reviews[0].status, 'no_longer_in_scope', 'a closed row is never reopened')
  assert.deepEqual(db.tables.h2a_live_review_conflicts.map(link => link.conflict_id), ['conflict-a'],
    'a new conflict is not attached to a row whose close already ran')
})

test('a concurrent capture that wins the live key is refreshed instead of duplicated', async () => {
  const { db, deps } = fixture()
  const original = db.client.from
  let raced = false
  db.client.from = table => {
    const query = original(table)
    const insert = query.insert
    query.insert = value => {
      if (!raced && table === 'h2a_dry_run_reviews') {
        raced = true
        db.tables.h2a_dry_run_reviews.push({ ...structuredClone(value), id: '00000000-0000-4000-8000-0000000000aa',
          run_id: 'run-other', created_at: '2026-10-19T11:00:00.000Z', updated_at: '2026-10-19T11:00:00.000Z' })
      }
      return insert(value)
    }
    return query
  }
  const result = await captureLiveReview(deps, { ...base, conflictId: 'conflict-a' })
  assert.deepEqual(result, { reviewId: '00000000-0000-4000-8000-0000000000aa', inserted: false, linked: true })
  assert.equal(db.tables.h2a_dry_run_reviews.length, 1)
  assert.deepEqual(db.tables.h2a_live_review_conflicts.map(link => link.review_id), ['00000000-0000-4000-8000-0000000000aa'])
})

test('capture requires a persisted conflict id and a valid classification', async () => {
  const { deps } = fixture()
  await assert.rejects(() => captureLiveReview(deps, { ...base, conflictId: undefined }), /conflict/i)
  await assert.rejects(() => captureLiveReview(deps, { ...base, conflictType: 'RAW', conflictId: 'conflict-a' }), /classification/)
})

test('capture passes create readiness into triage', async () => {
  const { db, deps } = fixture()
  await captureLiveReview(deps, { ...base, conflictId: 'conflict-a', createReadiness: { ready: true, referralSources: [{ id: '1', label: 'Web' }] } })
  assert.equal(db.tables.h2a_dry_run_reviews[0].triage_bucket, 'quick')
  assert.deepEqual(db.tables.h2a_dry_run_reviews[0].triage_details, { quickKind: 'create' })
  const { db: other, deps: otherDeps } = fixture()
  await captureLiveReview(otherDeps, { ...base, conflictId: 'conflict-a', createReadiness: { ready: false, blockedReason: 'salesperson_not_found' } })
  assert.equal(other.tables.h2a_dry_run_reviews[0].triage_bucket, 'blocked')
  assert.deepEqual(other.tables.h2a_dry_run_reviews[0].triage_details, { blockedReason: 'salesperson_not_found' })
})

test('a capture without a source keeps the stored source snapshot', async () => {
  const { db, deps } = fixture()
  await captureLiveReview(deps, { ...base, conflictId: 'conflict-a' })
  await captureLiveReview(deps, { ...base, source: undefined, reason: 'missing_hubspot_contact', conflictType: 'missing_source',
    runId: 'run-2', conflictId: 'conflict-b' })
  const row = db.tables.h2a_dry_run_reviews[0]
  assert.equal(row.reason, 'missing_hubspot_contact')
  assert.deepEqual(row.source_snapshot, { id: '10', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' })
  // A first capture without a source still stores the bare identity.
  const { db: fresh, deps: freshDeps } = fixture()
  await captureLiveReview(freshDeps, { ...base, source: undefined, reason: 'missing_hubspot_contact', conflictType: 'missing_source', conflictId: 'conflict-c' })
  assert.deepEqual(fresh.tables.h2a_dry_run_reviews[0].source_snapshot, { id: '10' })
})

test('refresh keeps stored merge and blocked knowledge the capture lacks', async () => {
  const { db, deps } = fixture()
  await captureLiveReview(deps, { ...base, conflictId: 'conflict-a', createReadiness: { ready: false, blockedReason: 'salesperson_not_found' } })
  // Readiness unknown on this capture (read failed): the stored block stays.
  await captureLiveReview(deps, { ...base, runId: 'run-2', conflictId: 'conflict-b', evidence: ['name'] })
  assert.equal(db.tables.h2a_dry_run_reviews[0].triage_bucket, 'blocked')
  assert.deepEqual(db.tables.h2a_dry_run_reviews[0].triage_details, { blockedReason: 'salesperson_not_found' })
  // Merge state is only known from a live HubSpot read; capture never clears it.
  db.tables.h2a_dry_run_reviews[0].triage_details = { merged: true }
  db.tables.h2a_dry_run_reviews[0].triage_bucket = 'blocked'
  await captureLiveReview(deps, { ...base, runId: 'run-3', conflictId: 'conflict-c', createReadiness: { ready: true } })
  assert.equal(db.tables.h2a_dry_run_reviews[0].triage_bucket, 'blocked')
  assert.deepEqual(db.tables.h2a_dry_run_reviews[0].triage_details, { merged: true })
  // Known readiness replaces a stored block.
  db.tables.h2a_dry_run_reviews[0].triage_details = { blockedReason: 'salesperson_not_found' }
  await captureLiveReview(deps, { ...base, runId: 'run-4', conflictId: 'conflict-d', createReadiness: { ready: true } })
  assert.deepEqual(db.tables.h2a_dry_run_reviews[0].triage_details, { quickKind: 'create' })
})

const liveReviewId = '00000000-0000-4000-8000-0000000000aa'
const closeActor = '00000000-0000-4000-8000-0000000000bb'

test('closing a live review dispatches one resume per resolved conflict and reports counts', async () => {
  const store = liveCloseStore({ reviewId: liveReviewId })
  const deps = { repository: store.methods, dispatchResume: store.dispatchResume }
  const result = await closeLiveReview(deps, { companyId: 'company-1', reviewId: liveReviewId, actorId: closeActor,
    outcome: 'resolved', resolutionAction: 'link_existing' })
  assert.deepEqual(result.closedConflictIds, ['c-1', 'c-2'])
  assert.equal(result.resumeIds.length, 2)
  assert.equal(result.replayed, false)
  assert.equal(result.dispatched, 2)
  assert.equal(result.pending, 0)
  assert.deepEqual(store.state.dispatched, result.resumeIds)
  assert.deepEqual(store.state.closeCalls[0], { companyId: 'company-1', reviewId: liveReviewId, actorId: closeActor,
    outcome: 'resolved', resolutionAction: 'link_existing' })
})

test('replaying close inserts no second resume', async () => {
  const store = liveCloseStore({ reviewId: liveReviewId })
  const deps = { repository: store.methods, dispatchResume: store.dispatchResume }
  const args = { companyId: 'company-1', reviewId: liveReviewId, actorId: closeActor, outcome: 'resolved', resolutionAction: 'create_new' }
  await closeLiveReview(deps, args)
  const replay = await closeLiveReview(deps, args)
  assert.equal(replay.replayed, true)
  assert.equal(store.state.resumes.length, 2)
  assert.equal(store.state.conflictEvents.length, 2)
  // Already-dispatched resumes are not dispatched again and are not reported as pending.
  assert.equal(store.state.dispatched.length, 2)
  assert.equal(replay.dispatched, 2)
  assert.equal(replay.pending, 0)
})

test('a resume that cannot be dispatched stays pending for the nightly retry', async () => {
  const store = liveCloseStore({ reviewId: liveReviewId })
  const deps = { repository: store.methods, dispatchResume: async () => false }
  const result = await closeLiveReview(deps, { companyId: 'company-1', reviewId: liveReviewId, actorId: closeActor,
    outcome: 'resolved_by_sync', resolutionAction: null })
  assert.equal(result.dispatched, 0)
  assert.equal(result.pending, 2)
  assert.deepEqual(store.state.resumes.map(resume => resume.status), ['pending', 'pending'])
  assert.deepEqual(store.state.conflicts.map(conflict => conflict.resolution_action), ['link_existing', 'link_existing'])
})

test('dispatchConflictResumes loads each resume and skips unknown ones', async () => {
  const store = liveCloseStore({ reviewId: liveReviewId })
  await store.methods.closeLiveReview('company-1', { reviewId: liveReviewId, actorId: closeActor, outcome: 'resolved', resolutionAction: 'link_existing' })
  const results = await dispatchConflictResumes({ repository: store.methods, dispatchResume: store.dispatchResume }, 'company-1',
    ['resume-1', 'missing'])
  assert.deepEqual(results, [{ resumeId: 'resume-1', accepted: true, pending: false }, { resumeId: 'missing', accepted: false, pending: true }])
})

test('a refused close surfaces as an error and dispatches nothing', async () => {
  const store = liveCloseStore({ reviewId: liveReviewId, review: { id: 'other', review_kind: 'live', status: 'needs_review' } })
  await assert.rejects(closeLiveReview({ repository: store.methods, dispatchResume: store.dispatchResume },
    { companyId: 'company-1', reviewId: liveReviewId, actorId: closeActor, outcome: 'skipped', resolutionAction: 'skip' }),
  error => error.closeError === 'not_found')
  assert.deepEqual(store.state.dispatched, [])
})

test('repository closeLiveReview calls the close RPC with tenant-scoped parameters', async () => {
  const calls = []
  const client = { from() { throw Error('unexpected table access') },
    rpc: async (name, params) => { calls.push([name, params]); return { data: { closedConflictIds: [], resumeIds: [], replayed: false }, error: null } } }
  const repository = createH2ARepository(client)
  const result = await repository.closeLiveReview('company-1', { reviewId: liveReviewId, actorId: closeActor, outcome: 'skipped', resolutionAction: 'skip' })
  assert.deepEqual(result, { closedConflictIds: [], resumeIds: [], replayed: false })
  assert.deepEqual(calls, [['h2a_close_live_review', { p_company_id: 'company-1', p_review_id: liveReviewId, p_actor_id: closeActor,
    p_outcome: 'skipped', p_resolution_action: 'skip' }]])
  await assert.rejects(repository.closeLiveReview('company-1', { reviewId: liveReviewId, actorId: closeActor, outcome: 'merged', resolutionAction: null }), TypeError)
})

// Backfill: open contact/company conflicts captured with their stored snapshots, in pages.
const conflictRow = (n, extra = {}) => ({ id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, company_id: 'company-1',
  portal_id: '123', object_type: 'contacts', source_id: '10', conflict_type: 'contact_match', reason: 'name_only_candidate',
  match_evidence: { evidence: ['name'] }, source_snapshot: { id: '10', firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com', apiKey: 'secret' },
  candidate_snapshots: [{ id: '200', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }], proposed_changes: {}, status: 'open', run_id: 'run-1',
  created_at: `2026-10-18T10:00:${String(n).padStart(2, '0')}.000Z`, ...extra })

function backfillFixture(conflicts) {
  const { db, deps } = fixture()
  const pages = []
  const repository = Object.assign(Object.create(Object.getPrototypeOf(deps.repository)), deps.repository, {
    async listOpenSourceConflicts(companyId, { limit, after = null }) {
      pages.push([companyId, limit, after])
      const open = conflicts.filter(row => row.status === 'open' && ['contacts', 'companies'].includes(row.object_type))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      const start = after ? open.findIndex(row => row.id === after.id) + 1 : 0
      return { items: open.slice(start, start + limit), hasMore: start + limit < open.length }
    },
    async getMappings() { return { contacts: [], organizations: [], options: [] } },
  })
  return { db, pages, deps: { ...deps, repository } }
}

test('backfill links all open conflicts for a source to one row and is idempotent', async () => {
  const conflicts = [conflictRow(1), conflictRow(2, { run_id: 'run-2' }), conflictRow(3, { source_id: '11', source_snapshot: { id: '11', firstname: 'Grace' } }),
    conflictRow(4, { object_type: 'calls', source_id: '900' }), conflictRow(5, { status: 'resolved', source_id: '12' })]
  const f = backfillFixture(conflicts)
  const first = await backfillLiveReviews(f.deps, { companyId: 'company-1' })
  assert.deepEqual([first.captured, first.linked, first.nextCursor], [2, 3, null])
  const rows = f.db.tables.h2a_dry_run_reviews
  assert.equal(rows.length, 2)
  const ada = rows.find(row => row.source_id === '10')
  assert.deepEqual([ada.review_kind, ada.status, ada.run_id, ada.reason, ada.conflict_type], ['live', 'needs_review', 'run-1', 'name_only_candidate', 'contact_match'])
  assert.equal(ada.source_snapshot.email, 'ada@example.com')
  assert.equal(JSON.stringify(rows).includes('secret'), false)
  // Triage is computed like capture: one same-email candidate is a quick link; readiness is unknown for backfill.
  assert.equal(ada.triage_bucket, 'quick')
  assert.deepEqual(f.db.tables.h2a_live_review_conflicts.map(link => [link.review_id === ada.id, link.conflict_id]),
    [[true, conflicts[0].id], [true, conflicts[1].id], [false, conflicts[2].id]])
  const before = structuredClone(f.db.tables)
  const again = await backfillLiveReviews(f.deps, { companyId: 'company-1' })
  assert.deepEqual([again.captured, again.linked, again.nextCursor], [0, 0, null])
  assert.deepEqual(f.db.tables, before, 'a second backfill writes nothing')
})

test('backfill pages by cursor and never overwrites a live row a sync already refreshed', async () => {
  const conflicts = [conflictRow(1), conflictRow(2, { source_id: '11' }), conflictRow(3, { source_id: '12' })]
  const f = backfillFixture(conflicts)
  // A live run already holds source 11 with fresher evidence.
  const live = await captureLiveReview(f.deps, { ...base, sourceId: '11', runId: 'run-9', reason: 'unique_exact_match',
    source: { id: '11', properties: { firstname: 'Grace', email: 'grace@new.example.com' } }, conflictId: 'conflict-live' })
  const page1 = await backfillLiveReviews(f.deps, { companyId: 'company-1', limit: 2 })
  assert.deepEqual([page1.captured, page1.linked], [1, 2])
  assert.deepEqual(page1.nextCursor, { createdAt: conflicts[1].created_at, id: conflicts[1].id })
  const page2 = await backfillLiveReviews(f.deps, { companyId: 'company-1', limit: 2, cursor: page1.nextCursor })
  assert.deepEqual([page2.captured, page2.linked, page2.nextCursor], [1, 1, null])
  assert.deepEqual(f.pages.map(([, limit, after]) => [limit, after?.id ?? null]), [[2, null], [2, conflicts[1].id]])
  const grace = f.db.tables.h2a_dry_run_reviews.find(row => row.id === live.reviewId)
  assert.equal(grace.reason, 'unique_exact_match')
  assert.equal(grace.source_snapshot.email, 'grace@new.example.com')
  assert.deepEqual(f.db.tables.h2a_live_review_conflicts.filter(link => link.review_id === live.reviewId).map(link => link.conflict_id),
    ['conflict-live', conflicts[1].id])
})

test('backfill skips conflicts it cannot classify or that lack a run, and bounds its page', async () => {
  const f = backfillFixture([conflictRow(1, { reason: 'not_a_review_reason' }), conflictRow(2, { run_id: null, source_id: '11' })])
  const result = await backfillLiveReviews(f.deps, { companyId: 'company-1', limit: 500 })
  assert.deepEqual([result.captured, result.linked, result.skipped], [0, 0, 2])
  assert.equal(f.pages[0][1], 100)
  assert.equal(f.db.tables.h2a_dry_run_reviews.length, 0)
  await assert.rejects(() => backfillLiveReviews(f.deps, { companyId: 'company-1', cursor: { createdAt: 'x', id: 'y', extra: 1 } }), TypeError)
})
