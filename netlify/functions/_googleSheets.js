import { createSign } from 'crypto'
import { readFile } from 'fs/promises'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const DEFAULT_LOCAL_SERVICE_ACCOUNT_PATH = '/Users/TinierTim/TBDev/gps_fupm/_reference/skillful-air-294619-2d5fcd0322e6.json'

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

  const res = await fetch(credentials.token_uri || GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const data = await res.json()
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
  const res = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error?.message || 'Google Sheets request failed.')
  }
  return data
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

  return {
    spreadsheetId,
    spreadsheetTitle: metadata.properties?.title || 'Google Sheet',
    sheetTitle,
    values: valuesRes.values || [],
  }
}
