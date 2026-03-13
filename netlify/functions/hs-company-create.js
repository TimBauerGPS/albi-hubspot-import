/**
 * POST /.netlify/functions/hs-company-create
 *
 * Find or create a HubSpot company by name.
 * Searches HubSpot first to avoid duplicates, then creates if not found.
 * Always caches the result in hs_cached_companies.
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

  const { hubspot_api_key: apiKey } = config

  try {
    // 1. Search HubSpot for an existing company with this exact name
    const searchResult = await hsPost('/crm/v3/objects/companies/search', {
      filterGroups: [
        { filters: [{ propertyName: 'name', operator: 'EQ', value: name }] },
      ],
      properties: ['name'],
      limit: 1,
    }, apiKey)

    let companyId = searchResult.results?.[0]?.id ?? null

    // 2. Create if not found
    if (!companyId) {
      const created = await hsPost('/crm/v3/objects/companies', {
        properties: { name },
      }, apiKey)
      companyId = created.id
    }

    // 3. Cache so future syncs and imports find it immediately
    await supabase.from('hs_cached_companies').upsert({
      user_id: user.id,
      hubspot_id: companyId,
      name,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'user_id,hubspot_id' })

    return jsonResponse(200, { companyId })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
