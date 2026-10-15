import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as presentation from '../../src/features/hubspotToAlbi/sampleReview.js'
import { presentSampleReviewQueryFilters } from '../../src/features/hubspotToAlbi/preflightPresentation.js'

const pageUrl = new URL('../../src/features/hubspotToAlbi/SampleReviewPage.jsx', import.meta.url)
const detailUrl = new URL('../../src/features/hubspotToAlbi/SampleReviewDetail.jsx', import.meta.url)
const row = (id = 'review-1') => ({ id, runId: 'sample-1', objectType: 'contacts', sourceId: 'hs-1',
  displayName: 'Alex Example', identity: { email: 'alex@example.com', phone: '+15551234567', organizationName: 'Example Co', domain: null },
  reason: 'name_only_candidate', status: 'needs_review', updatedAt: '2026-10-12T12:00:00.000Z', lastRecheckedAt: null })
const full = (id = 'review-1') => ({ ...row(id), sourceSnapshot: { id: 'hs-1', fullName: 'Alex Example', email: 'alex@example.com', phoneNumber: '+15551234567' },
  candidateSnapshots: [{ id: 'albi-1', fullName: 'Alex Example', email: 'another@example.com' }], matchEvidence: ['name'], proposedChanges: {}, events: [] })
const progress = { total: 2, needsReview: 2, cleared: 0, noLongerInScope: 0, fullDryRunReady: false }
const page = (items = [row()], extra = {}) => ({ items, nextCursor: null, sample: { id: 'sample-1', reviewCaptureVersion: 1, historical: false }, progress, ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

// Exercise the real JSX and request handlers. Only React's scheduling and the external HTTP boundary are substituted.
async function mount(overrides = {}) {
  const source = await readFile(pageUrl, 'utf8')
  const slots = [], effects = [], pending = []
  let index = 0, tree, dirty = true
  const context = { session: { access_token: 'token' }, companyId: 'company-1', companyName: 'Example Co', isAdmin: true,
    tenantRevision: 0, completeTenantTransition: revision => completed.push(revision) }
  const completed = [], calls = [], navigations = []
  const navigate = (path, options) => navigations.push({ path, options })
  const clients = Object.fromEntries(['getH2ADryRunReviews', 'getH2ADryRunReview', 'recheckH2ADryRunReview', 'resolveH2ADryRunReview'].map(name => [name, (...args) => {
    calls.push({ name, args })
    if (overrides[name]) return overrides[name](...args)
    return Promise.resolve(name === 'getH2ADryRunReviews' ? page() : { item: full(args[2]) })
  }]))
  const useState = initial => { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; dirty = true }] }
  const useRef = initial => { const slot = index++; return slots[slot] ??= { current: initial } }
  const useEffect = (run, deps) => { const slot = index++; const prior = effects[slot]
    if (!prior || !deps || deps.some((value, i) => !Object.is(value, prior.deps[i]))) pending.push(() => {
      prior?.cleanup?.(); effects[slot] = { deps, cleanup: run() }
    }) }
  const useCallback = (callback, deps) => { const ref = useRef(); if (!ref.current || deps.some((value, i) => !Object.is(value, ref.current.deps[i]))) ref.current = { callback, deps }; return ref.current.callback }
  const h = (type, props, ...children) => ({ type: typeof type === 'function' ? type.name : type, props: props ?? {}, children: children.flat(Infinity) })
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export default function', 'function'),
    { loader: 'jsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code
  const component = vm.runInNewContext(`${code}\nSampleReviewPage`, { ...presentation, presentSampleReviewQueryFilters, ...clients, h, Fragment: 'fragment',
    useState, useRef, useEffect, useCallback, useOutletContext: () => context, AbortController, Intl, Date, Set, Map,
    useLocation: () => ({ pathname: '/hubspot-to-albi/sample-review', search: overrides.locationSearch ?? '' }),
    useNavigate: () => navigate, URLSearchParams,
    Link: function Link() {}, SampleReviewDetail: function SampleReviewDetail() {} })
  async function flush() { for (let attempt = 0; attempt < 12; attempt++) {
    if (dirty) { dirty = false; index = 0; tree = component(); while (pending.length) pending.shift()() }
    await Promise.resolve(); await Promise.resolve()
  } return tree }
  await flush()
  const nodes = () => { const all = []; const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); node.children?.forEach(walk) }; walk(tree); return all }
  return { context, calls, completed, navigations, flush, nodes, text: () => JSON.stringify(tree),
    rerender: () => { dirty = true; return flush() },
    find: (type, text) => nodes().find(node => node.type === type && JSON.stringify(node.children).includes(text)),
    detail: () => nodes().find(node => node.type === 'SampleReviewDetail'),
    unmount: () => effects.forEach(effect => effect?.cleanup?.()) }
}

