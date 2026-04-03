import { getHubspotKey, jsonResponse } from './_getHubspotKey.js'
import { fetchGoogleSheetValues } from './_googleSheets.js'
import { runImportRows } from './_hsImportCore.js'
import { getAdminSupabase, getUserContextById, isInternalJobRequest } from './_supabaseAdmin.js'
import { parseAlbiSheetValues } from '../../src/lib/parseCSV.js'

const ALLIED_COMPANY_NAME = 'Allied Restoration Services'

async function resolveUserRequestContext(event, body) {
  if (isInternalJobRequest(event, body)) {
    const supabase = getAdminSupabase()
    const context = await getUserContextById(supabase, body.userId)
    return {
      supabase,
      userId: body.userId,
      companyId: context.companyId,
      companyName: context.companyName,
      userConfig: context.userConfig,
      effectiveConfig: context.effectiveConfig,
      sheetUrl: body.sheetUrl || context.userConfig?.google_sheet_url || null,
      skipIfRecent: Boolean(body.skipIfRecent),
      internal: true,
    }
  }

  const { user, config, supabase } = await getHubspotKey(event.headers.authorization)
  const context = await getUserContextById(supabase, user.id)
  const nextSheetUrl = body.sheetUrl || context.userConfig?.google_sheet_url || null

  if (body.sheetUrl && body.sheetUrl !== context.userConfig?.google_sheet_url) {
    await supabase
      .from('hs_user_config')
      .upsert({ user_id: user.id, google_sheet_url: body.sheetUrl }, { onConflict: 'user_id' })
  }

  return {
    supabase,
    userId: user.id,
    companyId: context.companyId,
    companyName: context.companyName,
    userConfig: { ...(context.userConfig || {}), google_sheet_url: nextSheetUrl },
    effectiveConfig: config,
    sheetUrl: nextSheetUrl,
    skipIfRecent: Boolean(body.skipIfRecent),
    internal: false,
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  const body = JSON.parse(event.body || '{}')
  let importId = null

  try {
    const ctx = await resolveUserRequestContext(event, body)

    if (ctx.companyName !== ALLIED_COMPANY_NAME) {
      return jsonResponse(403, { error: 'Google Sheet import is only enabled for Allied Restoration Services.' })
    }

    if (!ctx.effectiveConfig?.hubspot_api_key) {
      return jsonResponse(400, { error: 'HubSpot API key not configured.' })
    }

    if (!ctx.sheetUrl) {
      return jsonResponse(400, { error: 'No Google Sheet URL is saved for this user.' })
    }

    const { data: importRecord, error: importErr } = await ctx.supabase
      .from('hs_imports')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId ?? null,
        filename: 'Google Sheet: queued',
        total_rows: 0,
        status: 'pending',
      })
      .select('id')
      .single()

    if (importErr) {
      return jsonResponse(500, { error: `Failed to create import record: ${importErr.message}` })
    }
    importId = importRecord.id

    const sheet = await fetchGoogleSheetValues(ctx.sheetUrl)
    const parsed = parseAlbiSheetValues(sheet.values, ctx.effectiveConfig || {})

    if (parsed.missingColumns.length > 0) {
      await ctx.supabase
        .from('hs_imports')
        .update({ status: 'error', error_count: 1 })
        .eq('id', importId)

      return jsonResponse(400, {
        error: `Missing required columns: ${parsed.missingColumns.join(', ')}`,
      })
    }

    const result = await runImportRows({
      supabase: ctx.supabase,
      userId: ctx.userId,
      companyId: ctx.companyId,
      userConfig: ctx.effectiveConfig || {},
      apiKey: ctx.effectiveConfig.hubspot_api_key,
      rows: parsed.rows,
      filename: `Google Sheet: ${sheet.spreadsheetTitle} / ${sheet.sheetTitle}`,
      skipIfRecent: ctx.skipIfRecent,
      importId,
    })

    return jsonResponse(200, {
      ...result,
      sheetTitle: sheet.sheetTitle,
      spreadsheetTitle: sheet.spreadsheetTitle,
      filteredCount: parsed.filteredCount,
      excludedCount: parsed.excludedCount,
    })
  } catch (err) {
    if (importId) {
      try {
        const supabase = getAdminSupabase()
        await supabase
          .from('hs_imports')
          .update({ status: 'error', error_count: 1 })
          .eq('id', importId)
      } catch {
        // Best effort so the UI can show progress/failure for queued imports.
      }
    }
    return jsonResponse(500, { error: err.message })
  }
}
