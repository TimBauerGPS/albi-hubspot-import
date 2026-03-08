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
 * Syncs contacts, companies, and deals from HubSpot in 3 separate calls
 * to stay within Netlify's 10-second function timeout.
 * `onStep(type)` is called before each request so the UI can show progress.
 */
export async function syncHubspotData(session, onStep) {
  const types = ['contacts', 'companies', 'deals']
  const synced = { contacts: 0, companies: 0, deals: 0 }
  const errors = []

  for (const type of types) {
    onStep?.(type)
    const res = await call('hs-sync', { type }, session)
    synced[type] = res.synced?.[type] ?? 0
    if (res.errors?.length) errors.push(...res.errors)
  }

  return { synced, errors: errors.length > 0 ? errors : undefined }
}
