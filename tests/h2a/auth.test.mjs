import assert from 'node:assert/strict'
import test from 'node:test'

import { requireH2ARequest, resolveH2AContext } from '../../netlify/functions/_h2a/auth.js'

function fakeSupabase({ member = null, superAdmin = null, companies = [] } = {}) {
  const calls = []
  const supabase = {
    auth: {
      async getUser(token) {
        calls.push(['getUser', token])
        return token === 'valid-jwt'
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: new Error('invalid token') }
      },
    },
    from(table) {
      const query = { table, column: null, value: null }
      const builder = {
        select() { return builder },
        eq(column, value) { query.column = column; query.value = value; return builder },
        async maybeSingle() {
          calls.push([table, query.column, query.value])
          if (table === 'company_members' && query.value === 'user-1') return { data: member, error: null }
          if (table === 'super_admins' && query.value === 'user-1') return { data: superAdmin, error: null }
          if (table === 'companies') {
            const company = companies.find((item) => item.id === query.value)
            return { data: company ?? null, error: null }
          }
          return { data: null, error: null }
        },
      }
      return builder
    },
  }
  return { supabase, calls }
}

const companyA = { id: 'company-a', name: 'Alpha' }
const companyB = { id: 'company-b', name: 'Beta' }

test('member context resolves to their own company', async () => {
  const { supabase } = fakeSupabase({
    member: { company_id: companyA.id, role: 'member' }, companies: [companyA],
  })
  const context = await resolveH2AContext({ supabase, jwt: 'valid-jwt' })
  assert.deepEqual(
    { userId: context.userId, companyId: context.companyId, companyName: context.companyName, role: context.role },
    { userId: 'user-1', companyId: companyA.id, companyName: 'Alpha', role: 'member' },
  )
})

for (const role of ['member', 'admin']) {
  test(`${role} cannot select another company`, async () => {
    const { supabase } = fakeSupabase({
      member: { company_id: companyA.id, role }, companies: [companyA, companyB],
    })
    await assert.rejects(
      resolveH2AContext({ supabase, jwt: 'valid-jwt', requestedCompanyId: companyB.id }),
      (error) => error.statusCode === 403,
    )
  })
}

test('company admin passes requireAdmin for their own company', async () => {
  const { supabase } = fakeSupabase({
    member: { company_id: companyA.id, role: 'admin' }, companies: [companyA],
  })
  const context = await resolveH2AContext({ supabase, jwt: 'valid-jwt', requireAdmin: true })
  assert.equal(context.companyId, companyA.id)
  assert.equal(context.role, 'admin')
})

test('verified super admin may select any existing company', async () => {
  const { supabase } = fakeSupabase({ superAdmin: { user_id: 'user-1' }, companies: [companyB] })
  const context = await resolveH2AContext({ supabase, jwt: 'valid-jwt', requestedCompanyId: companyB.id })
  assert.deepEqual(
    { companyId: context.companyId, companyName: context.companyName, isSuperAdmin: context.isSuperAdmin },
    { companyId: companyB.id, companyName: 'Beta', isSuperAdmin: true },
  )
})

test('missing membership and non-super-admin is forbidden', async () => {
  const { supabase } = fakeSupabase()
  await assert.rejects(resolveH2AContext({ supabase, jwt: 'valid-jwt' }), (error) => error.statusCode === 403)
})

test('invalid JWT returns 401', async () => {
  const { supabase } = fakeSupabase()
  await assert.rejects(
    requireH2ARequest({ headers: { authorization: 'Bearer invalid' } }, { supabase }),
    (error) => error.statusCode === 401,
  )
})

test('internal jobs require the cron secret and an explicit existing company', async () => {
  const { supabase } = fakeSupabase({ companies: [companyA] })
  const baseEvent = { headers: { 'x-internal-cron-secret': 'secret' }, body: JSON.stringify({ companyId: companyA.id }) }
  const context = await requireH2ARequest(baseEvent, {
    supabase, internalJob: true, internalCronSecret: 'secret',
  })
  assert.deepEqual(
    { companyId: context.companyId, companyName: context.companyName, role: context.role },
    { companyId: companyA.id, companyName: 'Alpha', role: 'internal' },
  )

  await assert.rejects(
    requireH2ARequest({ ...baseEvent, headers: {} }, { supabase, internalJob: true, internalCronSecret: 'secret' }),
    (error) => error.statusCode === 401,
  )
  await assert.rejects(
    requireH2ARequest({ headers: { 'x-internal-cron-secret': 'secret' }, body: '{}' }, {
      supabase, internalJob: true, internalCronSecret: 'secret',
    }),
    (error) => error.statusCode === 400,
  )
  await assert.rejects(
    requireH2ARequest({ headers: { 'x-internal-cron-secret': 'secret' }, body: JSON.stringify({ companyId: companyB.id }) }, {
      supabase, internalJob: true, internalCronSecret: 'secret',
    }),
    (error) => error.statusCode === 404,
  )
})
