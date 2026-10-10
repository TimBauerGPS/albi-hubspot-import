import { requireH2ARequest, H2AAuthError } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { runCompanySync } from './_h2a/orchestrator.js'
import { decryptSecret, loadCredentialKeyring } from './_h2a/crypto.js'
import { HubSpotClient } from './_h2a/hubspotClient.js'
import { AlbiClient } from './_h2a/albiClient.js'
import { notifyRunExceptions } from './_h2a/notifications.js'
import { pacificStartOfDate } from './_h2a/time.js'

const allowedModes = new Set(['dry_run', 'live', 'backfill'])
const allowedTriggers = new Set(['manual', 'scheduled', 'resume', 'conflict_resolution'])
const ACTIVITY_TYPES = new Set(['meetings', 'calls', 'emails', 'communications', 'notes'])
const SOURCE_TYPES = new Set(['contacts', 'companies', ...ACTIVITY_TYPES])
const SAMPLE_LIMIT_PER_TYPE = 10
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Internal-Cron-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: JSON.stringify(body) })
const fail = (statusCode, message) => { throw new H2AAuthError(statusCode, message) }
const fromRpc = ({ key_version, ...envelope }) => ({ ...envelope, keyVersion: key_version })

async function notifyAfterRun(options, auth, companyId, result) {
  if (!auth.supabase || !result?.status || ['already_running', 'already_accepted'].includes(result.status)) return
  try {
    await (options.notifyRunExceptions ?? notifyRunExceptions)({ supabase: auth.supabase, siteUrl: options.siteUrl,
      resendApiKey: options.resendApiKey, fetch: options.fetch, sendEmail: options.sendEmail,
      resolveRecipients: options.resolveRecipients, logger: options.logger }, {
      companyId, companyName: auth.companyName,
      run: { id: result.runId, status: result.status, totals: result.totals ?? {} },
      newConflictCount: Number(result.newConflictCount ?? 0),
    })
  } catch { /* Notification delivery cannot change the run result. */ }
}

function requestBody(event) {
  let body
  try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body ?? {} } catch { fail(400, 'Invalid request body.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Unsupported request fields.')
  if (body.trigger === 'conflict_resolution') {
    const fields = ['companyId', 'mode', 'trigger', 'resumeId', 'sourceObjectType', 'sourceId', 'activityObjectType', 'activityId', 'originatingRunId', 'activityDeliveryId']
    if (Object.keys(body).some(key => !fields.includes(key)) || !UUID.test(body.resumeId ?? '') || body.mode !== 'live' ||
      !SOURCE_TYPES.has(body.sourceObjectType) || typeof body.sourceId !== 'string' || !body.sourceId.trim() || body.sourceId.length > 200 ||
      ((body.activityObjectType === undefined) !== (body.activityId === undefined)) ||
      body.activityObjectType !== undefined && (!ACTIVITY_TYPES.has(body.activityObjectType) || typeof body.activityId !== 'string' || !body.activityId.trim() || body.activityId.length > 200) ||
      ['originatingRunId', 'activityDeliveryId'].some(key => body[key] !== undefined && !UUID.test(body[key]))) fail(400, 'Invalid targeted resume payload.')
    return body
  }
  if (Object.keys(body).some(key => !['companyId', 'mode', 'trigger', 'runId', 'schedulerClaimId', 'businessDate', 'dryRunScope'].includes(key))) fail(400, 'Unsupported request fields.')
  if (!allowedModes.has(body.mode)) fail(400, 'Invalid sync mode.')
  if (body.dryRunScope !== undefined && (body.mode !== 'dry_run' || !['sample', 'full'].includes(body.dryRunScope))) fail(400, 'Invalid dry-run scope.')
  if (body.runId !== undefined && (typeof body.runId !== 'string' || !body.runId.trim())) fail(400, 'Invalid run ID.')
  if (body.schedulerClaimId !== undefined && body.schedulerClaimId !== body.runId) fail(400, 'Invalid scheduler identity.')
  if (body.trigger !== undefined && !allowedTriggers.has(body.trigger)) fail(400, 'Invalid sync trigger.')
  return body
}

