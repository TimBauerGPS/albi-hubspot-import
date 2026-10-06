import { randomUUID } from 'node:crypto'
import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { HUBSPOT_ACTIVITY_TYPES } from './_h2a/constants.js'
import { decryptSecret, encryptSecret, loadCredentialKeyring, maskSecret } from './_h2a/crypto.js'
import { pacificBusinessDate, pacificStartOfDate } from './_h2a/time.js'
import { mappingsMatchOptions, safePreflightDetails } from './_h2a/preflight.js'

const CONFIG_FIELDS = ['company_id', 'state', 'portal_id', 'selected_start_date', 'initial_start_locked_at',
  'preflight_status', 'preflight_checked_at', 'option_confirmation_status', 'options_confirmed_by',
  'options_confirmed_at', 'notification_recipients', 'created_at', 'updated_at']
const CONFIG_SELECT = [...CONFIG_FIELDS, 'preflight_details'].join(', ')
const MAPPING_SELECT = 'mapping_kind, source_key, albi_id, label, confirmed_by, confirmed_at'
const ACTION_FIELDS = {
  replace_credentials: ['hubspotToken', 'albiApiKey'],
  save_notification_recipients: ['notificationRecipients'],
  save_start_date: ['startDate'],
  confirm_option_mappings: ['optionMappings'],
  enter_dry_run: [], activate_live: [], disable: [], request_earlier_backfill: ['startDate'],
}
const MAPPING_KINDS = ['activity_type', 'default_contact_type', 'default_organization_type', 'organization_to_contact_type']
const RUN_TOTAL_FIELDS = ['created', 'updated', 'linked', 'delivered', 'reconciled', 'skipped', 'conflict', 'failed', 'dry_run']

function fail(statusCode, message) { throw new H2AAuthError(statusCode, message) }

function response(statusCode, value) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    },
    body: JSON.stringify(value),
  }
}

function parseBody(event) {
  let body
  try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body } catch { fail(400, 'Invalid request body.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'A settings action is required.')
  const fields = ACTION_FIELDS[body.action]
  if (!Object.hasOwn(ACTION_FIELDS, body.action) || !fields) fail(400, 'Unsupported settings action.')
  const allowed = new Set(['action', 'companyId', 'company_id', ...fields])
  if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'Unsupported settings fields.')
  return body
}

async function checked(query) {
  const result = await query
  if (result?.error) fail(500, 'Unable to access H2A settings.')
  return result.data
}

function defaultConfig(companyId, today) {
  return {
    company_id: companyId, state: 'disabled', selected_start_date: today, initial_start_locked_at: null,
    preflight_status: 'unchecked', preflight_details: {}, preflight_checked_at: null,
    option_confirmation_status: 'unconfirmed', options_confirmed_by: null, options_confirmed_at: null,
    notification_recipients: [],
  }
}

function fromRpc({ key_version, ...rest }) { return { ...rest, keyVersion: key_version } }
function toRpc({ keyVersion, ...rest }) { return { ...rest, key_version: keyVersion } }
function toMapping(row) {
  return { mappingKind: row.mapping_kind, sourceKey: row.source_key, albiId: row.albi_id, label: row.label }
}

function toCompletedDryRun(row) {
  if (!row) return null
  const totals = Object.fromEntries(RUN_TOTAL_FIELDS
    .filter(field => Number.isFinite(row.totals?.[field]) && row.totals[field] >= 0)
    .map(field => [field, row.totals[field]]))
  return { id: row.id, createdAt: row.created_at, finishedAt: row.finished_at, totals }
}

function validateDate(value, today) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value < '0001-01-01' || value > today) {
    fail(400, 'Start date must be a valid YYYY-MM-DD date no later than today.')
  }
  try { pacificStartOfDate(value) } catch { fail(400, 'Start date must be a valid YYYY-MM-DD calendar date.') }
  return value
}

function validateNotificationRecipients(value) {
  if (!Array.isArray(value) || value.length > 20 || value.some(email => typeof email !== 'string' || email.length > 254 ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email.trim()))) {
    fail(400, 'Notification recipients must be valid email addresses (up to 20).')
  }
  return [...new Set(value.map(email => email.trim().toLowerCase()))].sort()
}

function completeMappings(mappings) {
  return ['default_contact_type', 'default_organization_type'].every(kind =>
    mappings.some(row => row.mappingKind === kind && row.sourceKey === 'default' && row.albiId)) &&
    HUBSPOT_ACTIVITY_TYPES.every(type => mappings.some(row => row.mappingKind === 'activity_type' && row.sourceKey === type && row.albiId))
}

