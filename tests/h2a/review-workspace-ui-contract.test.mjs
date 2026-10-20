import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as workspaceHelpers from '../../src/features/hubspotToAlbi/reviewWorkspace.js'
import * as sampleReview from '../../src/features/hubspotToAlbi/sampleReview.js'
import { buildResolutionConfirmation } from '../../src/features/hubspotToAlbi/sampleReviewResolution.js'
import { blockedReasonCopy } from '../../shared/h2aBlockedReasons.js'
import { mountComponent, stub, textOf } from './workspace-harness.mjs'

const require = createRequire(import.meta.url)
let currentMock = null
const dir = new URL('../../src/features/hubspotToAlbi/', import.meta.url).pathname

// Bundle the real component with its real imports. React is either the real package (static markup) or a
// tiny hook/JSX double (interaction), so handlers can be invoked without a DOM.
async function load(file, mock) {
  const virtual = {
    name: 'mock-react',
    setup(b) {
      b.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, args => ({ path: args.path, namespace: 'mock-react' }))
      b.onLoad({ filter: /.*/, namespace: 'mock-react' }, args => ({ loader: 'js', contents: args.path === 'react'
        ? 'export const useState = (...a) => globalThis.__mock.useState(...a); export const useRef = (...a) => globalThis.__mock.useRef(...a); export const useEffect = (...a) => globalThis.__mock.useEffect(...a)'
        : 'export const jsx = (...a) => globalThis.__mock.jsx(...a); export const jsxs = jsx; export const Fragment = "fragment"' }))
    },
  }
  const result = await build({ entryPoints: [`${dir}${file}`], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: mock ? [] : ['react', 'react/jsx-runtime'], plugins: mock ? [virtual] : [], logLevel: 'silent' })
  const module = { exports: {} }
  const sandbox = { module, exports: module.exports, require, Intl, Date, Object, Set, Map, navigator: {}, document: { activeElement: null } }
  Object.defineProperty(sandbox, '__mock', { get: () => currentMock })
  vm.runInNewContext(result.outputFiles[0].text, sandbox, { filename: file })
  return module.exports.default
}

const rendered = async (file, props) => renderToStaticMarkup(createElement(await load(file, false), props))

function makeMock() {
  const slots = [], effects = [], pending = []; let index = 0
  const api = {
    useState: initial => { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; api.dirty = true }] },
    useRef: initial => { const slot = index++; return slots[slot] ??= { current: initial } },
    useEffect: (run, deps) => { const slot = index++, prior = effects[slot]
      if (!prior || !deps || deps.some((value, i) => !Object.is(value, prior.deps[i]))) pending.push(() => { prior?.cleanup?.(); effects[slot] = { deps, cleanup: run() } }) },
    jsx: (type, props, key) => {
      const { children, ...rest } = props ?? {}
      if (typeof type === 'function') return type({ ...rest, children })
      return { type, props: { ...rest, key }, children: [children].flat(Infinity).filter(child => child !== null && child !== undefined && child !== false && child !== true) }
    },
    dirty: true, reset: () => { index = 0 }, drain: () => { while (pending.length) pending.shift()() },
  }
  return api
}

async function mount(item, props = {}) {
  const mock = makeMock()
  const source = await load('ReviewRecord.jsx', true)
  let tree
  const run = () => { currentMock = mock; for (let n = 0; n < 6; n++) { if (!mock.dirty) break; mock.dirty = false; mock.reset(); tree = source({ item, ...props }); mock.drain() } }
  run()
  const nodes = () => { const all = []; const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); node.children?.forEach(walk) }; walk(tree); return all }
  const flat = node => typeof node === 'object' && node ? (node.children ?? []).map(flat).join('') : String(node ?? '')
  return { run, nodes, text: () => JSON.stringify(tree), plain: () => flat(tree),
    find: (type, label) => nodes().find(node => node.type === type && JSON.stringify(node.children).includes(label)) }
}

const j = value => JSON.parse(JSON.stringify(value))
const ADMIN = { enabled: true, mode: 'admins', canResolve: true, hubspotWrites: 'verified_when_first_used' }
const SOURCES = [{ id: '5', label: 'Network' }, { id: '9', label: 'Real Estate' }]
const base = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', reviewKind: 'sample',
  objectType: 'contacts', portalId: '321', sourceId: '123', status: 'needs_review', reason: 'duplicate_candidates', updatedAt: '2026-10-12T12:00:00.000Z',
  sourceSnapshot: { id: '123', firstName: 'Jane', lastName: 'Doe', email: 'jane@x.com', phoneNumber: '612-555-0101' },
  candidateSnapshots: [{ id: '456', firstName: 'Jane', lastName: 'Doe', email: 'Jane@x.com', phoneNumber: '612-555-0199' }],
  rankedCandidates: [{ id: '456', matchReasons: ['same_email', 'same_name'], warnings: [], strength: 'Strong', linkedElsewhere: 0 }],
  suggestedCandidateId: '456', resolutionCapability: ADMIN,
  forceCreateReadiness: { ready: true, referralSources: SOURCES } }
const none = { ...base, reason: 'no_match', candidateSnapshots: [], rankedCandidates: [], suggestedCandidateId: null,
  createReadiness: { ready: true, referralSources: SOURCES } }
const html = (item, props = {}) => rendered('ReviewRecord.jsx', { item, kind: 'sample', ...props })

test('referral select starts blank and create is disabled', async () => {
  const out = await html(none)
  assert.match(out, /<option value=""[^>]*>Referral source…<\/option>/)
  assert.match(out, /Real Estate/)
  assert.match(out, /<button[^>]*disabled=""[^>]*>Create in Albi/)
  const chosen = await html(none, { referralSourceId: '9' })
  assert.doesNotMatch(chosen, /<button[^>]*disabled=""[^>]*>Create in Albi/)
})

test('accept suggestion shows emails-match wording for same_email', async () => {
  assert.match(await html(base), /Accept suggestion \(emails match\)/)
  const phone = { ...base, rankedCandidates: [{ ...base.rankedCandidates[0], matchReasons: ['same_other_email'] }] }
  const out = await html(phone)
  assert.match(out, /Accept suggestion/); assert.doesNotMatch(out, /emails match/)
})

test('candidate cards show strength and reason chips, not bare ids', async () => {
  const out = await html(base)
  assert.match(out, /Strong/); assert.match(out, /Same email/); assert.match(out, /Same name/); assert.match(out, /Jane Doe/)
  assert.doesNotMatch(out, /score/i)
})

test('skip is rendered only for live', async () => {
  assert.doesNotMatch(await html(base, { kind: 'sample' }), />Skip</)
  assert.match(await html({ ...base, reviewKind: 'live' }, { kind: 'live' }), />Skip</)
})

test('merged record shows survivor action and no create', async () => {
  const out = await html({ ...none, mergedInto: { sourceId: '999', reviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } })
  assert.match(out, /Merged in HubSpot/); assert.match(out, /Review the surviving record/)
  assert.doesNotMatch(out, /Create in Albi/)
  const calls = []
  const ui = await mount({ ...none, mergedInto: { sourceId: '999', reviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }, { onOpenMergedSurvivor: value => calls.push(value) })
  ui.find('button', 'Review the surviving record').props.onClick()
  assert.deepEqual(j(calls), [{ sourceId: '999', reviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }])
})

test('blocked record shows named blocked copy', async () => {
  const out = await html({ ...none, createReadiness: { ready: false, blockedReason: 'salesperson_not_found' } })
  assert.match(out, /Can’t create yet/); assert.match(out, /exactly match one Albi salesperson/)
  assert.doesNotMatch(out, /Create in Albi/)
})

test('waiting_on_albi shows the update-in-Albi reminder with copy buttons', async () => {
  const out = await html({ ...base, resolution: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', reviewId: base.id, runId: base.runId, portalId: '321', sourceId: '123',
    objectType: 'contacts', action: 'resolve_fields', status: 'waiting_on_albi', events: [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', eventType: 'waiting_on_albi', createdAt: base.updatedAt,
      details: { manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '456', fields: [{ field: 'phoneNumber', value: '612-555-0101' }] }] } }] } })
  assert.match(out, /Update this contact in Albi/); assert.match(out, /Phone: 612-555-0101/)
  assert.match(out, />Copy</)
  assert.match(out, /https:\/\/app\.albiware\.com\/Relationships\/Contact\/456/)
  assert.match(out, /<summary[^>]*>History/)
  assert.doesNotMatch(out, /ffffffff-ffff|dddddddd-dddd/)
})

