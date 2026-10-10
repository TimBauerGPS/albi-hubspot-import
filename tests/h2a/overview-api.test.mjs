import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOverviewRepository,
  createOverviewHandler,
  getOverview,
  sanitizeOverviewRun,
} from '../../netlify/functions/h2a-overview.js'

const timestamp = '2026-10-05T12:00:00.000Z'
const runId = '00000000-0000-4000-8000-000000000001'

function run(overrides = {}) {
  return {
    id: runId,
    company_id: 'company-1',
    mode: 'live',
    trigger: 'manual',
    status: 'completed',
    totals: { created: 2, delivered: 3 },
    requested_by: 'private-user-id',
    created_at: timestamp,
    started_at: timestamp,
    finished_at: '2026-10-05T12:05:00.000Z',
    error_summary: null,
    ...overrides,
  }
}

function repository(overrides = {}) {
  const calls = []
  return {
    calls,
    async listRuns(companyId, options) {
      calls.push(['listRuns', companyId, options])
      return { items: [run()], hasMore: false }
    },
    async getActiveRun(companyId) {
      calls.push(['getActiveRun', companyId])
      return run({ status: 'running', finished_at: null })
    },
    async getRecentRun(companyId) {
      calls.push(['getRecentRun', companyId])
      return run()
    },
    async getLastCompletedRun(companyId) {
      calls.push(['getLastCompletedRun', companyId])
      return run()
    },
    async countOpenConflicts(companyId) {
      calls.push(['countOpenConflicts', companyId])
      return 4
    },
    ...overrides,
  }
}

function recordingSupabase() {
  const queries = []
  class Query {
    constructor(table) {
      this.table = table
      this.operations = []
      queries.push(this)
    }

    operation(method, ...args) {
      this.operations.push({ method, args })
      return this
    }

    select(...args) { return this.operation('select', ...args) }
    eq(...args) { return this.operation('eq', ...args) }
    not(...args) { return this.operation('not', ...args) }
    is(...args) { return this.operation('is', ...args) }
    in(...args) { return this.operation('in', ...args) }
    order(...args) { return this.operation('order', ...args) }
    limit(...args) { return this.operation('limit', ...args) }
    or(...args) { return this.operation('or', ...args) }
    maybeSingle() { return this.operation('maybeSingle') }
    then(resolve, reject) {
      const result = this.table === 'h2a_conflicts'
        ? { data: null, count: 0, error: null }
        : { data: this.operations.some(item => item.method === 'maybeSingle') ? null : [], error: null }
      return Promise.resolve(result).then(resolve, reject)
    }
  }
  return { queries, from: table => new Query(table) }
}

test('overview is tenant scoped and returns active, recent, last-success, and open-conflict summary', async () => {
  const repo = repository()
  const result = await getOverview({ repository: repo, companyId: 'company-1', limit: 25 })

  assert.deepEqual(repo.calls.map(call => call[1]), Array(5).fill('company-1'))
  assert.equal(result.summary.activeRun.status, 'running')
  assert.equal(result.summary.recentRun.status, 'completed')
  assert.equal(result.summary.lastSuccessfulRun.status, 'completed')
  assert.equal(result.summary.unresolvedConflictCount, 4)
  assert.equal(result.runs.length, 1)
  assert.equal(result.nextCursor, null)
})

test('overview sanitizes run metadata, totals, and fixed error categories', () => {
  const value = sanitizeOverviewRun(run({
    totals: {
      created: 2,
      would_create_contacts: 5,
      failed: -1,
      conflict: 1.2,
      provider_payload: { token: 'must-not-leak' },
    },
    error_summary: 'transient:timeout',
    source_snapshot: { email: 'private@example.com' },
    api_key: 'must-not-leak',
  }))

  assert.deepEqual(value.totals, { created: 2, would_create_contacts: 5 })
  assert.equal(value.errorCategory, 'Temporary provider problem')
  assert.equal(value.company_id, undefined)
  assert.equal(value.requested_by, undefined)
  assert.equal(value.error_summary, undefined)
  assert.equal(value.source_snapshot, undefined)
  assert.equal(value.api_key, undefined)

  const inheritedKey = sanitizeOverviewRun(run({ error_summary: 'constructor' }))
  assert.equal(inheritedKey.errorCategory, undefined)
})

test('overview exposes only validated sample metadata needed to label bounded dry runs', () => {
  const sample = sanitizeOverviewRun(run({ mode: 'dry_run', sample_limit_per_type: 10 }))
  assert.equal(sample.sampleLimitPerType, 10)

  for (const value of [0, 51, 1.5, '10']) {
    assert.equal(sanitizeOverviewRun(run({ mode: 'dry_run', sample_limit_per_type: value })).sampleLimitPerType, undefined)
  }
  assert.equal(sanitizeOverviewRun(run({ mode: 'live', sample_limit_per_type: 10 })).sampleLimitPerType, undefined)
})

