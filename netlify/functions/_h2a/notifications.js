const RESEND_API_URL = 'https://api.resend.com/emails'
const DEFAULT_FROM = 'HubSpot Importer <onboarding@resend.dev>'
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

function safeString(value, max = 120) {
  return typeof value === 'string' ? value.replace(/[\r\n<>]/g, ' ').slice(0, max) : ''
}

function checked(result) {
  if (result?.error) throw new Error('recipient_lookup_failed')
  return result?.data
}

function logSafely(logger, message) {
  try { logger?.warn?.(message) } catch { /* Logging failure must not affect sync work. */ }
}

export async function resolveCompanyAdminRecipients({ supabase, companyId }) {
  if (!supabase?.from || !supabase?.auth?.admin?.getUserById || typeof companyId !== 'string' || !companyId.trim()) {
    throw new TypeError('Tenant recipient lookup is not configured')
  }
  const [members, configs] = await Promise.all([
    supabase.from('company_members').select('user_id').eq('company_id', companyId).eq('role', 'admin'),
    supabase.from('h2a_company_config').select('notification_recipients').eq('company_id', companyId).limit(1),
  ])
  const ids = [...new Set((checked(members) ?? []).map(row => row.user_id).filter(Boolean))]
  const configured = (checked(configs)?.[0]?.notification_recipients ?? [])
  const emails = []
  for (const id of ids) {
    const result = await supabase.auth.admin.getUserById(id)
    const email = result?.data?.user?.email
    if (!result?.error && typeof email === 'string' && EMAIL.test(email.trim())) emails.push(email.trim().toLowerCase())
  }
  for (const value of Array.isArray(configured) ? configured : []) {
    if (typeof value === 'string' && EMAIL.test(value.trim())) emails.push(value.trim().toLowerCase())
  }
  return [...new Set(emails)].sort()
}

function notificationSummary({ companyName, run, newConflictCount = 0, conflictIds = [], siteUrl }) {
  const status = safeString(run?.status, 40)
  const runId = safeString(run?.id, 100)
  const conflictCount = Number.isSafeInteger(newConflictCount) ? Math.max(0, Math.min(newConflictCount, 10000)) : 0
  const totals = run?.totals && typeof run.totals === 'object' ? run.totals : {}
  const counts = ['created', 'updated', 'linked', 'delivered', 'reconciled', 'skipped', 'conflict', 'failed']
    .map(key => [key, Number.isSafeInteger(totals[key]) ? Math.max(0, Math.min(totals[key], 1000000)) : 0])
  const title = `HubSpot to Albi sync needs attention${companyName ? ` — ${safeString(companyName)}` : ''}`
  const lines = [
    'A HubSpot to Albi sync needs attention.',
    `Company: ${safeString(companyName) || 'Your company'}`,
    `Run: ${runId || 'unavailable'}`,
    `Status: ${status || 'failed'}`,
    `New conflicts: ${conflictCount}`,
    `Totals: ${counts.map(([key, value]) => `${key} ${value}`).join(', ')}`,
  ]
  const safeConflictIds = conflictIds.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)).slice(0, 10)
  if (safeConflictIds.length) lines.push(`Conflict IDs: ${safeConflictIds.join(', ')}`)
  const linkBase = typeof siteUrl === 'string' && /^https:\/\//.test(siteUrl) ? siteUrl.replace(/\/$/, '') : ''
  if (linkBase && runId) lines.push(`Review sync: ${linkBase}/hubspot-to-albi/overview`)
  if (linkBase && conflictCount) lines.push(`Review conflicts: ${linkBase}/hubspot-to-albi/conflicts`)
  return { subject: title.slice(0, 180), text: lines.join('\n') }
}

export async function notifyRunExceptions(deps, input = {}) {
  const run = input.run ?? {}
  const failed = ['failed', 'partially_failed'].includes(run.status) || Number(run.totals?.failed) > 0
  const newConflictCount = Number.isSafeInteger(input.newConflictCount) ? input.newConflictCount : 0
  if (!failed && newConflictCount < 1) return { sent: false, skipped: 'clean_run' }
  let recipients
  try {
    recipients = await (deps.resolveRecipients ?? resolveCompanyAdminRecipients)({ supabase: deps.supabase, companyId: input.companyId })
  } catch {
    logSafely(deps.logger ?? console, '[h2a-notification] recipient lookup failed')
    return { sent: false, skipped: 'recipient_lookup_failed' }
  }
  if (!recipients?.length) {
    logSafely(deps.logger ?? console, '[h2a-notification] no configured recipients')
    return { sent: false, skipped: 'no_recipients' }
  }
  const message = notificationSummary({ ...input, newConflictCount, siteUrl: deps.siteUrl ?? process.env.URL })
  const html = `<pre>${message.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`
  try {
    if (deps.sendEmail) await deps.sendEmail({ ...message, html, to: recipients })
    else {
      const apiKey = deps.resendApiKey ?? process.env.RESEND_API_KEY
      if (!apiKey) return { sent: false, skipped: 'missing_resend_api_key' }
      const response = await (deps.fetch ?? fetch)(RESEND_API_URL, { method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: deps.from ?? process.env.IMPORT_ALERT_FROM_EMAIL ?? DEFAULT_FROM, to: recipients,
          subject: message.subject, text: message.text, html }) })
      if (!response.ok) throw new Error('resend_failed')
    }
    return { sent: true, recipientCount: recipients.length }
  } catch {
    logSafely(deps.logger ?? console, '[h2a-notification] delivery failed')
    return { sent: false, skipped: 'delivery_failed' }
  }
}
