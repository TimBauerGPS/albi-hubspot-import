import { requireH2ARequest, H2AAuthError } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { runCompanySync } from './_h2a/orchestrator.js'
import { decryptSecret, loadCredentialKeyring } from './_h2a/crypto.js'
import { HubSpotClient } from './_h2a/hubspotClient.js'
import { AlbiClient } from './_h2a/albiClient.js'

const allowedModes = new Set(['dry_run', 'live', 'backfill'])
const allowedTriggers = new Set(['manual', 'scheduled', 'resume', 'conflict_resolution'])
const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Internal-Cron-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: JSON.stringify(body) })
const fail = (statusCode, message) => { throw new H2AAuthError(statusCode, message) }
const fromRpc = ({ key_version, ...envelope }) => ({ ...envelope, keyVersion: key_version })

function requestBody(event) {
  let body
  try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body ?? {} } catch { fail(400, 'Invalid request body.') }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).some(key => !['companyId', 'mode', 'trigger', 'runId'].includes(key))) fail(400, 'Unsupported request fields.')
  if (!allowedModes.has(body.mode)) fail(400, 'Invalid sync mode.')
  if (body.runId !== undefined && (typeof body.runId !== 'string' || !body.runId.trim())) fail(400, 'Invalid run ID.')
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
    try {
      const body = requestBody(event)
      if (background && (typeof body.companyId !== 'string' || !body.companyId.trim())) fail(400, 'Company ID is required.')
      if (!background && (body.runId || body.trigger && body.trigger !== 'manual')) fail(400, 'Manual runs cannot resume or select a trigger.')
      const auth = await (options.requireRequest ?? requireH2ARequest)({ ...event, body }, {
        supabase: options.supabase, getSupabase: options.getSupabase,
        internalCronSecret: options.internalCronSecret, internalJob: background, requireAdmin: !background,
        requestedCompanyId: body.companyId,
      })
      const companyId = auth.companyId
      const repository = options.repository ?? createH2ARepository(auth.supabase)
      if (!background) {
        const config = await repository.getConfig(companyId)
        if (!config || config.preflight_status !== 'valid' || !config.portal_id ||
          (body.mode === 'dry_run' ? !['dry_run', 'live'].includes(config.state) : config.state !== 'live')) {
          fail(409, 'H2A configuration is not ready for this run.')
        }
        if (await repository.getActiveLease(companyId)) return reply(200, { status: 'already_running', companyId })
        const run = await repository.queueRun(companyId, { mode: body.mode, trigger: 'manual', requestedBy: auth.userId })
        try { await dispatchBackground({ companyId, mode: body.mode, trigger: 'resume', runId: run.id }, options) }
        catch (error) { await repository.markQueueFailed(companyId, run.id); throw error }
        return reply(202, { status: 'queued', companyId, runId: run.id })
      }
      if (!body.runId && body.trigger === 'resume') fail(400, 'Resume requires a run ID.')
      if (body.runId) acceptedRun = { repository, companyId, runId: body.runId }
      const clients = await clientsFor(companyId, repository, options)
      const result = await (options.runSync ?? runCompanySync)({ ...clients, repository,
        dispatchContinuation: payload => dispatchBackground(payload, options) }, {
        companyId, mode: body.mode, trigger: body.trigger ?? 'scheduled', runId: body.runId ?? null,
      })
      if (result.status === 'already_running' && body.runId) await repository.markRunCollision(companyId, body.runId)
      return reply(200, result)
    } catch (error) {
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