function validateMappings(value) {
  if (!Array.isArray(value) || value.length > 500) fail(400, 'Complete option mappings are required.')
  const seen = new Set()
  const mappings = value.map(mapping => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
      Object.keys(mapping).some(key => !['mappingKind', 'sourceKey', 'albiId', 'label'].includes(key)) ||
      !MAPPING_KINDS.includes(mapping.mappingKind) ||
      !['sourceKey', 'albiId', 'label'].every(key => typeof mapping[key] === 'string' && mapping[key].trim() && mapping[key].length <= 500)) {
      fail(400, 'Invalid option mapping.')
    }
    const result = Object.fromEntries(['mappingKind', 'sourceKey', 'albiId', 'label'].map(key => [key, mapping[key].trim()]))
    if ((result.mappingKind === 'activity_type' && !HUBSPOT_ACTIVITY_TYPES.includes(result.sourceKey)) ||
      (result.mappingKind.startsWith('default_') && result.sourceKey !== 'default')) fail(400, 'Invalid option mapping source.')
    const identity = `${result.mappingKind}:${result.sourceKey}`
    if (seen.has(identity)) fail(400, 'Duplicate option mapping.')
    seen.add(identity)
    return result
  })
  if (!completeMappings(mappings)) fail(400, 'Confirm contact and organization defaults and every activity type.')
  return mappings
}