test('read-only capability renders no mutation controls', async () => {
  for (const capability of [{ enabled: false, mode: 'disabled', canResolve: false }, { enabled: true, mode: 'admins', canResolve: false }]) {
    const out = await html({ ...base, reviewKind: 'live', resolutionCapability: capability }, { kind: 'live' })
    assert.match(out, /read-only|unavailable/i)
    assert.doesNotMatch(out, /Accept suggestion|Link selected|Create in Albi|Add new in Albi|Skip|Recheck|Referral source…|Use HubSpot|Use Albi|Choose organization/)
  }
})

test('org-first eligible record offers create organization and contact', async () => {
  const item = { ...none, createReadiness: { ready: false, blockedReason: 'organization_not_synced', organization: { sourceId: '777' } },
    orgFirstCreate: { eligible: true, organizationReviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', organizationName: 'Whitfield Realty', referralSources: SOURCES } }
  const out = await html(item)
  assert.match(out, /Create organization and contact/); assert.match(out, /Whitfield Realty is not in Albi yet/)
  assert.doesNotMatch(out, /Can’t create yet/)
  const calls = []
  const ui = await mount(item, { referralSourceId: '9', onCreateWithOrganization: value => calls.push(value) })
  ui.find('button', 'Create organization and contact').props.onClick()
  assert.deepEqual(j(calls), [{ referralSourceId: '9' }])
  const notEligible = await html({ ...item, orgFirstCreate: { eligible: false } })
  assert.match(notEligible, /Create the organization first/); assert.doesNotMatch(notEligible, /Create organization and contact/)
})

test('linking a candidate with linkedElsewhere > 0 opens the many-to-one dialog with approval pre-checked and sends approveManyToOne true', async () => {
  const item = { ...base, suggestedCandidateId: null, rankedCandidates: [{ id: '456', matchReasons: ['same_phone'], warnings: ['already_linked_elsewhere'], strength: 'Likely', linkedElsewhere: 1 }] }
  const calls = []
  const ui = await mount(item, { onLink: (...args) => calls.push(JSON.parse(JSON.stringify(args))) })
  assert.equal(ui.find('button', 'Link anyway'), undefined)
  ui.find('button', 'Link selected').props.onClick(); ui.run()
  assert.equal(calls.length, 0)
  assert.match(ui.plain(), /Albi Jane Doe \(456\) is already linked to 1 other HubSpot record/)
  const checkbox = ui.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkbox.props.checked, true)
  ui.find('button', 'Link anyway').props.onClick(); ui.run()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0].id, '456'); assert.deepEqual(j(calls[0][1]), { approveManyToOne: true })
  assert.equal(ui.find('button', 'Link anyway'), undefined)
  // A candidate linked nowhere else links straight away, without approval.
  const plain = []
  const direct = await mount({ ...base, suggestedCandidateId: null }, { onLink: (...args) => plain.push(JSON.parse(JSON.stringify(args))) })
  direct.find('button', 'Link selected').props.onClick()
  assert.deepEqual(j(plain[0][1]), { approveManyToOne: false, emailMatch: true })
})

test('the referral select blurs after a change and create sends the chosen source', async () => {
  const calls = [], referrals = []; let blurred = 0
  const ui = await mount(none, { referralSourceId: '9', onCreate: value => calls.push(value), onReferral: value => referrals.push(value) })
  ui.nodes().find(node => node.type === 'select').props.onChange({ target: { value: '5', blur: () => { blurred += 1 } } })
  assert.deepEqual(j(referrals), ['5']); assert.equal(blurred, 1)
  ui.find('button', 'Create in Albi').props.onClick()
  assert.deepEqual(j(calls), [{ referralSourceId: '9' }])
})

test('create new in Albi is the force-create path and passes every ignored candidate', async () => {
  const calls = []
  const ui = await mount({ ...base, suggestedCandidateId: null }, { referralSourceId: '5', onForceCreate: value => calls.push(value) })
  assert.equal(ui.find('button', 'Create in Albi'), undefined)
  ui.find('button', 'Create new contact in Albi').props.onClick()
  assert.deepEqual(j(calls), [{ referralSourceId: '5', ignoredCandidateIds: ['456'] }])
})

test('accept calls back with the suggested candidate and the email-match flag', async () => {
  const calls = []
  const ui = await mount(base, { onAccept: (...args) => calls.push(JSON.parse(JSON.stringify(args))) })
  ui.find('button', 'Accept suggestion').props.onClick()
  assert.equal(calls[0][0].id, '456'); assert.deepEqual(j(calls[0][1]), { emailMatch: true })
})

test('field resolution offers per-field choices with All HubSpot and All Albi, and applies only when every field is chosen', async () => {
  const item = { ...base, reason: 'nonblank_field_difference', proposedChanges: { conflicts: { firstName: { proposed: 'Jane', current: 'Janet' }, jobTitle: { proposed: 'Lead', current: 'Analyst' } } },
    candidateSnapshots: [{ id: '456', firstName: 'Janet', jobTitle: 'Analyst' }], suggestedCandidateId: null }
  const out = await html(item)
  assert.match(out, /All HubSpot/); assert.match(out, /All Albi/); assert.match(out, /Use HubSpot/); assert.match(out, /Use Albi/)
  assert.match(out, /Updates HubSpot now/); assert.match(out, /You’ll update this in Albi/)
  assert.doesNotMatch(out, /Accept suggestion|Create in Albi/)
  const calls = []
  const ui = await mount(item, { onApplyFields: value => calls.push(value) })
  assert.equal(ui.find('button', 'Apply field choices').props.disabled, true)
  ui.find('button', 'All Albi').props.onClick(); ui.run()
  ui.find('button', 'Apply field choices').props.onClick()
  assert.deepEqual(j(calls), [{ firstName: 'albi', jobTitle: 'albi' }])
})

test('association reasons keep the organization-context choice and its copy', async () => {
  const item = { ...base, reason: 'organization_unresolved', candidateSnapshots: [], rankedCandidates: [], suggestedCandidateId: null,
    organizationOptions: [{ sourceId: '777', targetId: '888', contactTargetId: '456', currentOrganizationTargetId: '999', associated: false }] }
  const out = await html(item)
  assert.match(out, /Choose organization/); assert.match(out, /Existing HubSpot associations will not be removed/); assert.match(out, /add association/)
  const calls = []
  const ui = await mount(item, { onChooseOrganization: value => calls.push(value) })
  assert.equal(ui.find('button', 'Choose organization').props.disabled, true)
  ui.nodes().find(node => node.type === 'select').props.onChange({ target: { value: '777' } }); ui.run()
  ui.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); ui.run()
  ui.find('button', 'Choose organization').props.onClick()
  assert.deepEqual(j(calls), [{ organizationSourceId: '777', addHubSpotAssociation: true }])
  const none = await html({ ...item, organizationOptions: [] })
  assert.match(none, /Fresh server association evidence is unavailable/)
})

test('header shows the live HubSpot organization, IDs and provider links; matching fields are collapsed', async () => {
  const out = await html({ ...base, lastRecheckedAt: '2026-10-12T12:00:00.000Z', hubspotOrganizations: [{ sourceId: '777', name: 'Lakeside Property Group' }] })
  assert.match(out, /HubSpot organization:<\/span> Lakeside Property Group/)
  assert.match(out, /HubSpot ID 123/); assert.match(out, /https:\/\/app\.hubspot\.com\/contacts\/321\/record\/0-1\/123/)
  assert.match(out, /https:\/\/app\.albiware\.com\/Relationships\/Contact\/456/)
  assert.match(out, /Show 3 matching fields/)
})

