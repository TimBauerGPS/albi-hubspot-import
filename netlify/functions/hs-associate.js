/**
 * POST /.netlify/functions/hs-associate
 *
 * Associates a Deal with a Contact or Company in HubSpot.
 * Body: { dealId: string, objectType: 'contacts' | 'companies', objectId: string }
 *
 * Association type IDs (HUBSPOT_DEFINED):
 *   deal → contact: 3
 *   deal → company: 5
 */

import { getHubspotKey, jsonResponse, hsPut } from './_getHubspotKey.js'

const ASSOCIATION_TYPE_IDS = {
  contacts: 3,
  companies: 5,
}

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

  const typeId = ASSOCIATION_TYPE_IDS[objectType]
  if (!typeId) return jsonResponse(400, { error: `Unknown objectType: ${objectType}` })

  const { hubspot_api_key: apiKey } = config

  try {
    await hsPut(
      `/crm/v4/objects/deals/${dealId}/associations/${objectType}/${objectId}/3`,
      apiKey
    )
    return jsonResponse(200, { ok: true })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
