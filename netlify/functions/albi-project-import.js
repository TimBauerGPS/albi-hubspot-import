import { getHubspotKey, jsonResponse } from './_getHubspotKey.js'
import { runImportRows } from './_hsImportCore.js'
import { notifyGoogleSheetImportError } from './_importAlerts.js'
import { getAdminSupabase, getUserContextById, isInternalJobRequest } from './_supabaseAdmin.js'
import { parseAlbiRecords } from '../../src/lib/parseCSV.js'
import { createH2ARepository } from './_h2a/repository.js'
import { createH2AProviderClients } from './_h2a/providerClients.js'
import { ALBI_IMPORT_PREFIX, changedSinceFor, loadAlbiProjectRecords } from './_albiProjectSource.js'

// The Albi-to-HubSpot deal import, read from Albi's Projects API with the company's saved Albi key (H2A Settings).
// Same filters and import as the Google Sheet import; each run reads only projects changed since the last run.
const ALLIED_COMPANY_NAME = 'Allied Restoration Services'
const RECENT_MS = 45 * 60 * 1000

async function lastApiImport(supabase, userId) {
  const { data } = await supabase.from('hs_imports').select('imported_at, status').eq('user_id', userId)
    .like('filename', `${ALBI_IMPORT_PREFIX}%`).eq('status', 'complete').order('imported_at', { ascending: false }).limit(1).maybeSingle()
  return data?.imported_at ?? null
}

async function resolveContext(event, body) {
  if (isInternalJobRequest(event, body)) {
    const supabase = getAdminSupabase()
    const context = await getUserContextById(supabase, body.userId)
    return { supabase, admin: supabase, userId: body.userId, ...context, skipIfRecent: Boolean(body.skipIfRecent), internal: true }
  }
  const { user, config } = await getHubspotKey(event.headers.authorization)
  const admin = getAdminSupabase()
  const context = await getUserContextById(admin, user.id)
  return { supabase: admin, admin, userId: user.id, ...context, effectiveConfig: config, skipIfRecent: false, internal: false }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })
  let body
  try { body = JSON.parse(event.body || '{}') } catch { return jsonResponse(400, { error: 'Invalid request body.' }) }
  let importId = null, ctx = null
  try {
    ctx = await resolveContext(event, body)
    if (ctx.companyName !== ALLIED_COMPANY_NAME) return jsonResponse(403, { error: 'The Albi import is only enabled for Allied Restoration Services.' })
    if (!ctx.effectiveConfig?.hubspot_api_key) return jsonResponse(400, { error: 'HubSpot API key not configured.' })
    if (!ctx.companyId) return jsonResponse(400, { error: 'No company is set for this user.' })
    const lastRunAt = await lastApiImport(ctx.supabase, ctx.userId)
    if (ctx.skipIfRecent && lastRunAt && Date.now() - Date.parse(lastRunAt) < RECENT_MS) return jsonResponse(200, { skipped: true, reason: 'recent_import' })

    const startedAt = new Date().toISOString()
    const { data: importRecord, error: importErr } = await ctx.supabase.from('hs_imports')
      .insert({ user_id: ctx.userId, company_id: ctx.companyId, filename: `${ALBI_IMPORT_PREFIX} queued`, total_rows: 0, status: 'processing' })
      .select('id').single()
    if (importErr) return jsonResponse(500, { error: `Failed to create import record: ${importErr.message}` })
    importId = importRecord.id

    let clients
    try { clients = await createH2AProviderClients({ companyId: ctx.companyId, repository: createH2ARepository(ctx.admin) }) } catch {
      throw new Error('No Albi API key is saved for this company. Save it in HubSpot to Albi > Settings.')
    }
    const changedSince = changedSinceFor(lastRunAt)
    const source = await loadAlbiProjectRecords(clients.albi, { changedSince, userConfig: ctx.effectiveConfig || {} })
    const parsed = parseAlbiRecords(source.records, source.headers, ctx.effectiveConfig || {})
    const filename = `${ALBI_IMPORT_PREFIX} projects changed since ${changedSince.slice(0, 16).replace('T', ' ')} UTC`
    const result = await runImportRows({ supabase: ctx.supabase, userId: ctx.userId, companyId: ctx.companyId, userConfig: ctx.effectiveConfig || {},
      apiKey: ctx.effectiveConfig.hubspot_api_key, rows: parsed.rows, filename, importId })
    // The run's own start is the next run's starting point; imported_at records when it finished.
    await ctx.supabase.from('hs_imports').update({ imported_at: startedAt }).eq('id', importId)
    return jsonResponse(200, { ...result, source: 'albi_api', changedSince, listedCount: source.listedCount,
      filteredCount: parsed.filteredCount, excludedCount: parsed.excludedCount, noReferrerCount: parsed.noReferrerCount })
  } catch (err) {
    console.error('[albi-project-import] import failed', { importId, error: err.message })
    if (importId) {
      try { await getAdminSupabase().from('hs_imports').update({ status: 'error', error_count: 1 }).eq('id', importId) } catch { /* best effort */ }
    }
    try {
      await notifyGoogleSheetImportError({ importId, userId: ctx?.userId, companyName: ctx?.companyName, sheetUrl: 'Albi Projects API',
        message: err.message, details: { internal: ctx?.internal, source: 'albi_api' } })
    } catch { /* Alerts are best effort. */ }
    return jsonResponse(500, { error: err.message })
  }
}