test('shortcut help lists the keys and hides skip outside live', async () => {
  const closed = await rendered('ShortcutHelp.jsx', { open: false })
  assert.equal(closed, '')
  const sample = await rendered('ShortcutHelp.jsx', { open: true, kind: 'sample' })
  assert.match(sample, /Keyboard shortcuts/); assert.match(sample, /Accept the suggestion/); assert.doesNotMatch(sample, /Skip/)
  assert.match(await rendered('ShortcutHelp.jsx', { open: true, kind: 'live' }), /Skip \(live records only\)/)
})

test('accepting a stale suggestion that is now linked elsewhere goes through the many-to-one dialog', async () => {
  const item = { ...base, rankedCandidates: [{ ...base.rankedCandidates[0], linkedElsewhere: 2 }] }
  const links = [], accepts = []
  const ui = await mount(item, { onLink: (...a) => links.push(j(a)), onAccept: (...a) => accepts.push(j(a)) })
  ui.find('button', 'Accept suggestion').props.onClick(); ui.run()
  assert.equal(accepts.length, 0); assert.equal(links.length, 0)
  assert.match(ui.plain(), /already linked to 2 other HubSpot records/)
  ui.find('button', 'Link anyway').props.onClick(); ui.run()
  assert.deepEqual(links[0][1], { approveManyToOne: true, emailMatch: true })
})

test('a non-suggested same_email candidate keeps email-match semantics when linked', async () => {
  const calls = []
  const ui = await mount({ ...base, suggestedCandidateId: null }, { onLink: (...a) => calls.push(j(a)) })
  ui.find('button', 'Link selected').props.onClick()
  assert.equal(calls[0][1].emailMatch, true)
})

test('not-ready create without a blocked reason explains itself; force create warns about duplicates', async () => {
  const out = await html({ ...none, createReadiness: { ready: false } })
  assert.match(out, /Creation couldn’t be checked for this record\. Reload it, or Recheck it, to check again\./)
  const forced = await html({ ...base, suggestedCandidateId: null })
  assert.match(forced, /creating a new record ignores the matches listed above/)
  assert.doesNotMatch(await html({ ...none }), /ignores the matches listed above/)
})

test('force create is not offered when a listed candidate id is invalid', async () => {
  const item = { ...base, suggestedCandidateId: null, rankedCandidates: [...base.rankedCandidates, { id: 'bad', matchReasons: [], warnings: [], strength: 'Weak', linkedElsewhere: 0 }] }
  assert.doesNotMatch(await html(item), /Create new contact in Albi/)
})

test('org-first create is enabled once a source from orgFirstCreate is chosen', async () => {
  const item = { ...none, createReadiness: { ready: false, blockedReason: 'organization_not_synced', organization: { sourceId: '777' } },
    orgFirstCreate: { eligible: true, organizationName: 'Acme', referralSources: SOURCES } }
  const blank = await html(item)
  assert.match(blank, /Real Estate/); assert.match(blank, /<button[^>]*disabled=""[^>]*>Create organization and contact/)
  assert.doesNotMatch(await html(item, { referralSourceId: '5' }), /<button[^>]*disabled=""[^>]*>Create organization and contact/)
})

// ---- Task 14: workspace, queue, Albi to-do, bulk and pages ----

const CLIENTS = ['getH2ACreateBatch', 'startH2ACreateBatch', 'getH2AReviews', 'getH2ADryRunReview', 'recheckH2ADryRunReview', 'resolveH2ADryRunReview', 'bulkLinkH2AReviews',
  'createH2AOrganizationThenContact', 'skipH2ALiveReview', 'startH2ARecheckAll', 'getH2ARecheckAll', 'prepareH2AOrganizationReview',
  'prepareH2AMergedSurvivorReview', 'getH2AConflicts', 'getH2AOverview', 'prepareH2ALiveReviews']
function clients(overrides, calls, defaults) {
  return Object.fromEntries(CLIENTS.map(name => [name, (...args) => {
    calls.push({ name, args })
    return overrides[name] ? overrides[name](...args) : Promise.resolve(defaults(name, ...args))
  }]))
}
const listRow = (id, name, extra = {}) => ({ id, objectType: 'contacts', sourceId: '123', reason: 'duplicate_candidates', status: 'needs_review',
  displayName: name, identity: { email: `${id}@x.com`, organizationName: 'Lakeside' }, updatedAt: '2026-10-12T12:00:00.000Z',
  triageBucket: 'quick', triageDetails: { quickKind: 'link' }, ...extra })
const detailOf = (id, extra = {}) => ({ ...base, id, updatedAt: `2026-10-12T12:00:0${id.length % 10}.000Z`,
  sourceSnapshot: { ...base.sourceSnapshot, fullName: `Name ${id}` }, triageBucket: 'quick', triageDetails: { quickKind: 'link' }, ...extra })

async function mountWorkspace({ rows, document, ...overrides } = {}, props = {}) {
  const calls = []
  const bound = clients(overrides, calls, (name, _s, _c, arg) => name === 'getH2AReviews'
    ? { items: rows ?? [listRow('review-1', 'Jane Doe'), listRow('review-2', 'Marcus Lee')], nextCursor: null,
      bucketCounts: { quick: 2, todo: 0, decision: 1, blocked: 0, done: 0 } }
    : name === 'getH2ADryRunReview' ? { item: detailOf(arg) } : name === 'getH2ARecheckAll' ? { batch: null } : {})
  const ui = await mountComponent('ReviewWorkspace.jsx', {
    bindings: { ...bound, ...workspaceHelpers, ...sampleReview, buildResolutionConfirmation, blockedReasonCopy,
      ReviewRecord: stub('ReviewRecord'), ReviewQueue: stub('ReviewQueue'), AlbiTodo: stub('AlbiTodo'), ShortcutHelp: stub('ShortcutHelp'),
      ...(document ? { document } : {}) },
    props: { kind: 'sample', session: { access_token: 'token' }, companyId: 'company-1', tenantRevision: 0, completeTenantTransition() {}, isAdmin: true, ...props } })
  return { ...ui, calls, record: () => ui.find('ReviewRecord'), queue: () => ui.find('ReviewQueue') }
}
const candidate = { id: '456', name: 'Jane Doe', strength: 'Strong', matchReasons: ['same_email'], warnings: [], linkedElsewhere: 0 }

test('quick wins tab shows bulk link and no bulk create', async () => {
  const items = [listRow('a', 'Jane Doe'), listRow('b', 'Marcus Lee'), listRow('c', 'New Person', { triageDetails: { quickKind: 'create' } })]
  const props = { items, bucket: 'quick', selectedId: 'a', pendingIds: new Set(), errors: {}, checked: new Set(['a']), bulkLinkCount: 2,
    onSelect() {}, onToggle() {}, onSelectAll() {}, onBulkLink() {}, onRecheckSelected() {} }
  const out = await rendered('ReviewQueue.jsx', props)
  assert.match(out, /Link all exact matches \(2\)/)
  assert.match(out, /Select all in bucket/)
  assert.match(out, /Recheck selected \(1\)/)
  assert.equal((out.match(/type="checkbox"/g) ?? []).length, 3)
  assert.match(out, /Jane Doe/); assert.match(out, /Lakeside/)
  assert.doesNotMatch(out, /Create all|Bulk create|Create \d|Create selected/i)
  const decision = await rendered('ReviewQueue.jsx', { ...props, bucket: 'decision' })
  assert.doesNotMatch(decision, /Link all exact matches|Select all in bucket|type="checkbox"/)
  // The workspace counts only quick link rows that are not pending, and never offers a bulk create.
  const ui = await mountWorkspace({ rows: items })
  assert.equal(ui.queue().props.bulkLinkCount, 2)
  assert.equal(ui.queue().props.bucket, 'quick')
  assert.doesNotMatch(ui.text(), /Create all|Bulk create/i)
  assert.match(ui.text(), /Quick wins/); assert.match(ui.text(), /Needs decision/); assert.match(ui.text(), /Albi to-do/)
  const list = ui.calls.find(call => call.name === 'getH2AReviews')
  assert.equal(list.args[2].kind, 'sample'); assert.equal(list.args[2].bucket, 'quick'); assert.equal(list.args[2].limit, 100)
  ui.unmount()
})

