import test from 'node:test'
import assert from 'node:assert/strict'
import { changedSinceFor, loadAlbiProjectRecords, projectRecord, FIRST_RUN_LOOKBACK_DAYS } from '../../netlify/functions/_albiProjectSource.js'
import { parseAlbiRecords } from '../../src/lib/parseCSV.js'
import { AlbiClient } from '../../netlify/functions/_h2a/albiClient.js'
import { ApiError } from '../../netlify/functions/_h2a/http.js'

const project = (id, name, extra = {}) => ({ id, name, createdAt: '2026-10-01T15:00:00.000Z', status: { id: '10', name: 'Estimate Sent' },
  propertyType: { id: 'residential', name: 'Residential' }, closed: false,
  address: { address1: '1 Main St', city: 'Seattle', state: 'WA', zipCode: '98101' },
  insurance: { company: 'Example Mutual', claimNumber: 'C-1', deductible: 1000 },
  customer: { name: 'Jane Smith', email: 'jane@example.com', phone: '555-0199' },
  referrer: { contact: { name: 'Pat Agent' }, organization: { name: 'Agent Co' } },
  salesperson: { name: 'Sam Lee' }, projectManager: { name: 'Alex Kim' }, ...extra })
const financials = { estimatedRevenue: 6200, actualRevenue: 4850, totalInvoiceAmount: 4850, totalPaymentAmount: 3000, totalActualExpenses: 1680 }

test('a project becomes a sheet-shaped record the existing parser imports unchanged', () => {
  const record = projectRecord(project('1', 'GPC-26-WTR001'), financials)
  assert.equal(record.Referrer, 'Pat Agent')
  assert.equal(projectRecord(project('2', 'X', { referrer: { contact: null, organization: { name: 'Agent Co' } } }), financials).Referrer, 'Agent Co')
  const parsed = parseAlbiRecords([record], Object.keys(record), { pipeline_mapping: { WTR: 'Water Mitigation' } })
  assert.deepEqual(parsed.missingColumns, [])
  const [row] = parsed.rows
  assert.deepEqual([row.name, row.customer, row.status, row.estimatedRevenue, row.accrualRevenue, row.salesPerson, row.referrer, row.pipeline, row.dealName, row.deductible],
    ['GPC-26-WTR001', 'Jane Smith', 'Estimate Sent', 6200, 4850, 'Sam Lee', 'Pat Agent', 'Water Mitigation', 'Jane Smith - GPC-26-WTR001', 1000])
})

test('only changed, non-excluded projects are detail-read, and a missing financial scope stops the run plainly', async () => {
  const reads = []
  const albi = {
    listProjects: async args => { reads.push(['list', args]); return args.cursor === '1'
      ? { records: [project('1', 'GPC-26-WTR001'), project('2', 'GPC-26-WTY002')], cursor: '2' }
      : { records: [project('3', 'GPC-26-FIRE003'), project('4', 'BLOCKED-1')], cursor: null } },
    getProject: async id => { reads.push(['project', id]); return project(id, `P${id}`) },
    getProjectFinancials: async id => { reads.push(['financials', id]); return financials },
  }
  const result = await loadAlbiProjectRecords(albi, { changedSince: '2026-11-01T00:00:00.000Z', sleep: async () => {},
    userConfig: { excluded_suffixes: ['WTY'], blacklist: ['BLOCKED-1'] } })
  assert.equal(result.listedCount, 4)
  assert.equal(result.records.length, 2)
  assert.deepEqual(reads.filter(([kind]) => kind === 'list').map(([, args]) => args.changedSince), ['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'])
  assert.deepEqual(reads.filter(([kind]) => kind === 'project').map(([, id]) => id).sort(), ['1', '3'])
  albi.getProjectFinancials = async () => { throw new ApiError('permission', { operation: 'getProjectFinancials', status: 403, requiredScope: 'Permissions.Projects.ManageFinancial' }) }
  await assert.rejects(loadAlbiProjectRecords(albi, { sleep: async () => {} }), /add Permissions\.Projects\.ManageFinancial/)
})

test('a run starts just before the last run, or looks back on the first run', () => {
  const now = Date.parse('2026-11-03T20:00:00Z')
  assert.equal(changedSinceFor('2026-11-02T20:00:00Z', now), '2026-11-02T19:50:00.000Z')
  assert.equal(changedSinceFor(null, now), new Date(now - FIRST_RUN_LOOKBACK_DAYS * 86400000).toISOString())
})

test('the Albi client lists projects with changedSince and reads a project and its financials', async () => {
  const calls = []
  const fetch = async url => {
    const parsed = new URL(url); calls.push(parsed)
    const body = parsed.pathname.endsWith('/relationship-statuses') ? { data: [{ id: '1', name: 'Active', companyId: '1319' }] }
      : parsed.pathname.startsWith('/api/v1/company/') ? { data: { id: '1319', name: 'Allied' } }
        : parsed.pathname === '/api/v1/projects' ? { data: [project('7', 'GPC-26-WTR007')], continuationToken: null }
          : parsed.pathname.endsWith('/financials') ? { status: 1, data: financials }
            : parsed.pathname === '/api/v1/projects/404' ? new Response(JSON.stringify({ status: 10 }), { status: 404 }) : { status: 1, data: project('7', 'GPC-26-WTR007') }
    return body instanceof Response ? body : new Response(JSON.stringify(body))
  }
  const client = new AlbiClient({ apiKey: 'k', fetch })
  const page = await client.listProjects({ changedSince: '2026-11-01T00:00:00.000Z' })
  assert.deepEqual([page.records.map(record => record.id), page.cursor], [['7'], null])
  const list = calls.find(call => call.pathname === '/api/v1/projects')
  assert.deepEqual([list.searchParams.get('changedSince'), list.searchParams.get('limit'), list.searchParams.get('companyId')], ['2026-11-01T00:00:00.000Z', '100', '1319'])
  assert.equal((await client.getProject('7')).customer.name, 'Jane Smith')
  assert.equal((await client.getProjectFinancials('7')).estimatedRevenue, 6200)
  assert.equal(await client.getProject('404'), null)
})
