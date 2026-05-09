/**
 * POST /.netlify/functions/hs-sync-referrer-associations
 *
 * Replaces a deal's current contact/company referrer associations with the
 * latest resolved referrer IDs from the import row.
 */

import { getHubspotKey, hsDelete, hsGet, hsPut, jsonResponse } from './_getHubspotKey.js'

async function fetchDealAssociationIds(dealId, objectType, apiKey) {
  const ids = []
  let after = null

  do {
    const query = new URLSearchParams({ limit: '500' })
    if (after) query.set('after', after)

    const result = await hsGet(
      `/crm/v4/objects/deals/${dealId}/associations/${objectType}?${query.toString()}`,
      apiKey
    )

    for (const association of result.results || []) {
      if (association.toObjectId) ids.push(String(association.toObjectId))
    }

    after = result.paging?.next?.after ?? null
  } while (after)

  return ids
}

async function associateDeal(dealId, objectType, objectId, apiKey) {
  return hsPut(`/crm/v4/objects/deals/${dealId}/associations/default/${objectType}/${objectId}`, apiKey)
}

async function deleteDealAssociation(dealId, objectType, objectId, apiKey) {
  return hsDelete(`/crm/v4/objects/deals/${dealId}/associations/${objectType}/${objectId}`, apiKey)
}

async function syncAssociations(dealId, { contactId, companyId }, apiKey) {
  const desiredByType = {
    contacts: contactId ? String(contactId) : null,
    companies: companyId ? String(companyId) : null,
  }
  const changes = []

  for (const [objectType, desiredId] of Object.entries(desiredByType)) {
    const currentIds = await fetchDealAssociationIds(dealId, objectType, apiKey)

    for (const currentId of currentIds) {
      if (currentId === desiredId) continue
      await deleteDealAssociation(dealId, objectType, currentId, apiKey)
      changes.push({ action: 'removed', objectType, objectId: currentId })
    }

    if (desiredId && !currentIds.includes(desiredId)) {
      await associateDeal(dealId, objectType, desiredId, apiKey)
      changes.push({ action: 'added', objectType, objectId: desiredId })
    }
  }

  return {
    changed: changes.length > 0,
    changes,
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })

  let config
  try {
    ;({ config } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  const { dealId, contactId = null, companyId = null } = JSON.parse(event.body || '{}')
  if (!dealId) {
    return jsonResponse(400, { error: 'dealId is required' })
  }

  const { hubspot_api_key: apiKey } = config

  try {
    const result = await syncAssociations(dealId, { contactId, companyId }, apiKey)
    return jsonResponse(200, result)
  } catch (err) {
    return jsonResponse(500, { error: err.message })
  }
}
