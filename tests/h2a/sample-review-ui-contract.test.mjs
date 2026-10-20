import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import * as workspaceHelpers from '../../src/features/hubspotToAlbi/reviewWorkspace.js'
import { buildResolutionConfirmation } from '../../src/features/hubspotToAlbi/sampleReviewResolution.js'
import { blockedReasonCopy } from '../../shared/h2aBlockedReasons.js'
import { loadComponent, mountComponent, nodesOf, stub, textOf } from './workspace-harness.mjs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as presentation from '../../src/features/hubspotToAlbi/sampleReview.js'
import { presentSampleReviewQueryFilters } from '../../src/features/hubspotToAlbi/preflightPresentation.js'

const pageUrl = new URL('../../src/features/hubspotToAlbi/SampleReviewPage.jsx', import.meta.url)
const row = (id = 'review-1') => ({ id, runId: 'sample-1', objectType: 'contacts', sourceId: 'hs-1',
  displayName: 'Alex Example', identity: { email: 'alex@example.com', phone: '+15551234567', organizationName: 'Example Co', domain: null },
  reason: 'name_only_candidate', status: 'needs_review', updatedAt: '2026-10-12T12:00:00.000Z', lastRecheckedAt: null })
const full = (id = 'review-1') => ({ ...row(id), sourceSnapshot: { id: 'hs-1', fullName: 'Alex Example', email: 'alex@example.com', phoneNumber: '+15551234567' },
  candidateSnapshots: [{ id: 'albi-1', fullName: 'Alex Example', email: 'another@example.com' }], matchEvidence: ['name'], proposedChanges: {}, events: [] })
