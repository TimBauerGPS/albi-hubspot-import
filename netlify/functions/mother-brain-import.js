import { getHubspotKey, jsonResponse } from './_getHubspotKey.js'
import { runImportRows } from './_hsImportCore.js'
import { notifyGoogleSheetImportError } from './_importAlerts.js'
import { getAdminSupabase, getUserContextById, isInternalJobRequest } from './_supabaseAdmin.js'
import { parseAlbiRecords } from '../../src/lib/parseCSV.js'
import { MOTHER_BRAIN_IMPORT_PREFIX, loadMotherBrainProjects, motherBrainImportFilename } from './_motherBrain.js'

// The Albi-to-HubSpot deal import, read from Mother Brain so it spends no Albi requests. Mother Brain rows use the
// sheet's column names, so the same parser (filters, pipeline, deal name) and the same import run on them.
const ALLIED_COMPANY_NAME = 'Allied Restoration Services'
const RECENT_MS = 45 * 60 * 1000

async function latestImport(supabase, userId) {
  const { data } = await supabase.from('hs_imports').select('imported_at, filename, status, error_count, total_rows').eq('user_id', userId)
    .like('filename', `${MOTHER_BRAIN_IMPORT_PREFIX}%`).order('imported_at', { ascending: false }).limit(1).maybeSingle()
  return data ?? null
}

// The dataset the last clean run imported. A failed run or one with errors gets the same dataset again.
function importedVersion(latest) {
  if (latest?.status !== 'complete' || latest.error_count > 0) return null
  return String(latest.filename).slice(`${MOTHER_BRAIN_IMPORT_PREFIX} dataset `.length) || null
}

async function resolveContext(event, body) {
  if (isInternalJobRequest(event, body)) {
    const supabase = getAdminSupabase()
    const context = await getUserContextById(supabase, body.userId)
    return { supabase, userId: body.userId, ...context, nightly: Boolean(body.skipIfRecent), internal: true }
  }
  const { user, config } = await getHubspotKey(event.headers.authorization)
  const supabase = getAdminSupabase()
  const context = await getUserContextById(supabase, user.id)
  return { supabase, userId: user.id, ...context, effectiveConfig: config, nightly: false, internal: false }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })
  let body
  try { body = JSON.parse(event.body || '{}') } catch { return jsonResponse(400, { error: 'Invalid request body.' }) }
  let importId = null, ctx = null
  try {
    ctx = await resolveContext(event, body)
    if (ctx.companyName !== ALLIED_COMPANY_NAME) return jsonResponse(403, { error: 'The Mother Brain import is only enabled for Allied Restoration Services.' })
    if (!ctx.effectiveConfig?.hubspot_api_key) return jsonResponse(400, { error: 'HubSpot API key not configured.' })
    if (!ctx.companyId) return jsonResponse(400, { error: 'No company is set for this user.' })
    const latest = await latestImport(ctx.supabase, ctx.userId)
    if (ctx.nightly && latest && Date.now() - Date.parse(latest.imported_at) < RECENT_MS) return jsonResponse(200, { skipped: true, reason: 'recent_import' })

    const { data: importRecord, error: importErr } = await ctx.supabase.from('hs_imports')
      .insert({ user_id: ctx.userId, company_id: ctx.companyId, filename: `${MOTHER_BRAIN_IMPORT_PREFIX} queued`, total_rows: 0, status: 'processing' })
      .select('id').single()
    if (importErr) return jsonResponse(500, { error: `Failed to create import record: ${importErr.message}` })
    importId = importRecord.id

    // Only the nightly run skips an unchanged dataset: someone pressing the button may have changed the filters.
    const source = await loadMotherBrainProjects({ skipVersion: ctx.nightly ? importedVersion(latest) : null })
    const filename = motherBrainImportFilename(source.datasetVersionId)
    if (source.unchanged) {
      await ctx.supabase.from('hs_imports').update({ filename, total_rows: latest.total_rows ?? 0, created_count: 0, updated_count: 0, error_count: 0, status: 'complete' }).eq('id', importId)
      return jsonResponse(200, { skipped: true, reason: 'unchanged_dataset', importId, datasetVersionId: source.datasetVersionId })
    }
    const parsed = parseAlbiRecords(source.records, source.headers, ctx.effectiveConfig || {})
    const result = await runImportRows({ supabase: ctx.supabase, userId: ctx.userId, companyId: ctx.companyId, userConfig: ctx.effectiveConfig || {},
      apiKey: ctx.effectiveConfig.hubspot_api_key, rows: parsed.rows, filename, importId })
    return jsonResponse(200, { ...result, source: 'mother_brain', datasetVersionId: source.datasetVersionId, projectCount: source.records.length,
      filteredCount: parsed.filteredCount, excludedCount: parsed.excludedCount, noReferrerCount: parsed.noReferrerCount })
  } catch (err) {
    console.error('[mother-brain-import] import failed', { importId, error: err.message })
    if (importId) {
      try { await getAdminSupabase().from('hs_imports').update({ status: 'error', error_count: 1 }).eq('id', importId) } catch { /* best effort */ }
    }
    try {
      await notifyGoogleSheetImportError({ importId, userId: ctx?.userId, companyName: ctx?.companyName, sourceName: 'Mother Brain',
        message: err.message, details: { internal: ctx?.internal } })
    } catch { /* Alerts are best effort. */ }
    return jsonResponse(500, { error: err.message })
  }
}
