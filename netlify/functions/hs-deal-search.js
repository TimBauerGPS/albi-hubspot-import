/**
 * POST /.netlify/functions/hs-deal-search
 *
 * Search HubSpot for a deal matching the given project_id (upsert key).
 * Returns the deal ID if found, or null.
 *
 * Body: { projectId: string }
 */

import { getHubspotKey, jsonResponse, hsPost } from './_getHubspotKey.js'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  let user, config
  try {
    ;({ user, config } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  const { projectId } = JSON.parse(event.body || '{}')
  if (!projectId) return jsonResponse(400, { error: 'projectId is required' })

  const { hubspot_api_key: apiKey } = config

  try {
    const result = await hsPost('/crm/v3/objects/deals/search', {
      filterGroups: [
        {
          filters: [
            { propertyName: 'project_id', operator: 'EQ', value: projectId },
          ],
        },
      ],
      // Include revenue + stage properties so Import.jsx can detect duplicates
      // (skip update if stage + revenues match the row — mirrors Google Script logic)
      properties: ['project_id', 'dealname', 'dealstage', 'pipeline', 'total_estimates', 'accrual_revenue'],
      limit: 1,
    }, apiKey)

    const deal = result.results?.[0] || null
    return jsonResponse(200, { deal, found: !!deal })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
