import test from 'node:test'
import assert from 'node:assert/strict'
import { createH2ARepository } from '../../netlify/functions/_h2a/repository.js'
import { captureLiveReview } from '../../netlify/functions/_h2a/liveReview.js'

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
  assert.deepEqual(second, { reviewId: first.reviewId, inserted: false, closed: true })
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
  assert.deepEqual(result, { reviewId: '00000000-0000-4000-8000-0000000000aa', inserted: false })
  assert.equal(db.tables.h2a_dry_run_reviews.length, 1)
  assert.deepEqual(db.tables.h2a_live_review_conflicts.map(link => link.review_id), ['00000000-0000-4000-8000-0000000000aa'])
})

test('capture requires a persisted conflict id and a valid classification', async () => {
  const { deps } = fixture()
  await assert.rejects(() => captureLiveReview(deps, { ...base, conflictId: undefined }), /conflict/i)
  await assert.rejects(() => captureLiveReview(deps, { ...base, conflictType: 'RAW', conflictId: 'conflict-a' }), /classification/)
})
