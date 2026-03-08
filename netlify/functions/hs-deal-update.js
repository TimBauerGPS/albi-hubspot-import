/**
 * POST /.netlify/functions/hs-deal-update
 *
 * Updates an existing Deal in HubSpot.
 * Body: { dealId: string, properties: Object }
 */

import { getHubspotKey, jsonResponse, hsPatch } from './_getHubspotKey.js'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })

  let user, config
  try {
    ;({ user, config } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  const { dealId, properties } = JSON.parse(event.body || '{}')
  if (!dealId || !properties) return jsonResponse(400, { error: 'dealId and properties are required' })

  const { hubspot_api_key: apiKey } = config

  try {
    const deal = await hsPatch(`/crm/v3/objects/deals/${dealId}`, { properties }, apiKey)
    return jsonResponse(200, { deal })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
