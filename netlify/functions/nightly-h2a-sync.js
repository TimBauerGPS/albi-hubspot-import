import { randomUUID } from 'node:crypto'
import { getAdminSupabase } from './_supabaseAdmin.js'
import { createH2ARepository } from './_h2a/repository.js'
import { isDailyRunDue } from './_h2a/time.js'
import { notifyRunExceptions } from './_h2a/notifications.js'
import { conflictResumePayload } from './_h2a/conflicts.js'

export const config = { schedule: '17 * * * *' }
const RESUME_BATCH_SIZE = 25
const PREFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000

async function dispatchBackground(payload, options) {
  if (options.dispatch) return (await options.dispatch(payload)) === true
  const base = options.siteUrl ?? process.env.URL
  const secret = options.internalCronSecret ?? process.env.INTERNAL_CRON_SECRET
  if (!base || !secret) throw new Error('dispatch_not_configured')
  const url = new URL('/.netlify/functions/h2a-run-background', base)
  const response = await (options.fetch ?? fetch)(url.toString(), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Cron-Secret': secret }, body: JSON.stringify(payload) })
  return response.status === 202 || response.ok
}

function checked(result) {
  if (result?.error) throw new Error('scheduler_query_failed')
  return result?.data
}

async function loadCompanies(supabase) {
  return checked(await supabase.from('h2a_company_config').select('company_id, state, portal_id, selected_start_date, preflight_status, preflight_checked_at, option_confirmation_status')
    .order('company_id', { ascending: true })) ?? []
}

function isFresh(config, now) {
  const checkedAt = Date.parse(config.preflight_checked_at)
  return Number.isFinite(checkedAt) && checkedAt <= now.getTime() && now.getTime() - checkedAt <= PREFLIGHT_MAX_AGE_MS
}

async function defaultActivationReady(repository, companyId, config, now) {
  if (config.state !== 'live' || config.preflight_status !== 'valid' || config.option_confirmation_status !== 'confirmed' ||
    !config.portal_id || !config.selected_start_date || !isFresh(config, now)) return false
  const [mappings, credentials] = await Promise.all([repository.getMappings(companyId), repository.getCredentials(companyId)])
  const required = ['meetings', 'calls', 'emails', 'communications', 'notes']
  return Boolean(credentials?.hubspot_envelope && credentials?.albi_envelope &&
    ['default_contact_type', 'default_organization_type'].every(kind => mappings.options.some(row => row.mapping_kind === kind && row.source_key === 'default' && row.confirmed_at)) &&
    required.every(type => mappings.options.some(row => row.mapping_kind === 'activity_type' && row.source_key === type && row.confirmed_at)))
}

export function createNightlyScheduler(options = {}) {
  return async function nightlyH2ASync() {
    const supabase = options.supabase ?? (options.getSupabase ?? getAdminSupabase)()
    const repository = options.repository ?? createH2ARepository(supabase)
    const now = options.now?.() ?? new Date()
    const instant = now instanceof Date ? now : new Date(now)
    const due = isDailyRunDue({ now: instant })
    const companies = await (options.loadCompanies ?? loadCompanies)(supabase)
    const results = []

    // Conflict resumes are urgent item-scoped work and do not wait for the daily tick.
    for (const company of companies) {
      const companyId = company.company_id
      let intents = []
      try { intents = await (options.listPendingResumes ?? ((id, limit) => repository.listPendingConflictResumes(id, limit)))(companyId, RESUME_BATCH_SIZE) }
      catch { results.push({ companyId, kind: 'resume', status: 'list_failed' }); continue }
      for (const intent of intents ?? []) {
        const ownerToken = randomUUID()
        let claimed
        try { claimed = await (options.claimResume ?? ((id, resumeId, owner) => repository.claimConflictResume(id, resumeId, owner, 120)))(companyId, intent.id, ownerToken) }
        catch { results.push({ companyId, kind: 'resume', resumeId: intent.id, status: 'claim_failed' }); continue }
        if (!claimed) continue
        const payload = conflictResumePayload(claimed)
        try {
          const accepted = await (options.dispatchResume ?? (body => dispatchBackground(body, options)))(payload)
          const finished = await (options.finishResume ?? ((id, resumeId, owner, ok, code) => repository.finishConflictResume(id, resumeId, owner, ok, code)))
            (companyId, intent.id, ownerToken, accepted === true, accepted === true ? null : 'dispatch_not_accepted')
          results.push({ companyId, kind: 'resume', resumeId: intent.id, status: accepted && finished ? 'accepted' : 'pending' })
        } catch {
          try { await (options.finishResume ?? ((id, resumeId, owner, ok, code) => repository.finishConflictResume(id, resumeId, owner, ok, code)))
            (companyId, intent.id, ownerToken, false, 'dispatch_failed') } catch { /* The owner lease will expire for a retry. */ }
          results.push({ companyId, kind: 'resume', resumeId: intent.id, status: 'pending' })
        }
      }
    }

    if (due.due) for (const company of companies.filter(row => row.state === 'live')) {
      const companyId = company.company_id
      try {
        const ready = await (options.isActivationReady ?? ((repo, id, config, time) => defaultActivationReady(repo, id, config, time)))
          (repository, companyId, company, instant)
        if (!ready) { results.push({ companyId, kind: 'daily', status: 'ineligible' }); continue }
        const ownerToken = randomUUID()
        const claim = await (options.claimDailyRun ?? ((id, date, owner) => repository.claimDailyRun(id, date, owner, 180)))
          (companyId, due.businessDate, ownerToken)
        if (!claim?.id || claim.acquired !== true) { results.push({ companyId, kind: 'daily', status: 'already_claimed' }); continue }
        let accepted = false
        try {
          const queued = await (options.queueScheduledRun ?? ((id, claimId, date) => repository.queueScheduledRun(id, claimId, date)))
            (companyId, claim.id, due.businessDate)
          if (queued?.id && queued.id !== claim.id) throw new Error('scheduled_run_identity_mismatch')
          accepted = await (options.dispatchScheduled ?? (payload => dispatchBackground(payload, options)))
            ({ companyId, mode: 'live', trigger: 'scheduled', runId: claim.id, schedulerClaimId: claim.id, businessDate: due.businessDate }) === true
        } catch { accepted = false }
        let finished = false
        try { finished = await (options.finishDailyRun ?? ((id, claimId, owner, ok, code) => repository.finishDailyRun(id, claimId, owner, ok, code)))
          (companyId, claim.id, ownerToken, accepted, accepted ? null : 'dispatch_failed') } catch { /* A repeated request is safe by stable runId. */ }
        results.push({ companyId, kind: 'daily', status: accepted && finished ? 'accepted' : 'retryable' })
      } catch {
        results.push({ companyId, kind: 'daily', status: 'failed' })
      }
    }
    return { statusCode: 200, body: JSON.stringify({ status: 'ok', businessDate: due.businessDate, results }) }
  }
}

export const handler = createNightlyScheduler()