test('bulk dialog lists names and the skip-never-force sentence', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => listRow(`r${i + 1}`, `Person ${i + 1}`))
  const ui = await mountWorkspace({ rows, bulkLinkH2AReviews: (_s, _c, items) => Promise.resolve({ results: items.map((item, i) =>
    ({ reviewId: item.reviewId, ...(i === 6 ? { status: 'skipped', reason: 'linked_elsewhere' } : i === 7 ? { status: 'failed', reason: 'error' } : { status: 'done' }) })) }) })
  assert.equal(ui.queue().props.bulkLinkCount, 8)
  ui.queue().props.onBulkLink(); await ui.flush()
  const dialog = ui.find('div', 'Each record is rechecked')
  assert.ok(dialog, 'bulk confirmation dialog opens')
  const text = textOf(ui.nodes().find(node => node.props?.role === 'dialog'))
  for (let i = 1; i <= 6; i++) assert.match(text, new RegExp(`Person ${i}`))
  assert.doesNotMatch(text, /Person 7|Person 8/)
  assert.match(text, /…and 2 more/)
  assert.match(text, /Each record is rechecked on the server first\. Any that changed are skipped, never forced\./)
  assert.equal(ui.calls.filter(call => call.name === 'bulkLinkH2AReviews').length, 0)
  ui.find('button', 'Link 8').props.onClick(); await ui.flush(); await ui.flush()
  const sent = ui.calls.filter(call => call.name === 'bulkLinkH2AReviews')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].args[2].length, 8)
  for (const item of sent[0].args[2]) {
    assert.deepEqual(Object.keys(item).sort(), ['candidateId', 'clientRequestId', 'expectedUpdatedAt', 'reviewId'])
    assert.equal(item.candidateId, '456')
  }
  assert.match(ui.text(), /6 linked/); assert.match(ui.text(), /1 skipped/); assert.match(ui.text(), /Person 7: linked elsewhere/); assert.match(ui.text(), /1 failed/)
  ui.unmount()
})

test('bulk link sends chunks of 25 and recheck selected queues one batch for those ids', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => listRow(`r${i + 1}`, `Person ${i + 1}`))
  const ui = await mountWorkspace({ rows, bulkLinkH2AReviews: (_s, _c, items) => Promise.resolve({ results: items.map(item => ({ reviewId: item.reviewId, status: 'done' })) }) })
  ui.queue().props.onBulkLink(); await ui.flush()
  ui.find('button', 'Link 30').props.onClick()
  for (let n = 0; n < 6; n++) await ui.flush()
  assert.deepEqual(ui.calls.filter(call => call.name === 'bulkLinkH2AReviews').map(call => call.args[2].length), [25, 5])
  assert.match(ui.text(), /30 linked/)
  ui.unmount()
  const again = await mountWorkspace({ rows: rows.slice(0, 3) })
  again.queue().props.onToggle('r1'); again.queue().props.onToggle('r3'); await again.flush()
  assert.equal(again.queue().props.bulkLinkCount, 2)
  again.queue().props.onRecheckSelected(); await again.flush()
  assert.equal(again.calls.filter(call => call.name === 'startH2ARecheckAll').length, 0)
  again.find('button', 'Recheck 2').props.onClick(); await again.flush()
  const start = again.calls.filter(call => call.name === 'startH2ARecheckAll')
  assert.equal(start.length, 1); assert.deepEqual(j(start[0].args[2]), { kind: 'sample', reviewIds: ['r1', 'r3'] })
  again.unmount()
})

test('409 on deferred send returns the record with the changed message', async () => {
  const ui = await mountWorkspace({ resolveH2ADryRunReview: () => Promise.reject(Object.assign(new Error('Changed'), { status: 409 })) })
  assert.equal(ui.record().props.item.id, 'review-1')
  ui.record().props.onAccept(candidate, { emailMatch: true }); await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'resolveH2ADryRunReview').length, 0, 'nothing is sent inside the undo window')
  assert.match(ui.text(), /Linking Name review-1 → Albi Jane Doe/); assert.match(ui.text(), /Undo/); assert.match(ui.text(), /Send now/)
  assert.equal(ui.record().props.item.id, 'review-2', 'auto-advances to the next record')
  assert.ok(ui.queue().props.pendingIds.has('review-1'))
  // A second accept of the same pending record is refused by the queue: no second toast and no advance.
  ui.queue().props.onSelect('review-1'); await ui.flush()
  ui.record().props.onAccept(candidate, { emailMatch: true }); await ui.flush()
  assert.equal((ui.text().match(/Linking Name review-1/g) ?? []).length, 1)
  assert.equal(ui.record().props.item.id, 'review-1')
  assert.equal(ui.record().props.pending, true)
  await ui.tick(); await ui.flush()
  const sent = ui.calls.filter(call => call.name === 'resolveH2ADryRunReview')
  assert.equal(sent.length, 1)
  assert.deepEqual({ ...sent[0].args[2] }, { reviewId: 'review-1', expectedUpdatedAt: detailOf('review-1').updatedAt,
    clientRequestId: sent[0].args[2].clientRequestId, action: 'link_existing', candidateId: '456', approveManyToOne: false, ignoreContactDifferences: true })
  assert.equal(ui.queue().props.errors['review-1'], 'This record changed; review it again.')
  assert.ok(ui.queue().props.items.some(item => item.id === 'review-1'), 'the record stays in its bucket')
  assert.equal(ui.queue().props.pendingIds.has('review-1'), false)
  ui.queue().props.onSelect('review-1'); await ui.flush()
  assert.match(ui.text(), /This record changed; review it again\./)
  ui.unmount()
})

test('undo cancels a deferred action before anything is written; unmount flushes the rest', async () => {
  const ui = await mountWorkspace()
  ui.record().props.onAccept(candidate, { emailMatch: false }); await ui.flush()
  ui.find('button', 'Undo').props.onClick(); await ui.flush()
  assert.match(ui.text(), /Nothing was written/)
  assert.equal(ui.record().props.item.id, 'review-1')
  await ui.tick()
  assert.equal(ui.calls.filter(call => call.name === 'resolveH2ADryRunReview').length, 0)
  ui.record().props.onCreate({ referralSourceId: '9' }); await ui.flush()
  assert.ok(ui.listeners.beforeunload?.size, 'beforeunload guard while pending')
  ui.unmount(); await ui.flush()
  const sent = ui.calls.filter(call => call.name === 'resolveH2ADryRunReview')
  assert.equal(sent.length, 1); assert.equal(sent[0].args[2].action, 'create_albi'); assert.equal(sent[0].args[2].referralSourceId, '9')
})

test('risky actions open a dialog and send immediately on confirm', async () => {
  const ui = await mountWorkspace()
  ui.record().props.onForceCreate({ referralSourceId: '9', ignoredCandidateIds: ['456'] }); await ui.flush()
  assert.ok(ui.nodes().find(node => node.props?.role === 'dialog'))
  assert.match(ui.text(), /may create a duplicate/)
  ui.find('button', 'Create separate record').props.onClick(); await ui.flush()
  const sent = ui.calls.filter(call => call.name === 'resolveH2ADryRunReview')
  assert.equal(sent.length, 1); assert.equal(sent[0].args[2].action, 'force_create_albi')
  assert.doesNotMatch(ui.text(), /Send now/)
  // The many-to-one dialog inside the record already confirmed; the link is sent at once with approval.
  ui.record().props.onLink(candidate, { approveManyToOne: true }); await ui.flush()
  const link = ui.calls.filter(call => call.name === 'resolveH2ADryRunReview').at(-1).args[2]
  assert.equal(link.action, 'link_existing'); assert.equal(link.approveManyToOne, true)
  ui.unmount()
})

