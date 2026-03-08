/**
 * POST /.netlify/functions/hs-sync
 *
 * Pulls contacts, companies, and existing deals from the user's HubSpot account
 * and upserts them into Supabase cache tables (hs_cached_contacts, hs_cached_companies,
 * hs_cached_deals). Only fields needed for import lookups are stored.
 *
 * This runs server-side and is invisible to users — call it before each import batch
 * or on-demand from the Configuration page.
 *
 * Reference: Import Hubspot Data.js in _reference/ (syncAllHubSpotData)
 */

import { getHubspotKey, jsonResponse, hsGet, hsPost } from './_getHubspotKey.js'

const PAGE_SIZE = 100

// Paginate through HubSpot objects via the CRM search API (no associations)
async function fetchAll(apiKey, objectType, properties, filterGroups = []) {
  const all = []
  let after = undefined

  while (true) {
    const body = { properties, limit: PAGE_SIZE, filterGroups }
    if (after) body.after = after

    const res = await hsPost(`/crm/v3/objects/${objectType}/search`, body, apiKey)
    all.push(...(res.results || []))

    if (res.paging?.next?.after) {
      after = res.paging.next.after
      await sleep(200)
    } else {
      break
    }
  }

  return all
}

// Paginate through contacts via the GET list endpoint with company associations.
// The search API doesn't support associations; the list endpoint does via ?associations=companies.
async function fetchAllContacts(apiKey) {
  const all = []
  let after = undefined

  while (true) {
    let url = `/crm/v3/objects/contacts?limit=${PAGE_SIZE}&properties=firstname,lastname,email&associations=companies`
    if (after) url += `&after=${after}`

    const res = await hsGet(url, apiKey)
    all.push(...(res.results || []))

    if (res.paging?.next?.after) {
      after = res.paging.next.after
      await sleep(200)
    } else {
      break
    }
  }

  return all
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  let user, config, supabase
  try {
    ;({ user, config, supabase } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  // Accept an optional `type` param so the frontend can call each object type
  // separately, avoiding Netlify's 10-second function timeout on large accounts.
  // type: 'contacts' | 'companies' | 'deals' | undefined (all — kept for compat)
  const { type } = JSON.parse(event.body || '{}')

  const { hubspot_api_key: apiKey } = config
  const userId = user.id
  const syncedAt = new Date().toISOString()

  const results = { contacts: 0, companies: 0, deals: 0 }
  const errors = []

  // ─── Contacts ─────────────────────────────────────────────────────────────
  // Uses the GET list endpoint (not search) so we can request associations=companies.
  // The search API doesn't support associations; the list endpoint does.
  if (!type || type === 'contacts') {
  try {
    const contacts = await fetchAllContacts(apiKey)

    if (contacts.length > 0) {
      const rows = contacts.map(c => {
        // associations.companies.results is an array of { id, type } objects
        const companyId = c.associations?.companies?.results?.[0]?.id || null
        return {
          user_id: userId,
          hubspot_id: c.id,
          email: c.properties.email || null,
          first_name: c.properties.firstname || null,
          last_name: c.properties.lastname || null,
          company_hubspot_id: companyId,
          synced_at: syncedAt,
        }
      })

      // Upsert in chunks to avoid payload limits
      for (let i = 0; i < rows.length; i += 500) {
        await supabase
          .from('hs_cached_contacts')
          .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,hubspot_id' })
      }

      results.contacts = contacts.length
    }
  } catch (err) {
    errors.push('contacts: ' + err.message)
  }
  } // end contacts

  // ─── Companies ────────────────────────────────────────────────────────────
  if (!type || type === 'companies') {
  try {
    const companies = await fetchAll(apiKey, 'companies', ['name'])

    if (companies.length > 0) {
      const rows = companies.map(c => ({
        user_id: userId,
        hubspot_id: c.id,
        name: c.properties.name || null,
        synced_at: syncedAt,
      }))

      for (let i = 0; i < rows.length; i += 500) {
        await supabase
          .from('hs_cached_companies')
          .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,hubspot_id' })
      }

      results.companies = companies.length
    }
  } catch (err) {
    errors.push('companies: ' + err.message)
  }
  } // end companies

  // ─── Deals ────────────────────────────────────────────────────────────────
  if (!type || type === 'deals') {
  try {
    const deals = await fetchAll(apiKey, 'deals', [
      'dealname', 'project_id', 'dealstage', 'pipeline',
    ])

    if (deals.length > 0) {
      const rows = deals.map(d => ({
        user_id: userId,
        hubspot_id: d.id,
        project_id: d.properties.project_id || null,
        deal_name: d.properties.dealname || null,
        deal_stage: d.properties.dealstage || null,
        pipeline: d.properties.pipeline || null,
        synced_at: syncedAt,
      }))

      for (let i = 0; i < rows.length; i += 500) {
        await supabase
          .from('hs_cached_deals')
          .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,hubspot_id' })
      }

      results.deals = deals.length
    }
  } catch (err) {
    errors.push('deals: ' + err.message)
  }
  } // end deals

  // ─── Update last sync time in user config ─────────────────────────────────
  await supabase
    .from('hs_user_config')
    .update({ updated_at: syncedAt })
    .eq('user_id', userId)

  return jsonResponse(200, {
    synced: results,
    errors: errors.length > 0 ? errors : undefined,
    syncedAt,
  })
}
