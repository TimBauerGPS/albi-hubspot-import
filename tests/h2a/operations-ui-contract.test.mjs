import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildConflictResolution,
  candidateComparisonCopy,
  conflictEvidenceSummary,
  mergeOverviewRefresh,
  overviewPollingPauseNotice,
  presentRunTotals,
  proposedFieldComparisons,
  proposedConflictFields,
} from '../../src/features/hubspotToAlbi/operations.js'

const root = new URL('../../src/features/hubspotToAlbi/', import.meta.url)
const source = name => readFile(new URL(name, root), 'utf8')

test('overview totals use fixed dry-run and live vocabularies and reject unsafe values', () => {
  assert.deepEqual(presentRunTotals({ mode: 'live', totals: {
    created: 2, delivered: 3, failed: 0, raw_error: 8, updated: -1, linked: 1.5,
  }}), [
    { key: 'created', label: 'Created', value: 2 },
    { key: 'delivered', label: 'Activities delivered', value: 3 },
  ])
  assert.deepEqual(presentRunTotals({ mode: 'dry_run', totals: {
    would_create_contacts: 4, would_deliver_activities: 7, provider_payload: 99,
  }}), [
    { key: 'would_create_contacts', label: 'Would create contacts', value: 4 },
    { key: 'would_deliver_activities', label: 'Would deliver activities', value: 7 },
  ])
})

test('resolution builder emits exact contracts from displayed proposed fields only', () => {
  const conflict = {
    id: 'conflict-1', updated_at: '2026-10-05T12:00:00.000Z',
    proposed_changes: { updates: { city: 'Oakland' }, conflicts: { phone: { hubspot: '1', albi: '2' } }, apiKey: 'hidden' },
  }
  assert.deepEqual(proposedConflictFields(conflict), ['city', 'phone'])
  assert.deepEqual(buildConflictResolution(conflict, 'link_existing', { targetId: 'albi-7' }), {
    conflictId: 'conflict-1', expectedUpdatedAt: conflict.updated_at, action: 'link_existing', targetId: 'albi-7',
  })
  assert.deepEqual(buildConflictResolution(conflict, 'approve_fields', { fields: ['phone'] }), {
    conflictId: 'conflict-1', expectedUpdatedAt: conflict.updated_at, action: 'approve_fields', fields: ['phone'],
  })
  assert.throws(() => buildConflictResolution(conflict, 'approve_fields', { fields: ['apiKey'] }), /displayed field/i)
})

test('active overview refresh merges current rows without discarding appended keyset history', () => {
  const current = {
    summary: { unresolvedConflictCount: 2 },
    runs: [{ id: 'new', status: 'running' }, { id: 'older', status: 'completed' }],
    nextCursor: 'older-page',
  }
  const refreshed = {
    summary: { unresolvedConflictCount: 3 },
    runs: [{ id: 'new', status: 'completed' }, { id: 'fresh', status: 'running' }],
    nextCursor: 'fresh-page',
  }
  assert.deepEqual(mergeOverviewRefresh(current, refreshed), {
    summary: { unresolvedConflictCount: 3 },
    runs: [{ id: 'new', status: 'completed' }, { id: 'fresh', status: 'running' }, { id: 'older', status: 'completed' }],
    nextCursor: 'older-page',
  })
})

test('overview polling pause notices distinguish bounded completion from request failure', () => {
  assert.deepEqual(overviewPollingPauseNotice('limit'), {
    kind: 'info',
    message: 'The one-minute automatic refresh window ended. Use Refresh to check this run now.',
  })
  assert.deepEqual(overviewPollingPauseNotice('request_failed'), {
    kind: 'error',
    message: 'The latest automatic status request failed. Use Refresh to retry now.',
  })
  assert.equal(overviewPollingPauseNotice(null), null)
})

test('candidate comparison copy is action-aware for admins and compare-only for members', () => {
  assert.deepEqual(candidateComparisonCopy(true), {
    label: 'Compare and link Albi candidate',
    prompt: 'Select a candidate to compare and link',
    description: 'HubSpot is the recommended source, but different nonblank Albi values require your decision.',
  })
  assert.deepEqual(candidateComparisonCopy(false), {
    label: 'Compare Albi candidate',
    prompt: 'Select a candidate to compare',
    description: 'HubSpot is the recommended source. Different nonblank Albi values are shown for admin review.',
  })
})

test('proposed field rows keep HubSpot and Albi values adjacent to selectable fields', () => {
  const conflict = {
    source_snapshot: { city: 'Oakland', phone: '555-111-2222' },
    candidate_snapshots: [{ id: 'a1', city: 'Berkeley', phone: '555-333-4444' }],
    proposed_changes: {
      updates: { city: 'Oakland' },
      conflicts: { phone: { hubspot: '555-111-2222', albi: '555-333-4444' } },
    },
    match_evidence: { email: 'ada@example.com' },
  }
  assert.deepEqual(proposedFieldComparisons(conflict, conflict.candidate_snapshots[0]), [
    { field: 'city', hubspot: 'Oakland', albi: 'Berkeley' },
    { field: 'phone', hubspot: '555-111-2222', albi: '555-333-4444' },
  ])
  assert.equal(conflictEvidenceSummary(conflict), 'Email: ada@example.com')
})

