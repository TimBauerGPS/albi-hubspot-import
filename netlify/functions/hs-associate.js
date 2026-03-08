/**
 * POST /.netlify/functions/hs-associate
 *
 * Associates a Deal with a Contact or Company in HubSpot.
 * Body: { dealId: string, objectType: 'contacts' | 'companies', objectId: string }
 *
 * Uses the CRM v4 "default" association endpoint which creates the standard
 * HUBSPOT_DEFINED association without needing to specify a typeId in the URL.
 * Endpoint: PUT /crm/v4/objects/deals/{id}/associations/default/{toType}/{toId}
 */

import { getHubspotKey, jsonResponse, hsPut } from './_getHubspotKey.js'

const VALID_OBJECT_TYPES = new Set(['contacts', 'companies'])

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })

  let user, config
  try {
    ;({ user, config } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  const { dealId, objectType, objectId } = JSON.parse(event.body || '{}')
  if (!dealId || !objectType || !objectId) {
    return jsonResponse(400, { error: 'dealId, objectType, and objectId are required' })
  }
  if (!VALID_OBJECT_TYPES.has(objectType)) {
    return jsonResponse(400, { error: `Unknown objectType: ${objectType}` })
  }

  const { hubspot_api_key: apiKey } = config

  try {
    await hsPut(
      `/crm/v4/objects/deals/${dealId}/associations/default/${objectType}/${objectId}`,
      apiKey
    )
    return jsonResponse(200, { ok: true })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
