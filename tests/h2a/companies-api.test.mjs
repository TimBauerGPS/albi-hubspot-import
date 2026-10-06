import assert from 'node:assert/strict'
import test from 'node:test'

import { createCompaniesHandler } from '../../netlify/functions/h2a-companies.js'

function fixture({ superAdmin = false, companies = [], failure = null } = {}) {
  const calls = []
  const supabase = {
    auth: {
      async getUser(jwt) {
        calls.push(['auth.getUser', jwt])
        if (jwt !== 'valid-jwt') return { data: { user: null }, error: { message: 'invalid token details' } }
        return { data: { user: { id: 'user-1', email: 'private@example.com' } }, error: null }
      },
    },
    from(table) {
      let columns
      let filter
      const orders = []
      const builder = {
        select(value) { columns = value; calls.push(['select', table, value]); return builder },
        eq(column, value) { filter = [column, value]; return builder },
        order(column, options) { orders.push([column, options]); return builder },
        async maybeSingle() {
          calls.push(['maybeSingle', table, filter])
          if (failure === table) return { data: null, error: { message: 'db-secret-fragment' } }
          if (table === 'super_admins') return { data: superAdmin ? { user_id: 'user-1' } : null, error: null }
          throw new Error(`Unexpected maybeSingle table: ${table}`)
        },
        then(resolve, reject) {
          calls.push(['execute', table, columns, orders])
          const result = failure === table
            ? { data: null, error: { message: 'db-secret-fragment' } }
            : { data: structuredClone(companies), error: null }
          return Promise.resolve(result).then(resolve, reject)
        },
      }
      return builder
    },
  }
  const handle = createCompaniesHandler({ supabase })
  async function request(jwt = 'valid-jwt', httpMethod = 'GET') {
    const result = await handle({ httpMethod, headers: { authorization: `Bearer ${jwt}` } })
    return { ...result, json: JSON.parse(result.body) }
  }
  return { calls, request }
}

test('super admin receives only deduplicated, sorted company IDs and names', async () => {
  const f = fixture({ superAdmin: true, companies: [
    { id: 'company-b', name: ' Beta ', private_notes: 'never return' },
    { id: 'company-a', name: 'Alpha', private_notes: 'never return' },
    { id: 'company-a', name: 'Duplicate', private_notes: 'never return' },
    { id: null, name: 'Invalid' },
  ] })
  const result = await f.request()

  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json, { companies: [
    { id: 'company-a', name: 'Alpha' },
    { id: 'company-b', name: 'Beta' },
  ] })
  assert.equal(result.body.includes('private_notes'), false)
  assert.ok(f.calls.some(call => call[0] === 'select' && call[1] === 'companies' && call[2] === 'id, name'))
})

test('regular member receives 403 without querying or returning companies', async () => {
  const f = fixture({ companies: [{ id: 'company-a', name: 'Alpha' }] })
  const result = await f.request()

  assert.equal(result.statusCode, 403)
  assert.deepEqual(result.json, { error: 'Company options are unavailable.' })
  assert.equal(f.calls.some(call => call[1] === 'companies'), false)
  assert.equal(Object.hasOwn(result.json, 'companies'), false)
})

test('authentication and database failures return fixed non-enumerating errors', async () => {
  const invalid = fixture()
  const invalidResult = await invalid.request('invalid-jwt')
  assert.equal(invalidResult.statusCode, 401)
  assert.deepEqual(invalidResult.json, { error: 'Authentication required.' })

  const lookupFailure = fixture({ failure: 'super_admins' })
  const failureResult = await lookupFailure.request()
  assert.equal(failureResult.statusCode, 500)
  assert.deepEqual(failureResult.json, { error: 'Unable to load company options.' })
  assert.equal(failureResult.body.includes('db-secret-fragment'), false)

  const companyFailure = fixture({ superAdmin: true, failure: 'companies' })
  const companyFailureResult = await companyFailure.request()
  assert.equal(companyFailureResult.statusCode, 500)
  assert.deepEqual(companyFailureResult.json, { error: 'Unable to load company options.' })
  assert.equal(companyFailureResult.json.companies, undefined)
  assert.equal(companyFailureResult.body.includes('db-secret-fragment'), false)
})

test('endpoint accesses only super-admin authorization and company ID/name data', async () => {
  const f = fixture({ superAdmin: true, companies: [{ id: 'company-1', name: 'Alpha' }] })
  await f.request()

  assert.deepEqual(f.calls.filter(call => call[0] === 'select'), [
    ['select', 'super_admins', 'user_id'],
    ['select', 'companies', 'id, name'],
  ])
  assert.equal(f.calls.some(call => call[1] === 'company_members' || call[1] === 'auth.users'), false)
})

test('company option endpoint permits OPTIONS and rejects other methods', async () => {
  const f = fixture()
  assert.equal((await f.request('valid-jwt', 'OPTIONS')).statusCode, 200)
  assert.equal((await f.request('valid-jwt', 'POST')).statusCode, 405)
})