test('org-first contact error is shown on the record beside a created organization, never as success', async () => {
  const ui = await mountWorkspace({ getH2ADryRunReview: (_s, _c, id) => Promise.resolve({ item: detailOf(id, id === 'review-1'
    ? { orgFirstCreate: { eligible: true, organizationReviewId: 'org-review', organizationName: 'Acme' } } : {}) }),
  createH2AOrganizationThenContact: () => Promise.resolve({ organization: { resolution: { status: 'completed' } }, contact: { error: 'Albi rejected the contact.', status: 409 } }) })
  ui.record().props.onCreateWithOrganization({ referralSourceId: '9' }); await ui.flush()
  assert.match(ui.text(), /Creating organization Acme, then Name review-1/)
  await ui.tick(); await ui.flush(); await ui.flush()
  const sent = ui.calls.find(call => call.name === 'createH2AOrganizationThenContact').args[2]
  assert.equal(sent.referralSourceId, '9'); assert.equal(sent.organizationReviewId, 'org-review'); assert.ok(sent.organizationExpectedUpdatedAt)
  assert.match(ui.queue().props.errors['review-1'], /organization was created/i)
  assert.match(ui.queue().props.errors['review-1'], /Albi rejected the contact\./)
  ui.unmount()
})

test('albi to-do groups tasks with copy buttons and a recheck-done count', async () => {
  const calls = []
  const task = (targetId, fields, objectType = 'contacts') => ({ provider: 'albi', objectType, targetId, fields })
  const waiting = (id, tasks) => ({ ...base, id, reviewKind: id === 'b' || id === 'c' ? 'live' : 'sample', resolution: { id: `aaaaaaaa-0000-4000-8000-00000000000${{ a: 1, b: 2, c: 3 }[id]}`, status: 'waiting_on_albi', action: 'resolve_fields', objectType: 'contacts',
    events: [{ id: `bbbbbbbb-0000-4000-8000-00000000000${{ a: 1, b: 2, c: 3 }[id]}`, eventType: 'waiting_on_albi', details: { manualTasks: tasks } }] } })
  const details = {
    a: waiting('a', [task('456', [{ field: 'phoneNumber', value: '612-555-0101' }])]),
    b: waiting('b', [task('456', [{ field: 'city', value: 'Minneapolis' }])]),
    c: waiting('c', [task('777', [{ field: 'name', value: 'Acme Inc' }, { field: 'domain', value: 'acme.com' }], 'companies')]),
  }
  const bound = clients({}, calls, (name, _s, _c, arg) => name === 'getH2AReviews'
    ? { items: arg.kind === 'live' ? [listRow('b', 'Bea'), listRow('c', 'Acme')] : [listRow('a', 'Ann')], nextCursor: null }
    : name === 'getH2ADryRunReview' ? { item: details[arg] } : name === 'getH2ARecheckAll' ? { batch: { id: 'x', status: 'completed' } } : { batch: { id: 'x', status: 'queued' } })
  const ui = await mountComponent('AlbiTodo.jsx', { bindings: { ...bound, ...sampleReview },
    props: { session: { access_token: 'token' }, companyId: 'company-1', tenantKey: 'company-1:0' },
    storage: { 'h2a.albiTodo.company-1': JSON.stringify(['gone-resolution:abc']) } })
  await ui.flush()
  const lists = calls.filter(call => call.name === 'getH2AReviews').map(call => [call.args[2].kind, call.args[2].bucket])
  assert.deepEqual(lists.sort(), [['live', 'todo'], ['sample', 'todo']])
  const albiLinks = ui.all('a').filter(node => textOf(node).includes('Open in Albi'))
  assert.equal(albiLinks.length, 2, 'one group per Albi record')
  assert.match(albiLinks.map(node => node.props.href).join(' '), /Contact\/456/)
  assert.equal(ui.all('button').filter(node => textOf(node) === 'Copy').length, 4)
  assert.match(ui.text(), /612-555-0101/); assert.match(ui.text(), /Minneapolis/); assert.match(ui.text(), /acme\.com/)
  assert.doesNotMatch(ui.storage.get('h2a.albiTodo.company-1') ?? '[]', /gone-resolution/, 'stale ticks are dropped')
  const recheck = () => ui.all('button').find(node => textOf(node).startsWith('Recheck done'))
  assert.match(textOf(recheck()), /Recheck done \(0\)/); assert.equal(recheck().props.disabled, true)
  const boxes = () => ui.all('input').filter(node => node.props.type === 'checkbox')
  assert.equal(boxes().length, 3)
  ui.all('button').filter(node => textOf(node) === 'Copy')[0].props.onClick()
  assert.equal(ui.clipboard.length, 1)
  boxes()[0].props.onChange({ target: { checked: true } }); await ui.flush()
  boxes()[2].props.onChange({ target: { checked: true } }); await ui.flush()
  assert.match(textOf(recheck()), /Recheck done \(2\)/)
  assert.match(ui.storage.get('h2a.albiTodo.company-1'), /aaaaaaaa-0000-4000-8000-000000000001:/)
  recheck().props.onClick(); await ui.flush()
  const started = calls.filter(call => call.name === 'startH2ARecheckAll').map(call => ({ ...call.args[2], reviewIds: [...call.args[2].reviewIds] }))
  assert.equal(started.length, 2, 'one batch per kind')
  assert.deepEqual(started.sort((x, y) => x.kind.localeCompare(y.kind)), [{ kind: 'live', reviewIds: ['c'] }, { kind: 'sample', reviewIds: ['a'] }])
  await ui.tick(); await ui.flush()
  assert.ok(calls.filter(call => call.name === 'getH2AReviews').length >= 4, 'reloads after the batches finish')
  ui.unmount()
})

test('conflicts page renders the same workspace with kind live', async () => {
  const calls = []
  let prepared = 0
  const bound = clients({ prepareH2ALiveReviews: () => Promise.resolve(++prepared < 3 ? { captured: 2, linked: 0, nextCursor: `c${prepared}` } : { captured: 1, linked: 1, nextCursor: null }) },
    calls, name => name === 'getH2AConflicts'
      ? { items: [{ id: 'k1', object_type: 'activities', conflict_type: 'activity_delivery', reason: 'held_activity', status: 'open', source_snapshot: { name: 'Call log' }, created_at: '2026-10-12T12:00:00.000Z' },
        { id: 'k2', object_type: 'contacts', conflict_type: 'contact_match', reason: 'duplicate_candidates', status: 'open', source_snapshot: { name: 'Hidden Contact' }, created_at: '2026-10-12T12:00:00.000Z' }], nextCursor: null }
      : name === 'getH2AOverview' ? { summary: { unresolvedConflictCount: 4 } } : {})
  const ui = await mountComponent('ConflictsPage.jsx', { bindings: { ...bound, conflictEvidenceSummary: () => 'Evidence', ReviewWorkspace: stub('ReviewWorkspace') },
    context: { session: { access_token: 'token' }, companyId: 'company-1', companyName: 'Allied', isAdmin: true, tenantRevision: 0, completeTenantTransition() {} } })
  const workspace = ui.find('ReviewWorkspace')
  assert.equal(workspace.props.kind, 'live'); assert.equal(workspace.props.companyId, 'company-1')
  assert.match(ui.text(), /4 unresolved/)
  assert.match(ui.text(), /Call log/); assert.doesNotMatch(ui.text(), /Hidden Contact/)
  assert.doesNotMatch(ui.json(), new RegExp('Conflict' + 'Detail'))
  const reloadBefore = workspace.props.reloadToken
  ui.find('button', 'Prepare open conflicts for review').props.onClick()
  for (let n = 0; n < 4; n++) await ui.flush()
  assert.deepEqual(calls.filter(call => call.name === 'prepareH2ALiveReviews').map(call => call.args[2].cursor), [undefined, 'c1', 'c2'])
  assert.notEqual(ui.find('ReviewWorkspace').props.reloadToken, reloadBefore)
  assert.match(ui.text(), /5 captured/)
  ui.unmount()
  const member = await mountComponent('ConflictsPage.jsx', { bindings: { ...bound, conflictEvidenceSummary: () => '', ReviewWorkspace: stub('ReviewWorkspace') },
    context: { session: { access_token: 'token' }, companyId: 'company-1', isAdmin: false, tenantRevision: 0, completeTenantTransition() {} } })
  assert.equal(member.find('button', 'Prepare open conflicts for review'), undefined)
  member.unmount()
})