test('selectable reasons cannot send the presentation fallback rejected by the API', () => {
  assert.equal(presentation.SAMPLE_REVIEW_REASON_OPTIONS.some(option => option.value === 'other_review_reason'), false)
  assert.equal(presentation.presentSampleReviewItem({ reason: 'unknown-secret' }).reasonLabel, 'Other review reason')
})

test('queue shows applying, waiting and failed resolution badges without internal details', async () => {
  const ui = await mount({ getH2ADryRunReviews: () => Promise.resolve(page([
    { ...row('a'), resolutionStatus: 'applying' }, { ...row('b'), resolutionStatus: 'waiting_on_albi' },
    { ...row('c'), resolutionStatus: 'failed', leaseOwner: 'secret' },
  ])) })
  assert.equal(ui.nodes().filter(node => node.type === 'li').length, 3)
  assert.deepEqual(ui.nodes().filter(node => node.type === 'li').map(node => [node.props.key,
    JSON.stringify(node).includes('Applying'), JSON.stringify(node).includes('Waiting on Albi'), JSON.stringify(node).includes('Action failed')]),
  [['a', true, false, false], ['b', false, true, false], ['c', false, false, true]])
  assert.match(ui.text(), /Applying/)
  assert.match(ui.text(), /Waiting on Albi/)
  assert.match(ui.text(), /Action failed/)
  assert.doesNotMatch(ui.text(), /secret/)
  ui.unmount()
})

test('Overview reason query initializes only catalog filters and clears invalid parameters', async () => {
  const valid = await mount({ locationSearch: '?objectType=contacts&reason=nonblank_field_difference' })
  assert.equal(valid.calls[0].args[2].objectType, 'contacts')
  assert.equal(valid.calls[0].args[2].reason, 'nonblank_field_difference')
  valid.unmount()
  const invalid = await mount({ locationSearch: '?objectType=unsafe&reason=other_review_reason' })
  assert.equal(invalid.calls[0].args[2].objectType, '')
  assert.equal(invalid.calls[0].args[2].reason, '')
  assert.equal(invalid.navigations.at(-1).options.replace, true)
  invalid.unmount()
})

test('resolution sends decision only, locks duplicates, and refreshes selected detail', async () => {
  const pending = deferred(); let details = 0
  const ui = await mount({ resolveH2ADryRunReview: () => pending.promise,
    getH2ADryRunReview: (_s, _c, id) => Promise.resolve({ item: { ...full(id), updatedAt: `2026-10-12T12:0${++details}:00.000Z` } }) })
  const resolve = ui.detail().props.onResolve
  const action = resolve({ action: 'link_existing', candidateId: '456' }, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-10-12T12:01:00.000Z')
  await ui.flush()
  const duplicate = resolve({ action: 'link_existing', candidateId: '456' }, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-10-12T12:01:00.000Z')
  await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'resolveH2ADryRunReview').length, 1)
  assert.equal(ui.detail().props.recheckPending, true)
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.name === 'resolveH2ADryRunReview').args[2])), {
    reviewId: 'review-1', expectedUpdatedAt: '2026-10-12T12:01:00.000Z', clientRequestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    action: 'link_existing', candidateId: '456' })
  pending.resolve({ resolution: { status: 'ready_to_recheck' } }); await action; await duplicate; await ui.flush()
  assert.equal(details, 2); assert.equal(ui.detail().props.item.updatedAt, '2026-10-12T12:02:00.000Z')
  ui.unmount()
})

