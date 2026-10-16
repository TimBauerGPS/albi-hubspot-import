import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { presentSampleReviewItem } from '../../src/features/hubspotToAlbi/sampleReview.js'
import { buildResolutionConfirmation } from '../../src/features/hubspotToAlbi/sampleReviewResolution.js'
import { mountSampleReviewResolution } from './ui-render-fixture.mjs'

const url = new URL('../../src/features/hubspotToAlbi/SampleReviewResolution.jsx', import.meta.url)
const base = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  objectType: 'contacts', portalId: '321', sourceId: '123', status: 'needs_review', reason: 'nonblank_field_difference',
  updatedAt: '2026-10-12T12:00:00.000Z', sourceSnapshot: { id: '123', firstName: 'Alex', lastName: 'Stone' },
  candidateSnapshots: [{ id: '456', firstName: 'Alec', lastName: 'Stone' }],
  proposedChanges: { conflicts: { firstName: { proposed: 'Alex', current: 'Alec' } } },
  resolutionCapability: { enabled: true, mode: 'admins', canResolve: true, hubspotWrites: 'verified_when_first_used' } }

async function render(item = base, extra = {}) {
  const source = await readFile(url, 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export default function', 'function'),
    { loader: 'jsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code
  const Component = vm.runInNewContext(`${code}\nSampleReviewResolution`, {
    h: createElement, Fragment, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: value => ({ current: value }), useEffect() {}, useMemo: callback => callback(),
    presentSampleReviewItem, buildResolutionConfirmation, crypto: { randomUUID: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    document: { activeElement: null }, Date, Intl, Object, Set,
  })
  return renderToStaticMarkup(createElement(Component, { item, onResolve() {}, ...extra }))
}

const mount = (item = base, onResolve = async () => ({ resolution: { status: 'ready_to_recheck' } })) =>
  mountSampleReviewResolution(item, onResolve)

test('read-only capability never renders resolution mutation controls', async () => {
  for (const capability of [{ enabled: false, mode: 'disabled', canResolve: false },
    { enabled: true, mode: 'admins', canResolve: false }]) {
    const html = await render({ ...base, resolutionCapability: capability })
    assert.match(html, /read-only|unavailable/i)
    assert.doesNotMatch(html, /Use HubSpot|Use Albi|Review resolution|Create in Albi|Link selected/)
  }
})

test('field resolution shows explicit destination choices and validated provider links', async () => {
  const html = await render()
  assert.match(html, /Use HubSpot/); assert.match(html, /Use Albi/)
  assert.match(html, /Updates HubSpot now/); assert.match(html, /You’ll update this in Albi/)
  assert.match(html, /https:\/\/app\.hubspot\.com\/contacts\/321\/record\/0-1\/123/)
  assert.match(html, /https:\/\/app\.albiware\.com\/Relationships\/Contact\/456/)
  assert.match(html, /target="_blank" rel="noreferrer"/)
})

test('identity and organization controls require eligible evidence', async () => {
  const identity = await render({ ...base, reason: 'name_only_candidate', proposedChanges: {} })
  assert.match(identity, /Link.*Albi/i)
  assert.doesNotMatch(identity, /Create in Albi/)
  const forced = await render({ ...base, reason: 'name_only_candidate', proposedChanges: {}, forceCreateReadiness: { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }, { id: '9', label: 'Real Estate' }] } })
  assert.match(forced, /These records are different/i)
  assert.match(forced, /create a new Albi record/i)
  const noCandidate = await render({ ...base, reason: 'no_match', candidateSnapshots: [], proposedChanges: {},
    createReadiness: { ready: true, referralSources: [{ id: '5', label: 'Network' }, { id: '9', label: 'Real Estate' }] } })
  assert.match(noCandidate, /Create in Albi/)
  assert.match(noCandidate, /Referral source/); assert.match(noCandidate, /Real Estate/)
  const noOrganizationEvidence = await render({ ...base, reason: 'organization_unresolved', proposedChanges: {} })
  assert.doesNotMatch(noOrganizationEvidence, /Choose organization/)
  const organization = await render({ ...base, reason: 'organization_unresolved', proposedChanges: {},
    organizationOptions: [{ sourceId: '777', targetId: '888', contactTargetId: '456',
      currentOrganizationTargetId: '999', contactUrl: 'https://app.albiware.com/Relationships/Contact/456',
      organizationUrl: 'https://app.albiware.com/Relationships/Organization/888', associated: true }] })
  assert.match(organization, /Choose organization/)
  assert.match(organization, /Existing HubSpot associations will not be removed/)
})

test('forced create confirmation names the duplicate risk and submits the audited candidate IDs', async () => {
  const calls = []
  const ui = await mount({ ...base, reason: 'name_only_candidate', proposedChanges: {},
    forceCreateReadiness: { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }, { id: '9', label: 'Real Estate' }] } }, async (...args) => {
    calls.push(args); return { resolution: { status: 'ready_to_recheck' } }
  })
  ui.find('button', 'Create a separate Albi record').props.onClick(); await ui.flush()
  assert.match(ui.text(), /Choose a referral source/)
  assert.equal(ui.find('button', 'Confirm resolution'), undefined)
  ui.find('select', 'Choose referral source').props.onChange({ target: { value: '9' } }); await ui.flush()
  ui.find('button', 'Create a separate Albi record').props.onClick(); await ui.flush()
  assert.match(ui.text(), /Referral source: ","Real Estate/)
  assert.match(ui.text(), /You’ll update this in Albi/)
  assert.match(ui.text(), /New Record created/)
  assert.match(ui.text(), /ignores 1 listed candidate/i)
  assert.match(ui.text(), /duplicate may be created/i)
  await ui.find('button', 'Confirm resolution').props.onClick(); await ui.flush()
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][0])),
    { action: 'force_create_albi', referralSourceId: '9', ignoredCandidateIds: ['456'] })
})

