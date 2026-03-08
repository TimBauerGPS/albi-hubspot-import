/**
 * POST /.netlify/functions/hs-company-search
 *
 * Search HubSpot companies by name.
 * Returns the company ID if found, or null.
 *
 * Checks the local Supabase cache first before hitting the HubSpot API.
 *
 * Body: { name: string }
 */

import { getHubspotKey, jsonResponse, hsPost } from './_getHubspotKey.js'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })

  let user, config, supabase
  try {
    ;({ user, config, supabase } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  const { name } = JSON.parse(event.body || '{}')
  if (!name) return jsonResponse(400, { error: 'name is required' })

  // ── 1. Try cache first ────────────────────────────────────────────────────
  const { data: cached } = await supabase
    .from('hs_cached_companies')
    .select('hubspot_id')
    .eq('user_id', user.id)
    .ilike('name', name)
    .maybeSingle()

  if (cached) return jsonResponse(200, { companyId: cached.hubspot_id, source: 'cache' })

  // ── 2. Fall back to HubSpot API ───────────────────────────────────────────
  const { hubspot_api_key: apiKey } = config

  try {
    const result = await hsPost('/crm/v3/objects/companies/search', {
      filterGroups: [
        { filters: [{ propertyName: 'name', operator: 'EQ', value: name }] },
      ],
      properties: ['name'],
      limit: 1,
    }, apiKey)

    const company = result.results?.[0]
    if (!company) return jsonResponse(200, { companyId: null })

    return jsonResponse(200, { companyId: company.id, source: 'api' })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