test('resolution 409 refreshes current detail before the confirmation can be retried', async () => {
  let details = 0
  const ui = await mount({ resolveH2ADryRunReview: () => Promise.reject(Object.assign(new Error('Changed'), { status: 409 })),
    getH2ADryRunReview: (_s, _c, id) => Promise.resolve({ item: { ...full(id), updatedAt: `2026-10-12T12:0${++details}:00.000Z` } }) })
  await assert.rejects(ui.detail().props.onResolve({ action: 'link_existing', candidateId: '456' },
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-10-12T12:01:00.000Z'), { status: 409 })
  await ui.flush()
  assert.equal(ui.detail().props.item.updatedAt, '2026-10-12T12:02:00.000Z')
  ui.unmount()
})

test('an outdated local confirmation is rejected before a mutation request', async () => {
  const ui = await mount()
  await assert.rejects(ui.detail().props.onResolve({ action: 'link_existing', candidateId: '456' },
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-10-12T11:00:00.000Z'), { status: 409 })
  assert.equal(ui.calls.filter(call => call.name === 'resolveH2ADryRunReview').length, 0)
  ui.unmount()
})

test('sample review uses centralized requests and accessible wrapping without provider mutation controls', async () => {
  const [source, detail] = await Promise.all([readFile(pageUrl, 'utf8'), readFile(detailUrl, 'utf8')])
  assert.doesNotMatch(source + detail, /\bfetch\s*\(|\bsupabase\b|dangerouslySetInnerHTML|\btruncate\b/)
  for (const label of ['Status', 'Object type', 'Reason']) assert.match(source, new RegExp(`>${label}<`))
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /role="alert"/)
  assert.match(detail, /break-words/); assert.match(detail, /break-all/)
  assert.equal((detail.match(/Recheck this record<\/button>/g) ?? []).length, 1)
  assert.doesNotMatch(detail, />\s*(?:Link|Create|Approve|Retain|Skip)(?:\s|<)/i)
})

test('list summaries retain direct identity and detail loads separately with abortable requests', async () => {
  const ui = await mount()
  assert.match(ui.text(), /Alex Example/); assert.match(ui.text(), /alex@example.com/); assert.match(ui.text(), /\+15551234567/)
  assert.equal(ui.detail().props.item.id, 'review-1')
  assert.deepEqual(ui.completed, [0])
  for (const call of ui.calls) assert.ok(call.args.at(-1).signal instanceof AbortSignal)
  ui.unmount()
})

test('filters reset pagination/selection and late load-more cannot mix a previous filter queue', async () => {
  const more = deferred(); let reads = 0
  const ui = await mount({ getH2ADryRunReviews: (_session, _company, filters) => {
    reads++; if (filters.cursor) return more.promise
    return Promise.resolve(reads === 1 ? page([row()], { nextCursor: 'next' }) : page([row('filtered')]))
  } })
  const loadingMore = ui.find('button', 'Load more').props.onClick(); await ui.flush()
  ui.nodes().find(node => node.type === 'select' && node.props.id === 'sample-review-status').props.onChange({ target: { value: 'cleared' } }); await ui.flush()
  more.resolve(page([row('obsolete')])); await loadingMore; await ui.flush()
  assert.doesNotMatch(ui.text(), /obsolete/); assert.equal(ui.detail().props.item.id, 'filtered')
  const last = ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1)
  assert.equal(last.args[2].status, 'cleared'); assert.equal(last.args[2].cursor, undefined)
  ui.unmount()
})

test('load-more appends unique rows without disturbing the selected record', async () => {
  const ui = await mount({ getH2ADryRunReviews: (_s, _c, filters) => Promise.resolve(filters.cursor
    ? page([row(), row('review-2')]) : page([row()], { nextCursor: 'next' })) })
  await ui.find('button', 'Load more').props.onClick(); await ui.flush()
  assert.equal(ui.nodes().filter(node => node.type === 'li').length, 2)
  assert.equal(ui.detail().props.item.id, 'review-1'); ui.unmount()
})

test('pagination publishes refreshed progress with the same sample and preserves its selection', async () => {
  const refreshed = { ...progress, needsReview: 1, cleared: 1 }
  const ui = await mount({ getH2ADryRunReviews: (_s, _c, filters) => Promise.resolve(filters.cursor
    ? page([row('review-2')], { progress: refreshed, nextCursor: 'next-2' }) : page([row()], { nextCursor: 'next' })) })
  await ui.find('button', 'Load more').props.onClick(); await ui.flush()
  const counter = ui.nodes().find(node => node.type === 'dl' && node.props['aria-label'] === 'Sample review progress')
  assert.match(JSON.stringify(counter), /"children":\[1\]/)
  assert.equal(ui.detail().props.item.id, 'review-1')
  const action = ui.find('button', 'Load more').props.onClick(); await action; await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1).args[2].cursor, 'next-2')
  ui.unmount()
})

test('sample replacement during pagination clears old evidence and refetches the new first page', async () => {
  const firstB = deferred(), oldDetail = deferred(); let firstPages = 0
  const sampleB = { id: 'sample-B', reviewCaptureVersion: 1, historical: false }
  const bRow = { ...row('review-B'), runId: 'sample-B', displayName: 'New Sample Person' }
  const ui = await mount({ getH2ADryRunReviews: (_s, _c, filters) => filters.cursor
    ? Promise.resolve(page([{ ...bRow, id: 'cursor-B' }], { sample: sampleB, nextCursor: 'cursor-B-next' }))
    : ++firstPages === 1 ? Promise.resolve(page([row('review-A'), row('review-A2')], { nextCursor: 'cursor-A' })) : firstB.promise,
    getH2ADryRunReview: (_s, _c, id) => id === 'review-A2' ? oldDetail.promise
      : Promise.resolve({ item: { ...full(id), runId: id === 'review-B' ? 'sample-B' : 'sample-1' } }) })
  ui.nodes().filter(node => node.type === 'button' && JSON.stringify(node.children).includes('HubSpot ID:'))[1].props.onClick()
  await ui.flush()
  const oldSignal = ui.calls.filter(call => call.name === 'getH2ADryRunReview').at(-1).args[3].signal
  await ui.find('button', 'Load more').props.onClick(); await ui.flush()
  assert.equal(ui.detail(), undefined)
  assert.doesNotMatch(ui.text(), /review-A|cursor-B|Alex Example/)
  assert.match(ui.text(), /Loading sample reviews/)
  assert.equal(oldSignal.aborted, true)
  assert.equal(ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1).args[2].cursor, undefined)
  firstB.resolve(page([bRow], { sample: sampleB, progress: { ...progress, total: 1, needsReview: 1 }, nextCursor: 'first-B-next' }))
  await ui.flush()
  oldDetail.resolve({ item: full('review-A2') }); await ui.flush()
  assert.equal(ui.detail().props.item.id, 'review-B')
  assert.equal(ui.detail().props.item.runId, 'sample-B')
  assert.doesNotMatch(ui.text(), /review-A|cursor-B|Corrections are clear/)
  ui.unmount()
})

