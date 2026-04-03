import { getAdminSupabase } from './_supabaseAdmin.js'

const APP_NAME = 'albi-hubspot-import'
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
  if (getPacificHour() !== 18) {
    return new Response('Skipping outside 6pm Pacific window.', { status: 200 })
  }

  const supabase = getAdminSupabase()
  const { data: accessRows, error } = await supabase
    .from('user_app_access')
    .select('user_id')
    .eq('app_name', APP_NAME)

  if (error) {
    return new Response(error.message, { status: 500 })
  }

  const userIds = [...new Set((accessRows || []).map(row => row.user_id).filter(Boolean))]
  const results = await Promise.allSettled(
    userIds.map(userId => dispatchBackground('hs-sync-background', { userId, skipIfRecent: true }))
  )

  const queued = results.filter(r => r.status === 'fulfilled').length
  const failed = results.length - queued

  return new Response(`Queued ${queued} nightly sync job(s); ${failed} failed.`, { status: 200 })
}

export const config = {
  schedule: '5 * * * *',
}
