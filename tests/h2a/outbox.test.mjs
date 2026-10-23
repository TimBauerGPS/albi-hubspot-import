import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeOutboxAction, runReviewOutbox, OUTBOX_PACE_MS } from '../../netlify/functions/_h2a/outbox.js'
import { H2AReviewError } from '../../netlify/functions/_h2a/reviewService.js'

const UUID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const item = (n, action = { kind: 'resolution', decision: { action: 'create_albi', referralSourceId: '5' } }) => ({
  id: UUID(n), company_id: 'c1', review_id: UUID(100 + n), review_kind: 'live', expected_updated_at: '2026-10-23T12:00:00.000Z',
  client_request_id: UUID(200 + n), action, requested_by: UUID(999), status: 'queued', attempts: 0, next_attempt_at: '2026-10-23T12:00:00.000Z' })

function fixture(items, outcomes = {}) {
  let clock = Date.parse('2026-10-23T12:00:00.000Z')
  const rows = items.map(row => ({ ...row })), finished = [], triage = [], slept = [], executed = []
  let workerOwner = null, released = 0
  const repository = {
    claimOutboxWorker: async (_c, owner) => { if (workerOwner && workerOwner !== owner) return false; workerOwner = owner; return true },
    releaseOutboxWorker: async (_c, owner) => { if (workerOwner === owner) workerOwner = null; released++ },
    claimOutboxItem: async () => {
      const due = rows.filter(row => row.status === 'queued' && Date.parse(row.next_attempt_at) <= clock)
        .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))[0]
      if (!due) return null
      due.status = 'sending'; due.attempts += 1
      return { ...due }
    },
    nextOutboxDue: async () => {
      const queued = rows.filter(row => row.status === 'queued').map(row => Date.parse(row.next_attempt_at)).sort((a, b) => a - b)
      return queued.length ? new Date(queued[0]).toISOString() : null
    },
    finishOutboxItem: async (_c, id, patch) => {
      const row = rows.find(candidate => candidate.id === id)
      Object.assign(row, { status: patch.status, ...(patch.nextAttemptAt ? { next_attempt_at: patch.nextAttemptAt } : {}),
        error_code: patch.errorCode ?? null, error_detail: patch.errorDetail ?? {} })
      finished.push({ id, ...patch })
      return true
    },
    getReview: async (_c, id) => ({ id, company_id: 'c1', object_type: 'contacts', status: 'needs_review', triage_bucket: 'outbox',
      source_snapshot: {}, candidate_snapshots: [] }),
    setReviewTriage: async (_c, id, next) => { triage.push([id, next]) },
    getCurrentReviewResolution: async () => ({ status: 'ready_to_recheck' }),
    listReviewResolutionEvents: async (_c, resolutionId) => outcomes.events?.[resolutionId] ?? [],
  }
  const deps = { repository, clockMs: () => clock, now: () => new Date(clock), sleep: async ms => { slept.push(ms); clock += ms },
    executeResolution: async (_deps, input) => {
      executed.push(input.reviewId)
      const next = outcomes[input.reviewId]?.shift?.() ?? { resolution: { id: 'r-ok', status: 'ready_to_recheck' } }
      if (next instanceof Error) throw next
      return next
    },
    dispatchContinuation: async payload => { deps.continued = payload } }
  return { rows, finished, triage, slept, executed, deps, release: () => released, setWorker: owner => { workerOwner = owner } }
}

test('outbox actions are validated: a resolution decision, or a create with its organization', () => {
  assert.deepEqual(normalizeOutboxAction({ kind: 'resolution', decision: { action: 'link_existing', candidateId: '20', approveManyToOne: false } }),
    { kind: 'resolution', decision: { action: 'link_existing', candidateId: '20', approveManyToOne: false } })
  assert.deepEqual(normalizeOutboxAction({ kind: 'create_with_organization', referralSourceId: '5' }), { kind: 'create_with_organization', referralSourceId: '5' })
  for (const bad of [null, { kind: 'resolution', decision: { action: 'drop_tables' } }, { kind: 'other' }, { kind: 'create_with_organization' },
    { kind: 'create_with_organization', referralSourceId: '5', organizationReviewId: 'nope' }]) assert.throws(() => normalizeOutboxAction(bad), TypeError)
})

test('the worker sends queued actions one at a time at a steady pace and moves each record out of the Outbox tab', async () => {
  const f = fixture([item(1), item(2)])
  const result = await runReviewOutbox(f.deps, { companyId: 'c1' })
  assert.equal(result.status, 'idle')
  assert.deepEqual(f.executed, [UUID(101), UUID(102)])
  assert.deepEqual(f.rows.map(row => row.status), ['sent', 'sent'])
  assert.ok(f.slept.filter(ms => ms === OUTBOX_PACE_MS).length >= 1)
  assert.deepEqual(f.triage.map(([id]) => id), [UUID(101), UUID(102)])
  assert.ok(f.triage.every(([, next]) => next.bucket !== 'outbox'))
  assert.equal(f.release(), 1)
})

test('when Albi is busy the action goes back in line and the worker pauses, longer each time, before trying again', async () => {
  const busy = { resolution: { id: 'r-busy', status: 'failed' } }
  const f = fixture([item(1)], { [UUID(101)]: [busy, busy], events: { 'r-busy': [{ event_type: 'failed', sanitized_details: { category: 'rate_limit', code: 'operation_failed', providerStatus: 429 } }] } })
  await runReviewOutbox(f.deps, { companyId: 'c1' })
  assert.deepEqual(f.finished.map(row => row.status), ['queued', 'queued', 'sent'])
  assert.deepEqual(f.finished.slice(0, 2).map(row => row.errorCode), ['albi_busy', 'albi_busy'])
  assert.ok(f.slept.includes(30000) && f.slept.includes(60000))
  assert.equal(f.rows[0].status, 'sent')
})