for (const first of ['recheck', 'pagination']) {
  test(`recheck cancels prior same-sample pagination when ${first} completes first and preserves a retryable cursor`, async () => {
    const more = deferred(), rechecked = deferred(); let pages = 0
    const updatedProgress = { ...progress, needsReview: 0, cleared: 2 }
    const ui = await mount({ getH2ADryRunReviews: (_s, _c, filters) => !filters.cursor
      ? Promise.resolve(page([row()], { nextCursor: 'original-cursor' }))
      : ++pages === 1 ? more.promise : Promise.resolve(page([row('new-page')], { progress: updatedProgress })),
      recheckH2ADryRunReview: () => rechecked.promise })
    const loadMore = ui.find('button', 'Load more').props.onClick
    const pagination = loadMore(); await ui.flush()
    const pageSignal = ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1).args[2].signal
    const action = ui.detail().props.onRecheck(); await ui.flush()
    const recheckSignal = ui.calls.find(call => call.name === 'recheckH2ADryRunReview').args[3].signal
    const finishPage = async () => { more.resolve(page([row('stale-page')], { nextCursor: 'stale-cursor' })); await pagination; await ui.flush() }
    const finishRecheck = async () => { rechecked.resolve({ item: { ...full(), status: 'cleared' }, progress: updatedProgress }); await action; await ui.flush() }
    if (first === 'recheck') { await finishRecheck(); await finishPage() } else { await finishPage(); await finishRecheck() }
    assert.equal(ui.detail().props.item.status, 'cleared')
    assert.deepEqual(ui.nodes().filter(node => node.type === 'dd').map(node => node.children[0]), [0, 2, 0])
    assert.match(ui.text(), /Corrections are clear for this sample/)
    assert.doesNotMatch(ui.text(), /stale-page/)
    assert.equal(pageSignal.aborted, true); assert.equal(recheckSignal.aborted, false)
    assert.equal(ui.find('button', 'Load more').props.disabled, false)
    await ui.find('button', 'Load more').props.onClick(); await ui.flush()
    assert.equal(ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1).args[2].cursor, 'original-cursor')
    assert.match(ui.text(), /new-page/)
    ui.unmount()
  })
}

