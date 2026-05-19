/**
 * POST /.netlify/functions/hs-contact-search
 *
 * Search HubSpot contacts by referrer name (firstName + lastName split by Import.jsx).
 * Falls back to email if provided.
 *
 * Mirrors the Google Script's matchReferrer() logic:
 *   1. Check local Supabase cache by first_name + last_name (case-insensitive)
 *   2. Fall back to HubSpot API search with firstname + lastname filters
 *   3. Return both contactId AND the contact's companyId so the caller can
 *      associate both with the new deal in one pass.
 *
 * Body: { email?: string, firstName?: string, lastName?: string }
 */

import { getHubspotKey, jsonResponse, hsGet, hsPost } from './_getHubspotKey.js'

function normalizeLookupKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function contactMatchesName(contact, firstName, lastName) {
  const props = contact.properties || {}
  const contactFirst = normalizeLookupKey(props.firstname)
  const contactLast = normalizeLookupKey(props.lastname)
  const wantedFirst = normalizeLookupKey(firstName)
  const wantedLast = normalizeLookupKey(lastName)

  if (wantedLast && contactLast !== wantedLast) return false
  if (!wantedFirst) return true
  if (contactFirst === wantedFirst) return true
  const wantedInitial = wantedFirst.replace(/\./g, '')
  return wantedInitial.length === 1 && contactFirst.startsWith(wantedInitial)
}

async function fetchContactCompanyId(contactId, apiKey) {
  const result = await hsGet(`/crm/v4/objects/contacts/${contactId}/associations/companies?limit=500`, apiKey)
  return result.results?.[0]?.toObjectId ? String(result.results[0].toObjectId) : null
}

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

  try {
    const searchBodies = []

    if (email) {
      searchBodies.push({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['firstname', 'lastname', 'email'],
        limit: 1,
      })
    } else {
      const filters = [
        ...(firstName ? [{ propertyName: 'firstname', operator: 'EQ', value: firstName }] : []),
        ...(lastName ? [{ propertyName: 'lastname', operator: 'EQ', value: lastName }] : []),
      ]
      if (filters.length > 0) {
        searchBodies.push({ filterGroups: [{ filters }], properties: ['firstname', 'lastname', 'email'], limit: 1 })
      }

      const query = [firstName, lastName].filter(Boolean).join(' ').trim()
      if (query) {
        searchBodies.push({ query, properties: ['firstname', 'lastname', 'email'], limit: 10 })
      }
    }

    let contact = null
    for (const body of searchBodies) {
      const result = await hsPost('/crm/v3/objects/contacts/search', body, apiKey)
      contact = email
        ? result.results?.[0]
        : (result.results || []).find(c => contactMatchesName(c, firstName, lastName))
      if (contact) break
    }

    if (!contact) return jsonResponse(200, { contactId: null, companyId: null })

    const companyId = await fetchContactCompanyId(contact.id, apiKey)

    await supabase
      .from('hs_cached_contacts')
      .upsert({
        user_id: user.id,
        hubspot_id: String(contact.id),
        email: contact.properties?.email || null,
        first_name: contact.properties?.firstname || null,
        last_name: contact.properties?.lastname || null,
        company_hubspot_id: companyId,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'user_id,hubspot_id' })

    return jsonResponse(200, { contactId: contact.id, companyId, source: 'api' })
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
