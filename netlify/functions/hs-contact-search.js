/**
 * POST /.netlify/functions/hs-contact-search
 *
 * Search HubSpot contacts by referrer name (firstName + lastName split by Import.jsx).
 * Falls back to email if provided.
 *
 * Mirrors the Google Script's matchReferrer() logic:
 *   1. Check local Supabase cache by first_name + last_name (case-insensitive)
 *   2. Fall back to HubSpot API search with firstname + lastname filters
 *   3. Return both contactId AND the contact's companyId (from company_hubspot_id in cache)
 *      so the caller can associate both with the new deal in one pass.
 *
 * Body: { email?: string, firstName?: string, lastName?: string }
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

  const { email, firstName, lastName } = JSON.parse(event.body || '{}')
  const hasName = firstName || lastName

  if (!email && !hasName) {
    return jsonResponse(400, { error: 'email or firstName/lastName is required' })
  }

  // ── 1. Try cache ───────────────────────────────────────────────────────────
  // Email takes precedence (more precise match)
  if (email) {
    const { data: cached } = await supabase
      .from('hs_cached_contacts')
      .select('hubspot_id, company_hubspot_id')
      .eq('user_id', user.id)
      .ilike('email', email)
      .maybeSingle()

    if (cached) {
      return jsonResponse(200, {
        contactId: cached.hubspot_id,
        companyId: cached.company_hubspot_id || null,
        source: 'cache',
      })
    }
  }

  // Name-based cache lookup (mirrors matchReferrer exact case-insensitive match)
  if (hasName) {
    let query = supabase
      .from('hs_cached_contacts')
      .select('hubspot_id, company_hubspot_id')
      .eq('user_id', user.id)

    if (firstName) query = query.ilike('first_name', firstName)
    if (lastName)  query = query.ilike('last_name', lastName)

    const { data: cached } = await query.maybeSingle()

    if (cached) {
      return jsonResponse(200, {
        contactId: cached.hubspot_id,
        companyId: cached.company_hubspot_id || null,
        source: 'cache',
      })
    }
  }

  // ── 2. Fall back to HubSpot API ───────────────────────────────────────────
  const { hubspot_api_key: apiKey } = config

  // Build filters — match on email OR exact first+last name
  const filters = email
    ? [{ propertyName: 'email', operator: 'EQ', value: email }]
    : [
        ...(firstName ? [{ propertyName: 'firstname', operator: 'EQ', value: firstName }] : []),
        ...(lastName  ? [{ propertyName: 'lastname',  operator: 'EQ', value: lastName  }] : []),
      ]

  try {
    const result = await hsPost('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters }],
      properties: ['firstname', 'lastname', 'email'],
      limit: 1,
    }, apiKey)

    const contact = result.results?.[0]
    if (!contact) return jsonResponse(200, { contactId: null, companyId: null })

    // companyId not available from search API — hs-sync.js stores it in cache.
    // If this contact was just fetched live (not in cache), companyId will be null;
    // populated on next sync. Caller falls back to company-name search anyway.
    return jsonResponse(200, { contactId: contact.id, companyId: null, source: 'api' })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
