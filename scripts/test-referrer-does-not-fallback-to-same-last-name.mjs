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
      hs_cached_deals: [],
      hs_cached_contacts: [{
        user_id: 'user-1',
        hubspot_id: 'contact-samantha',
        first_name: 'Samantha',
        last_name: 'Preciado',
        company_hubspot_id: 'company-samantha',
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

let createDealPayload = null
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options = {}) => {
  const path = String(url)
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
  if (path.includes('/crm/v3/objects/contacts/search')) {
    return Response.json({
      results: [{
        id: 'contact-eddie',
        properties: { firstname: 'Eddie', lastname: 'Preciado', email: 'eddie@example.com' },
      }],
    })
  }
  if (path.includes('/crm/v4/objects/contacts/contact-eddie/associations/companies')) {
    return Response.json({ results: [{ toObjectId: 'company-eddie' }] })
  }
  if (path.includes('/crm/v3/objects/deals') && options.method === 'POST') {
    createDealPayload = JSON.parse(options.body)
    return Response.json({ id: 'deal-eddie' })
  }
  throw new Error(`Unexpected fetch: ${path}`)
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
      name: 'JOB-PRECIADO',
      dealName: 'Eddie Preciado - JOB-PRECIADO',
      referrer: 'Eddie Preciado',
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

  assert.equal(result.summary.held, 0, 'live HubSpot contact should resolve the referrer')
  assert.equal(result.summary.created, 1, 'deal should be created after resolving Eddie')
  assert.equal(createDealPayload.associations[0].to.id, 'contact-eddie')
  assert.equal(createDealPayload.associations[1].to.id, 'company-eddie')
  assert.equal(supabase.db.upserts.hs_cached_contacts?.[0]?.hubspot_id, 'contact-eddie')
} finally {
  globalThis.fetch = originalFetch
}