const progress = { total: 2, needsReview: 2, cleared: 0, noLongerInScope: 0, fullDryRunReady: false }
const page = (items = [row()], extra = {}) => ({ items, nextCursor: null, sample: { id: 'sample-1', reviewCaptureVersion: 1, historical: false }, progress, ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const workspaceUrl = new URL('../../src/features/hubspotToAlbi/ReviewWorkspace.jsx', import.meta.url)

const loadQueue = () => loadComponent('ReviewQueue.jsx')
const metaOf = ui => ui.metas.at(-1) ?? null

// Exercise the real workspace JSX and request handlers. Only React's scheduling, child components and the HTTP boundary are substituted.
async function mount(overrides = {}) {
  const calls = [], completed = [], metas = []
  const bound = Object.fromEntries(['getH2AReviews', 'getH2ADryRunReview', 'recheckH2ADryRunReview', 'resolveH2ADryRunReview', 'prepareH2AOrganizationReview', 'prepareH2AMergedSurvivorReview',
    'getH2ARecheckAll', 'startH2ARecheckAll', 'bulkLinkH2AReviews', 'createH2AOrganizationThenContact', 'skipH2ALiveReview'].map(name => [name, (...args) => {
    calls.push({ name, args })
    const override = overrides[name]
    if (override) return override(...args)
    return Promise.resolve(name === 'getH2AReviews' ? page() : name === 'getH2ARecheckAll' ? { batch: null }
      : name === 'startH2ARecheckAll' ? { status: 'queued', batch: { id: 'batch-1', status: 'queued', total: 0, done: 0 } } : { item: full(args[2]) })
  }]))
  const render = label => meta => { metas.push(meta); return { type: 'section', props: { 'data-slot': label }, children: [`${label}:${JSON.stringify(meta?.progress ?? null)}`] } }
  const props = { kind: 'sample', session: { access_token: 'token' }, companyId: 'company-1', tenantRevision: 0, isAdmin: true,
    completeTenantTransition: revision => completed.push(revision), initialFilters: overrides.initialFilters,
    renderHeader: render('header'), renderGate: overrides.renderGate ?? (() => null), ...overrides.props }
  const ui = await mountComponent('ReviewWorkspace.jsx', { props, bindings: { ...bound, ...workspaceHelpers, ...presentation, buildResolutionConfirmation, blockedReasonCopy,
    ReviewRecord: stub('ReviewRecord'), ReviewQueue: stub('ReviewQueue'), AlbiTodo: stub('AlbiTodo'), ShortcutHelp: stub('ShortcutHelp') } })
  const context = { get companyId() { return props.companyId }, set companyId(value) { props.companyId = value },
    get tenantRevision() { return props.tenantRevision }, set tenantRevision(value) { props.tenantRevision = value } }
  return { ...ui, calls, completed, metas, context, rerender: () => ui.rerender({ ...props }),
    detail: () => ui.find('ReviewRecord'), queue: () => ui.find('ReviewQueue'),
    loadMore: () => ui.find('ReviewQueue').props.onLoadMore(), select: id => ui.find('ReviewQueue').props.onSelect(id) }
}

// The page itself with the workspace as a double: its header, fresh-sample gate and Recheck-all section.
async function mountPage(overrides = {}) {
  const calls = [], navigations = []
  const bound = Object.fromEntries(['getH2ARecheckAll', 'startH2ARecheckAll'].map(name => [name, (...args) => {
    calls.push({ name, args })
    if (overrides[name]) return overrides[name](...args)
    return Promise.resolve(name === 'getH2ARecheckAll' ? { batch: null } : { status: 'queued', batch: { id: 'batch-1', status: 'queued', total: 0, done: 0 } })
  }]))
  const ui = await mountComponent('SampleReviewPage.jsx', { bindings: { ...bound, ...presentation, presentSampleReviewQueryFilters,
    ReviewWorkspace: stub('ReviewWorkspace'), Link: stub('Link'),
    useLocation: () => ({ pathname: '/hubspot-to-albi/sample-review', search: overrides.locationSearch ?? '' }), useNavigate: () => (path, options) => navigations.push({ path, options }) },
  context: { session: { access_token: 'token' }, companyId: 'company-1', companyName: 'Example Co', isAdmin: true, tenantRevision: 0, completeTenantTransition() {} } })
  const workspace = () => ui.find('ReviewWorkspace')
  const slot = (name, meta) => workspace().props[name]?.(meta) ?? null
  return { ...ui, calls, navigations, workspace, slot }
}
const meta = (extra = {}) => ({ sample: { id: 'sample-1', reviewCaptureVersion: 1, historical: false }, progress, loading: false, busy: false, ...extra })

test('selectable reasons cannot send the presentation fallback rejected by the API', () => {
  assert.equal(presentation.SAMPLE_REVIEW_REASON_OPTIONS.some(option => option.value === 'other_review_reason'), false)
  assert.equal(presentation.presentSampleReviewItem({ reason: 'unknown-secret' }).reasonLabel, 'Other review reason')
})

test('queue shows applying, waiting and failed resolution badges without internal details', async () => {
  const items = [{ ...row('a'), resolutionStatus: 'applying' }, { ...row('b'), resolutionStatus: 'waiting_on_albi' }, { ...row('c'), resolutionStatus: 'failed', leaseOwner: 'secret' }]
  const html = renderToStaticMarkup(createElement(await loadQueue(), { items, bucket: 'decision', selectedId: 'a', pendingIds: new Set(), errors: {}, checked: new Set() }))
  assert.equal((html.match(/<li/g) ?? []).length, 3)
  assert.match(html, /Applying/); assert.match(html, /Waiting on Albi/); assert.match(html, /Action failed/)
  assert.match(html, /Alex Example/); assert.doesNotMatch(html, /secret/)
})

test('Overview reason query initializes only catalog filters and clears invalid parameters', async () => {
  const valid = await mountPage({ locationSearch: '?objectType=contacts&reason=nonblank_field_difference' })
  assert.equal(valid.workspace().props.initialFilters.objectType, 'contacts')
  assert.equal(valid.workspace().props.initialFilters.reason, 'nonblank_field_difference')
  valid.unmount()
  const invalid = await mountPage({ locationSearch: '?objectType=unsafe&reason=other_review_reason' })
  assert.equal(invalid.workspace().props.initialFilters.objectType, '')
  assert.equal(invalid.workspace().props.initialFilters.reason, '')
  assert.equal(invalid.navigations.at(-1).options.replace, true)
  invalid.unmount()
  const ui = await mount({ initialFilters: { status: '', objectType: 'contacts', reason: 'nonblank_field_difference' } })
  assert.equal(ui.calls[0].args[2].objectType, 'contacts'); assert.equal(ui.calls[0].args[2].reason, 'nonblank_field_difference')
  ui.unmount()
})

test('sample review uses centralized requests and accessible wrapping without provider mutation controls', async () => {
  const [source, workspace] = await Promise.all([readFile(pageUrl, 'utf8'), readFile(workspaceUrl, 'utf8')])
  assert.doesNotMatch(source + workspace, /\bfetch\s*\(|\bsupabase\b|dangerouslySetInnerHTML/)
  assert.doesNotMatch(source + workspace, new RegExp(['SampleReview' + 'Detail', 'SampleReview' + 'Resolution(?!\\.js)', 'Conflict' + 'Detail'].join('|')))
  for (const label of ['Status', 'Object type', 'Reason']) assert.match(workspace, new RegExp(`>${label}<`))
  assert.match(workspace, />Filters</)
  assert.match(source, /aria-live="polite"/); assert.match(workspace, /aria-live="polite"/)
  assert.match(source, /role="alert"/); assert.match(workspace, /role="alert"/)
  assert.match(source, /<ReviewWorkspace[\s\S]*kind="sample"/)
})

test('list summaries retain direct identity and detail loads separately with abortable requests', async () => {
  const ui = await mount()
  assert.equal(ui.queue().props.items[0].displayName, 'Alex Example')
  assert.equal(ui.detail().props.item.id, 'review-1')
  assert.deepEqual(ui.completed, [0])
  for (const call of ui.calls) assert.ok(call.args.at(-1).signal instanceof AbortSignal)
  ui.unmount()
})

test('filters reset pagination/selection and late load-more cannot mix a previous filter queue', async () => {
  const more = deferred(); let reads = 0
  const ui = await mount({ getH2AReviews: (_session, _company, filters) => {
    reads++; if (filters.cursor) return more.promise
    return Promise.resolve(reads === 1 ? page([row()], { nextCursor: 'next' }) : page([row('filtered')]))
  } })
  const loadingMore = ui.loadMore(); await ui.flush()
  ui.nodes().find(node => node.type === 'select' && node.props.id === 'sample-review-status').props.onChange({ target: { value: 'cleared' } }); await ui.flush()
  more.resolve(page([row('obsolete')])); await loadingMore; await ui.flush()
  assert.doesNotMatch(JSON.stringify(ui.queue().props.items), /obsolete/); assert.equal(ui.detail().props.item.id, 'filtered')
  const last = ui.calls.filter(call => call.name === 'getH2AReviews').at(-1)
  assert.equal(last.args[2].status, 'cleared'); assert.equal(last.args[2].cursor, undefined)
  ui.unmount()
})

test('load-more appends unique rows without disturbing the selected record', async () => {
  const ui = await mount({ getH2AReviews: (_s, _c, filters) => Promise.resolve(filters.cursor
    ? page([row(), row('review-2')]) : page([row()], { nextCursor: 'next' })) })
  await ui.loadMore(); await ui.flush()
  assert.equal(ui.queue().props.items.length, 2)
  assert.equal(ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].limit, 100)
  assert.equal(ui.detail().props.item.id, 'review-1'); ui.unmount()
})

test('pagination publishes refreshed progress with the same sample and preserves its selection', async () => {
  const refreshed = { ...progress, needsReview: 1, cleared: 1 }
  const ui = await mount({ getH2AReviews: (_s, _c, filters) => Promise.resolve(filters.cursor
    ? page([row('review-2')], { progress: refreshed, nextCursor: 'next-2' }) : page([row()], { nextCursor: 'next' })) })
  await ui.loadMore(); await ui.flush()
  assert.equal(metaOf(ui).progress.needsReview, 1)
  assert.equal(ui.detail().props.item.id, 'review-1')
  await ui.loadMore(); await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].cursor, 'next-2')
  ui.unmount()
})

