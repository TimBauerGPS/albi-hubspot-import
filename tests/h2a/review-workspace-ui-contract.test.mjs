import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

test('add new in Albi instead is the force-create path and passes every ignored candidate', async () => {
  const calls = []
  const ui = await mount({ ...base, suggestedCandidateId: null }, { referralSourceId: '5', onForceCreate: value => calls.push(value) })
  assert.equal(ui.find('button', 'Create in Albi'), undefined)
  ui.find('button', 'Add new in Albi instead').props.onClick()
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
  assert.match(out, /Creation is unavailable until the candidate and type checks are ready\. Recheck this record after correcting them\./)
  const forced = await html({ ...base, suggestedCandidateId: null })
  assert.match(forced, /can create a duplicate, so the server rechecks every record before applying it/)
  assert.doesNotMatch(await html({ ...none }), /create a duplicate/)
})

test('force create is not offered when a listed candidate id is invalid', async () => {
  const item = { ...base, suggestedCandidateId: null, rankedCandidates: [...base.rankedCandidates, { id: 'bad', matchReasons: [], warnings: [], strength: 'Weak', linkedElsewhere: 0 }] }
  assert.doesNotMatch(await html(item), /Add new in Albi instead/)
})

test('org-first create is enabled once a source from orgFirstCreate is chosen', async () => {
  const item = { ...none, createReadiness: { ready: false, blockedReason: 'organization_not_synced', organization: { sourceId: '777' } },
    orgFirstCreate: { eligible: true, organizationName: 'Acme', referralSources: SOURCES } }
  const blank = await html(item)
  assert.match(blank, /Real Estate/); assert.match(blank, /<button[^>]*disabled=""[^>]*>Create organization and contact/)
  assert.doesNotMatch(await html(item, { referralSourceId: '5' }), /<button[^>]*disabled=""[^>]*>Create organization and contact/)
})
