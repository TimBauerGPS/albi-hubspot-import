import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as presentation from '../../src/features/hubspotToAlbi/sampleReview.js'

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
  const completed = [], calls = []
  const clients = Object.fromEntries(['getH2ADryRunReviews', 'getH2ADryRunReview', 'recheckH2ADryRunReview'].map(name => [name, (...args) => {
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
  const component = vm.runInNewContext(`${code}\nSampleReviewPage`, { ...presentation, ...clients, h, Fragment: 'fragment',
    useState, useRef, useEffect, useCallback, useOutletContext: () => context, AbortController, Intl, Date, Set, Map,
    Link: function Link() {}, SampleReviewDetail: function SampleReviewDetail() {} })
  async function flush() { for (let attempt = 0; attempt < 12; attempt++) {
    if (dirty) { dirty = false; index = 0; tree = component(); while (pending.length) pending.shift()() }
    await Promise.resolve(); await Promise.resolve()
  } return tree }
  await flush()
  const nodes = () => { const all = []; const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); node.children?.forEach(walk) }; walk(tree); return all }
  return { context, calls, completed, flush, nodes, text: () => JSON.stringify(tree),
    rerender: () => { dirty = true; return flush() },
    find: (type, text) => nodes().find(node => node.type === type && JSON.stringify(node.children).includes(text)),
    detail: () => nodes().find(node => node.type === 'SampleReviewDetail'),
    unmount: () => effects.forEach(effect => effect?.cleanup?.()) }
}

test('selectable reasons cannot send the presentation fallback rejected by the API', () => {
  assert.equal(presentation.SAMPLE_REVIEW_REASON_OPTIONS.some(option => option.value === 'other_review_reason'), false)
  assert.equal(presentation.presentSampleReviewItem({ reason: 'unknown-secret' }).reasonLabel, 'Other review reason')
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

test('detail renders full identity, every candidate, fixed audit labels and only the recheck action', async () => {
  const source = await readFile(detailUrl, 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export default function', 'function'),
    { loader: 'jsx', jsxFactory: 'h' }).code
  const Detail = vm.runInNewContext(`${code}\nSampleReviewDetail`, { ...presentation, h: createElement, Intl, Date })
  const item = { ...full(), sourceSnapshot: { ...full().sourceSnapshot, fullName: '<script>alert(1)</script>',
    email: 'complete-long-direct-email-address@example.com', mobileNumber: '+15559876543', address1: '123 Complete Street', city: 'Example City' },
    candidateSnapshots: [{ id: 'albi-1', email: 'one@example.com' }, { id: 'albi-2', email: 'two@example.com' }],
    events: [{ id: 'event-1', eventType: 'unknown-private-label', reason: 'unknown-private-reason', createdAt: '2026-10-12T12:00:00Z', details: { outcome: 'unknown-secret-outcome' } }] }
  const html = renderToStaticMarkup(createElement(Detail, { item, recheckPending: false, onRecheck() {} }))
  for (const value of ['complete-long-direct-email-address@example.com', '+15559876543', '123 Complete Street', 'Example City', 'albi-1', 'albi-2', 'one@example.com', 'two@example.com']) assert.ok(html.includes(value), value)
  assert.ok(html.includes('&lt;script&gt;')); assert.equal(html.includes('<script>'), false)
  assert.equal((html.match(/<button/g) ?? []).length, 1); assert.match(html, /Recheck this record/)
  assert.match(html, /Review event/); assert.doesNotMatch(html, /unknown-private|unknown-secret/)
})
