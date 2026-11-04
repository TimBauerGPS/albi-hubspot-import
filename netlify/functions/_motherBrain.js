// Mother Brain (https://motherbrain.netlify.app), the shared project dataset built from Albi. The deal import reads it
// instead of spending Albi requests. Server-side only: MOTHER_BRAIN_API_KEY must never reach the browser.
// docs/mother-brain-columns-needed.md lists these columns for the key; keep the two in sync.
export const MOTHER_BRAIN_IMPORT_PREFIX = 'Mother Brain:'
export const MOTHER_BRAIN_COLUMNS = Object.freeze(['Name', 'Link to Project', 'Customer', 'Status', 'Estimated Revenue', 'Accrual Revenue',
  'Sales Person', 'Created At', 'Customer Email', 'Address 1', 'City', 'State', 'Zip Code', 'Insurance Company', 'Insurance Claim Number',
  'Property Type', 'Referrer', 'Project Manager', 'Deductible'])

const PAGE_SIZE = 1000
const MAX_PAGES = 200
const ATTEMPTS = 3
const RETRY_DELAY_MS = 5000
const TIMEOUT_MS = 60000
const VERSION_HEADER = 'x-motherbrain-dataset-version'

export const motherBrainImportFilename = version => `${MOTHER_BRAIN_IMPORT_PREFIX} dataset ${version}`

function friendlyError(status, error) {
  const code = error?.code
  if (code === 'INVALID_API_KEY') return 'Mother Brain refused the API key. Check MOTHER_BRAIN_API_KEY in Netlify.'
  if (code === 'COLUMN_ACCESS_DENIED') {
    const columns = Array.isArray(error?.details?.columns) ? error.details.columns.join(', ') : 'some columns'
    return `The Mother Brain key cannot read: ${columns}. Add them to this app's key (docs/mother-brain-columns-needed.md).`
  }
  if (code === 'UNKNOWN_COLUMN') {
    const columns = Array.isArray(error?.details?.columns) ? error.details.columns.join(', ') : 'a requested column'
    return `Mother Brain does not have: ${columns}.`
  }
  if (code === 'NO_ACTIVE_DATASET') return 'Mother Brain has no active dataset right now.'
  return `Mother Brain request failed (${status}${code ? ` ${code}` : ''}).`
}

const retryable = (status, code) => status === 429 || status >= 500 || code === 'RATE_LIMITED'

async function readBody(response) {
  if ((response.headers.get('content-type') ?? '').includes('application/json')) return response.json().catch(() => ({}))
  await response.text().catch(() => '')
  return {}
}

async function queryPage(query, { baseUrl, apiKey, fetchImpl, sleep }) {
  for (let attempt = 1; ; attempt++) {
    let failure
    try {
      const response = await fetchImpl(`${baseUrl}/api/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = await readBody(response)
      if (response.ok) return { body, version: response.headers.get(VERSION_HEADER) }
      failure = new Error(friendlyError(response.status, body.error))
      if (!retryable(response.status, body.error?.code)) throw Object.assign(failure, { final: true })
    } catch (error) {
      if (error.final) throw error
      failure ??= new Error(`Could not reach Mother Brain: ${error.message}`)
    }
    if (attempt >= ATTEMPTS) throw failure
    await sleep(RETRY_DELAY_MS * attempt)
  }
}

// Reads every project from one pinned dataset version, so a refresh during the run cannot mix two snapshots. When the
// dataset is still skipVersion, stops after the first page and answers { unchanged: true }.
export async function loadMotherBrainProjects({ skipVersion = null, env = process.env, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const baseUrl = String(env.MOTHER_BRAIN_BASE_URL ?? '').trim().replace(/\/+$/, '')
  const apiKey = String(env.MOTHER_BRAIN_API_KEY ?? '').trim()
  if (!baseUrl || !apiKey) throw new Error('Mother Brain is not configured. Set MOTHER_BRAIN_BASE_URL and MOTHER_BRAIN_API_KEY in Netlify.')

  const records = []
  let datasetVersionId = null
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error('Mother Brain returned more pages than expected.')
    const { body, version } = await queryPage({ select: [...MOTHER_BRAIN_COLUMNS], limit: PAGE_SIZE, offset: records.length,
      ...(datasetVersionId ? { datasetVersionId } : {}) }, { baseUrl, apiKey, fetchImpl, sleep })
    if (!version || (datasetVersionId && version !== datasetVersionId)) throw new Error('The Mother Brain dataset changed during the import. Run it again.')
    if (!Array.isArray(body.rows) || body.rows.length > PAGE_SIZE) throw new Error('Mother Brain returned an unreadable response.')
    datasetVersionId = version
    if (version === skipVersion) return { unchanged: true, datasetVersionId, headers: [...MOTHER_BRAIN_COLUMNS], records: [] }
    records.push(...body.rows)
    if (body.rows.length < PAGE_SIZE) break
  }
  // An empty dataset is a problem at the source, not a night with no projects.
  if (!records.length) throw new Error('Mother Brain returned no projects.')
  return { unchanged: false, datasetVersionId, headers: [...MOTHER_BRAIN_COLUMNS], records }
}