// ---- Task 14 fix round 1 ----

const key = (k, extra = {}) => ({ key: k, target: null, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra })
const press = (ui, k, extra) => { for (const fn of ui.listeners.keydown ?? []) fn(key(k, extra)) }

test('after a StrictMode double mount, deferred sends still apply their result and the 409 message', async () => {
  let reject = true
  const moved = new Set()
  const ui = await mountWorkspace({
    resolveH2ADryRunReview: (_s, _c, input) => { if (reject) return Promise.reject(Object.assign(new Error('Changed'), { status: 409 })); moved.add(input.reviewId); return Promise.resolve({}) },
    getH2ADryRunReview: (_s, _c, id) => Promise.resolve({ item: detailOf(id, moved.has(id) ? { triageBucket: 'done' } : {}) }),
  })
  await ui.strictRemount()
  assert.equal(ui.record().props.item.id, 'review-1')
  ui.record().props.onAccept(candidate, { emailMatch: false }); await ui.flush()
  await ui.tick(); await ui.flush(); await ui.flush()
  assert.equal(ui.queue().props.errors['review-1'], 'This record changed; review it again.')
  reject = false
  ui.queue().props.onSelect('review-2'); await ui.flush()
  ui.record().props.onAccept(candidate, { emailMatch: false }); await ui.flush()
  await ui.tick(); await ui.flush(); await ui.flush()
  assert.ok(!ui.queue().props.items.some(item => item.id === 'review-2'), 'afterWrite moves the record out of its bucket')
  ui.unmount()
})

test('a tenant change clears the previous company bucket counts and any open dialog', async () => {
  const ui = await mountWorkspace({ getH2AReviews: (_s, company) => company === 'company-2' ? Promise.reject(new Error('Service unavailable'))
    : Promise.resolve({ items: [listRow('review-1', 'Jane Doe')], nextCursor: null, bucketCounts: { quick: 7, todo: 3, decision: 1, blocked: 0, done: 0 } }) })
  assert.match(ui.text(), /Quick wins7/)
  ui.record().props.onForceCreate({ referralSourceId: '9', ignoredCandidateIds: ['456'] }); await ui.flush()
  assert.ok(ui.nodes().find(node => node.props?.role === 'dialog'))
  await ui.rerender({ companyId: 'company-2', tenantRevision: 1 }); await ui.flush()
  assert.match(ui.text(), /Service unavailable/)
  assert.doesNotMatch(ui.text(), /Quick wins7|Albi to-do3/)
  assert.match(ui.text(), /Quick wins—/)
  assert.equal(ui.nodes().find(node => node.props?.role === 'dialog'), undefined)
  ui.unmount()
})