test('forced create explicitly confirms when its Albi organization association is deferred', async () => {
  const calls = []
  const ui = await mount({ ...base, reason: 'name_only_candidate', proposedChanges: {},
    forceCreateReadiness: { eligible: true, ready: true, referralSources: [{ id: '5', label: 'Network' }, { id: '9', label: 'Real Estate' }], deferredOrganizationSourceId: '777' } }, async (...args) => {
    calls.push(args); return { resolution: { status: 'ready_to_recheck' } }
  })
  ui.find('select', 'Choose referral source').props.onChange({ target: { value: '5' } }); await ui.flush()
  ui.find('button', 'Create a separate Albi record').props.onClick(); await ui.flush()
  assert.match(ui.text(), /organization link will be deferred/i)
  await ui.find('button', 'Confirm resolution').props.onClick(); await ui.flush()
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][0])),
    { action: 'force_create_albi', referralSourceId: '5', ignoredCandidateIds: ['456'], deferOrganizationAssociation: true })
})

test('waiting audit keeps provider success and validated manual task links visible', async () => {
  const html = await render({ ...base, resolution: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', reviewId: base.id,
    runId: base.runId, portalId: '321', sourceId: '123', objectType: 'contacts', action: 'resolve_fields', status: 'waiting_on_albi',
    events: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', eventType: 'provider_applied', createdAt: base.updatedAt },
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', eventType: 'waiting_on_albi', createdAt: base.updatedAt,
        details: { manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '456', fields: [{ field: 'firstName', value: 'Alex' }] }] } }] } })
  assert.match(html, /Waiting on Albi/); assert.match(html, /Provider change applied/)
  assert.match(html, /Open contact in Albi/)
  assert.match(html, /https:\/\/app\.albiware\.com\/Relationships\/Contact\/456/)
})