test('sample replacement during pagination clears old evidence and refetches the new first page', async () => {
  const firstB = deferred(), oldDetail = deferred(); let firstPages = 0
  const sampleB = { id: 'sample-B', reviewCaptureVersion: 1, historical: false }
  const bRow = { ...row('review-B'), runId: 'sample-B', displayName: 'New Sample Person' }
  const ui = await mount({ getH2AReviews: (_s, _c, filters) => filters.cursor
    ? Promise.resolve(page([{ ...bRow, id: 'cursor-B' }], { sample: sampleB, nextCursor: 'cursor-B-next' }))
    : ++firstPages === 1 ? Promise.resolve(page([row('review-A'), row('review-A2')], { nextCursor: 'cursor-A' })) : firstB.promise,
    getH2ADryRunReview: (_s, _c, id) => id === 'review-A2' ? oldDetail.promise
      : Promise.resolve({ item: { ...full(id), runId: id === 'review-B' ? 'sample-B' : 'sample-1' } }) })
  ui.select('review-A2'); await ui.flush()
  const oldSignal = ui.calls.filter(call => call.name === 'getH2ADryRunReview' && call.args[2] === 'review-A2').at(-1).args[3].signal
  await ui.loadMore(); await ui.flush()
  assert.equal(ui.detail(), undefined)
  assert.doesNotMatch(ui.json(), /review-A|cursor-B|Alex Example/)
  assert.match(ui.text(), /Loading/)
  assert.equal(oldSignal.aborted, true)
  assert.equal(ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].cursor, undefined)
  firstB.resolve(page([bRow], { sample: sampleB, progress: { ...progress, total: 1, needsReview: 1 }, nextCursor: 'first-B-next' }))
  await ui.flush()
  oldDetail.resolve({ item: full('review-A2') }); await ui.flush()
  assert.equal(ui.detail().props.item.id, 'review-B')
  assert.equal(ui.detail().props.item.runId, 'sample-B')
  assert.doesNotMatch(ui.json(), /review-A|cursor-B/)
  ui.unmount()
})

