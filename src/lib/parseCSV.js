import Papa from 'papaparse'

// Required columns that must be present for import to proceed
export const REQUIRED_COLUMNS = ['Name', 'Customer', 'Status', 'Estimated Revenue']

// Internal key → Albi CSV column header
export const COLUMN_MAP = {
  name: 'Name',                       // Albi job number — upsert key (→ project_id)
  projectLink: 'Link to Project',
  customer: 'Customer',               // Customer name (used in deal name prefix)
  status: 'Status',                   // Deal stage value
  estimatedRevenue: 'Estimated Revenue',
  accrualRevenue: 'Accrual Revenue',
  salesPerson: 'Sales Person',        // → HubSpot owner email lookup; also used for row filter
  createdAt: 'Created At',
  inspectionDate: 'Inspection Date',
  estimator: 'Estimator',
  customerEmail: 'Customer Email',
  address1: 'Address 1',
  city: 'City',
  state: 'State',
  zipCode: 'Zip Code',
  insuranceCompany: 'Insurance Company',
  insuranceClaimNumber: 'Insurance Claim Number',
  propertyType: 'Property Type',
  referrer: 'Referrer',               // KEY: used to match HubSpot contact/company for associations
  projectManager: 'Project Manager',
  deductible: 'Deductible',
}

/**
 * Derive the HubSpot pipeline suffix from an Albi job name.
 *
 * The Google Script extracts the first run of alpha chars AFTER THE SECOND DASH.
 * Example job formats:
 *   GPC-24-WTR001  → after 2nd dash: "WTR001" → suffix "WTR"
 *   GPC-24-FIRE002 → after 2nd dash: "FIRE002" → suffix "FIRE"
 *
 * Falls back to the first segment before the first dash if the pattern doesn't match
 * (e.g. simple names like "WTR-001").
 *
 * @param {string} name - Albi job name/number
 * @param {Object} pipelineMapping - per-user config: { 'WTR': 'Water Mitigation', ... }
 * @returns {string|null} - HubSpot pipeline label, or null if not mapped
 */
export function getPipelineFromName(name, pipelineMapping = {}) {
  const str = String(name)
  const firstDash = str.indexOf('-')
  const secondDash = firstDash > -1 ? str.indexOf('-', firstDash + 1) : -1

  let suffix = null
  if (secondDash > -1) {
    const after = str.substring(secondDash + 1)
    const match = after.match(/^([a-zA-Z]+)/)
    if (match) suffix = match[1].toUpperCase()
  }

  // Fallback: first segment before first dash
  if (!suffix) suffix = str.split('-')[0].trim().toUpperCase()

  return pipelineMapping[suffix] || null
}

/**
 * Extract the raw job type suffix from an Albi job name (for exclusion checks).
 * Uses the same extraction logic as getPipelineFromName.
 */
function extractSuffix(name) {
  const str = String(name)
  const firstDash = str.indexOf('-')
  const secondDash = firstDash > -1 ? str.indexOf('-', firstDash + 1) : -1
  if (secondDash > -1) {
    const after = str.substring(secondDash + 1)
    const match = after.match(/^([a-zA-Z]+)/)
    if (match) return match[1].toUpperCase()
  }
  return str.split('-')[0].trim().toUpperCase()
}

/**
 * Return true if the job should be excluded from import.
 *
 * Mirrors the Google Script: `excludedStrings.some(str => rowName.includes(str))`
 * Uses substring matching (.includes), not just prefix — any excluded string
 * appearing anywhere in the job name triggers exclusion.
 *
 * @param {string} name - Albi job name
 * @param {string[]} excludedSuffixes - per-user config: ['WTY', 'LTR', ...]
 */
export function isExcluded(name, excludedSuffixes = []) {
  const upper = String(name).toUpperCase()
  return excludedSuffixes.some(s => upper.includes(s.toUpperCase()))
}

/**
 * Returns true if the Referrer value indicates a Google lead
 * (mirrors the Google Script's isGoogleReferrer check).
 */
export function isGoogleLead(referrer) {
  return String(referrer).toLowerCase().includes('google')
}

function extractProjectLink(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''

  const hrefMatch = raw.match(/href\s*=\s*"([^"]+)"/i) || raw.match(/href\s*=\s*'([^']+)'/i)
  if (hrefMatch?.[1]) return hrefMatch[1]

  if (/^https?:\/\//i.test(raw)) return raw
  return ''
}