test('completed resolution keeps audit but removes earlier manual work cards', async () => {
  const resolution = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', reviewId: base.id, runId: base.runId,
    portalId: '321', sourceId: '123', objectType: 'contacts', action: 'resolve_fields', status: 'completed',
    events: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', eventType: 'waiting_on_albi', createdAt: base.updatedAt,
      details: { manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '456', fields: [{ field: 'firstName', value: 'Alex' }] }] } },
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', eventType: 'completed', createdAt: base.updatedAt }] }
  const html = await render({ ...base, resolution })
  assert.match(html, /Completed/); assert.match(html, /Waiting on Albi/)
  assert.doesNotMatch(html, /Manual Albi task/)
})

test('whole-record choice covers eligible differences and a failed retry keeps its request ID', async () => {
  const calls = []
  const ui = await mount({ ...base, proposedChanges: { conflicts: {
    firstName: { proposed: 'Alex', current: 'Alec' }, jobTitle: { proposed: 'Lead', current: 'Analyst' } } },
    candidateSnapshots: [{ id: '456', firstName: 'Alec', jobTitle: 'Analyst' }] }, async (...args) => {
    calls.push(args); if (calls.length === 1) throw Error('Provider unavailable')
    return { resolution: { status: 'ready_to_recheck' } }
  })
  ui.find('button', 'Use HubSpot for all').props.onClick(); await ui.flush()
  ui.find('button', 'Review resolution').props.onClick(); await ui.flush()
  assert.match(ui.text(), /You’ll update this in Albi/)
  assert.deepEqual(ui.nodes().filter(node => node.type === 'li').map(node => node.children.join('')),
    ['First name: Alex', 'Job title: Lead'])
  await ui.find('button', 'Confirm resolution').props.onClick(); await ui.flush()
  assert.equal(ui.find('button', 'Retry resolution') != null, true)
  await ui.find('button', 'Retry resolution').props.onClick(); await ui.flush()
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1], calls[1][1])
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][0])), { action: 'resolve_fields', fieldChoices: { firstName: 'hubspot', jobTitle: 'hubspot' } })
  ui.find('button', 'Use Albi for all').props.onClick(); await ui.flush()
  ui.find('button', 'Review resolution').props.onClick(); await ui.flush()
  assert.match(ui.text(), /Updates HubSpot now/)
  await ui.find('button', 'Confirm resolution').props.onClick(); await ui.flush()
  assert.notEqual(calls[2][1], calls[0][1])
})

test('active resolution disables duplicate confirmation and announces applying', async () => {
  let finish, calls = 0
  const pending = new Promise(resolve => { finish = resolve })
  const ui = await mount(base, async () => { calls++; return pending })
  ui.find('button', 'Use Albi for all').props.onClick(); await ui.flush()
  ui.find('button', 'Review resolution').props.onClick(); await ui.flush()
  const submit = ui.find('button', 'Confirm resolution').props.onClick()
  await ui.flush()
  assert.equal(ui.find('button', 'Applying…').props.disabled, true)
  assert.match(ui.text(), /Applying resolution/)
  const dialog = ui.nodes().find(node => node.props?.role === 'dialog')
  assert.equal(ui.nodes(dialog).some(node => node.props?.role === 'status' && JSON.stringify(node.children).includes('Applying resolution')), true)
  await ui.find('button', 'Applying…').props.onClick(); assert.equal(calls, 1)
  finish({ resolution: { status: 'waiting_on_albi' } }); await submit; await ui.flush()
  assert.match(ui.text(), /Waiting on Albi/)
})