test('a saved Load more handler cannot start pagination during recheck and the control recovers afterward', async () => {
  const rechecked = deferred()
  const ui = await mount({ getH2ADryRunReviews: () => Promise.resolve(page([row()], { nextCursor: 'next' })),
    recheckH2ADryRunReview: () => rechecked.promise })
  const loadMore = ui.find('button', 'Load more').props.onClick
  const action = ui.detail().props.onRecheck(); await ui.flush()
  await loadMore(); await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'getH2ADryRunReviews').length, 1)
  assert.equal(ui.find('button', 'Load more').props.disabled, true)
  rechecked.resolve({ item: full(), progress }); await action; await ui.flush()
  assert.equal(ui.find('button', 'Load more').props.disabled, false)
  ui.unmount()
})

for (const status of [502, 409]) {
  test(`recheck ${status} cancels stale pagination while retaining evidence, progress and the retryable cursor`, async () => {
    const more = deferred(); let pages = 0, detailReads = 0
    const ui = await mount({ getH2ADryRunReviews: (_s, _c, filters) => !filters.cursor
      ? Promise.resolve(page([row()], { nextCursor: 'original-cursor' }))
      : ++pages === 1 ? more.promise : Promise.resolve(page([row('retried-page')])),
      getH2ADryRunReview: () => Promise.resolve({ item: { ...full(), updatedAt: ++detailReads === 1
        ? '2026-10-12T12:00:00.000Z' : '2026-10-12T12:02:00.000Z' } }),
      recheckH2ADryRunReview: () => Promise.reject(Object.assign(new Error('Unable to recheck this sample review.'), { status })) })
    const pagination = ui.find('button', 'Load more').props.onClick(); await ui.flush()
    const signal = ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1).args[2].signal
    await ui.detail().props.onRecheck(); await ui.flush()
    more.resolve(page([row('stale-page')], { progress: { ...progress, needsReview: 999 }, nextCursor: 'stale-cursor' }))
    await pagination; await ui.flush()
    assert.equal(ui.detail().props.item.id, 'review-1')
    assert.deepEqual(ui.nodes().filter(node => node.type === 'dd').map(node => node.children[0]), [2, 0, 0])
    assert.equal(signal.aborted, true)
    assert.match(ui.text(), status === 409 ? /changed/ : /Recheck failed/)
    assert.equal(ui.detail().props.item.updatedAt, status === 409 ? '2026-10-12T12:02:00.000Z' : '2026-10-12T12:00:00.000Z')
    assert.doesNotMatch(ui.text(), /stale-page/)
    assert.equal(ui.find('button', 'Load more').props.disabled, false)
    await ui.find('button', 'Load more').props.onClick(); await ui.flush()
    assert.equal(ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1).args[2].cursor, 'original-cursor')
    assert.match(ui.text(), /retried-page/)
    ui.unmount()
  })
}

for (const transition of ['filter', 'tenant', 'unmount']) {
  test(`stale replacement pagination after ${transition} cannot reset the current queue or start another fetch`, async () => {
    const more = deferred(); let firstPages = 0
    const ui = await mount({ getH2ADryRunReviews: (_s, _c, filters) => filters.cursor ? more.promise
      : Promise.resolve(page([row(++firstPages === 1 ? 'review-A' : 'current-record')], { nextCursor: 'next' })) })
    const action = ui.find('button', 'Load more').props.onClick(); await ui.flush()
    const signal = ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1).args[2].signal
    if (transition === 'filter') {
      ui.nodes().find(node => node.type === 'select' && node.props.id === 'sample-review-status').props.onChange({ target: { value: 'cleared' } })
      await ui.flush()
    } else if (transition === 'tenant') {
      ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1; await ui.rerender()
    } else ui.unmount()
    const readsBefore = ui.calls.filter(call => call.name === 'getH2ADryRunReviews').length
    more.resolve(page([{ ...row('obsolete-B'), runId: 'sample-B' }], { sample: { id: 'sample-B', reviewCaptureVersion: 1 } }))
    await action; await ui.flush()
    assert.equal(signal.aborted, true)
    assert.equal(ui.calls.filter(call => call.name === 'getH2ADryRunReviews').length, readsBefore)
    assert.doesNotMatch(ui.text(), /obsolete-B/)
    if (transition !== 'unmount') { assert.equal(ui.detail().props.item.id, 'current-record'); ui.unmount() }
  })
}