export function parseAlbiRecords(data, headers = [], userConfig = {}) {
  const {
    excluded_suffixes: excludedSuffixes = [],
    pipeline_mapping: pipelineMapping = {},
    sales_team: salesTeam = [],
    blacklist: blacklist = [],
  } = userConfig

  const normalizedHeaders = headers.map(h => String(h || '').trim())
  const salesTeamNames = new Set(salesTeam.map(p => String(p.name || '').trim().toLowerCase()))
  const blacklistSet = new Set(blacklist.map(b => String(b).trim()))
  const headerLower = normalizedHeaders.map(h => h.toLowerCase())
  const missingColumns = REQUIRED_COLUMNS.filter(
    req => !headerLower.includes(req.toLowerCase())
  )

  let excludedCount = 0
  let filteredCount = 0
  let noReferrerCount = 0
  const rows = []
  const unmappedSuffixes = new Set()

  data.forEach((raw, idx) => {
    const get = key => {
      const col = COLUMN_MAP[key]
      if (raw?.[col] !== undefined) return String(raw[col] || '').trim()
      const found = normalizedHeaders.find(h => h.toLowerCase() === col.toLowerCase())
      return found ? String(raw?.[found] || '').trim() : ''
    }

    const name = get('name')
    if (!name) return

    if (isExcluded(name, excludedSuffixes) || blacklistSet.has(name)) {
      excludedCount++
      return
    }

    const referrer = get('referrer')
    const salesPerson = get('salesPerson')
    if (!referrer) {
      noReferrerCount++
      return
    }

    if (salesTeamNames.size > 0) {
      const spInTeam = salesTeamNames.has(salesPerson.toLowerCase())
      const googleLead = isGoogleLead(referrer)
      if (!spInTeam && !googleLead) {
        filteredCount++
        return
      }
    }

    const customer = get('customer')
    const pipeline = getPipelineFromName(name, pipelineMapping)
    if (!pipeline) unmappedSuffixes.add(extractSuffix(name))

    rows.push({
      _rowIndex: idx,
      name,
      customer,
      referrer,
      salesPerson,
      status: get('status'),
      estimatedRevenue: parseFloat(String(get('estimatedRevenue')).replace(/[^0-9.]/g, '')) || 0,
      accrualRevenue: parseFloat(String(get('accrualRevenue')).replace(/[^0-9.]/g, '')) || 0,
      createdAt: get('createdAt'),
      customerEmail: get('customerEmail'),
      address1: get('address1'),
      city: get('city'),
      state: get('state'),
      zipCode: get('zipCode'),
      projectLink: extractProjectLink(get('projectLink')),
      insuranceCompany: get('insuranceCompany'),
      insuranceClaimNumber: get('insuranceClaimNumber'),
      propertyType: get('propertyType'),
      projectManager: get('projectManager'),
      deductible: parseFloat(String(get('deductible')).replace(/[^0-9.]/g, '')) || 0,
      pipeline,
      dealName: `${customer} - ${name}`,
      isGoogleLead: isGoogleLead(referrer),
    })
  })

  return {
    rows,
    missingColumns,
    excludedCount,
    filteredCount,
    noReferrerCount,
    unmappedSuffixes: [...unmappedSuffixes],
  }
}

export function parseAlbiSheetValues(values, userConfig = {}, linkMap = []) {
  const [headerRow = [], ...bodyRows] = values || []
  const headers = headerRow.map(h => String(h || '').trim())
  const records = bodyRows.map(row => {
    const record = {}
    headers.forEach((header, idx) => {
      record[header] = row?.[idx] ?? ''
    })
    return record
  })

  const parsed = parseAlbiRecords(records, headers, userConfig)
  parsed.rows = parsed.rows.map(row => ({
    ...row,
    projectLink: row.projectLink || linkMap[row._rowIndex + 1] || '',
  }))
  return parsed
}

/**
 * Parse an Albi CSV file with per-user config applied.
 *
 * Mirrors the Google Script's `prepareDealsForExport()` filtering logic:
 *  - Skips blank Name rows
 *  - Skips rows matching excluded suffixes (substring match)
 *  - Skips rows matching the blacklist
 *  - Skips rows with no Referrer; these never reach HubSpot create/update or import tracking
 *  - Skips rows where Sales Person is not in the configured team AND referrer is not a Google lead
 *  - Rows with a referrer but no HubSpot contact/company match go into unmatchedReferrers
 *    (handled during import, not parse — we just pass the referrer through here)
 *
 * @param {File} file
 * @param {Object} userConfig - from hs_user_config
 * @returns {Promise<{ rows, missingColumns, excludedCount, filteredCount, unmatchedCount }>}
 */
export function parseAlbiCSV(file, userConfig = {}) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim(),
      complete({ data, meta }) {
        resolve(parseAlbiRecords(data, meta.fields || [], userConfig))
      },
      error(err) {
        reject(new Error(err.message))
      },
    })
  })
}
