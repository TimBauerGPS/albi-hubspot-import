import test from 'node:test'
import assert from 'node:assert/strict'
import { fieldDiffRows, nextRecordId, REASON_LABELS, WARNING_LABELS, BUCKETS, createDeferredQueue, shortcutFor } from '../../src/features/hubspotToAlbi/reviewWorkspace.js'

const rows = (source, candidate, objectType = 'contact') => fieldDiffRows({ objectType, source, candidate })

test('whitespace and case differences in email are same', () => {
  const r = rows({ email: ' A@B.com ' }, { email: 'a@b.COM' })
  assert.equal(r.find(x => x.key === 'email').kind, 'same')
})
test('phone formats compare by digits', () => {
  const r = rows({ phoneNumber: '(555) 123-4567' }, { phoneNumber: '+1 555.123.4567' })
  assert.equal(r.find(x => x.key === 'phoneNumber').kind, 'same')
})
test('blank on both sides is hidden', () => {
  const r = rows({ email: 'a@b.com', city: '  ' }, { email: 'a@b.com' })
  assert.equal(r.some(x => x.key === 'city'), false)
})
test('differs sorts before one_side before same', () => {
  const r = rows({ email: 'a@b.com', city: 'Reno', state: 'NV', lastName: 'Lee' }, { email: 'a@b.com', city: 'Sparks', lastName: '' })
  assert.deepEqual(r.map(x => x.kind), ['differs', 'one_side', 'hubspot_only', 'same'].filter(k => r.some(x => x.kind === k)).flatMap(k => r.filter(x => x.kind === k).map(() => k)))
  assert.equal(r[0].kind, 'differs')
  assert.equal(r.at(-1).kind, 'same')
  assert.equal(r.find(x => x.key === 'state').kind, 'hubspot_only')
})
test('one_side means only Albi has a value', () => {
  assert.equal(rows({}, { city: 'Reno' }).find(x => x.key === 'city').kind, 'one_side')
})
test('contact rows omit name; organizations omit first/last', () => {
  const c = rows({ name: 'X', firstName: 'A' }, { name: 'Y', firstName: 'A' })
  assert.equal(c.some(x => x.key === 'name'), false)
  const o = rows({ name: 'X', firstName: 'A', lastName: 'B' }, { name: 'Y' }, 'organization')
  assert.equal(o.some(x => ['firstName', 'lastName'].includes(x.key)), false)
  assert.equal(o.some(x => x.key === 'name'), true)
})
test('labels and buckets', () => {
  assert.equal(REASON_LABELS.same_domain, 'Same domain')
  assert.equal(REASON_LABELS.same_email, 'Same email')
  assert.equal(WARNING_LABELS.different_email, 'Different email')
  assert.deepEqual(BUCKETS.map(b => b[0]), ['quick', 'decision', 'blocked', 'todo', 'done'])
})
test('nextRecordId wraps and skips pending', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.equal(nextRecordId(order, 'a', new Set(['b'])), 'c')
  assert.equal(nextRecordId(order, 'd', new Set(['a'])), 'b')
  assert.equal(nextRecordId(order, 'a', new Set(['b', 'c', 'd'])), null)
  assert.equal(nextRecordId(order, 'zz', new Set()), 'a')
})

function fake() {
  const timers = new Map(); let n = 0
  return { setTimer: (fn, ms) => { timers.set(++n, { fn, ms }); return n }, clearTimer: id => timers.delete(id),
    fire: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn() } }, count: () => timers.size }
}
const setup = (sendImpl) => {
  const f = fake(); const sent = []; const changes = []
  const q = createDeferredQueue({ delayMs: 5000, send: async item => { sent.push(item.id); if (sendImpl) return sendImpl(item) },
    onChange: p => changes.push(p.map(i => i.id)), setTimer: f.setTimer, clearTimer: f.clearTimer })
  return { f, sent, changes, q }
}
const item = (id, extra = {}) => ({ id, recordId: 'r' + id, label: id, payload: {}, ...extra })