for (const first of ['recheck', 'pagination']) {
  test(`recheck cancels prior same-sample pagination when ${first} completes first and preserves a retryable cursor`, async () => {
    const more = deferred(), rechecked = deferred(); let pages = 0
    const updatedProgress = { ...progress, needsReview: 0, cleared: 2 }
    const ui = await mount({ getH2AReviews: (_s, _c, filters) => !filters.cursor
      ? Promise.resolve(page([row()], { nextCursor: 'original-cursor' }))
      : ++pages === 1 ? more.promise : Promise.resolve(page([row('new-page')], { progress: updatedProgress })),
      recheckH2ADryRunReview: () => rechecked.promise })
    const pagination = ui.loadMore(); await ui.flush()
    const pageSignal = ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].signal
    const action = ui.detail().props.onRecheck(); await ui.flush()
    const recheckSignal = ui.calls.find(call => call.name === 'recheckH2ADryRunReview').args[3].signal
    const finishPage = async () => { more.resolve(page([row('stale-page')], { nextCursor: 'stale-cursor' })); await pagination; await ui.flush() }
    const finishRecheck = async () => { rechecked.resolve({ item: { ...full(), status: 'cleared' }, progress: updatedProgress }); await action; await ui.flush() }
    if (first === 'recheck') { await finishRecheck(); await finishPage() } else { await finishPage(); await finishRecheck() }
    assert.equal(ui.detail().props.item.status, 'cleared')
    assert.deepEqual(metaOf(ui).progress, updatedProgress)
    assert.doesNotMatch(JSON.stringify(ui.queue().props.items), /stale-page/)
    assert.equal(pageSignal.aborted, true); assert.equal(recheckSignal.aborted, false)
    assert.equal(ui.queue().props.loadMoreDisabled, false)
    await ui.loadMore(); await ui.flush()
    assert.equal(ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].cursor, 'original-cursor')
    assert.match(JSON.stringify(ui.queue().props.items), /new-page/)
    ui.unmount()
  })
}

test('a saved Load more handler cannot start pagination during recheck and the control recovers afterward', async () => {
  const rechecked = deferred()
  const ui = await mount({ getH2AReviews: () => Promise.resolve(page([row()], { nextCursor: 'next' })),
    recheckH2ADryRunReview: () => rechecked.promise })
  const loadMore = ui.queue().props.onLoadMore
  const action = ui.detail().props.onRecheck(); await ui.flush()
  await loadMore(); await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'getH2AReviews').length, 1)
  assert.equal(ui.queue().props.loadMoreDisabled, true)
  rechecked.resolve({ item: full(), progress }); await action; await ui.flush()
  assert.equal(ui.queue().props.loadMoreDisabled, false)
  ui.unmount()
})

for (const status of [502, 409]) {
  test(`recheck ${status} cancels stale pagination while retaining evidence, progress and the retryable cursor`, async () => {
    const more = deferred(); let pages = 0, detailReads = 0
    const ui = await mount({ getH2AReviews: (_s, _c, filters) => !filters.cursor
      ? Promise.resolve(page([row()], { nextCursor: 'original-cursor' }))
      : ++pages === 1 ? more.promise : Promise.resolve(page([row('retried-page')])),
      getH2ADryRunReview: () => Promise.resolve({ item: { ...full(), updatedAt: ++detailReads === 1
        ? '2026-10-12T12:00:00.000Z' : '2026-10-12T12:02:00.000Z' } }),
      recheckH2ADryRunReview: () => Promise.reject(Object.assign(new Error('Unable to recheck this sample review.'), { status })) })
    const pagination = ui.loadMore(); await ui.flush()
    const signal = ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].signal
    await ui.detail().props.onRecheck(); await ui.flush()
    more.resolve(page([row('stale-page')], { progress: { ...progress, needsReview: 999 }, nextCursor: 'stale-cursor' }))
    await pagination; await ui.flush()
    assert.equal(ui.detail().props.item.id, 'review-1')
    assert.deepEqual(metaOf(ui).progress, progress)
    assert.equal(signal.aborted, true)
    assert.match(ui.text(), status === 409 ? /changed/ : /Recheck failed/)
    assert.equal(ui.detail().props.item.updatedAt, status === 409 ? '2026-10-12T12:02:00.000Z' : '2026-10-12T12:00:00.000Z')
    assert.doesNotMatch(JSON.stringify(ui.queue().props.items), /stale-page/)
    assert.equal(ui.queue().props.loadMoreDisabled, false)
    await ui.loadMore(); await ui.flush()
    assert.equal(ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].cursor, 'original-cursor')
    assert.match(JSON.stringify(ui.queue().props.items), /retried-page/)
    ui.unmount()
  })
}