async function dispatchBackground(payload, options) {
  if (options.dispatch) return options.dispatch(payload)
  const base = options.siteUrl ?? process.env.URL
  const secret = options.internalCronSecret ?? process.env.INTERNAL_CRON_SECRET
  if (!base || !secret) throw new Error('H2A background dispatch is not configured')
  const url = new URL('/.netlify/functions/h2a-run-background', base)
  const response = await (options.fetch ?? fetch)(url.toString(), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Cron-Secret': secret }, body: JSON.stringify(payload) })
  if (!response.ok) throw new Error('H2A background dispatch failed')
}

async function clientsFor(companyId, repository, options) {
  if (options.makeClients) return options.makeClients(companyId)
  const credentials = await repository.getCredentials(companyId)
  if (!credentials?.hubspot_envelope || !credentials?.albi_envelope) throw new Error('H2A credentials are missing')
  const keyring = options.keyring ?? loadCredentialKeyring(options.env ?? process.env)
  const hubspotToken = decryptSecret(fromRpc(credentials.hubspot_envelope), keyring)
  const albiApiKey = decryptSecret(fromRpc(credentials.albi_envelope), keyring)
  return { hubspot: new HubSpotClient({ token: hubspotToken, fetch: options.fetch }),
    albi: new AlbiClient({ apiKey: albiApiKey, fetch: options.fetch }) }
}

export function createRunHandler(options = {}, { background = false } = {}) {
  return async function handler(event) {
    if (event.httpMethod === 'OPTIONS') return reply(200, {})
    if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' })
    let acceptedRun
    let acceptedResume
    let notificationContext
    try {
      const body = requestBody(event)
      if (background && (typeof body.companyId !== 'string' || !body.companyId.trim())) fail(400, 'Company ID is required.')
      if (background && body.dryRunScope !== undefined) fail(400, 'Background runs use their persisted scope.')
      if (!background && (body.runId || body.trigger && body.trigger !== 'manual')) fail(400, 'Manual runs cannot resume or select a trigger.')
      const auth = await (options.requireRequest ?? requireH2ARequest)({ ...event, body }, {
        supabase: options.supabase, getSupabase: options.getSupabase,
        internalCronSecret: options.internalCronSecret, internalJob: background, requireAdmin: !background,
        requestedCompanyId: body.companyId,
      })
      const companyId = auth.companyId
      notificationContext = { auth, companyId }
      const repository = options.repository ?? createH2ARepository(auth.supabase)
      if (!background) {
        const config = await repository.getConfig(companyId)
        if (!config || config.preflight_status !== 'valid' || !config.portal_id ||
          (body.mode === 'dry_run' ? !['dry_run', 'live'].includes(config.state) : config.state !== 'live')) {
          fail(409, 'H2A configuration is not ready for this run.')
        }
        if (await repository.getActiveLease(companyId)) return reply(200, { status: 'already_running', companyId })
        const run = await repository.queueRun(companyId, { mode: body.mode, trigger: 'manual', requestedBy: auth.userId,
          sampleLimitPerType: body.dryRunScope === 'sample' ? SAMPLE_LIMIT_PER_TYPE : null })
        try { await dispatchBackground({ companyId, mode: body.mode, trigger: 'resume', runId: run.id }, options) }
        catch (error) { await repository.markQueueFailed(companyId, run.id); throw error }
        return reply(202, { status: 'queued', companyId, runId: run.id })
      }
      if (body.trigger === 'conflict_resolution') {
        if (!background || !body.companyId) fail(400, 'Targeted resumes require internal authorization and an explicit company.')
        const intent = await repository.getConflictResume(body.companyId, body.resumeId)
        if (!intent || intent.company_id !== companyId || !['pending', 'dispatched'].includes(intent.status) ||
          intent.source_object_type !== body.sourceObjectType || intent.source_id !== body.sourceId ||
          (intent.activity_object_type ?? undefined) !== body.activityObjectType || (intent.activity_id ?? undefined) !== body.activityId ||
          (intent.originating_run_id ?? undefined) !== body.originatingRunId || (intent.activity_delivery_id ?? undefined) !== body.activityDeliveryId ||
          !['link_existing', 'create_new'].includes(intent.resolution_action)) fail(409, 'Targeted resume no longer matches its saved intent.')
        acceptedResume = { repository, companyId, resumeId: intent.id }
        const existing = await repository.getResumeRun?.(companyId, body.resumeId)
        if (existing && ['completed', 'cancelled'].includes(existing.status)) {
          return reply(200, { status: 'already_accepted', companyId, resumeId: body.resumeId, runId: existing.id })
        }
        const clients = await clientsFor(companyId, repository, options)
        const result = await (options.runSync ?? runCompanySync)({ ...clients, repository, logger: options.logger,
          dispatchContinuation: payload => dispatchBackground(payload, options) }, { companyId, mode: 'live', trigger: 'conflict_resolution', resumeId: body.resumeId })
        await notifyAfterRun(options, auth, companyId, result)
        return reply(200, result)
      }
      if (!body.runId && body.trigger === 'resume') fail(400, 'Resume requires a run ID.')
      if (body.runId) acceptedRun = { repository, companyId, runId: body.runId }
      if (body.trigger === 'scheduled' && (!body.runId || !UUID.test(body.schedulerClaimId ?? '') || body.schedulerClaimId !== body.runId)) {
        fail(400, 'Scheduled runs require a stable scheduler claim ID.')
      }
      if (body.trigger === 'scheduled') {
        try { pacificStartOfDate(body.businessDate) } catch { fail(400, 'Scheduled runs require a valid Pacific business date.') }
        const existing = await repository.getRun?.(companyId, body.schedulerClaimId)
        if (existing && (existing.company_id !== companyId || existing.trigger !== 'scheduled' || existing.business_date !== body.businessDate)) {
          fail(409, 'Scheduled identity does not match its persisted run.')
        }
        if (existing && ['completed', 'cancelled'].includes(existing.status)) {
          return reply(200, { status: 'already_accepted', companyId, runId: existing.id })
        }
      }
      const clients = await clientsFor(companyId, repository, options)
      const result = await (options.runSync ?? runCompanySync)({ ...clients, repository,
        logger: options.logger, dispatchContinuation: payload => dispatchBackground(payload, options) }, {
        companyId, mode: body.mode, trigger: body.trigger ?? 'scheduled', runId: body.runId ?? null,
        schedulerClaimId: body.schedulerClaimId ?? null,
      })
      if (result.status === 'already_running' && body.runId && body.trigger === 'scheduled') {
        return reply(409, { status: 'retryable', companyId })
      }
      if (result.status === 'already_running' && body.runId) await repository.markRunCollision(companyId, body.runId)
      await notifyAfterRun(options, auth, companyId, result)
      return reply(200, result)
    } catch (error) {
      const persistedFailure = error?.h2aPersistedFailure
      if (persistedFailure && notificationContext) {
        await notifyAfterRun(options, notificationContext.auth, notificationContext.companyId, {
          status: 'failed', runId: persistedFailure.runId, totals: persistedFailure.totals,
          newConflictCount: persistedFailure.newConflictCount,
        })
      }
      if (acceptedResume) {
        try { await acceptedResume.repository.requeueConflictResume?.(acceptedResume.companyId, acceptedResume.resumeId) }
        catch { /* The intent remains visible for operational recovery. */ }
      }
      if (acceptedRun) {
        try { await acceptedRun.repository.markQueueFailed(acceptedRun.companyId, acceptedRun.runId) }
        catch { /* Preserve the original sanitized failure. */ }
      }
      return reply(error instanceof H2AAuthError ? error.statusCode : 502,
        { error: error instanceof H2AAuthError ? error.message : 'Unable to start H2A sync.' })
    }
  }
}

export const handler = createRunHandler()
