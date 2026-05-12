import assert from 'node:assert/strict'
import { runImportRows } from '../netlify/functions/_hsImportCore.js'

class Query {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.operation = 'select'
    this.rows = null
    this.patch = null
    this.filters = []
    this.singleMode = false
    this.maybeSingleMode = false
    this.rangeStart = null
    this.rangeEnd = null
  }

  select() {
    this.operation = this.operation === 'insert' ? 'insertSelect' : 'select'
    return this
  }

  insert(rows) {
    this.operation = 'insert'
    this.rows = Array.isArray(rows) ? rows : [rows]
    return this
  }

  update(patch) {
    this.operation = 'update'
    this.patch = patch
    return this
  }

  upsert(rows) {
    this.operation = 'upsert'
    this.rows = Array.isArray(rows) ? rows : [rows]
    return this
  }

  eq(key, value) {
    this.filters.push({ key, value })
    return this
  }

  is(key, value) {
    this.filters.push({ key, value })
    return this
  }

  range(start, end) {
    this.rangeStart = start
    this.rangeEnd = end
    return this
  }

  single() {
    this.singleMode = true
    return this
  }

  maybeSingle() {
    this.maybeSingleMode = true
    return this
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject)
  }

  execute() {
    const tableRows = this.db.tables[this.table] || []

    if (this.operation === 'insert' || this.operation === 'insertSelect') {
      this.db.inserts[this.table] ||= []
      this.db.inserts[this.table].push(...this.rows)
      if (this.singleMode) return { data: { id: `${this.table}-inserted` }, error: null }
      return { data: this.rows, error: null }
    }

    if (this.operation === 'update') {
      this.db.updates[this.table] ||= []
      this.db.updates[this.table].push({ patch: this.patch, filters: this.filters })
      return { data: null, error: null }
    }

    if (this.operation === 'upsert') {
      this.db.upserts[this.table] ||= []
      this.db.upserts[this.table].push(...this.rows)
      return { data: this.rows, error: null }
    }

    let data = tableRows.filter(row =>
      this.filters.every(filter => row[filter.key] === filter.value)
    )

    if (this.rangeStart !== null) {
      data = data.slice(this.rangeStart, this.rangeEnd + 1)
    }

    if (this.singleMode || this.maybeSingleMode) {
      return { data: data[0] || null, error: null }
    }

    return { data, error: null }
  }
}

function createSupabaseMock() {
  const db = {
    tables: {
      hs_cached_deals: [{
        user_id: 'user-1',
        hubspot_id: 'deal-1',
        project_id: 'JOB-1',
        deal_stage: 'sold-stage',
        pipeline: 'water-pipeline',
        total_estimates: 1000,
        accrual_revenue: 0,
        amount: 1000,
      }],
      hs_cached_contacts: [{
        user_id: 'user-1',
        hubspot_id: 'contact-1',
        first_name: 'Known',
        last_name: 'Referrer',
        company_hubspot_id: 'company-1',
      }],
      hs_cached_companies: [],
      hs_held_deals: [],
      hs_imports: [],
    },
    inserts: {},
    updates: {},
    upserts: {},
  }

  return {
    db,
    from(table) {
      return new Query(db, table)
    },
  }
}

const calls = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options = {}) => {
  const path = String(url)
  const method = options.method || 'GET'
  calls.push({ method, path })

  if (path.includes('/crm/v3/pipelines/deals')) {
    return Response.json({
      results: [{
        id: 'water-pipeline',
        label: 'Water',
        stages: [{ id: 'sold-stage', label: 'Sold' }],
      }],
    })
  }
  if (path.includes('/crm/v3/owners/')) {
    return Response.json({ results: [] })
  }

  throw new Error(`Unexpected fetch: ${method} ${path}`)
}

try {
  const supabase = createSupabaseMock()

  const result = await runImportRows({
    supabase,
    userId: 'user-1',
    companyId: 'company-1',
    userConfig: {},
    apiKey: 'test-key',
    rows: [{
      name: 'JOB-1',
      dealName: 'Customer - JOB-1',
      referrer: 'Known Referrer',
      salesPerson: '',
      pipeline: 'Water',
      status: 'Sold',
      estimatedRevenue: 1000,
      accrualRevenue: 0,
      isGoogleLead: false,
    }],
    filename: 'unit-test.csv',
    importId: 'import-1',
  })

  assert.equal(result.summary.updated, 0, 'unchanged rows should not count as updates')
  assert.equal(result.summary.errors, 0, 'unchanged rows should not fail on association-only work')
  assert.equal(result.summary.skipped, 1, 'unchanged rows should be skipped')
  assert.equal(
    calls.some(call => call.path.includes('/crm/v4/objects/deals/deal-1/associations')),
    false,
    'unchanged rows should not fetch or mutate HubSpot associations'
  )
  assert.equal(supabase.db.inserts.hs_deals?.[0]?.action_taken, 'skipped')
} finally {
  globalThis.fetch = originalFetch
}
