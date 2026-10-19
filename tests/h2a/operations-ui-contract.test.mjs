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
import { presentReviewBreakdown } from '../../src/features/hubspotToAlbi/reviewBreakdown.js'
import { mountWorkflowPage, renderWorkflowPage } from './ui-render-fixture.mjs'

const root = new URL('../../src/features/hubspotToAlbi/', import.meta.url)
const source = name => readFile(new URL(name, root), 'utf8')

test('Overview reason rows open the queue filtered to that contact reason', async () => {
  const run = { id: 'sample-filter', mode: 'dry_run', status: 'completed', sampleLimitPerType: 10, reviewCaptureVersion: 1,
    totals: { requires_review: 1 }, reviewBreakdown: [{ kind: 'record', objectType: 'contacts', reason: 'auth:network', count: 1 }] }
  const html = await renderWorkflowPage('OverviewPage', { summary: { completedSampleRun: run }, runs: [run] }, overviewBindings)
  assert.match(html, /href="\/hubspot-to-albi\/sample-review\?objectType=contacts&amp;reason=auth%3Anetwork"/)
})

test('Overview organization reason links use companies and unknown object types stay plain text', async () => {
  const run = { id: 'sample-organizations', mode: 'dry_run', status: 'completed', sampleLimitPerType: 10, reviewCaptureVersion: 1,
    totals: { requires_review: 3 }, reviewBreakdown: [
      { kind: 'record', objectType: 'organizations', reason: 'missing_target', count: 1 },
      { kind: 'record', objectType: 'companies', reason: 'missing_hubspot_company', count: 1 },
      { kind: 'record', objectType: 'unknown', reason: 'missing_required_name', count: 1 },
    ] }
  const html = await renderWorkflowPage('OverviewPage', { summary: { completedSampleRun: run }, runs: [run] }, overviewBindings)
  assert.match(html, /href="\/hubspot-to-albi\/sample-review\?objectType=companies&amp;reason=missing_target"/)
  assert.match(html, /href="\/hubspot-to-albi\/sample-review\?objectType=companies&amp;reason=missing_hubspot_company"/)
  assert.doesNotMatch(html, /href="[^\"]*reason=missing_required_name"/)
  const member = await renderWorkflowPage('OverviewPage', { summary: { completedSampleRun: run }, runs: [run] }, overviewBindings, { isAdmin: false })
  assert.doesNotMatch(member, /href="[^\"]*reason=/)
})

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

test('sample dry-run review breakdown separates underlying records, blocked activities, and simulation findings', () => {
  assert.deepEqual(presentReviewBreakdown({
    mode: 'dry_run',
    sampleLimitPerType: 10,
    totals: { requires_review: 16 },
    reviewBreakdown: [
      { kind: 'simulation', objectType: 'contacts', reason: 'planned_record_dependency', count: 4 },
      { kind: 'record', objectType: 'contacts', reason: 'name_only_candidate', count: 2 },
      { kind: 'record', objectType: 'contacts', reason: 'name_only_candidate', count: 1 },
      { kind: 'activity', objectType: 'emails', reason: 'organization_fields_require_review', count: 3 },
      { kind: 'activity', objectType: 'calls', reason: 'contact_fields_require_review', count: 2 },
      { kind: 'activity', objectType: 'communications', reason: 'association_contract_unverified', count: 2 },
      { kind: 'not-safe', objectType: 'provider_person_123', reason: 'secret_provider_message', count: 2 },
      { kind: 'activity', objectType: 'emails', reason: 'missing_target', count: 0 },
    ],
  }), {
    count: 16,
    groups: [
      {
        key: 'record',
        label: 'Underlying records to review',
        description: 'These contacts and organizations need a matching, data, or mapping decision.',
        total: 3,
        items: [
          { key: 'contacts:name_only_candidate', objectLabel: 'Contacts', reasonLabel: 'Match is based on name only', count: 3 },
        ],
      },
      {
        key: 'activity',
        label: 'Activities blocked by those records',
        description: 'These activities are blocked by a related record or another prerequisite that needs review.',
        total: 9,
        items: [
          { key: 'emails:organization_fields_require_review', objectLabel: 'Emails', reasonLabel: 'Related organization fields need review', count: 3 },
          { key: 'calls:contact_fields_require_review', objectLabel: 'Calls', reasonLabel: 'Related contact fields need review', count: 2 },
          { key: 'communications:association_contract_unverified', objectLabel: 'Communications', reasonLabel: 'Related contact-organization link needs review', count: 2 },
          { key: 'other:other_review_reason', objectLabel: 'Other records', reasonLabel: 'Other review reason', count: 2 },
        ],
      },
      {
        key: 'simulation',
        label: 'Expected in a dry run',
        description: 'These depend on a contact or organization that would be created first, so they are not necessarily real problems.',
        total: 4,
        items: [
          { key: 'contacts:planned_record_dependency', objectLabel: 'Contacts', reasonLabel: 'Depends on a record that would be created', count: 4 },
        ],
      },
    ],
  })
})

test('review breakdown stays hidden outside populated sample dry runs', () => {
  const breakdown = [{ kind: 'record', objectType: 'contacts', reason: 'missing_target', count: 1 }]
  assert.equal(presentReviewBreakdown({ mode: 'dry_run', totals: { requires_review: 1 }, reviewBreakdown: breakdown }), null)
  assert.equal(presentReviewBreakdown({ mode: 'live', sampleLimitPerType: 10, totals: { requires_review: 1 }, reviewBreakdown: breakdown }), null)
  assert.equal(presentReviewBreakdown({ mode: 'dry_run', sampleLimitPerType: 10, totals: { requires_review: 0 }, reviewBreakdown: breakdown }), null)
  assert.equal(presentReviewBreakdown({ mode: 'dry_run', sampleLimitPerType: 10, totals: { requires_review: 1 }, reviewBreakdown: [] }), null)
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
  assert.match(page, /Full dry run/)
  assert.match(page, /sampleLimitPerType/)
  assert.match(page, /<details/)
  assert.match(page, /<summary/)
  assert.match(page, /Why \{breakdown\.count\} need review/)
  assert.match(page, /\{group\.total\}/)
  assert.match(page, /presentReviewBreakdown/)
})

const overviewBindings = { presentRunTotals, presentReviewBreakdown, mergeOverviewRefresh, overviewPollingPauseNotice }
test('rendered Overview links only current completed review-capable samples and preserves historical breakdowns', async () => {
  for (const [version, status, link] of [[1, 'completed', true], [null, 'completed', false], [1, 'failed', false]]) {
    const run = { id: 'sample', mode: 'dry_run', status, sampleLimitPerType: 10, reviewCaptureVersion: version,
      totals: { requires_review: 3 }, reviewBreakdown: [{ kind: 'record', objectType: 'contacts', reason: 'name_only_candidate', count: 3 }] }
    const html = await renderWorkflowPage('OverviewPage', { summary: { completedSampleRun: status === 'completed' ? run : null }, runs: [run] }, overviewBindings)
    assert.equal(html.includes('href="/hubspot-to-albi/sample-review"'), link)
    assert.match(html, /Why 3 need review/)
    if (status === 'completed' && !version) assert.match(html, /Run a new sample to create detailed review data/)
  }
})

test('rendered Overview displays failed newer attempt and retains prior completed set even off the current page', async () => {
  const completed = { id: 'prior-completed', mode: 'dry_run', status: 'completed', sampleLimitPerType: 10, reviewCaptureVersion: 1 }
  const failed = { id: 'new-failed', mode: 'dry_run', status: 'failed', sampleLimitPerType: 10, reviewCaptureVersion: 1 }
  const data = { summary: { latestSampleRun: failed, completedSampleRun: completed }, runs: [failed] }
  const html = await renderWorkflowPage('OverviewPage', data, overviewBindings)
  assert.match(html, /Newer sample failed/)
  assert.match(html, /prior completed sample/i)
  assert.match(html, /href="\/hubspot-to-albi\/sample-review"/)
  assert.match(html, /Review underlying records/)
  const member = await renderWorkflowPage('OverviewPage', data, overviewBindings, { isAdmin: false })
  assert.doesNotMatch(member, /href="\/hubspot-to-albi\/sample-review"/)
})

test('superseded review-capable history rows cannot link to a different current review set', async () => {
  const prior = { id: 'prior', mode: 'dry_run', status: 'completed', sampleLimitPerType: 10, reviewCaptureVersion: 1 }
  const current = { ...prior, id: 'current' }
  const html = await renderWorkflowPage('OverviewPage', { summary: { completedSampleRun: current }, runs: [prior] }, overviewBindings)
  assert.doesNotMatch(html, /href="\/hubspot-to-albi\/sample-review"/)
})

const sampleRun = id => ({ id, mode: 'dry_run', status: 'completed', sampleLimitPerType: 10, reviewCaptureVersion: 1 })
const sampleOverview = (completed, runs = [completed], extra = {}) => ({
  summary: { completedSampleRun: completed, latestSampleRun: completed }, runs, nextCursor: 'history-page', ...extra,
})
const deferredOverview = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const reviewLinks = (ui, runId) => ui.nodes(ui.nodes().find(node => node.type === 'li' && node.props.key === runId))
  .filter(node => node.type === 'Link' && node.props.to === '/hubspot-to-albi/sample-review')

test('pagination updates current sample metadata and failure notice while deduplicating history', async () => {
  const sampleA = sampleRun('sample-A'), sampleB = sampleRun('sample-B')
  const older = { id: 'older-history', mode: 'live', status: 'completed' }
  const failed = { ...sampleRun('sample-C-failed'), status: 'failed' }
  const ui = await mountWorkflowPage('OverviewPage', { ...overviewBindings,
    getH2AOverview: async (_session, _company, options) => options.cursor
      ? sampleOverview(sampleB, [older, sampleA, sampleB], { summary: { completedSampleRun: sampleB, latestSampleRun: failed }, nextCursor: 'next-history' })
      : sampleOverview(sampleA, [sampleA, older]),
  })
  assert.equal(reviewLinks(ui, 'sample-A').length, 1)
  await ui.find('button', 'Load more').props.onClick(); await ui.flush()
  assert.equal(ui.state().summary.completedSampleRun.id, 'sample-B')
  assert.equal(ui.state().summary.latestSampleRun.id, 'sample-C-failed')
  assert.deepEqual([...ui.state().runs].map(run => run.id), ['sample-A', 'older-history', 'sample-B'])
  assert.equal(ui.state().nextCursor, 'next-history')
  assert.equal(reviewLinks(ui, 'sample-A').length, 0)
  assert.equal(reviewLinks(ui, 'sample-B').length, 1)
  assert.match(ui.text(), /Newer sample failed/)
  ui.unmount()
})

test('late pagination after a tenant switch updates neither history nor sample summary', async () => {
  const oldPage = deferredOverview(), sampleA = sampleRun('tenant-1-sample'), sampleB = sampleRun('obsolete-page'), sampleC = sampleRun('tenant-2-sample')
  const ui = await mountWorkflowPage('OverviewPage', { ...overviewBindings,
    getH2AOverview: async (_session, company, options) => company === 'company-2'
      ? sampleOverview(sampleC) : options.cursor ? oldPage.promise : sampleOverview(sampleA),
  })
  const pending = ui.find('button', 'Load more').props.onClick(); await ui.flush()
  const oldSignal = ui.requests.at(-1)[2].signal
  ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1; await ui.rerender()
  oldPage.resolve(sampleOverview(sampleB, [sampleB], { summary: { completedSampleRun: sampleB, latestSampleRun: { ...sampleB, status: 'failed' } } }))
  await pending; await ui.flush()
  assert.equal(oldSignal.aborted, true)
  assert.equal(ui.state().summary.completedSampleRun.id, 'tenant-2-sample')
  assert.deepEqual([...ui.state().runs].map(run => run.id), ['tenant-2-sample'])
  assert.doesNotMatch(ui.text(), /obsolete-page|Newer sample failed/)
  ui.unmount()
})

test('pagination aborted on unmount cannot publish its late history or sample summary', async () => {
  const page = deferredOverview(), sampleA = sampleRun('sample-A'), sampleB = sampleRun('late-sample-B')
  const ui = await mountWorkflowPage('OverviewPage', { ...overviewBindings,
    getH2AOverview: async (_session, _company, options) => options.cursor ? page.promise : sampleOverview(sampleA),
  })
  const pending = ui.find('button', 'Load more').props.onClick(); await ui.flush()
  const signal = ui.requests.at(-1)[2].signal
  ui.unmount(); page.resolve(sampleOverview(sampleB)); await pending; await ui.flush()
  assert.equal(signal.aborted, true)
  assert.equal(ui.state().summary.completedSampleRun.id, 'sample-A')
  assert.deepEqual([...ui.state().runs].map(run => run.id), ['sample-A'])
})

test('older pagination cannot overwrite the current sample observed by a newer refresh', async () => {
  const page = deferredOverview(), sampleA = sampleRun('sample-A'), sampleB = sampleRun('refreshed-sample-B')
  let first = true
  const ui = await mountWorkflowPage('OverviewPage', { ...overviewBindings,
    getH2AOverview: async (_session, _company, options) => {
      if (options.cursor) return page.promise
      const sample = first ? sampleA : sampleB; first = false; return sampleOverview(sample)
    },
  })
  const pending = ui.find('button', 'Load more').props.onClick(); await ui.flush()
  await ui.find('button', 'Refresh').props.onClick(); await ui.flush()
  page.resolve(sampleOverview(sampleA, [{ id: 'obsolete-history' }])); await pending; await ui.flush()
  assert.equal(ui.state().summary.completedSampleRun.id, 'refreshed-sample-B')
  assert.equal(ui.state().runs.some(run => run.id === 'obsolete-history'), false)
  assert.equal(reviewLinks(ui, 'sample-A').length, 0)
  ui.unmount()
})

test('older refresh cannot overwrite current sample metadata from newer pagination', async () => {
  const refresh = deferredOverview(), sampleA = sampleRun('sample-A'), sampleB = sampleRun('obsolete-refresh-B'), sampleC = sampleRun('page-sample-C')
  let first = true
  const ui = await mountWorkflowPage('OverviewPage', { ...overviewBindings,
    getH2AOverview: async (_session, _company, options) => {
      if (options.cursor) return sampleOverview(sampleC)
      if (!first) return refresh.promise
      first = false; return sampleOverview(sampleA)
    },
  })
  const pending = ui.find('button', 'Refresh').props.onClick(); await ui.flush()
  await ui.find('button', 'Load more').props.onClick(); await ui.flush()
  refresh.resolve(sampleOverview(sampleB)); await pending; await ui.flush()
  assert.equal(ui.state().summary.completedSampleRun.id, 'page-sample-C')
  assert.equal(ui.state().runs.some(run => run.id === 'obsolete-refresh-B'), false)
  assert.equal(reviewLinks(ui, 'sample-A').length, 0)
  ui.unmount()
})

test('conflict page runs the live review workspace, the prepare backfill and a read-only activity list', async () => {
  const page = await source('ConflictsPage.jsx')
  assert.match(page, /<ReviewWorkspace[\s\S]*kind="live"/)
  assert.match(page, /prepareH2ALiveReviews/)
  assert.match(page, /Prepare open conflicts for review/)
  assert.match(page, /nextCursor/)
  assert.match(page, /getH2AConflicts/)
  assert.match(page, /getH2AOverview/)
  assert.match(page, /unresolvedConflictCount/)
  assert.match(page, /Load more/)
  assert.match(page, /read-only/i)
  assert.doesNotMatch(page, /ConflictDetail|resolveH2AConflict/)
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