test('an action Albi keeps refusing as busy fails after repeated tries and stays in the Outbox with the reason', async () => {
  const busy = { resolution: { id: 'r-busy', status: 'failed' } }
  const f = fixture([item(1)], { [UUID(101)]: Array.from({ length: 12 }, () => busy),
    events: { 'r-busy': [{ event_type: 'failed', sanitized_details: { category: 'rate_limit' } }] } })
  f.deps.maxBusyAttempts = 3
  await runReviewOutbox(f.deps, { companyId: 'c1' })
  assert.equal(f.rows[0].status, 'failed'); assert.equal(f.rows[0].error_code, 'albi_busy')
  assert.deepEqual(f.triage.at(-1), [UUID(101), { bucket: 'outbox', details: { outbox: 'failed' } }])
})

test('other failures stay in the Outbox with a named reason', async () => {
  const f = fixture([item(1), item(2), item(3)], {
    [UUID(101)]: [new H2AReviewError(409, 'This record changed. Refresh and confirm the resolution again.')],
    [UUID(102)]: [{ resolution: { id: 'r-match', status: 'failed' } }],
    [UUID(103)]: [new Error('boom')],
    events: { 'r-match': [{ event_type: 'failed', sanitized_details: { category: 'error', staleCheck: 'candidates' } }] } })
  await runReviewOutbox(f.deps, { companyId: 'c1' })
  assert.deepEqual(f.rows.map(row => [row.status, row.error_code]), [['failed', 'changed'], ['failed', 'possible_match'], ['failed', 'error']])
})

test('only one worker sends for a company at a time', async () => {
  const f = fixture([item(1)])
  f.setWorker('someone-else')
  assert.equal((await runReviewOutbox(f.deps, { companyId: 'c1' })).status, 'busy')
  assert.deepEqual(f.executed, [])
})

test('a worker near its time limit hands the rest to a continuation', async () => {
  const f = fixture([item(1), { ...item(2), next_attempt_at: '2026-10-23T12:20:00.000Z' }])
  const result = await runReviewOutbox(f.deps, { companyId: 'c1' })
  assert.equal(result.status, 'continued')
  assert.deepEqual(f.deps.continued, { companyId: 'c1' })
  assert.deepEqual(f.executed, [UUID(101)])
})

test('a create queued with its default referral source uses the record’s default, then the fallback, or fails with the reason', async () => {
  const rows = [item(1, { kind: 'create_default_referral' }), item(2, { kind: 'create_default_referral', fallbackReferralSourceId: '5' }),
    item(3, { kind: 'create_default_referral' }), item(4, { kind: 'create_default_referral' })]
  const f = fixture(rows)
  const decisions = []
  const readiness = { [UUID(101)]: { ready: true, defaultReferralSourceId: '7' }, [UUID(102)]: { ready: true }, [UUID(103)]: { ready: true },
    [UUID(104)]: { ready: false, blockedReason: 'organization_not_synced' } }
  f.deps.loadCreateDefault = async row => readiness[row.review_id]
  f.deps.executeResolution = async (_deps, input) => { decisions.push([input.reviewId, input.decision]); return { resolution: { id: 'r', status: 'ready_to_recheck' } } }
  await runReviewOutbox(f.deps, { companyId: 'c1' })
  assert.deepEqual(decisions, [[UUID(101), { action: 'create_albi', referralSourceId: '7' }], [UUID(102), { action: 'create_albi', referralSourceId: '5' }]])
  assert.deepEqual(f.finished.filter(row => row.status === 'failed').map(row => [row.id, row.errorCode]),
    [[UUID(3), 'no_default_referral'], [UUID(4), 'organization_not_synced']])
  assert.deepEqual(normalizeOutboxAction({ kind: 'create_default_referral', fallbackReferralSourceId: '5' }), { kind: 'create_default_referral', fallbackReferralSourceId: '5' })
  assert.throws(() => normalizeOutboxAction({ kind: 'create_default_referral', fallbackReferralSourceId: 'x' }), TypeError)
})

test('queued creates share one Albi read per run instead of each reading Albi', async () => {
  const rows = [item(1), item(2), item(3, { kind: 'resolution', decision: { action: 'link_existing', candidateId: '20', approveManyToOne: false } })]
  const f = fixture(rows)
  const reads = [], snapshots = []
  f.deps.readAlbiList = async kind => { reads.push(kind); return [{ id: '900' }] }
  f.deps.executeResolution = async (deps, input) => {
    snapshots.push(deps.albiSnapshot ? deps.albiSnapshot.contacts.length : null)
    // A create adds the new record to the shared read, as the resolution does.
    if (deps.albiSnapshot) deps.albiSnapshot.contacts.push({ id: `new-${input.reviewId}` })
    return { resolution: { id: 'r', status: 'ready_to_recheck' } }
  }
  await runReviewOutbox(f.deps, { companyId: 'c1' })
  assert.deepEqual(reads, ['contacts'])
  // The second create sees the first; the link reads Albi itself.
  assert.deepEqual(snapshots, [1, 2, null])
})