test('real Overview and Conflicts pages replace placeholders through the protected layout', async () => {
  const [app, overview, conflicts] = await Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    source('OverviewPage.jsx'),
    source('ConflictsPage.jsx'),
  ])
  assert.match(app, /import OverviewPage/)
  assert.match(app, /import ConflictsPage/)
  assert.match(app, /<Route\s+index\s+element=\{<OverviewPage\s*\/>\}/)
  assert.match(app, /path=["']conflicts["'][\s\S]*element=\{<ConflictsPage\s*\/>\}/)
  assert.doesNotMatch(app, /HubSpotToAlbiPlaceholder title=["'](?:Overview|Conflicts)/)
  for (const page of [overview, conflicts]) {
    assert.match(page, /useOutletContext/)
    assert.match(page, /AbortController/)
    assert.match(page, /completeTenantTransition/)
    assert.match(page, /role="alert"/)
    assert.match(page, /aria-live="polite"/)
  }
})

test('overview covers loading, empty, metrics, active status, run-now, and keyset history', async () => {
  const page = await source('OverviewPage.jsx')
  for (const phrase of ['Loading sync overview', 'No sync runs yet', 'Run now', 'Load more', 'Last successful sync', 'Open conflicts']) {
    assert.match(page, new RegExp(phrase, 'i'))
  }
  assert.match(page, /getH2AOverview/)
  assert.match(page, /runH2ASync\([^)]*['"]live['"]/s)
  assert.match(page, /nextCursor/)
  assert.match(page, /MAX_ACTIVE_POLLS/)
  assert.match(page, />Refresh</)
  assert.match(page, /Last updated/)
  assert.match(page, /Polling paused/)
  assert.match(page, /pollingPauseReason/)
  assert.match(page, /overviewPollingPauseNotice/)
  assert.match(page, /mergeOverviewRefresh/)
  assert.match(page, /isAdmin/)
  assert.match(page, /admin-only/i)
  assert.match(page, /presentRunTotals/)
  assert.match(page, /mutationControllers/)
  assert.match(page, /controller\.abort\(\)/)
  assert.match(page, /Sample dry run/)
  assert.match(page, /sampleLimitPerType/)
})

test('conflict queue exposes count, focused refresh, pagination, and member read-only mode', async () => {
  const page = await source('ConflictsPage.jsx')
  assert.match(page, /getH2AConflicts/)
  assert.match(page, /getH2AConflict/)
  assert.match(page, /getH2AOverview/)
  assert.match(page, /unresolvedConflictCount/)
  assert.match(page, /Load more/)
  assert.match(page, /read-only/i)
  assert.match(page, /replaceConflict/)
  assert.match(page, /cause\?\.status === 409/)
  assert.match(page, /many-to-one/i)
  assert.match(page, /noticeKind/)
  assert.match(page, /staleRefreshRequired/)
  assert.match(page, /Refresh selected item/)
  assert.match(page, /could not be refreshed/i)
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/)
})

test('conflict detail is evidence-first, responsive, semantic, and supports all five actions', async () => {
  const detail = await source('ConflictDetail.jsx')
  for (const action of ['link_existing', 'create_new', 'approve_fields', 'retain_albi', 'skip_item']) {
    assert.match(detail, new RegExp(`['"]${action}['"]`))
  }
  for (const phrase of ['Why this needs review', 'Match evidence', 'HubSpot recommendation', 'Proposed changes', 'Audit trail', 'HubSpot source', 'Albi candidate']) {
    assert.match(detail, new RegExp(phrase, 'i'))
  }
  assert.match(detail, /<fieldset/)
  assert.match(detail, /<legend/)
  assert.match(detail, /<dl/)
  assert.match(detail, /lg:grid-cols-2/)
  assert.match(detail, /role="dialog"/)
  assert.match(detail, /Confirm resolution/)
  assert.match(detail, /approveManyToOne/)
  assert.match(detail, /expectedUpdatedAt/)
  assert.match(detail, /Escape/)
  assert.match(detail, /previousFocus/)
  assert.match(detail, /event\.key === 'Tab'/)
  assert.match(detail, /proposedFieldComparisons/)
  assert.match(detail, /candidateComparisonCopy/)
  assert.match(detail, /Reviewed target/)
  assert.match(detail, /\[overflow-wrap:anywhere\]/)
  assert.match(detail, /aria-busy=/)
  assert.match(detail, /submitLock/)
  assert.match(detail, /max-h-\[calc\(100vh-2rem\)\]/)
  assert.doesNotMatch(detail, /candidateIndex/)
  assert.doesNotMatch(detail, /dangerouslySetInnerHTML|innerHTML/)
})