test('dialog effects focus, announce retained failure, trap from container, and return focus', async () => {
  const ui = await mount(base, async () => { throw Error('Provider unavailable') })
  ui.find('button', 'Use HubSpot for all').props.onClick(); await ui.flush()
  const trigger = ui.find('button', 'Review resolution')
  trigger.dom.focus()
  trigger.props.onClick(); await ui.flush()
  let dialog = ui.nodes().find(node => node.props?.role === 'dialog')
  assert.equal(ui.documentState.activeElement, ui.find('button', 'Cancel').dom)
  await ui.find('button', 'Confirm resolution').props.onClick(); await ui.flush()
  dialog = ui.nodes().find(node => node.props?.role === 'dialog')
  assert.equal(ui.nodes(dialog).some(node => node.props?.role === 'alert' && JSON.stringify(node.children).includes('Provider unavailable')), true)
  assert.equal(ui.documentState.activeElement, ui.find('button', 'Retry resolution').dom)
  ui.documentState.activeElement = dialog.children[0].dom
  let prevented = false
  dialog.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(ui.documentState.activeElement, ui.find('button', 'Cancel').dom)
  ui.find('button', 'Cancel').props.onClick(); await ui.flush()
  assert.equal(ui.documentState.activeElement, trigger.dom)
})

test('confirmation traps Tab in both directions and Escape returns to the decision', async () => {
  const ui = await mount()
  ui.find('button', 'Use HubSpot for all').props.onClick(); await ui.flush()
  ui.find('button', 'Review resolution').props.onClick(); await ui.flush()
  const dialog = ui.nodes().find(node => node.props?.role === 'dialog')
  const first = { focus() { ui.documentState.activeElement = first } }
  const last = { focus() { ui.documentState.activeElement = last } }
  dialog.children[0].props.ref.current = { querySelectorAll: () => [first, last] }
  let prevented = false
  ui.documentState.activeElement = first
  dialog.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.equal(ui.documentState.activeElement, last)
  dialog.props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault() {} })
  assert.equal(ui.documentState.activeElement, first)
  dialog.props.onKeyDown({ key: 'Escape' }); await ui.flush()
  assert.equal(ui.nodes().some(node => node.props?.role === 'dialog'), false)
})

test('unassociated organization requires explicit addition and confirms the HubSpot write', async () => {
  const calls = []
  const ui = await mount({ ...base, reason: 'organization_unresolved', proposedChanges: {},
    organizationOptions: [{ sourceId: '777', targetId: '888', contactTargetId: '456', currentOrganizationTargetId: '999',
      associated: false, contactUrl: 'https://app.albiware.com/Relationships/Contact/456',
      organizationUrl: 'https://app.albiware.com/Relationships/Organization/888' }] },
  async (...args) => { calls.push(args); return { resolution: { status: 'waiting_on_albi' } } })
  const selector = ui.nodes().find(node => node.type === 'select' && JSON.stringify(node.children).includes('777'))
  selector.props.onChange({ target: { value: '777' } }); await ui.flush()
  assert.equal(ui.find('button', 'Choose organization').props.disabled, true)
  const approval = ui.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox')
  approval.props.onChange({ target: { checked: true } }); await ui.flush()
  assert.equal(ui.find('button', 'Choose organization').props.disabled, false)
  ui.find('button', 'Choose organization').props.onClick(); await ui.flush()
  assert.match(ui.text(), /Adds HubSpot association/)
  await ui.find('button', 'Confirm resolution').props.onClick(); await ui.flush()
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][0])), { action: 'choose_organization',
    organizationSourceId: '777', addHubSpotAssociation: true })
})

test('blocked create names the exact missing Albi default', async () => {
  const forced = await render({ ...base, reason: 'name_only_candidate', proposedChanges: {},
    forceCreateReadiness: { eligible: true, ready: false, blockedReason: 'salesperson_not_found' } })
  assert.match(forced, /does not exactly match one Albi salesperson/)
  assert.doesNotMatch(forced, /Choose referral source/)
  const create = await render({ ...base, reason: 'no_match', candidateSnapshots: [], proposedChanges: {},
    createReadiness: { ready: false, blockedReason: 'referrer_type_missing' } })
  assert.match(create, /Albi has no “Referrer” relationship type/)
})
