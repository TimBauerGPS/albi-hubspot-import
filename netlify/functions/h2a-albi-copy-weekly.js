import { getAdminSupabase } from './_supabaseAdmin.js'

// The weekly rebuild of the Albi copy: early Wednesday, the point in the week furthest from Mother Brain's Saturday
// 1 AM full refresh, in even Pacific hours, which its odd-hour refreshes leave free. Two hours in case the first stops.
export const config = { schedule: '25 * * * *' }
export const REBUILD_WEEKDAY = 'Wed'
export const REBUILD_HOURS = Object.freeze([2, 4])

export function rebuildDue(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', hour12: false })
    .formatToParts(date).map(part => [part.type, part.value]))
  return parts.weekday === REBUILD_WEEKDAY && REBUILD_HOURS.includes(Number(parts.hour) % 24)
}

export function createWeeklyCopyScheduler(options = {}) {
  return async () => {
    if (!rebuildDue(options.now?.() ?? new Date())) return { statusCode: 200, body: JSON.stringify({ status: 'not_due' }) }
    const supabase = options.supabase ?? (options.getSupabase ?? getAdminSupabase)()
    const { data, error } = await supabase.from('h2a_company_config').select('company_id').in('state', ['live', 'dry_run'])
    if (error) return { statusCode: 500, body: JSON.stringify({ status: 'failed' }) }
    const base = options.siteUrl ?? process.env.URL
    const secret = options.internalCronSecret ?? process.env.INTERNAL_CRON_SECRET
    if (!base || !secret) return { statusCode: 500, body: JSON.stringify({ status: 'dispatch_not_configured' }) }
    const url = new URL('/.netlify/functions/h2a-albi-copy-rebuild-background', base)
    const results = await Promise.allSettled((data ?? []).map(({ company_id: companyId }) => (options.fetch ?? fetch)(url.toString(), { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Cron-Secret': secret }, body: JSON.stringify({ companyId }) })))
    return { statusCode: 200, body: JSON.stringify({ status: 'ok', queued: results.filter(result => result.status === 'fulfilled').length, failed: results.filter(result => result.status === 'rejected').length }) }
  }
}

export const handler = createWeeklyCopyScheduler()