export function createSettingsHandler(options = {}) {
  const getNow = options.now ?? (() => new Date())
  return async function settingsHandler(event) {
    if (event.httpMethod === 'OPTIONS') return response(200, {})
    if (!['GET', 'PUT'].includes(event.httpMethod)) return response(405, { error: 'Method not allowed.' })
    try {
      const body = event.httpMethod === 'PUT' ? parseBody(event) : {}
      const query = event.queryStringParameters ?? {}
      if (Object.keys(query).some(key => !['companyId', 'company_id'].includes(key))) fail(400, 'Unsupported query parameters.')
      const companyIds = [body.companyId, body.company_id, query.companyId, query.company_id].filter(value => value !== undefined)
      if (companyIds.some(value => typeof value !== 'string' || !value.trim()) || new Set(companyIds).size > 1) {
        fail(400, 'A single company selector is required.')
      }
      const context = await requireH2ARequest({ ...event, body }, {
        supabase: options.supabase, getSupabase: options.getSupabase,
        requireAdmin: event.httpMethod === 'PUT', requestedCompanyId: companyIds[0],
      })
      const { supabase, companyId, userId } = context
      const timestamp = getNow().toISOString()
      const today = pacificBusinessDate(timestamp)
      let storedConfig = await checked(supabase.from('h2a_company_config').select(CONFIG_SELECT).eq('company_id', companyId).maybeSingle())
      let config = { ...defaultConfig(companyId, today), ...storedConfig }
      // A DB null start date still represents the displayed Pacific default until saved/locked.
      config.selected_start_date ??= today
      let mappings = await checked(supabase.from('h2a_option_mappings').select(MAPPING_SELECT).eq('company_id', companyId))
      let credentials = await checked(supabase.rpc('h2a_get_credentials', { p_company_id: companyId }))
      let backfillRequestId
      let keyring
      const getKeyring = () => keyring ??= options.keyring ?? loadCredentialKeyring(options.env ?? process.env)
      const getSecrets = () => credentials ? {
        hubspotToken: decryptSecret(fromRpc(credentials.hubspot_envelope), getKeyring()),
        albiApiKey: decryptSecret(fromRpc(credentials.albi_envelope), getKeyring()),
      } : { hubspotToken: null, albiApiKey: null }

      async function getCompletedDryRun() {
        if (!config.initial_start_locked_at) return null
        return checked(supabase.from('h2a_sync_runs')
          .select('id, created_at, finished_at, totals')
          .eq('company_id', companyId)
          .eq('mode', 'dry_run')
          .eq('status', 'completed')
          .gt('created_at', config.initial_start_locked_at)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle())
      }

      async function saveConfig(patch) {
        let request
        if (storedConfig) {
          request = supabase.from('h2a_company_config').update({ ...patch, updated_at: timestamp }).eq('company_id', companyId)
          // Reject stale transitions; in particular, never overwrite a concurrent start-date lock.
          for (const field of ['updated_at', 'state', 'preflight_status', 'option_confirmation_status', 'initial_start_locked_at', 'selected_start_date', 'notification_recipients']) {
            const value = storedConfig[field]
            if (value === null) request = request.is(field, null)
            else if (value !== undefined) request = request.eq(field, value)
          }
        } else {
          request = supabase.from('h2a_company_config').insert({ ...defaultConfig(companyId, today), ...patch, updated_at: timestamp })
        }
        const saved = await checked(request.select(CONFIG_SELECT).maybeSingle())
        if (!saved) fail(409, 'Settings changed concurrently. Reload and try again.')
        storedConfig = saved
        config = { ...defaultConfig(companyId, today), ...saved }
        config.selected_start_date ??= today
      }

      async function finalizeCredentialInvalidation() {
        const saved = await checked(supabase.from('h2a_company_config').update({
          state: 'disabled', portal_id: null, preflight_status: 'unchecked', preflight_details: {}, preflight_checked_at: null,
          option_confirmation_status: 'unconfirmed', options_confirmed_by: null, options_confirmed_at: null,
          updated_at: getNow().toISOString(),
        }).eq('company_id', companyId).select(CONFIG_SELECT).maybeSingle())
        if (!saved) fail(409, 'Settings changed while credentials were being replaced. Reload and try again.')
        storedConfig = saved
        config = { ...defaultConfig(companyId, today), ...saved }
        config.selected_start_date ??= today
      }

      function requireReady() {
        if (!credentials || config.preflight_status !== 'valid' || config.option_confirmation_status !== 'confirmed' ||
          !completeMappings(mappings.map(toMapping)) || mappings.some(row => !row.confirmed_at) ||
          !mappingsMatchOptions(mappings.map(toMapping), config.preflight_details?.options)) {
          fail(409, 'Valid credentials, successful preflight, and confirmed option mappings are required.')
        }
        getSecrets() // Fail closed on unavailable key versions or unauthenticated envelopes.
        validateDate(config.selected_start_date, today)
      }

      if (event.httpMethod === 'PUT') {
        switch (body.action) {
          case 'replace_credentials': {
            const fields = ['hubspotToken', 'albiApiKey'].filter(field => Object.hasOwn(body, field))
            if (!fields.length || fields.some(field => typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 16384) ||
              (!credentials && fields.length !== 2)) fail(400, 'Supply both initial credentials or a nonempty replacement.')
            const hubspotEnvelope = Object.hasOwn(body, 'hubspotToken') ? toRpc(encryptSecret(body.hubspotToken, getKeyring())) : credentials.hubspot_envelope
            const albiEnvelope = Object.hasOwn(body, 'albiApiKey') ? toRpc(encryptSecret(body.albiApiKey, getKeyring())) : credentials.albi_envelope
            // Invalidate first: a failed private RPC must not leave a company active with stale preflight.
            await saveConfig({ state: 'disabled', portal_id: null, preflight_status: 'running', preflight_details: {}, preflight_checked_at: null,
              option_confirmation_status: 'unconfirmed', options_confirmed_by: null, options_confirmed_at: null })
            try {
              await checked(supabase.rpc('h2a_put_credentials', {
                p_company_id: companyId, p_hubspot_envelope: hubspotEnvelope, p_albi_envelope: albiEnvelope, p_updated_by: userId,
              }))
            } catch (error) {
              // Leave a failed replacement disabled; if cleanup fails, `running` still blocks readiness.
              try { await finalizeCredentialInvalidation() } catch { /* Keep the fail-closed running marker. */ }
              throw error
            }
            // Clear any preflight result that raced between initial invalidation and the credential RPC.
            await finalizeCredentialInvalidation()
            credentials = { hubspot_envelope: hubspotEnvelope, albi_envelope: albiEnvelope }
            break
          }
          case 'save_start_date': {
            const startDate = validateDate(body.startDate, today)
            if (config.initial_start_locked_at && startDate !== config.selected_start_date) {
              fail(409, startDate < config.selected_start_date ? 'Use request_earlier_backfill for an earlier date.' : 'The initial start date is fixed and cannot move forward.')
            }
            if (!storedConfig?.selected_start_date || startDate !== config.selected_start_date) await saveConfig({ selected_start_date: startDate })
            break
          }
          case 'save_notification_recipients': {
            await saveConfig({ notification_recipients: validateNotificationRecipients(body.notificationRecipients) })
            break
          }
          case 'confirm_option_mappings': {
            const confirmed = validateMappings(body.optionMappings)
            if (!mappingsMatchOptions(confirmed, config.preflight_details?.options)) {
              fail(400, 'Option mappings must use IDs from the latest tenant preflight options.')
            }
            await saveConfig({ state: 'disabled', option_confirmation_status: 'unconfirmed', options_confirmed_by: null, options_confirmed_at: null })
            const rows = confirmed.map(mapping => ({ company_id: companyId, mapping_kind: mapping.mappingKind,
              source_key: mapping.sourceKey, albi_id: mapping.albiId, label: mapping.label,
              confirmed_by: userId, confirmed_at: timestamp, updated_at: timestamp }))
            // This action confirms the entire submitted set, including removed optional mappings.
            // Keep configuration inactive/unconfirmed until the replacement set is persisted.
            await checked(supabase.from('h2a_option_mappings').delete().eq('company_id', companyId))
            await checked(supabase.from('h2a_option_mappings').insert(rows))
            mappings = await checked(supabase.from('h2a_option_mappings').select(MAPPING_SELECT).eq('company_id', companyId))
            await saveConfig({ state: config.preflight_status === 'valid' && credentials ? 'ready' : 'disabled',
              option_confirmation_status: 'confirmed', options_confirmed_by: userId, options_confirmed_at: timestamp })
            break
          }
          case 'enter_dry_run':
            requireReady()
            if (config.state === 'live') fail(409, 'Disable live sync before starting a dry run.')
            await saveConfig({ state: 'dry_run', selected_start_date: config.selected_start_date,
              initial_start_locked_at: config.initial_start_locked_at ?? timestamp })
            break
          case 'activate_live':
            requireReady()
            if (config.state !== 'dry_run' || !config.initial_start_locked_at) fail(409, 'A dry run is required before live activation.')
            if (!await getCompletedDryRun()) fail(409, 'A completed dry run is required before live activation.')
            await saveConfig({ state: 'live' })
            break
          case 'disable':
            await saveConfig({ state: 'disabled' })
            break
          case 'request_earlier_backfill': {
            const startDate = validateDate(body.startDate, today)
            if (!config.initial_start_locked_at || startDate >= config.selected_start_date) fail(409, 'Backfill requires a date earlier than the fixed initial start date.')
            const requestId = randomUUID()
            // Task 8 plans execution windows; this API records the durable requested ranges only.
            await checked(supabase.from('h2a_backfill_windows').insert(HUBSPOT_ACTIVITY_TYPES.map(objectType => ({
              company_id: companyId, object_type: objectType, request_id: requestId, requested_by: userId,
              requested_start_date: startDate, requested_at: timestamp, request_metadata: {}, status: 'pending',
              start_at: pacificStartOfDate(startDate), end_at: pacificStartOfDate(config.selected_start_date),
            }))))
            backfillRequestId = requestId
            break
          }
        }
      }
      const secrets = getSecrets()
      const protectedValues = [...Object.values(secrets),
        ...Object.values(credentials?.hubspot_envelope ?? {}), ...Object.values(credentials?.albi_envelope ?? {})]
        .filter(value => typeof value === 'string' && value.length > 0)
      const safeConfig = Object.fromEntries(CONFIG_FIELDS.filter(field => config[field] !== undefined).map(field => [field, config[field]]))
      const completedDryRun = await getCompletedDryRun()
      return response(200, {
        companyId, companyName: context.companyName,
        config: safeConfig, optionMappings: mappings.map(toMapping),
        preflight: { status: config.preflight_status, details: safePreflightDetails(config.preflight_details, protectedValues), checkedAt: config.preflight_checked_at },
        hubspotTokenMask: maskSecret(secrets.hubspotToken), albiApiKeyMask: maskSecret(secrets.albiApiKey),
        dryRunReviewReady: Boolean(completedDryRun), lastCompletedDryRun: toCompletedDryRun(completedDryRun),
        ...(backfillRequestId ? { backfillRequestId } : {}),
      })
    } catch (error) {
      // DB/provider errors may contain secrets. Never serialize or log the underlying exception.
      return response(error instanceof H2AAuthError ? error.statusCode : 500,
        { error: error instanceof H2AAuthError ? error.message : 'Unable to access H2A settings.' })
    }
  }
}

export const handler = createSettingsHandler()
