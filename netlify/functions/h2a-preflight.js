import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { decryptSecret, loadCredentialKeyring } from './_h2a/crypto.js'
import { HubSpotClient } from './_h2a/hubspotClient.js'
import { AlbiClient } from './_h2a/albiClient.js'
import { completeConfirmedMappings, runPreflight } from './_h2a/preflight.js'
import { HUBSPOT_ACTIVITY_TYPES } from './_h2a/constants.js'
import { pacificBusinessDate, pacificStartOfDate } from './_h2a/time.js'
import { isRecord } from './_h2a/http.js'

const fail = (statusCode, message) => { throw new H2AAuthError(statusCode, message) }
const response = (statusCode, body) => ({ statusCode, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
}, body: JSON.stringify(body) })
async function checked(query) { const result = await query; if (result?.error) fail(500, 'Unable to access H2A configuration.'); return result.data }
const fromRpc = ({ key_version, ...envelope }) => ({ ...envelope, keyVersion: key_version })
const snapshotFields = ['updated_at', 'state', 'preflight_status', 'option_confirmation_status', 'selected_start_date', 'initial_start_locked_at']
const sameConfig = (left, right) => left && right && snapshotFields.every(key => left[key] === right[key])
const sameCredentials = (left, right) => left && right && left.updated_at === right.updated_at &&
  ['hubspot_envelope', 'albi_envelope'].every(provider => ['ciphertext', 'iv', 'tag', 'key_version'].every(key => left[provider]?.[key] === right[provider]?.[key]))

// Shared POST boundary for preflight and its strictly read-only estimate endpoint.
export function createH2AReadHandler(options = {}, { estimate = false } = {}) {
  return async function handler(event) {
    if (event.httpMethod === 'OPTIONS') return response(200, {})
    if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed.' })
    try {
      let body
      try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body ?? {} } catch { fail(400, 'Invalid request body.') }
      const query = event.queryStringParameters ?? {}
      if (!isRecord(body) || Object.keys(body).some(key => !['companyId', 'company_id', ...(estimate ? ['startDate'] : [])].includes(key)) ||
        Object.keys(query).some(key => !['companyId', 'company_id'].includes(key))) fail(400, 'Unsupported request fields.')
      const selectors = [body.companyId, body.company_id, query.companyId, query.company_id].filter(value => value !== undefined)
      if (selectors.some(value => typeof value !== 'string' || !value.trim()) || new Set(selectors).size > 1) fail(400, 'A single company selector is required.')
      const { supabase, companyId } = await requireH2ARequest({ ...event, body }, {
        supabase: options.supabase, getSupabase: options.getSupabase, requireAdmin: true, requestedCompanyId: selectors[0],
      })
      let occurredAtGte
      if (estimate) {
        const today = pacificBusinessDate((options.now?.() ?? new Date()).toISOString())
        if (typeof body.startDate !== 'string' || body.startDate < '0001-01-01' || body.startDate > today) fail(400, 'Start date must be a valid Pacific date no later than today.')
        try { occurredAtGte = pacificStartOfDate(body.startDate) } catch { fail(400, 'Start date must be a valid YYYY-MM-DD calendar date.') }
      }
      const loadConfig = () => checked(supabase.from('h2a_company_config').select('*').eq('company_id', companyId).maybeSingle())
      const loadCredentials = () => checked(supabase.rpc('h2a_get_credentials', { p_company_id: companyId }))
      const config = estimate ? null : await loadConfig()
      if (!estimate && !config) fail(409, 'Save H2A credentials in Settings before running preflight.')
      const credentials = await loadCredentials()
      if (!credentials) fail(409, 'Save H2A credentials in Settings first.')
      const keyring = options.keyring ?? loadCredentialKeyring(options.env ?? process.env)
      const secrets = { hubspotToken: decryptSecret(fromRpc(credentials.hubspot_envelope), keyring), albiApiKey: decryptSecret(fromRpc(credentials.albi_envelope), keyring) }
      const clients = options.makeClients ? options.makeClients(secrets) : {
        hubspot: new HubSpotClient({ token: secrets.hubspotToken, fetch: options.fetch }),
        albi: new AlbiClient({ apiKey: secrets.albiApiKey, fetch: options.fetch }),
      }
      if (estimate) {
        const byObjectType = {}; let capped = false
        for (const objectType of HUBSPOT_ACTIVITY_TYPES) {
          const result = await clients.hubspot.estimateActivities({ objectType, occurredAtGte })
          if (!Number.isSafeInteger(result?.count) || result.count < 0 || typeof result.capped !== 'boolean') fail(502, 'Unable to estimate HubSpot activities.')
          byObjectType[objectType] = result.count; capped ||= result.capped
        }
        return response(200, { total: Object.values(byObjectType).reduce((sum, count) => sum + count, 0), byObjectType, capped })
      }
      const protectedValues = [...Object.values(secrets), ...Object.values(credentials.hubspot_envelope), ...Object.values(credentials.albi_envelope)].filter(value => typeof value === 'string' && value)
      const result = await runPreflight({ ...clients, protectedValues })
      // Both versions are captured before external calls and reloaded immediately before persistence.
      const freshConfig = await loadConfig()
      const freshCredentials = await loadCredentials()
      if (!sameConfig(config, freshConfig) || !sameCredentials(credentials, freshCredentials)) fail(409, 'Settings changed during preflight. Run preflight again.')
      const mappings = await checked(supabase.from('h2a_option_mappings').select('mapping_kind, source_key, albi_id, confirmed_at').eq('company_id', companyId))
      const confirmed = config.option_confirmation_status === 'confirmed' && completeConfirmedMappings(mappings, result.details.options)
      const checkedAt = (options.now?.() ?? new Date()).toISOString()
      const patch = { portal_id: result.portalId, preflight_status: result.status, preflight_details: result.details, preflight_checked_at: checkedAt, updated_at: checkedAt }
      if (result.status !== 'valid' || !confirmed) patch.state = 'disabled'
      if (!confirmed) Object.assign(patch, { option_confirmation_status: 'unconfirmed', options_confirmed_by: null, options_confirmed_at: null })
      let update = supabase.from('h2a_company_config').update(patch).eq('company_id', companyId)
      for (const field of snapshotFields) {
        if (config[field] === null) update = update.is(field, null)
        else if (config[field] !== undefined) update = update.eq(field, config[field])
      }
      const saved = await checked(update.select('company_id').maybeSingle())
      if (!saved) fail(409, 'Settings changed during preflight. Run preflight again.')
      return response(200, { companyId, portalId: result.portalId, preflight: { status: result.status, details: result.details, checkedAt } })
    } catch (error) {
      return response(error instanceof H2AAuthError ? error.statusCode : 502,
        { error: error instanceof H2AAuthError ? error.message : 'Unable to complete H2A provider checks.' })
    }
  }
}
export const createPreflightHandler = options => createH2AReadHandler(options)
export const handler = createPreflightHandler()
