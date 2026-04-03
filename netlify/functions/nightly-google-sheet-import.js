import { getAdminSupabase } from './_supabaseAdmin.js'

const APP_NAME = 'albi-hubspot-import'
const ALLIED_COMPANY_NAME = 'Allied Restoration Services'
const TIMEZONE = 'America/Los_Angeles'

function getPacificHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    hour12: false,
  }).format(date))
}

function getSiteUrl() {
  return process.env.URL || process.env.DEPLOY_URL || process.env.DEPLOY_PRIME_URL
}

async function dispatchBackground(path, payload) {
  const siteUrl = getSiteUrl()
  const secret = process.env.INTERNAL_CRON_SECRET

  if (!siteUrl) throw new Error('Missing Netlify site URL environment variable.')
  if (!secret) throw new Error('Missing INTERNAL_CRON_SECRET.')

  const res = await fetch(`${siteUrl}/.netlify/functions/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-cron-secret': secret,
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok && res.status !== 202) {
    const text = await res.text()
    throw new Error(`Dispatch failed (${res.status}): ${text}`)
  }
}

export default async () => {
  if (getPacificHour() !== 20) {
    return new Response('Skipping outside 8pm Pacific window.', { status: 200 })
  }

  const supabase = getAdminSupabase()

  const [{ data: accessRows, error: accessError }, { data: memberRows, error: memberError }, { data: configRows, error: configError }] = await Promise.all([
    supabase.from('user_app_access').select('user_id').eq('app_name', APP_NAME),
    supabase.from('company_members').select('user_id, companies(name)'),
    supabase.from('hs_user_config').select('user_id, google_sheet_url').not('google_sheet_url', 'is', null),
  ])

  const error = accessError || memberError || configError
  if (error) {
    return new Response(error.message, { status: 500 })
  }

  const appUsers = new Set((accessRows || []).map(row => row.user_id))
  const alliedUsers = new Set(
    (memberRows || [])
      .filter(row => row.companies?.name === ALLIED_COMPANY_NAME)
      .map(row => row.user_id)
  )

  const targetUserIds = [...new Set(
    (configRows || [])
      .filter(row => row.google_sheet_url && appUsers.has(row.user_id) && alliedUsers.has(row.user_id))
      .map(row => row.user_id)
  )]

  const results = await Promise.allSettled(
    targetUserIds.map(userId => dispatchBackground('google-sheet-import-background', { userId, skipIfRecent: true }))
  )

  const queued = results.filter(r => r.status === 'fulfilled').length
  const failed = results.length - queued

  return new Response(`Queued ${queued} nightly Google Sheet import(s); ${failed} failed.`, { status: 200 })
}

export const config = {
  schedule: '10 * * * *',
}