test('albi to-do drops the previous company groups and ticks on a tenant change', async () => {
  const calls = []
  const task = { provider: 'albi', objectType: 'contacts', targetId: '456', fields: [{ field: 'phoneNumber', value: '612-555-0101' }] }
  const item = { ...base, id: 'a', resolution: { id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'waiting_on_albi', action: 'resolve_fields', objectType: 'contacts',
    events: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', eventType: 'waiting_on_albi', details: { manualTasks: [task] } }] } }
  const bound = clients({ getH2AReviews: (_s, company, query) => company === 'company-2' ? Promise.reject(new Error('Service unavailable'))
    : Promise.resolve({ items: query.kind === 'sample' ? [listRow('a', 'Ann')] : [], nextCursor: null }) },
  calls, name => name === 'getH2ADryRunReview' ? { item } : {})
  const ui = await mountComponent('AlbiTodo.jsx', { bindings: { ...bound, ...sampleReview },
    props: { session: { access_token: 'token' }, companyId: 'company-1', tenantKey: 'company-1:0' },
    storage: { 'h2a.albiTodo.company-2': JSON.stringify(['other:tick']) } })
  await ui.flush()
  assert.match(ui.text(), /612-555-0101/)
  ui.all('input').find(node => node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); await ui.flush()
  await ui.rerender({ companyId: 'company-2', tenantKey: 'company-2:1' }); await ui.flush()
  assert.match(ui.text(), /Service unavailable/)
  assert.doesNotMatch(ui.text(), /612-555-0101|Open in Albi/)
  assert.match(ui.text(), /Recheck done \(0\)/)
  ui.unmount()
})

test('workspace shortcuts are ignored while another modal (the many-to-one approval) is open', async () => {
  let modalOpen = true
  const document = { activeElement: null, querySelector: selector => modalOpen && selector.includes('aria-modal') ? {} : null }
  const ui = await mountWorkspace({ document })
  press(ui, 'j'); press(ui, 't'); await ui.flush()
  assert.equal(ui.record().props.item.id, 'review-1')
  assert.equal(ui.find('AlbiTodo'), undefined)
  press(ui, 'j', { target: { closest: selector => selector.includes('dialog') ? {} : null } }); modalOpen = false; await ui.flush()
  assert.equal(ui.record().props.item.id, 'review-1', 'a key from inside a dialog is ignored too')
  press(ui, 'j'); await ui.flush()
  assert.equal(ui.record().props.item.id, 'review-2')
  ui.unmount()
})

test('bulk rows whose detail cannot be loaded count as failed, not skipped', async () => {
  const rows = [listRow('r1', 'Person 1'), listRow('r2', 'Person 2')]
  const ui = await mountWorkspace({ rows, getH2ADryRunReview: (_s, _c, id) => id === 'r2' ? Promise.reject(new Error('Network down')) : Promise.resolve({ item: detailOf(id) }),
    bulkLinkH2AReviews: (_s, _c, items) => Promise.resolve({ results: items.map(item => ({ reviewId: item.reviewId, status: 'done' })) }) })
  ui.queue().props.onBulkLink(); await ui.flush()
  ui.find('button', 'Link 2').props.onClick(); for (let n = 0; n < 4; n++) await ui.flush()
  const sent = ui.calls.filter(call => call.name === 'bulkLinkH2AReviews')
  assert.deepEqual(j(sent.map(call => call.args[2].map(item => item.reviewId))), [['r1']])
  assert.match(ui.text(), /1 linked, 0 skipped, 1 failed/)
  assert.doesNotMatch(ui.text(), /no longer an exact match/)
  ui.unmount()
})

test('members get a read-only workspace: no mutation controls, no writing shortcuts, no bulk', async () => {
  const ui = await mountWorkspace({}, { isAdmin: false, readOnly: true })
  const record = ui.record().props
  assert.equal(record.readOnly, true)
  for (const handler of ['onAccept', 'onLink', 'onCreate', 'onForceCreate', 'onCreateWithOrganization', 'onApplyFields', 'onChooseOrganization', 'onSkip']) assert.equal(record[handler], undefined, handler)
  assert.equal(ui.queue().props.bulkEnabled, false)
  await record.onRecheck(); press(ui, 'r'); press(ui, 'x'); await ui.flush()
  assert.equal(ui.calls.filter(call => call.name === 'recheckH2ADryRunReview').length, 0)
  assert.equal(ui.queue().props.checked.size, 0)
  press(ui, 'j'); await ui.flush()
  assert.equal(ui.record().props.item.id, 'review-2', 'navigation still works')
  ui.unmount()
  const out = await html(base, { readOnly: true })
  assert.doesNotMatch(out, /Accept suggestion|Link selected|Create in Albi|Referral source…/)
  assert.match(out, /read-only for your role/)
  const { readFile } = await import('node:fs/promises')
  const source = file => readFile(new URL(`../../src/features/hubspotToAlbi/${file}`, import.meta.url), 'utf8')
  const page = await source('SampleReviewPage.jsx'), conflicts = await source('ConflictsPage.jsx')
  assert.match(page, /readOnly=\{!isAdmin\}/); assert.match(conflicts, /readOnly=\{!isAdmin\}/)
})

test('the confirm dialog starts focused on Confirm so Enter confirms; Enter elsewhere in it confirms through the window handler', async () => {
  const ui = await mountWorkspace()
  ui.record().props.onForceCreate({ referralSourceId: '9', ignoredCandidateIds: ['456'] }); await ui.flush()
  const confirm = ui.all('button').find(node => node.props['data-dialog-confirm'])
  assert.match(textOf(confirm), /Create separate record/)
  assert.ok(confirm.props.ref, 'Confirm holds the initial-focus ref')
  assert.ok(!ui.all('button').some(node => textOf(node).startsWith('Cancel') && node.props.ref), 'Cancel is not the initial focus')
  press(ui, 'Enter'); await ui.flush()
  const sent = ui.calls.filter(call => call.name === 'resolveH2ADryRunReview')
  assert.equal(sent.length, 1); assert.equal(sent[0].args[2].action, 'force_create_albi')
  assert.equal(ui.nodes().find(node => node.props?.role === 'dialog'), undefined)
  ui.unmount()
})

// Ported from the removed detail and resolution component suites.
test('job-title-only differences render with both labelled sides', async () => {
  const item = { ...base, reason: 'nonblank_field_difference', sourceSnapshot: { id: '123', jobTitle: 'Engineer' },
    candidateSnapshots: [{ id: '456', jobTitle: 'Manager' }], proposedChanges: { conflicts: { jobTitle: { proposed: 'Engineer', current: 'Manager' } } } }
  const out = await html(item)
  assert.match(out, /Job title/); assert.match(out, /Engineer/); assert.match(out, /Manager/)
})

test('record content is escaped, never injected as markup', async () => {
  const out = await html({ ...base, sourceSnapshot: { ...base.sourceSnapshot, firstName: '<script>alert(1)</script>' } })
  assert.equal(out.includes('<script>'), false)
})

test('waiting audit shows provider success and the Albi link; completed audit drops the earlier reminder', async () => {
  const event = (id, eventType, details) => ({ id, eventType, createdAt: base.updatedAt, ...(details ? { details } : {}) })
  const resolution = status => ({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', reviewId: base.id, runId: base.runId, portalId: '321', sourceId: '123',
    objectType: 'contacts', action: 'resolve_fields', status, events: [event('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'provider_applied'),
      event('ffffffff-ffff-4fff-8fff-ffffffffffff', 'waiting_on_albi', { manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '456',
        fields: [{ field: 'firstName', value: 'Alex' }] }] }), ...(status === 'completed' ? [event('99999999-9999-4999-8999-999999999999', 'completed')] : [])] })
  const waiting = await html({ ...base, resolution: resolution('waiting_on_albi') })
  assert.match(waiting, /Update this contact in Albi/)
  assert.match(waiting, /https:\/\/app\.albiware\.com\/Relationships\/Contact\/456/)
  const done = await html({ ...base, resolution: resolution('completed') })
  assert.doesNotMatch(done, /Update this contact in Albi/)
})

test('blocked create names the exact missing Albi default', async () => {
  const out = await html({ ...none, createReadiness: { ready: false, blockedReason: 'referrer_type_missing' } })
  assert.match(out, /Referrer/); assert.doesNotMatch(out, /Create in Albi/)
})

test('workspace dialogs trap focus, close on Escape, and writes carry the audit keys', async () => {
  const dir2 = new URL('../../src/features/hubspotToAlbi/', import.meta.url)
  const workspace = await readFile(new URL('ReviewWorkspace.jsx', dir2), 'utf8')
  const many = await readFile(new URL('ManyToOneDialog.jsx', dir2), 'utf8')
  for (const source of [workspace, many]) {
    assert.match(source, /role="dialog"/); assert.match(source, /aria-modal="true"/)
    assert.match(source, /'Escape'/); assert.match(source, /event\.key !== 'Tab'/)
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML/)
  }
  assert.match(workspace, /expectedUpdatedAt/); assert.match(workspace, /clientRequestId/)
  assert.match(many, /approveManyToOne|Approve/)
})

const sentResolutions = ui => ui.calls.filter(call => call.name === 'resolveH2ADryRunReview').map(call => call.args[2])

test('HubSpot field writes are dialog-gated: nothing is sent until confirmed, then exactly once', async () => {
  const ui = await mountWorkspace()
  ui.record().props.onApplyFields({ email: 'albi' }); await ui.flush()
  assert.ok(ui.nodes().find(node => node.props?.role === 'dialog'))
  assert.match(ui.text(), /Update HubSpot now\?/)
  await ui.tick(); await ui.flush()
  assert.equal(sentResolutions(ui).length, 0, 'no send while the dialog is open, even after the undo window')
  ui.find('button', 'Update HubSpot').props.onClick(); await ui.flush()
  const sent = sentResolutions(ui)
  assert.equal(sent.length, 1); assert.equal(sent[0].action, 'resolve_fields'); assert.deepEqual({ ...sent[0].fieldChoices }, { email: 'albi' })
  await ui.tick(); await ui.flush()
  assert.equal(sentResolutions(ui).length, 1)
  ui.unmount()
})

test('adding a HubSpot association is dialog-gated: nothing is sent until confirmed, then exactly once', async () => {
  const ui = await mountWorkspace()
  ui.record().props.onChooseOrganization({ organizationSourceId: '777', addHubSpotAssociation: true }); await ui.flush()
  assert.ok(ui.nodes().find(node => node.props?.role === 'dialog'))
  assert.match(ui.text(), /Add a HubSpot association\?/)
  await ui.tick(); await ui.flush()
  assert.equal(sentResolutions(ui).length, 0)
  ui.find('button', 'Add association').props.onClick(); await ui.flush()
  const sent = sentResolutions(ui)
  assert.equal(sent.length, 1); assert.equal(sent[0].action, 'choose_organization'); assert.equal(sent[0].addHubSpotAssociation, true)
  ui.unmount()
})

test('retrying a failed send of the same decision reuses its clientRequestId', async () => {
  let attempt = 0
  const ui = await mountWorkspace({ resolveH2ADryRunReview: () => (++attempt === 1 ? Promise.reject(new Error('Network down')) : Promise.resolve({ item: null })) })
  ui.record().props.onCreate({ referralSourceId: '9' }); await ui.flush()
  await ui.tick(); await ui.flush()
  assert.equal(sentResolutions(ui).length, 1)
  ui.queue().props.onSelect('review-1'); await ui.flush()
  ui.record().props.onCreate({ referralSourceId: '9' }); await ui.flush()
  await ui.tick(); await ui.flush()
  ui.queue().props.onSelect('review-1'); await ui.flush()
  ui.record().props.onCreate({ referralSourceId: '5' }); await ui.flush()
  await ui.tick(); await ui.flush()
  const sent = sentResolutions(ui)
  assert.equal(sent.length, 3)
  assert.equal(sent[1].clientRequestId, sent[0].clientRequestId, 'same decision and version: same id')
  assert.notEqual(sent[2].clientRequestId, sent[0].clientRequestId, 'a changed decision gets a new id')
  ui.unmount()
})