test('overview uses an opaque deterministic effective-time and id cursor', async () => {
  const second = run({ id: '00000000-0000-4000-8000-000000000002', started_at: null,
    created_at: '2026-10-04T09:00:00.000Z' })
  const repo = repository({
    async listRuns(companyId, options) {
      assert.equal(companyId, 'company-1')
      assert.deepEqual(options, { limit: 2, before: null })
      return { items: [run(), second, run({ id: '00000000-0000-4000-8000-000000000003' })], hasMore: true }
    },
  })

  const first = await getOverview({ repository: repo, companyId: 'company-1', limit: 2 })
  assert.equal(first.runs.length, 2)
  assert.deepEqual(first.nextCursor, { effectiveAt: '2026-10-04T09:00:00.000Z', id: second.id })

  await getOverview({ repository: repository(), companyId: 'company-1', limit: 2, cursor: first.nextCursor })
  await assert.rejects(
    () => getOverview({ repository: repository(), companyId: 'company-1', cursor: { effectiveAt: 'not-a-date', id: second.id } }),
    error => error.statusCode === 400,
  )
})

test('overview repository scopes both cursor branches and constructs stable descending keyset queries', async () => {
  const supabase = recordingSupabase()
  const repo = createOverviewRepository(supabase)
  const before = { effectiveAt: '2026-10-04T09:00:00.000Z', id: '00000000-0000-4000-8000-000000000002' }

  await repo.listRuns('company-1', { limit: 2, before })
  const runQueries = supabase.queries.filter(query => query.table === 'h2a_sync_runs')
  assert.equal(runQueries.length, 2)

  for (const query of runQueries) {
    assert.deepEqual(query.operations.find(item => item.method === 'eq')?.args, ['company_id', 'company-1'])
    assert.deepEqual(query.operations.find(item => item.method === 'limit')?.args, [3])
  }
  assert.deepEqual(runQueries[0].operations.filter(item => item.method === 'order').map(item => item.args), [
    ['started_at', { ascending: false }],
    ['id', { ascending: false }],
  ])
  assert.deepEqual(runQueries[0].operations.find(item => item.method === 'not')?.args, ['started_at', 'is', null])
  assert.deepEqual(runQueries[1].operations.filter(item => item.method === 'order').map(item => item.args), [
    ['created_at', { ascending: false }],
    ['id', { ascending: false }],
  ])
  assert.deepEqual(runQueries[1].operations.find(item => item.method === 'is')?.args, ['started_at', null])
  assert.deepEqual(runQueries[0].operations.find(item => item.method === 'or')?.args, [
    `started_at.lt.${before.effectiveAt},and(started_at.eq.${before.effectiveAt},id.lt.${before.id})`,
  ])
  assert.deepEqual(runQueries[1].operations.find(item => item.method === 'or')?.args, [
    `created_at.lt.${before.effectiveAt},and(created_at.eq.${before.effectiveAt},id.lt.${before.id})`,
  ])
})

test('overview summary repository queries retain the authorized company predicate', async () => {
  const supabase = recordingSupabase()
  const repo = createOverviewRepository(supabase)
  await Promise.all([
    repo.getActiveRun('company-1'),
    repo.getRecentRun('company-1'),
    repo.getLastCompletedRun('company-1'),
    repo.countOpenConflicts('company-1'),
  ])

  assert.equal(supabase.queries.length, 5)
  for (const query of supabase.queries) {
    assert.ok(query.operations.some(item => item.method === 'eq' &&
      item.args[0] === 'company_id' && item.args[1] === 'company-1'))
  }
})

test('member reads and super-admin tenant selection use the authorization choke point', async () => {
  const calls = []
  const handler = createOverviewHandler({
    requireRequest: async (_event, options) => {
      calls.push(options)
      return { companyId: 'selected-company', supabase: {} }
    },
    repository: repository({
      async listRuns() { return { items: [], hasMore: false } },
      async getActiveRun() { return null },
      async getRecentRun() { return null },
      async getLastCompletedRun() { return null },
      async countOpenConflicts() { return 0 },
    }),
  })

  const response = await handler({ httpMethod: 'GET', queryStringParameters: { companyId: 'selected-company', limit: '10' } })
  assert.equal(response.statusCode, 200)
  assert.equal(calls[0].requireAdmin, false)
  assert.equal(calls[0].requestedCompanyId, 'selected-company')
})

test('overview errors are no-store and never expose raw database details', async () => {
  const handler = createOverviewHandler({
    requireRequest: async () => { throw new Error('password=private database detail') },
  })
  const response = await handler({ httpMethod: 'GET', queryStringParameters: {} })
  assert.equal(response.statusCode, 500)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.deepEqual(JSON.parse(response.body), { error: 'Unable to load HubSpot to Albi overview.' })
  assert.equal(response.body.includes('private'), false)
})
