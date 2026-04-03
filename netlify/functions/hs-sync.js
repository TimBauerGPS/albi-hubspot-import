/**
 * POST /.netlify/functions/hs-sync
 *
 * Accepts either:
 * - a logged-in user's Supabase JWT in Authorization, or
 * - an internal scheduled-job request with x-internal-cron-secret + { userId }.
 */

import { getHubspotKey, jsonResponse } from './_getHubspotKey.js'
import { runHubspotSync } from './_hsSyncCore.js'
import { getAdminSupabase, getUserContextById, isInternalJobRequest } from './_supabaseAdmin.js'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  const body = JSON.parse(event.body || '{}')

  try {
    if (isInternalJobRequest(event, body)) {
      const supabase = getAdminSupabase()
      const context = await getUserContextById(supabase, body.userId)
      const apiKey = context.effectiveConfig?.hubspot_api_key

      if (!apiKey) {
        return jsonResponse(404, { error: 'HubSpot API key not configured for that user.' })
      }

      const result = await runHubspotSync({
        supabase,
        userId: body.userId,
        apiKey,
        skipIfRecent: Boolean(body.skipIfRecent),
      })

      return jsonResponse(200, result)
    }

    const { user, config, supabase } = await getHubspotKey(event.headers.authorization)
    const result = await runHubspotSync({
      supabase,
      userId: user.id,
      apiKey: config.hubspot_api_key,
      skipIfRecent: Boolean(body.skipIfRecent),
    })

    return jsonResponse(200, result)
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