for (const transition of ['filter', 'tenant', 'unmount']) {
  test(`stale replacement pagination after ${transition} cannot reset the current queue or start another fetch`, async () => {
    const more = deferred(); let firstPages = 0
    const ui = await mount({ getH2AReviews: (_s, _c, filters) => filters.cursor ? more.promise
      : Promise.resolve(page([row(++firstPages === 1 ? 'review-A' : 'current-record')], { nextCursor: 'next' })) })
    const action = ui.loadMore(); await ui.flush()
    const signal = ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].signal
    if (transition === 'filter') {
      ui.nodes().find(node => node.type === 'select' && node.props.id === 'sample-review-status').props.onChange({ target: { value: 'cleared' } })
      await ui.flush()
    } else if (transition === 'tenant') {
      ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1; await ui.rerender()
    } else ui.unmount()
    const readsBefore = ui.calls.filter(call => call.name === 'getH2AReviews').length
    more.resolve(page([{ ...row('obsolete-B'), runId: 'sample-B' }], { sample: { id: 'sample-B', reviewCaptureVersion: 1 } }))
    await action; await ui.flush()
    assert.equal(signal.aborted, true)
    assert.equal(ui.calls.filter(call => call.name === 'getH2AReviews').length, readsBefore)
    assert.doesNotMatch(ui.json(), /obsolete-B/)
    if (transition !== 'unmount') { assert.equal(ui.detail().props.item.id, 'current-record'); ui.unmount() }
  })
}

test('a tenant switch while replacement first-page fetch is pending aborts and hides its late evidence', async () => {
  const replacement = deferred(); let companyOneReads = 0
  const ui = await mount({ getH2AReviews: (_s, company, filters) => company === 'company-2'
    ? Promise.resolve(page([row('tenant-two')])) : filters.cursor
      ? Promise.resolve(page([row('obsolete-B')], { sample: { id: 'sample-B', reviewCaptureVersion: 1 } }))
      : ++companyOneReads === 1 ? Promise.resolve(page([row('review-A')], { nextCursor: 'next' })) : replacement.promise })
  await ui.loadMore(); await ui.flush()
  assert.equal(companyOneReads, 2)
  const signal = ui.calls.filter(call => call.name === 'getH2AReviews').at(-1).args[2].signal
  ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1; await ui.rerender()
  replacement.resolve(page([row('obsolete-B')], { sample: { id: 'sample-B', reviewCaptureVersion: 1 } })); await ui.flush()
  assert.equal(signal.aborted, true); assert.equal(ui.detail().props.item.id, 'tenant-two')
  assert.doesNotMatch(ui.json(), /review-A|obsolete-B/)
  ui.unmount()
})

test('tenant transition aborts all prior requests and ignores late list results', async () => {
  const old = deferred()
  const ui = await mount({ getH2AReviews: (_s, company) => company === 'company-1' ? old.promise : Promise.resolve(page([row('new-tenant')])) })
  const signal = ui.calls[0].args[2].signal
  ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1
  await ui.rerender(); old.resolve(page([row('old-tenant')])); await ui.flush()
  assert.equal(signal.aborted, true); assert.doesNotMatch(ui.json(), /old-tenant/)
  assert.deepEqual(ui.completed, [1]); ui.unmount()
})

test('recheck submits current version, prevents duplicate submission and replaces progress and evidence', async () => {
  const pending = deferred()
  const ui = await mount({ recheckH2ADryRunReview: () => pending.promise })
  const action = ui.detail().props.onRecheck()
  ui.detail().props.onRecheck(); await ui.flush()
  const calls = ui.calls.filter(call => call.name === 'recheckH2ADryRunReview')
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args[2])), { reviewId: 'review-1', expectedUpdatedAt: '2026-10-12T12:00:00.000Z' })
  const cleared = { total: 2, needsReview: 0, cleared: 2, noLongerInScope: 0, fullDryRunReady: false }
  pending.resolve({ item: { ...full(), status: 'cleared', updatedAt: '2026-10-12T12:01:00.000Z' }, progress: cleared })
  await action; await ui.flush()
  assert.equal(ui.detail().props.item.status, 'cleared')
  assert.deepEqual(metaOf(ui).progress, cleared)
  assert.match(ui.text(), /Recheck complete/)
  ui.unmount()
})

