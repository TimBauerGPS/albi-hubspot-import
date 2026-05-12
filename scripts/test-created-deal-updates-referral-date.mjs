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
  const body = options.body ? JSON.parse(options.body) : null
  calls.push({ method, path, body })

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
  if (method === 'POST' && path.includes('/crm/v3/objects/deals')) {
    return Response.json({ id: 'deal-1', createdAt: '2026-05-12T18:00:00Z' })
  }
  if (method === 'PATCH' && path.includes('/crm/v3/objects/contacts/contact-1')) {
    return Response.json({ id: 'contact-1' })
  }
  if (method === 'PATCH' && path.includes('/crm/v3/objects/companies/company-1')) {
    return Response.json({
      status: 'error',
      message: 'Property values were not valid',
      category: 'VALIDATION_ERROR',
    }, { status: 400 })
  }
  if (method === 'POST' && path.includes('/crm/v3/properties/companies')) {
    return Response.json({
      status: 'error',
      message: 'Missing scopes',
      category: 'MISSING_SCOPES',
    }, { status: 403 })
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

  assert.equal(result.summary.created, 1, 'deal should still be created')
  assert.equal(result.summary.errors, 0, 'referral date update failures should not error the import')

  const contactPatch = calls.find(call =>
    call.method === 'PATCH' &&
    call.path.includes('/crm/v3/objects/contacts/contact-1')
  )
  assert.equal(contactPatch?.body?.properties?.last_deal_referred, '1778544000000')

  const companyPropertyCreate = calls.find(call =>
    call.method === 'POST' &&
    call.path.includes('/crm/v3/properties/companies')
  )
  assert.equal(companyPropertyCreate?.body?.name, 'last_deal_referred')
  assert.equal(companyPropertyCreate?.body?.type, 'date')
  assert.equal(companyPropertyCreate?.body?.fieldType, 'date')
} finally {
  globalThis.fetch = originalFetch
}
