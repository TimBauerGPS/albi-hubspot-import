import { createSign } from 'crypto'
import { readFile } from 'fs/promises'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const DEFAULT_LOCAL_SERVICE_ACCOUNT_PATH = '/Users/TinierTim/TBDev/gps_fupm/_reference/skillful-air-294619-2d5fcd0322e6.json'
const GOOGLE_FETCH_TIMEOUT_MS = 60_000

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs)
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  }
}

async function fetchJsonWithTimeout(url, options, label) {
  const { signal, clear } = createTimeoutSignal(GOOGLE_FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(url, { ...options, signal })
    const data = await res.json()
    return { res, data }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${label} timed out after ${GOOGLE_FETCH_TIMEOUT_MS / 1000}s.`)
    }
    throw err
  } finally {
    clear()
  }
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

async function loadServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  }

  const path = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || DEFAULT_LOCAL_SERVICE_ACCOUNT_PATH
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw)
}

async function getAccessToken() {
  const credentials = await loadServiceAccount()
  const now = Math.floor(Date.now() / 1000)

  const header = { alg: 'RS256', typ: 'JWT' }
  const claimSet = {
    iss: credentials.client_email,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: credentials.token_uri || GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claimSet))}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const signature = signer.sign(credentials.private_key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

  const assertion = `${unsigned}.${signature}`
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })

  const { res, data } = await fetchJsonWithTimeout(credentials.token_uri || GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 'Google access-token request')
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to get Google access token.')
  }

  return data.access_token
}

function parseSheetUrl(sheetUrl) {
  let url
  try {
    url = new URL(sheetUrl)
  } catch {
    throw new Error('Please enter a valid Google Sheets URL.')
  }

  const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  if (!match) throw new Error('Could not find a spreadsheet ID in that Google Sheets URL.')

  const gid = url.searchParams.get('gid') || url.hash.match(/gid=(\d+)/)?.[1] || null
  return { spreadsheetId: match[1], gid }
}

async function googleGetJson(path, accessToken) {
  const { res, data } = await fetchJsonWithTimeout(`https://sheets.googleapis.com/v4/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, `Google Sheets request (${path})`)
  if (!res.ok) {
    throw new Error(data.error?.message || 'Google Sheets request failed.')
  }
  return data
}

function columnIndexToLetter(index) {
  let result = ''
  let current = index + 1
  while (current > 0) {
    const remainder = (current - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    current = Math.floor((current - 1) / 26)
  }
  return result
}

async function fetchSheetHyperlinks(spreadsheetId, sheetTitle, accessToken, values) {
  const headerRow = values?.[0] || []
  const linkColumnIndex = headerRow.findIndex(value => String(value || '').trim().toLowerCase() === 'link to project')
  if (linkColumnIndex === -1) return []

  const columnLetter = columnIndexToLetter(linkColumnIndex)
  const range = encodeURIComponent(`'${sheetTitle}'!${columnLetter}:${columnLetter}`)
  const data = await googleGetJson(
    `spreadsheets/${spreadsheetId}?includeGridData=true&ranges=${range}&fields=sheets(data(rowData(values(formattedValue,hyperlink))))`,
    accessToken
  )

  const rowData = data.sheets?.[0]?.data?.[0]?.rowData || []
  return rowData.map(row => row.values?.[0]?.hyperlink || '')
}

export async function fetchGoogleSheetValues(sheetUrl) {
  const { spreadsheetId, gid } = parseSheetUrl(sheetUrl)
  const accessToken = await getAccessToken()
  const metadata = await googleGetJson(
    `spreadsheets/${spreadsheetId}?fields=properties(title),sheets(properties(sheetId,title))`,
    accessToken
  )

  const selectedSheet = gid
    ? metadata.sheets?.find(sheet => String(sheet.properties?.sheetId) === String(gid))
    : metadata.sheets?.[0]

  if (!selectedSheet?.properties?.title) {
    throw new Error('Could not determine which worksheet to import from that Google Sheet.')
  }

  const sheetTitle = selectedSheet.properties.title
  const range = encodeURIComponent(`'${sheetTitle}'`)
  const valuesRes = await googleGetJson(
    `spreadsheets/${spreadsheetId}/values/${range}`,
    accessToken
  )
  const values = valuesRes.values || []
  const hyperlinks = await fetchSheetHyperlinks(spreadsheetId, sheetTitle, accessToken, values)

  return {
    spreadsheetId,
    spreadsheetTitle: metadata.properties?.title || 'Google Sheet',
    sheetTitle,
    values,
    hyperlinks,
  }
}