test('failed recheck keeps the selected evidence while 409 reloads its current version', async () => {
  let stale = false, details = 0
  const ui = await mount({ getH2ADryRunReview: () => Promise.resolve({ item: { ...full(), updatedAt: ++details === 1 ? '2026-10-12T12:00:00.000Z' : '2026-10-12T12:02:00.000Z' } }),
    recheckH2ADryRunReview: () => Promise.reject(Object.assign(new Error('Unable to recheck this sample review.'), { status: stale ? 409 : 502 })) })
  await ui.detail().props.onRecheck(); await ui.flush()
  assert.equal(ui.detail().props.item.id, 'review-1'); assert.match(ui.text(), /Recheck failed/)
  stale = true; await ui.detail().props.onRecheck(); await ui.flush()
  assert.equal(ui.detail().props.item.updatedAt, '2026-10-12T12:02:00.000Z'); assert.match(ui.text(), /changed/)
  ui.unmount()
})

test('an invalid recheck response reloads detail and recognizes a server-completed recheck', async () => {
  let details = 0
  const ui = await mount({
    getH2ADryRunReview: (_s, _c, id) => Promise.resolve({ item: { ...full(id),
      updatedAt: ++details === 1 ? '2026-10-12T12:00:00.000Z' : '2026-10-12T12:02:00.000Z',
      lastRecheckedAt: details === 1 ? null : '2026-10-12T12:01:59.000Z' } }),
    recheckH2ADryRunReview: () => Promise.reject(Object.assign(new Error('HubSpot to Albi returned an invalid response.'), { status: 502 })),
  })
  await ui.detail().props.onRecheck(); await ui.flush()
  assert.equal(ui.detail().props.item.lastRecheckedAt, '2026-10-12T12:01:59.000Z')
  assert.match(ui.text(), /Recheck complete/)
  assert.doesNotMatch(ui.text(), /Recheck failed\. /)
  ui.unmount()
})

test('a recheck the gateway timed out keeps reloading until the server finishes it', async () => {
  let details = 0
  const ui = await mount({ props: { recheckReloadMs: 1 },
    getH2ADryRunReview: (_s, _c, id) => Promise.resolve({ item: { ...full(id),
      updatedAt: ++details <= 3 ? '2026-10-12T12:00:00.000Z' : '2026-10-12T12:02:00.000Z',
      lastRecheckedAt: details <= 3 ? null : '2026-10-12T12:01:59.000Z' } }),
    recheckH2ADryRunReview: () => Promise.reject(Object.assign(new Error('This took too long to answer, but it may still finish. Wait a moment, then reload the record.'),
      { status: 504, timedOut: true })),
  })
  const pending = ui.detail().props.onRecheck(); await ui.flush()
  assert.match(ui.text(), /still finishing/)
  assert.doesNotMatch(ui.text(), /Recheck failed\. |didn’t finish in time/)
  for (let i = 0; i < 6 && !/Recheck complete/.test(ui.text()); i++) await ui.tick()
  await pending
  assert.equal(ui.detail().props.item.lastRecheckedAt, '2026-10-12T12:01:59.000Z')
  assert.match(ui.text(), /Recheck complete/)
  ui.unmount()
})

test('sample page keeps fresh-sample messaging', async () => {
  const ui = await mountPage()
  assert.equal(ui.workspace().props.kind, 'sample')
  const gate = extra => textOf(ui.slot('renderGate', meta(extra)))
  assert.match(gate({ sample: { historical: true, reviewCaptureVersion: null } }), /Run a new sample to create detailed review data/)
  assert.match(gate({ sample: null }), /No completed sample is available/)
  assert.match(gate({ progress: { total: 0, needsReview: 0, cleared: 0, noLongerInScope: 0, fullDryRunReady: true } }), /No underlying records need correction/)
  assert.equal(ui.slot('renderGate', meta()), null)
  const before = textOf(ui.slot('renderBeforeQueue', meta({ progress: { ...progress, needsReview: 0, cleared: 2 } })))
  assert.match(before, /Corrections are clear for this sample\. Run a fresh sample to verify them; this sample does not unlock the full dry run\./)
  assert.doesNotMatch(textOf(ui.slot('renderBeforeQueue', meta())), /Corrections are clear/)
  const header = textOf(ui.slot('renderHeader', meta()))
  assert.match(header, /Sample review/); assert.match(header, /Needs review/)
  assert.match(textOf(ui.slot('renderFooter', meta())), /Original sample run totals remain unchanged/)
  ui.unmount()
})

test('late detail for another selection is aborted and cannot overwrite current evidence', async () => {
  const previous = deferred()
  const ui = await mount({ getH2AReviews: () => Promise.resolve(page([row(), row('review-2')])),
    getH2ADryRunReview: (_s, _c, id) => id === 'review-1' ? previous.promise : Promise.resolve({ item: full(id) }) })
  const signal = ui.calls.find(call => call.name === 'getH2ADryRunReview').args[3].signal
  ui.select('review-2'); await ui.flush()
  previous.resolve({ item: full() }); await ui.flush()
  assert.equal(signal.aborted, true); assert.equal(ui.detail().props.item.id, 'review-2'); ui.unmount()
})

