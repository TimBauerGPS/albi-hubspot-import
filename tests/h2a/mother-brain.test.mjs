import test from 'node:test'
import assert from 'node:assert/strict'
import { loadMotherBrainProjects, motherBrainImportFilename, MOTHER_BRAIN_COLUMNS } from '../../netlify/functions/_motherBrain.js'
import { parseAlbiRecords } from '../../src/lib/parseCSV.js'

const env = { MOTHER_BRAIN_BASE_URL: 'https://mb.test/', MOTHER_BRAIN_API_KEY: 'mb_live_test' }
const noSleep = async () => {}
const reply = (body, { status = 200, version = 'v1', type = 'application/json' } = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': type, ...(version ? { 'x-motherbrain-dataset-version': version } : {}) } })
const row = index => ({ Name: `GPC-24-WTR${index}` })
const rows = (count, from = 0) => Array.from({ length: count }, (_, index) => row(from + index))

function server(...replies) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    const next = replies.shift()
    if (next instanceof Error) throw next
    return next
  }
  return { calls, fetchImpl, load: options => loadMotherBrainProjects({ env, fetchImpl, sleep: noSleep, ...options }) }
}

test('every page after the first is pinned to the first dataset version', async () => {
  const mb = server(reply({ rows: rows(1000) }), reply({ rows: rows(3, 1000) }))
  const result = await mb.load()
  assert.equal(result.records.length, 1003)
  assert.equal(result.datasetVersionId, 'v1')
  assert.equal(mb.calls[0].url, 'https://mb.test/api/query')
  assert.equal(mb.calls[0].headers.authorization, 'Bearer mb_live_test')
  assert.deepEqual(mb.calls[0].body, { select: [...MOTHER_BRAIN_COLUMNS], limit: 1000, offset: 0 })
  assert.deepEqual(mb.calls[1].body, { select: [...MOTHER_BRAIN_COLUMNS], limit: 1000, offset: 1000, datasetVersionId: 'v1' })
})

test('a run stops when a page is short, and an exact multiple reads one empty page', async () => {
  const mb = server(reply({ rows: rows(1000) }), reply({ rows: [] }))
  assert.equal((await mb.load()).records.length, 1000)
  assert.equal(mb.calls.length, 2)
})

test('two dataset versions are never combined', async () => {
  await assert.rejects(server(reply({ rows: rows(1000) }), reply({ rows: [] }, { version: 'v2' })).load(), /changed during the import/)
  await assert.rejects(server(reply({ rows: rows(1) }, { version: null })).load(), /changed during the import/)
})

test('an unchanged dataset costs one request', async () => {
  const mb = server(reply({ rows: rows(1000) }))
  const result = await mb.load({ skipVersion: 'v1' })
  assert.equal(result.unchanged, true)
  assert.equal(result.datasetVersionId, 'v1')
  assert.equal(mb.calls.length, 1)
})

test('a refused key or column fails at once and names the fix', async () => {
  const denied = { error: { code: 'COLUMN_ACCESS_DENIED', details: { columns: ['Referrer', 'Deductible'] } } }
  const mb = server(reply(denied, { status: 403, version: null }))
  await assert.rejects(mb.load(), /cannot read: Referrer, Deductible/)
  assert.equal(mb.calls.length, 1)
  await assert.rejects(server(reply({ error: { code: 'INVALID_API_KEY' } }, { status: 401, version: null })).load(), /MOTHER_BRAIN_API_KEY/)
})

test('rate limits, server errors and network failures are retried, then reported', async () => {
  const mb = server(reply({ error: { code: 'RATE_LIMITED' } }, { status: 429, version: null }), new Error('socket hang up'), reply({ rows: rows(2) }))
  assert.equal((await mb.load()).records.length, 2)
  assert.equal(mb.calls.length, 3)
  const down = server(...Array.from({ length: 3 }, () => reply('<html>down</html>', { status: 502, version: null, type: 'text/html' })))
  await assert.rejects(down.load(), /request failed \(502\)/)
  assert.equal(down.calls.length, 3)
})

test('missing settings and an empty dataset never reach the import', async () => {
  await assert.rejects(loadMotherBrainProjects({ env: {} }), /not configured/)
  await assert.rejects(server(reply({ rows: [] })).load(), /no projects/)
  await assert.rejects(server(reply({ columns: [] })).load(), /unreadable/)
})

test('Mother Brain rows parse like sheet rows', () => {
  const record = Object.fromEntries(MOTHER_BRAIN_COLUMNS.map(column => [column, '']))
  Object.assign(record, { Name: 'GPC-24-WTR001', Customer: 'Jane Smith', Status: 'Active', Referrer: 'Acme Insurance', 'Estimated Revenue': '6200.50',
    'Link to Project': '<a href="https://app.albiware.com/Project/7?tab=BasicInfo" target="_blank">Link to Project</a>' })
  const parsed = parseAlbiRecords([record], [...MOTHER_BRAIN_COLUMNS], { pipeline_mapping: { WTR: 'Water Mitigation' } })
  assert.deepEqual(parsed.missingColumns, [])
  assert.equal(parsed.rows[0].dealName, 'Jane Smith - GPC-24-WTR001')
  assert.equal(parsed.rows[0].pipeline, 'Water Mitigation')
  assert.equal(parsed.rows[0].estimatedRevenue, 6200.5)
  assert.equal(parsed.rows[0].projectLink, 'https://app.albiware.com/Project/7?tab=BasicInfo')
})

test('the import filename carries the dataset version', () => {
  assert.equal(motherBrainImportFilename('v1'), 'Mother Brain: dataset v1')
})
