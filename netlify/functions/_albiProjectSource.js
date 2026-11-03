import { ApiError } from './_h2a/http.js'
import { isExcluded } from '../../src/lib/parseCSV.js'

// The Albi-to-HubSpot deal import, reading Albi's Projects API instead of the exported Google Sheet. Each project
// becomes one record with the sheet's column names, so the same parser (filters, pipeline, deal name) and the same
// import run on it. A run reads only projects that changed since the last one (Albi's changedSince).
export const ALBI_IMPORT_PREFIX = 'Albi API:'
// The first API run has no earlier run to continue from; it reads projects changed in this many days (the sheet
// import has already covered older ones).
export const FIRST_RUN_LOOKBACK_DAYS = 30
// Re-read a few minutes before the last run started, so a project written on the boundary is not missed.
export const OVERLAP_MS = 10 * 60000
// Two detail reads per project; a few at a time stays well under Albi's 10-in-flight and per-minute limits.
const CONCURRENCY = 3
const PACE_MS = 1100

export const PROJECT_HEADERS = Object.freeze(['Name', 'Created At', 'Customer', 'Status', 'Estimated Revenue', 'Accrual Revenue', 'Sales Person',
  'Project Manager', 'Referrer', 'Customer Email', 'Customer Phone Number', 'Address 1', 'City', 'State', 'Zip Code', 'Insurance Company',
  'Insurance Claim Number', 'Deductible', 'Property Type', 'Total Invoice Amount', 'Total Payment Amount', 'Total Actual Expenses', 'File Closed'])

const text = value => typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value)
const amount = value => Number.isFinite(value) ? String(value) : ''

// The sheet's Referrer is the referring contact's name, else the referring organization's.
function referrerName(referrer) {
  return text(referrer?.contact?.name) || text(referrer?.organization?.name)
}

export function projectRecord(project, financials) {
  return {
    'Name': text(project.name),
    'Created At': text(project.createdAt),
    'Customer': text(project.customer?.name),
    'Status': text(project.status?.name),
    'Estimated Revenue': amount(financials?.estimatedRevenue),
    'Accrual Revenue': amount(financials?.actualRevenue),
    'Sales Person': text(project.salesperson?.name),
    'Project Manager': text(project.projectManager?.name),
    'Referrer': referrerName(project.referrer),
    'Customer Email': text(project.customer?.email),
    'Customer Phone Number': text(project.customer?.phone),
    'Address 1': text(project.address?.address1),
    'City': text(project.address?.city),
    'State': text(project.address?.state),
    'Zip Code': text(project.address?.zipCode),
    'Insurance Company': text(project.insurance?.company),
    'Insurance Claim Number': text(project.insurance?.claimNumber),
    'Deductible': amount(project.insurance?.deductible),
    'Property Type': text(project.propertyType?.name),
    'Total Invoice Amount': amount(financials?.totalInvoiceAmount),
    'Total Payment Amount': amount(financials?.totalPaymentAmount),
    'Total Actual Expenses': amount(financials?.totalActualExpenses),
    'File Closed': project.closed === true ? 'Yes' : '',
  }
}

// Where this run starts: just before the last API run started, or FIRST_RUN_LOOKBACK_DAYS back.
export function changedSinceFor(lastRunAt, now = Date.now()) {
  const last = Date.parse(lastRunAt ?? '')
  const start = Number.isFinite(last) ? last - OVERLAP_MS : now - FIRST_RUN_LOOKBACK_DAYS * 24 * 60 * 60000
  return new Date(start).toISOString()
}

// Reads changed projects and their details. A project whose name is excluded or blacklisted is never detail-read.
// A key without the financial scope fails the run (an import without revenue would zero HubSpot amounts).
export async function loadAlbiProjectRecords(albi, { changedSince, userConfig = {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const listed = []
  const seen = new Set()
  for (let cursor = '1'; cursor !== null;) {
    if (seen.has(cursor) || seen.size > 5000) throw new Error('Albi project pagination loop')
    seen.add(cursor)
    const page = await albi.listProjects({ cursor, pageSize: 100, ...(changedSince ? { changedSince } : {}) })
    listed.push(...page.records)
    cursor = page.cursor
  }
  const blacklist = new Set((userConfig.blacklist ?? []).map(value => String(value).trim()))
  const wanted = listed.filter(project => text(project.name) && !isExcluded(project.name, userConfig.excluded_suffixes ?? []) && !blacklist.has(text(project.name)))
  const records = new Array(wanted.length)
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const index = next++
      const summary = wanted[index]
      try {
        const [project, financials] = await Promise.all([albi.getProject(summary.id), albi.getProjectFinancials(summary.id)])
        records[index] = project ? projectRecord(project, financials) : null
      } catch (error) {
        if (error instanceof ApiError && error.category === 'permission') {
          throw new Error(`The Albi key cannot read ${error.operation === 'getProjectFinancials' ? 'project financials' : 'projects'}. Ask Albi support to add ${error.requiredScope ?? 'the project scopes'} to the key.`)
        }
        throw error
      }
      await sleep(PACE_MS)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker))
  return { headers: [...PROJECT_HEADERS], records: records.filter(Boolean), listedCount: listed.length }
}