test('the next record is prefetched so it opens without a wait', async () => {
  const ui = await mount({ getH2AReviews: () => Promise.resolve(page([row(), row('review-2')])) })
  assert.deepEqual(ui.calls.filter(call => call.name === 'getH2ADryRunReview').map(call => call.args[2]), ['review-1', 'review-2'])
  ui.select('review-2'); await ui.flush()
  assert.equal(ui.detail().props.item.id, 'review-2')
  assert.equal(ui.calls.filter(call => call.name === 'getH2ADryRunReview').length, 2)
  ui.unmount()
})

test('a tenant switch aborts recheck and ignores late progress and record changes', async () => {
  const pending = deferred()
  const ui = await mount({ recheckH2ADryRunReview: () => pending.promise,
    getH2AReviews: (_s, company) => Promise.resolve(page([row(company === 'company-1' ? 'review-1' : 'review-new')])) })
  const action = ui.detail().props.onRecheck(); await ui.flush()
  const signal = ui.calls.find(call => call.name === 'recheckH2ADryRunReview').args[3].signal
  ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1; await ui.rerender()
  pending.resolve({ item: { ...full(), status: 'cleared' }, progress: { ...progress, needsReview: 0, cleared: 2 } }); await action; await ui.flush()
  assert.equal(signal.aborted, true); assert.equal(ui.detail().props.item.id, 'review-new')
  assert.equal(metaOf(ui).progress.needsReview, 2); assert.deepEqual(ui.completed, [0, 1]); ui.unmount()
})

test('opening an unsynced organization prepares its own review once, selects it, and can return to the contact', async () => {
  const ui = await mount({ prepareH2AOrganizationReview: () => Promise.resolve({ organization: { sourceId: '777', reviewId: 'org-review', mapped: false } }) })
  await ui.detail().props.onOpenOrganization({ sourceId: '777', reviewId: null }); await ui.flush()
  const prepare = ui.calls.filter(call => call.name === 'prepareH2AOrganizationReview')
  assert.equal(prepare.length, 1)
  assert.deepEqual(prepare[0].args.slice(0, 3).map(value => typeof value === 'object' ? { ...value } : value),
    [{ access_token: 'token' }, 'company-1', { reviewId: 'review-1', expectedUpdatedAt: '2026-10-12T12:00:00.000Z' }])
  assert.equal(ui.detail().props.item.id, 'org-review')
  ui.find('button', 'Back to contact review').props.onClick(); await ui.flush()
  assert.equal(ui.detail().props.item.id, 'review-1')
  ui.unmount()
})

test('an organization that already has a review opens it without preparing another', async () => {
  const ui = await mount()
  await ui.detail().props.onOpenOrganization({ sourceId: '777', reviewId: 'known-review' }); await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'prepareH2AOrganizationReview').length, 0)
  assert.equal(ui.detail().props.item.id, 'known-review')
  ui.unmount()
})

test('a failed organization preparation reports the error and keeps the contact selected', async () => {
  const ui = await mount({ prepareH2AOrganizationReview: () => Promise.reject(Object.assign(new Error('This contact needs exactly one associated organization.'), { status: 409 })) })
  await ui.detail().props.onOpenOrganization({ sourceId: '777', reviewId: null }); await ui.flush()
  assert.match(ui.text(), /exactly one associated organization/)
  assert.equal(ui.detail().props.item.id, 'review-1')
  ui.unmount()
})

const batch = extra => ({ id: 'batch-1', status: 'running', total: 4, done: 1, cleared: 1, stillNeedsReview: 0,
  noLongerInScope: 0, stale: 0, failed: 0, errorCode: null, ...extra })

