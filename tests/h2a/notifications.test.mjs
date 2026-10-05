import test from 'node:test'
import assert from 'node:assert/strict'
import { notifyRunExceptions, resolveCompanyAdminRecipients } from '../../netlify/functions/_h2a/notifications.js'

function fakeSupabase({ members = [], users = {}, config = null } = {}) {
  const filters = []
  return {
    filters,
    from(table) {
      const query = { select() { return query }, eq(key, value) { filters.push([table, key, value]); return query }, limit() { return query },
        then(resolve) { resolve({ data: table === 'company_members' ? members : config ? [config] : [], error: null }) } }
      return query
    },
    auth: { admin: { async getUserById(id) { return { data: { user: users[id] ?? null }, error: null } } } },
  }
}

test('notification recipients are current company admins plus explicit tenant recipients, not global admins', async () => {
  const supabase = fakeSupabase({ members: [{ user_id: 'u1', role: 'admin' }, { user_id: 'u2', role: 'member' }, { user_id: 'u3', role: 'admin' }],
    users: { u1: { email: 'Admin@Example.com' }, u3: { email: 'admin@example.com' } },
    config: { notification_recipients: ['Ops@Example.com', 'bad', 'admin@example.com'] } })
  const recipients = await resolveCompanyAdminRecipients({ supabase, companyId: 'c1' })
  assert.deepEqual(recipients, ['admin@example.com', 'ops@example.com'])
  assert.equal(supabase.filters.filter(([table, key, value]) => table === 'company_members' && key === 'company_id' && value === 'c1').length, 1)
  assert.equal(supabase.filters.filter(([table, key, value]) => table === 'h2a_company_config' && key === 'company_id' && value === 'c1').length, 1)
})

test('clean runs are suppressed and exception messages are bounded and redacted', async () => {
  const sent = []
  const deps = { resolveRecipients: async () => ['admin@example.com'], sendEmail: async message => sent.push(message),
    siteUrl: 'https://example.test' }
  assert.deepEqual(await notifyRunExceptions(deps, { companyId: 'c1', companyName: 'Alpha', run: { id: 'r1', status: 'completed', totals: { created: 1 } } }),
    { sent: false, skipped: 'clean_run' })
  await notifyRunExceptions(deps, { companyId: 'c1', companyName: 'Alpha', run: { id: 'r2', status: 'partially_failed', totals: { conflict: 1, failed: 2 }, error_summary: 'secret-token-provider body' },
    newConflictCount: 1, conflictIds: ['conflict-safe'] })
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Alpha/)
  assert.match(sent[0].text, /r2/)
  assert.doesNotMatch(JSON.stringify(sent[0]), /secret-token-provider|ciphertext|raw body/)
  assert.doesNotMatch(JSON.stringify(sent[0]), /company-b|other tenant/i)
})

test('new conflicts trigger a tenant-only notification even when the run completed', async () => {
  const sent = []
  await notifyRunExceptions({ resolveRecipients: async ({ companyId }) => { assert.equal(companyId, 'c1'); return ['admin@example.com'] },
    sendEmail: async message => sent.push(message), siteUrl: 'https://example.test' },
  { companyId: 'c1', companyName: 'Alpha', run: { id: 'run-1', status: 'completed', totals: { conflict: 1 } },
    newConflictCount: 1, conflictIds: ['conflict-1', 'private company B'] })
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /conflict-1/)
  assert.doesNotMatch(sent[0].text, /private company B/)
})

test('no recipients skips safely and logs no tenant data', async () => {
  const logs = []
  const result = await notifyRunExceptions({ resolveRecipients: async () => [], sendEmail: async () => assert.fail(),
    logger: { warn: (...args) => logs.push(args) } }, { companyId: 'private-company', run: { id: 'private-run', status: 'failed' } })
  assert.deepEqual(result, { sent: false, skipped: 'no_recipients' })
  assert.doesNotMatch(JSON.stringify(logs), /private-company|private-run/)
})