test('with candidates listed, Create new contact in Albi is always shown, disabled with the reason when not ready', async () => {
  const blocked = await mount({ ...base, suggestedCandidateId: null, forceCreateReadiness: { eligible: true, ready: false, blockedReason: 'evidence_unavailable' } }, { referralSourceId: '5' })
  const button = blocked.find('button', 'Create new contact in Albi')
  assert.ok(button)
  assert.equal(button.props.disabled, true)
  assert.match(blocked.text(), /didn.t finish in time/)
  const unknown = await mount({ ...base, suggestedCandidateId: null, forceCreateReadiness: { eligible: false, ready: false } }, { referralSourceId: '5' })
  assert.equal(unknown.find('button', 'Create new contact in Albi').props.disabled, true)
  assert.match(unknown.text(), /Reload or Recheck this record/)
  const organization = await html({ ...base, objectType: 'companies', suggestedCandidateId: null })
  assert.match(organization, /Create new organization in Albi/)
})

test('field differences can be ignored to just link, for contacts and organizations', async () => {
  const item = { ...base, reason: 'nonblank_field_difference', proposedChanges: { conflicts: { jobTitle: { proposed: 'Lead', current: 'Analyst' }, city: { proposed: 'A', current: 'B' } } },
    candidateSnapshots: [{ id: '456', firstName: 'Janet', jobTitle: 'Analyst', city: 'B' }], suggestedCandidateId: null }
  const calls = []
  const ui = await mount(item, { onIgnoreAndLink: (target, fields) => calls.push([target.id, fields]) })
  ui.find('button', 'Link and ignore differences').props.onClick()
  assert.deepEqual(j(calls), [['456', ['city', 'jobTitle']]])
  const organization = await html({ ...item, objectType: 'companies', proposedChanges: { conflicts: { phoneNumber: { proposed: '1', current: '2' } } },
    candidateSnapshots: [{ id: '456', name: 'Acme', phoneNumber: '2' }] })
  assert.match(organization, /Link and ignore differences/)
})

test('ignoring differences asks once, listing the fields, then links', async () => {
  const ui = await mountWorkspace()
  ui.record().props.onIgnoreAndLink(candidate, ['city', 'jobTitle']); await ui.flush()
  assert.ok(ui.nodes().find(node => node.props?.role === 'dialog'))
  assert.match(ui.text(), /City/); assert.match(ui.text(), /Job title/)
  ui.find('button', 'Link and ignore').props.onClick(); await ui.flush()
  const sent = ui.calls.filter(call => call.name === 'resolveH2ADryRunReview').at(-1).args[2]
  assert.equal(sent.action, 'link_existing'); assert.deepEqual(j(sent.ignoredFields), ['city', 'jobTitle']); assert.equal(sent.candidateId, '456')
  ui.unmount()
})

test('a field HubSpot leaves blank offers only Use Albi and can be applied on its own', async () => {
  const item = { ...base, reason: 'nonblank_field_difference', sourceSnapshot: { id: '123', firstName: 'Jane', lastName: 'Doe' },
    proposedChanges: {}, candidateSnapshots: [{ id: '456', firstName: 'Jane', lastName: 'Doe', jobTitle: 'Analyst' }], suggestedCandidateId: null }
  const calls = []
  const ui = await mount(item, { onApplyFields: value => calls.push(value) })
  const group = ui.nodes().find(node => node.props?.['aria-label'] === 'Keep which Job title')
  assert.ok(group)
  assert.doesNotMatch(JSON.stringify(group.children), /Use HubSpot/)
  ui.find('button', 'Use Albi').props.onClick(); ui.run()
  ui.find('button', 'Apply field choices').props.onClick()
  assert.deepEqual(j(calls), [{ jobTitle: 'albi' }])
})

test('quick wins offers Create selected for no-match rows', async () => {
  const items = [listRow('a', 'Jane Doe', { triageDetails: { quickKind: 'create' } }), listRow('b', 'Marcus Lee')]
  const props = { items, bucket: 'quick', selectedId: 'a', pendingIds: new Set(), errors: {}, checked: new Set(['a']), bulkLinkCount: 1, createSelectedCount: 1,
    onSelect() {}, onToggle() {}, onSelectAll() {}, onBulkLink() {}, onRecheckSelected() {}, onCreateSelected() {} }
  const out = await rendered('ReviewQueue.jsx', props)
  assert.match(out, /Create selected \(1\)/)
  assert.doesNotMatch(await rendered('ReviewQueue.jsx', { ...props, bucket: 'decision' }), /Create selected/)
})

test('Create selected asks for one referral source, starts a background batch and reports the outcome', async () => {
  const rows = [listRow('a', 'Jane Doe', { triageDetails: { quickKind: 'create' } }), listRow('b', 'Marcus Lee', { triageDetails: { quickKind: 'create' } }), listRow('c', 'Linky')]
  let polls = 0
  const ui = await mountWorkspace({ rows,
    getH2ADryRunReview: async (_s, _c, id) => ({ item: detailOf(id, { updatedAt: '2026-10-12T12:00:00.000Z',
      triageDetails: { quickKind: id === 'c' ? 'link' : 'create' } }) }),
    getH2ACreateBatch: async () => ({ referralSources: [{ id: '5', label: 'Network' }],
      batch: polls++ === 0 ? null : { id: 'b1', status: 'completed', total: 2, done: 2, created: 1, skipped: 1, failed: 0 } }),
    startH2ACreateBatch: async () => ({ status: 'queued', batch: { id: 'b1', status: 'queued', total: 2, done: 0, created: 0, skipped: 0, failed: 0 } }) },
  { createBatchPollMs: 1 })
  assert.equal(ui.queue().props.createSelectedCount, 2)
  await ui.queue().props.onCreateSelected(); await ui.flush()
  assert.match(ui.text(), /Jane Doe/); assert.match(ui.text(), /Marcus Lee/)
  const confirm = ui.find('button', 'Create 2 in Albi')
  assert.equal(confirm.props.disabled, true)
  ui.find('select', 'Referral source').props.onChange({ target: { value: '5' } }); await ui.flush()
  ui.find('button', 'Create 2 in Albi').props.onClick(); await ui.flush()
  const started = ui.calls.find(call => call.name === 'startH2ACreateBatch')
  assert.deepEqual(j(started.args[2]), { kind: 'sample', referralSourceId: '5', items: [{ reviewId: 'a', expectedUpdatedAt: '2026-10-12T12:00:00.000Z' }, { reviewId: 'b', expectedUpdatedAt: '2026-10-12T12:00:00.000Z' }] })
  assert.match(ui.text(), /Creating in Albi: 0 of 2 done/)
  for (let i = 0; i < 5 && !/Create selected finished/.test(ui.text()); i++) await ui.tick()
  assert.match(ui.text(), /Create selected finished: 1 created, 1 skipped, 0 failed/)
  ui.unmount()
})

test('an organization whose only differences are HubSpot blanks can fill from Albi or just link', async () => {
  const item = { ...base, objectType: 'companies', reason: 'nonblank_field_difference', proposedChanges: {},
    sourceSnapshot: { id: '123', name: 'Mercury Insurance', phoneNumber: '(800) 503-3724' },
    candidateSnapshots: [{ id: '575110', name: 'Mercury Insurance', phoneNumber: '(800) 503-3724', city: 'Santa Ana', zipcode: '92702', country: 'USA' }],
    rankedCandidates: [{ id: '575110', matchReasons: ['same_name', 'same_phone'], warnings: [], strength: 'Likely', linkedElsewhere: 0 }], suggestedCandidateId: null }
  const calls = []
  const ui = await mount(item, { onIgnoreAndLink: (target, fields) => calls.push([target.id, fields]) })
  assert.ok(ui.find('button', 'Use Albi'))
  ui.find('button', 'Link and ignore differences').props.onClick()
  assert.deepEqual(j(calls), [['575110', ['city', 'country', 'zipcode']]])
})