test('sends once after the delay', async () => {
  const { f, sent, q, changes } = setup(); q.enqueue(item('1'))
  assert.equal(q.pending().length, 1); f.fire(); await Promise.resolve()
  assert.deepEqual(sent, ['1']); assert.equal(q.pending().length, 0); assert.ok(changes.length >= 2)
})
test('undo before the delay sends nothing', () => {
  const { f, sent, q } = setup(); q.enqueue(item('1'))
  assert.equal(q.undo('1').id, '1'); f.fire(); assert.deepEqual(sent, []); assert.equal(q.undo('1'), null)
})
test('sendNow sends immediately and the timer does not resend', async () => {
  const { f, sent, q } = setup(); q.enqueue(item('1')); await q.sendNow('1'); f.fire(); await Promise.resolve()
  assert.deepEqual(sent, ['1'])
})
test('flushAll sends every pending item once', async () => {
  const { f, sent, q } = setup(); q.enqueue(item('1')); q.enqueue(item('2')); await q.flushAll(); f.fire()
  assert.deepEqual(sent.sort(), ['1', '2']); assert.equal(q.pending().length, 0)
})
test('undo without id undoes the most recent', () => {
  const { sent, q } = setup(); q.enqueue(item('1')); q.enqueue(item('2'))
  assert.equal(q.undo().id, '2'); assert.deepEqual(q.pending().map(i => i.id), ['1']); assert.deepEqual(sent, [])
})
test('send rejection calls onError and removes the item', async () => {
  const errs = []; const boom = new Error('boom')
  const { q } = setup(() => { throw boom }); q.enqueue(item('1', { onError: e => errs.push(e) }))
  await q.sendNow('1'); assert.deepEqual(errs, [boom]); assert.equal(q.pending().length, 0)
})

const ev = (key, extra = {}) => ({ key, repeat: false, metaKey: false, ctrlKey: false, altKey: false, target: null, ...extra })
const tgt = sel => ({ closest: s => s.split(',').map(x => x.trim()).includes(sel) ? {} : null })
test('keys map', () => {
  const o = { kind: 'live', dialogOpen: false }
  const exp = { j: 'next', ArrowDown: 'next', k: 'prev', ArrowUp: 'prev', Enter: 'accept', a: 'accept', l: 'link', n: 'create', s: 'skip',
    r: 'recheck', x: 'toggle', t: 'todo', u: 'undo', '?': 'help', Escape: 'escape' }
  for (const [k, v] of Object.entries(exp)) assert.equal(shortcutFor(ev(k), o), v, k)
  assert.deepEqual(shortcutFor(ev('3'), o), { pick: 3 })
  assert.equal(shortcutFor(ev('0'), o), null)
  assert.equal(shortcutFor(ev('z'), o), null)
})
test('Enter on a focused button returns null', () => {
  const o = { kind: 'live', dialogOpen: false }
  assert.equal(shortcutFor(ev('Enter', { target: tgt('button') }), o), null)
  assert.equal(shortcutFor(ev(' ', { target: tgt('a') }), o), null)
  assert.equal(shortcutFor(ev('j', { target: tgt('button') }), o), 'next')
})
test('inputs, repeat and modifiers return null', () => {
  const o = { kind: 'live', dialogOpen: false }
  assert.equal(shortcutFor(ev('j', { repeat: true }), o), null)
  assert.equal(shortcutFor(ev('j', { target: tgt('input') }), o), null)
  assert.equal(shortcutFor(ev('j', { metaKey: true }), o), null)
  assert.equal(shortcutFor(ev('j', { ctrlKey: true }), o), null)
  assert.equal(shortcutFor(ev('j', { altKey: true }), o), null)
})
test('s is null on sample', () => {
  assert.equal(shortcutFor(ev('s'), { kind: 'sample', dialogOpen: false }), null)
})
test('dialog mode only confirms or cancels', () => {
  const o = { kind: 'live', dialogOpen: true }
  assert.equal(shortcutFor(ev('Enter'), o), 'dialogConfirm')
  assert.equal(shortcutFor(ev('Escape'), o), 'dialogCancel')
  assert.equal(shortcutFor(ev('j'), o), null)
  assert.equal(shortcutFor(ev('1'), o), null)
})
