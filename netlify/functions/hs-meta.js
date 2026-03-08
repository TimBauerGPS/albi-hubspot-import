/**
 * POST /.netlify/functions/hs-meta
 *
 * Returns pipelines (with stages) and owners from the user's HubSpot account.
 * Used client-side to build dropdowns for status mapping previews.
 */

import { getHubspotKey, jsonResponse, hsGet } from './_getHubspotKey.js'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  let user, config
  try {
    ;({ user, config } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  const { hubspot_api_key: apiKey } = config

  const [pipelinesRes, ownersRes] = await Promise.allSettled([
    hsGet('/crm/v3/pipelines/deals', apiKey),
    hsGet('/crm/v3/owners/', apiKey),
  ])

  const pipelines = pipelinesRes.status === 'fulfilled'
    ? pipelinesRes.value.results.map(p => ({
        id: p.id,
        label: p.label,
        stages: p.stages.map(s => ({ id: s.id, label: s.label })),
      }))
    : []

  const owners = ownersRes.status === 'fulfilled'
    ? ownersRes.value.results.map(o => ({
        id: o.id,
        name: `${o.firstName || ''} ${o.lastName || ''}`.trim(),
        email: o.email,
      }))
    : []

  return jsonResponse(200, { pipelines, owners })
}
