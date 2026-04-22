import { hsGet, hsPost } from './_getHubspotKey.js'

const PAGE_SIZE = 100

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseHubspotNumber(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function fetchAll(apiKey, objectType, properties, filterGroups = []) {
  const all = []
  let after

  while (true) {
    const body = { properties, limit: PAGE_SIZE, filterGroups }
    if (after) body.after = after

    const res = await hsPost(`/crm/v3/objects/${objectType}/search`, body, apiKey)
    all.push(...(res.results || []))

    if (!res.paging?.next?.after) break
    after = res.paging.next.after
    await sleep(200)
  }

  return all
}

async function fetchAllContacts(apiKey) {
  const all = []
  let after

  while (true) {
    let url = '/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email&associations=companies'
    if (after) url += `&after=${after}`

    const res = await hsGet(url, apiKey)
    all.push(...(res.results || []))

    if (!res.paging?.next?.after) break
    after = res.paging.next.after
    await sleep(200)
  }

  return all
}

export async function runHubspotSync({ supabase, userId, apiKey, skipIfRecent = false }) {
  if (skipIfRecent) {
    const { data: currentConfig } = await supabase
      .from('hs_user_config')
      .select('updated_at')
      .eq('user_id', userId)
      .maybeSingle()

    const lastUpdated = currentConfig?.updated_at ? new Date(currentConfig.updated_at).getTime() : 0
    if (Date.now() - lastUpdated < 45 * 60 * 1000) {
      return { skipped: true, reason: 'recent_sync' }
    }
  }

  const syncedAt = new Date().toISOString()
  const results = { contacts: 0, companies: 0, deals: 0 }
  const errors = []

  try {
    const contacts = await fetchAllContacts(apiKey)
    if (contacts.length > 0) {
      const rows = contacts.map(c => ({
        user_id: userId,
        hubspot_id: c.id,
        email: c.properties.email || null,
        first_name: c.properties.firstname || null,
        last_name: c.properties.lastname || null,
        company_hubspot_id: c.associations?.companies?.results?.[0]?.id || null,
        synced_at: syncedAt,
      }))

      for (let i = 0; i < rows.length; i += 500) {
        await supabase
          .from('hs_cached_contacts')
          .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,hubspot_id' })
      }

      results.contacts = contacts.length
    }
  } catch (err) {
    errors.push(`contacts: ${err.message}`)
  }

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
    errors.push(`companies: ${err.message}`)
  }

  try {
    const deals = await fetchAll(apiKey, 'deals', [
      'dealname', 'project_id', 'dealstage', 'pipeline',
      'total_estimates', 'accrual_revenue', 'amount',
    ])

    if (deals.length > 0) {
      const rows = deals.map(d => ({
        user_id: userId,
        hubspot_id: d.id,
        project_id: d.properties.project_id || null,
        deal_name: d.properties.dealname || null,
        deal_stage: d.properties.dealstage || null,
        pipeline: d.properties.pipeline || null,
        total_estimates: parseHubspotNumber(d.properties.total_estimates),
        accrual_revenue: parseHubspotNumber(d.properties.accrual_revenue),
        amount: parseHubspotNumber(d.properties.amount),
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
    errors.push(`deals: ${err.message}`)
  }

  await supabase
    .from('hs_user_config')
    .update({ updated_at: syncedAt })
    .eq('user_id', userId)

  return {
    synced: results,
    errors: errors.length > 0 ? errors : undefined,
    syncedAt,
  }
}