test('a tenant switch while replacement first-page fetch is pending aborts and hides its late evidence', async () => {
  const replacement = deferred(); let companyOneReads = 0
  const ui = await mount({ getH2ADryRunReviews: (_s, company, filters) => company === 'company-2'
    ? Promise.resolve(page([row('tenant-two')])) : filters.cursor
      ? Promise.resolve(page([row('obsolete-B')], { sample: { id: 'sample-B', reviewCaptureVersion: 1 } }))
      : ++companyOneReads === 1 ? Promise.resolve(page([row('review-A')], { nextCursor: 'next' })) : replacement.promise })
  await ui.find('button', 'Load more').props.onClick(); await ui.flush()
  assert.equal(companyOneReads, 2)
  const signal = ui.calls.filter(call => call.name === 'getH2ADryRunReviews').at(-1).args[2].signal
  ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1; await ui.rerender()
  replacement.resolve(page([row('obsolete-B')], { sample: { id: 'sample-B', reviewCaptureVersion: 1 } })); await ui.flush()
  assert.equal(signal.aborted, true); assert.equal(ui.detail().props.item.id, 'tenant-two')
  assert.doesNotMatch(ui.text(), /review-A|obsolete-B/)
  ui.unmount()
})

test('tenant transition aborts all prior requests and ignores late list results', async () => {
  const old = deferred()
  const ui = await mount({ getH2ADryRunReviews: (_s, company) => company === 'company-1' ? old.promise : Promise.resolve(page([row('new-tenant')])) })
  const signal = ui.calls[0].args[2].signal
  ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1
  await ui.rerender(); old.resolve(page([row('old-tenant')])); await ui.flush()
  assert.equal(signal.aborted, true); assert.doesNotMatch(ui.text(), /old-tenant/)
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
  pending.resolve({ item: { ...full(), status: 'cleared', updatedAt: '2026-10-12T12:01:00.000Z' },
    progress: { total: 2, needsReview: 0, cleared: 2, noLongerInScope: 0, fullDryRunReady: false } })
  await action; await ui.flush()
  assert.equal(ui.detail().props.item.status, 'cleared')
  assert.match(ui.text(), /Corrections are clear for this sample\. Run a fresh sample to verify them; this sample does not unlock the full dry run\./)
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

test('historical, missing, clean and filtered-empty samples have distinct recovery guidance', async () => {
  for (const [response, expected] of [
    [page([], { sample: { historical: true, reviewCaptureVersion: null } }), /Run a new sample to create detailed review data/],
    [page([], { sample: null }), /Settings/],
    [page([], { progress: { total: 0, needsReview: 0, cleared: 0, noLongerInScope: 0, fullDryRunReady: true } }), /No underlying records need correction/],
    [page([], { progress }), /No records match these filters/],
  ]) { const ui = await mount({ getH2ADryRunReviews: () => Promise.resolve(response) }); assert.match(ui.text(), expected); ui.unmount() }
})

test('late detail for another selection is aborted and cannot overwrite current evidence', async () => {
  const previous = deferred()
  const ui = await mount({ getH2ADryRunReviews: () => Promise.resolve(page([row(), row('review-2')])),
    getH2ADryRunReview: (_s, _c, id) => id === 'review-1' ? previous.promise : Promise.resolve({ item: full(id) }) })
  const signal = ui.calls.find(call => call.name === 'getH2ADryRunReview').args[3].signal
  const rowButtons = ui.nodes().filter(node => node.type === 'button' && JSON.stringify(node.children).includes('HubSpot ID:'))
  rowButtons[1].props.onClick(); await ui.flush()
  previous.resolve({ item: full() }); await ui.flush()
  assert.equal(signal.aborted, true); assert.equal(ui.detail().props.item.id, 'review-2'); ui.unmount()
})

test('a tenant switch aborts recheck and ignores late progress and record changes', async () => {
  const pending = deferred()
  const ui = await mount({ recheckH2ADryRunReview: () => pending.promise,
    getH2ADryRunReviews: (_s, company) => Promise.resolve(page([row(company === 'company-1' ? 'review-1' : 'review-new')])) })
  const action = ui.detail().props.onRecheck(); await ui.flush()
  const signal = ui.calls.find(call => call.name === 'recheckH2ADryRunReview').args[3].signal
  ui.context.companyId = 'company-2'; ui.context.tenantRevision = 1; await ui.rerender()
  pending.resolve({ item: { ...full(), status: 'cleared' }, progress: { ...progress, needsReview: 0, cleared: 2 } }); await action; await ui.flush()
  assert.equal(signal.aborted, true); assert.equal(ui.detail().props.item.id, 'review-new')
  assert.doesNotMatch(ui.text(), /Corrections are clear/); assert.deepEqual(ui.completed, [0, 1]); ui.unmount()
})

test('detail renders full identity, every candidate, fixed audit labels and the resolution panel', async () => {
  const source = await readFile(detailUrl, 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export default function', 'function'),
    { loader: 'jsx', jsxFactory: 'h' }).code
  const Detail = vm.runInNewContext(`${code}\nSampleReviewDetail`, { ...presentation, h: createElement, Intl, Date,
    SampleReviewResolution: ({ item }) => createElement('aside', { 'data-review-id': item.id }, 'Resolution panel') })
  const item = { ...full(), sourceSnapshot: { ...full().sourceSnapshot, fullName: '<script>alert(1)</script>',
    email: 'complete-long-direct-email-address@example.com', mobileNumber: '+15559876543', address1: '123 Complete Street', city: 'Example City' },
    candidateSnapshots: [{ id: 'albi-1', email: 'one@example.com' }, { id: 'albi-2', email: 'two@example.com' }],
    events: [{ id: 'event-1', eventType: 'unknown-private-label', reason: 'unknown-private-reason', createdAt: '2026-10-12T12:00:00Z', details: { outcome: 'unknown-secret-outcome' } }] }
  const html = renderToStaticMarkup(createElement(Detail, { item, recheckPending: false, onRecheck() {} }))
  for (const value of ['complete-long-direct-email-address@example.com', '+15559876543', '123 Complete Street', 'Example City', 'albi-1', 'albi-2', 'one@example.com', 'two@example.com']) assert.ok(html.includes(value), value)
  assert.ok(html.includes('&lt;script&gt;')); assert.equal(html.includes('<script>'), false)
  assert.match(html, /Recheck this record/); assert.match(html, /Resolution panel/)
  assert.match(html, /Review event/); assert.doesNotMatch(html, /unknown-private|unknown-secret/)
})

test('detail renders job-title-only differences and labels source job title without a candidate', async () => {
  const source = await readFile(detailUrl, 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export default function', 'function'),
    { loader: 'jsx', jsxFactory: 'h' }).code
  const Detail = vm.runInNewContext(`${code}\nSampleReviewDetail`, { ...presentation, h: createElement, Intl, Date,
    SampleReviewResolution: () => null })
  const item = { ...full(), reason: 'nonblank_field_difference', sourceSnapshot: { id: 'hs-1', jobTitle: 'Engineer' },
    candidateSnapshots: [{ id: 'albi-1', jobTitle: 'Manager' }],
    proposedChanges: { conflicts: { jobTitle: { proposed: 'Engineer', current: 'Manager' } } } }
  const html = renderToStaticMarkup(createElement(Detail, { item, onRecheck() {} }))
  assert.match(html, /Fields with different values/)
  assert.match(html, /HubSpot · Job title/); assert.match(html, /Albi · Job title/)
  assert.match(html, /Engineer/); assert.match(html, /Manager/)
  const withoutCandidate = renderToStaticMarkup(createElement(Detail, { item: { ...item, candidateSnapshots: [], proposedChanges: {} }, onRecheck() {} }))
  assert.match(withoutCandidate, /HubSpot · Job title/); assert.match(withoutCandidate, /Engineer/)
})
