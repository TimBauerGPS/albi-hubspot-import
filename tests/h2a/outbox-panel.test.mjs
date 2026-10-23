import assert from 'node:assert/strict'
import test from 'node:test'
import { mountComponent } from './workspace-harness.mjs'

const j = value => JSON.parse(JSON.stringify(value))
const later = new Date(Date.now() + 60000).toISOString()

async function mountPanel(items, extra = {}) {
  const calls = []
  let current = items
  const bindings = {
    getH2AOutbox: async (...args) => { calls.push(['get', ...args]); return { items: current, summary: {
      queued: current.filter(item => item.status === 'queued').length, sending: current.filter(item => item.status === 'sending').length,
      failed: current.filter(item => item.status === 'failed').length } } },
    retryH2AOutbox: async (_s, _c, ids) => { calls.push(['retry', ids]); current = current.map(item => ids.includes(item.id) ? { ...item, status: 'queued', errorCode: null } : item); return { retried: ids.length } },
    returnH2AOutbox: async (_s, _c, ids) => { calls.push(['return', ids]); current = current.filter(item => !ids.includes(item.id)); return { returned: ids.length } },
  }
  const changed = []
  const ui = await mountComponent('OutboxPanel.jsx', { bindings, props: { session: { access_token: 't' }, companyId: 'c1', kind: 'live',
    tenantKey: 'c1:0', pollMs: 1, onChanged: () => changed.push(1), ...extra } })
  for (let i = 0; i < 4; i++) await ui.flush()
  return { ui, calls, changed, setItems: next => { current = next } }
}

const rows = [
  { id: 'o1', reviewId: 'r1', name: 'Costa Costa', objectType: 'contacts', action: 'create_albi', status: 'failed', attempts: 8, errorCode: 'albi_busy' },
  { id: 'o2', reviewId: 'r2', name: 'Acme Plumbing', objectType: 'companies', action: 'link_existing', status: 'failed', attempts: 1, errorCode: 'possible_match' },
  { id: 'o3', reviewId: 'r3', name: 'Jane Doe', objectType: 'contacts', action: 'create_with_organization', status: 'queued', attempts: 1, errorCode: 'albi_busy', nextAttemptAt: later },
  { id: 'o4', reviewId: 'r4', name: 'Sam Lee', objectType: 'contacts', action: 'skip_live', status: 'sending', attempts: 1, errorCode: null },
]

test('the outbox lists each action, where it stands, and why a failed one failed', async () => {
  const { ui } = await mountPanel(rows)
  const text = ui.text()
  for (const pattern of [/Costa Costa/, /Create in Albi/, /Albi was busy/, /Acme Plumbing/, /possible match appeared in Albi/,
    /Jane Doe/, /Create organization and contact/, /Waiting/, /trying again/i, /Sam Lee/, /Sending/, /2 failed/]) assert.match(text, pattern)
})

test('Retry puts a failed action back in line; Back to review returns the record; Retry all retries every failure', async () => {
  const { ui, calls, changed } = await mountPanel(rows)
  ui.nodes().find(node => node.type === 'button' && node.props['aria-label'] === 'Retry Costa Costa').props.onClick(); for (let i = 0; i < 3; i++) await ui.flush()
  assert.deepEqual(j(calls.find(call => call[0] === 'retry')), ['retry', ['o1']])
  ui.nodes().find(node => node.type === 'button' && node.props['aria-label'] === 'Back to review: Acme Plumbing').props.onClick(); for (let i = 0; i < 3; i++) await ui.flush()
  assert.deepEqual(j(calls.find(call => call[0] === 'return')), ['return', ['o2']])
  assert.doesNotMatch(ui.text(), /Acme Plumbing/)
  assert.ok(changed.length >= 2)
  const second = await mountPanel(rows)
  second.ui.find('button', 'Retry all failed').props.onClick(); for (let i = 0; i < 3; i++) await second.ui.flush()
  assert.deepEqual(j(second.calls.find(call => call[0] === 'retry')), ['retry', ['o1', 'o2']])
})

test('while anything is waiting or sending the outbox keeps itself current; an empty outbox says so', async () => {
  const { ui, calls, setItems } = await mountPanel(rows)
  const before = calls.filter(call => call[0] === 'get').length
  setItems([]); await ui.tick(); for (let i = 0; i < 3; i++) await ui.flush()
  assert.ok(calls.filter(call => call[0] === 'get').length > before)
  assert.match(ui.text(), /Nothing in the Outbox/)
})
