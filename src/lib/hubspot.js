/**
 * Client-side helpers that call our Netlify serverless functions.
 * The HubSpot API key is NEVER sent from the browser — only the Supabase JWT is sent.
 * All functions include the Authorization header so Netlify can validate the user.
 */

const BASE = '/.netlify/functions'

async function call(path, body, session) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`)
  return data
}

export async function runConfigCheck(session) {
  return call('hs-config-check', {}, session)
}

export async function searchDeal(projectId, session) {
  return call('hs-deal-search', { projectId }, session)
}

export async function createDeal(properties, associations, session) {
  return call('hs-deal-create', { properties, associations }, session)
}

export async function updateDeal(dealId, properties, session) {
  return call('hs-deal-update', { dealId, properties }, session)
}

export async function associateDeal(dealId, objectType, objectId, session) {
  return call('hs-associate', { dealId, objectType, objectId }, session)
}

// Search by email, or by first+last name split from the Referrer field.
// Returns { contactId, companyId } — the contact's associated HubSpot company
// is included so Import.jsx can associate both with the deal in one pass.
export async function searchContact(email, firstName, lastName, session) {
  return call('hs-contact-search', { email, firstName, lastName }, session)
}

export async function searchCompany(name, session) {
  return call('hs-company-search', { name }, session)
}

export async function fetchPipelinesAndOwners(session) {
  return call('hs-meta', {}, session)
}

/**
 * Attempt to automatically create required deal properties in HubSpot.
 * Returns { created, alreadyExisted, failed } or throws with error.error === 'missing_scope'.
 */
export async function createRequiredProperties(session) {
  const res = await fetch(`/.netlify/functions/hs-property-create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({}),
  })
  const data = await res.json()
  if (res.status === 403 && data.error === 'missing_scope') {
    // Return the instructions rather than throwing — caller handles this case
    return { missingScope: true, message: data.message, manualInstructions: data.manualInstructions }
  }
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`)
  return data
}

/**
 * Queues a full HubSpot sync using a single Netlify Background Function call.
 * Returns 202 immediately; the function syncs contacts → companies → deals
 * sequentially and writes hs_user_config.updated_at when all three are done.
 *
 * Using a single sequential call (vs three parallel calls) prevents HubSpot
 * API rate-limit contention between concurrent function invocations.
 */
export async function syncHubspotData(session) {
  const res = await fetch(`/.netlify/functions/hs-sync-background`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({}),  // no type = sync all three in sequence
  })
  // Background functions always return 202 — any non-2xx means a network/config error
  if (!res.ok && res.status !== 202) {
    throw new Error(`Sync request failed: ${res.status}`)
  }
  return { background: true }
}
