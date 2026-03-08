/**
 * POST /.netlify/functions/hs-deal-create
 *
 * Creates a new Deal in HubSpot.
 * Body: { properties: Object, associations: Array }
 */

import { getHubspotKey, jsonResponse, hsPost } from './_getHubspotKey.js'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })

  let user, config
  try {
    ;({ user, config } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  const { properties, associations } = JSON.parse(event.body || '{}')
  if (!properties) return jsonResponse(400, { error: 'properties is required' })

  const { hubspot_api_key: apiKey } = config

  try {
    const payload = { properties }
    if (associations?.length > 0) payload.associations = associations

    const deal = await hsPost('/crm/v3/objects/deals', payload, apiKey)
    return jsonResponse(200, { deal })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
