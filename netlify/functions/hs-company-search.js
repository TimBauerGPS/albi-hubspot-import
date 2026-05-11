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

function normalizeLookupKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

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
      query: name,
      properties: ['name'],
      limit: 10,
    }, apiKey)

    const wantedName = normalizeLookupKey(name)
    const company = (result.results || []).find(c => normalizeLookupKey(c.properties?.name) === wantedName)
    if (!company) return jsonResponse(200, { companyId: null })

    await supabase
      .from('hs_cached_companies')
      .upsert({
        user_id: user.id,
        hubspot_id: String(company.id),
        name: company.properties?.name || name,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'user_id,hubspot_id' })

    return jsonResponse(200, { companyId: company.id, source: 'api' })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