test('recheck all starts one batch, shows polled progress, and reloads the queue when it finishes', async () => {
  const statuses = [{ batch: null }, { batch: batch() }, { batch: batch({ done: 3, cleared: 2, stillNeedsReview: 1 }) },
    { batch: batch({ status: 'completed', done: 4, cleared: 3, stillNeedsReview: 1 }) }]
  const ui = await mountPage({ getH2ARecheckAll: () => Promise.resolve(statuses.shift() ?? { batch: batch({ status: 'completed', done: 4, cleared: 3, stillNeedsReview: 1 }) }) })
  const section = () => ui.slot('renderBeforeQueue', meta())
  const button = label => nodesOf(section()).find(node => node.type === 'button' && textOf(node).includes(label))
  assert.equal(button('Recheck all').props.disabled, false)
  button('Recheck all').props.onClick(); await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'startH2ARecheckAll').length, 1)
  assert.equal(ui.calls.find(call => call.name === 'startH2ARecheckAll').args[1], 'company-1')
  assert.equal(ui.calls.find(call => call.name === 'startH2ARecheckAll').args[2].kind, 'sample')
  assert.match(textOf(section()), /Rechecking 1 of 4 open records/)
  assert.equal(button('Rechecking').props.disabled, true)
  const reloadBefore = ui.workspace().props.reloadToken
  await ui.tick()
  assert.match(textOf(section()), /Rechecking 3 of 4 open records/)
  await ui.tick()
  assert.match(textOf(section()), /Recheck all finished: 3 cleared, 1 still need review, 0 no longer in scope\./)
  assert.equal(ui.workspace().props.reloadToken, reloadBefore + 1)
  assert.equal(ui.timers.size, 0)
  ui.unmount()
})

test('recheck all resumes showing an active batch on load and hides old finished batches', async () => {
  const active = await mountPage({ getH2ARecheckAll: () => Promise.resolve({ batch: batch() }) })
  assert.match(textOf(active.slot('renderBeforeQueue', meta())), /Rechecking 1 of 4 open records/)
  assert.equal(active.timers.size, 1)
  active.unmount()
  const old = await mountPage({ getH2ARecheckAll: () => Promise.resolve({ batch: batch({ status: 'completed', done: 4 }) }) })
  const section = old.slot('renderBeforeQueue', meta())
  assert.doesNotMatch(textOf(section), /Recheck all finished/)
  assert.equal(nodesOf(section).find(node => node.type === 'button' && textOf(node).includes('Recheck all')).props.disabled, false)
  old.unmount()
})

test('recheck all start failures are shown without starting polling', async () => {
  const ui = await mountPage({ startH2ARecheckAll: () => Promise.reject(new Error('Unable to start rechecking all reviews.')) })
  const button = () => nodesOf(ui.slot('renderBeforeQueue', meta())).find(node => node.type === 'button' && textOf(node).includes('Recheck all'))
  button().props.onClick(); await ui.flush()
  assert.match(textOf(ui.slot('renderBeforeQueue', meta())), /Unable to start rechecking all reviews\./)
  assert.equal(button().props.disabled, false)
  ui.unmount()
})

test('recheck all is disabled when nothing needs review or the workspace is busy', async () => {
  const ui = await mountPage()
  const button = extra => nodesOf(ui.slot('renderBeforeQueue', meta(extra))).find(node => node.type === 'button' && textOf(node).includes('Recheck all'))
  assert.equal(button({ progress: { ...progress, needsReview: 0, cleared: 2 } }).props.disabled, true)
  assert.equal(button({ busy: true }).props.disabled, true)
  ui.unmount()
})

test('reviewing a merge survivor captures its review once and selects it', async () => {
  const ui = await mount({ prepareH2AMergedSurvivorReview: () => Promise.resolve({ survivor: { sourceId: '570263829186', reviewId: 'survivor-review' } }) })
  await ui.detail().props.onOpenMergedSurvivor({ sourceId: '570263829186', reviewId: null }); await ui.flush()
  const prepared = ui.calls.filter(call => call.name === 'prepareH2AMergedSurvivorReview')
  assert.equal(prepared.length, 1)
  assert.deepEqual({ ...prepared[0].args[2] }, { reviewId: 'review-1', expectedUpdatedAt: '2026-10-12T12:00:00.000Z' })
  assert.equal(ui.detail().props.item.id, 'survivor-review')
  ui.unmount()
  const known = await mount()
  await known.detail().props.onOpenMergedSurvivor({ sourceId: '570263829186', reviewId: 'known-survivor' }); await known.flush()
  assert.equal(known.calls.filter(call => call.name === 'prepareH2AMergedSurvivorReview').length, 0)
  assert.equal(known.detail().props.item.id, 'known-survivor')
  known.unmount()
})

test('a link or create is not followed by an automatic recheck (Recheck all settles them in one Albi read)', async () => {
  const flush = async ui => { for (let i = 0; i < 6; i++) await ui.flush() }
  const ui = await mount({ resolveH2ADryRunReview: () => Promise.resolve({ resolution: { status: 'ready_to_recheck' } }) })
  await ui.detail().props.onLink({ id: 'albi-1' }, { approveManyToOne: true }); await flush(ui)
  assert.equal(ui.calls.filter(call => call.name === 'recheckH2ADryRunReview').length, 0)
  assert.doesNotMatch(ui.text(), /automatic recheck/i)
  ui.unmount()
})
