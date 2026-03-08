/**
 * POST /.netlify/functions/hs-property-create
 *
 * Creates the required custom deal properties in HubSpot for the logged-in user.
 * Requires the crm.schemas.deals.write scope on their Private App.
 *
 * Returns { created: [], alreadyExisted: [], failed: [] }
 */

import { getHubspotKey, jsonResponse, hsGet, hsPost } from './_getHubspotKey.js'

// The custom deal properties this app requires, with their full HubSpot specs
const REQUIRED_PROPERTIES = [
  {
    name: 'project_id',
    label: 'Project ID',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation',
    description: 'Albi job number — used as the upsert key for deal imports.',
  },
  {
    name: 'total_estimates',
    label: 'Total Estimates',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation',
    description: 'Total estimated revenue from Albi.',
  },
  {
    name: 'accrual_revenue',
    label: 'Accrual Revenue',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation',
    description: 'Accrual revenue from Albi.',
  },
  {
    name: 'referral_date',
    label: 'Referral Date',
    type: 'date',
    fieldType: 'date',
    groupName: 'dealinformation',
    description: 'Date of referral from Albi.',
  },
]

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })

  let user, config
  try {
    ;({ user, config } = await getHubspotKey(event.headers.authorization))
  } catch (err) {
    return jsonResponse(401, { error: err.message })
  }

  const { hubspot_api_key: apiKey } = config

  // Fetch existing properties to skip ones that already exist
  let existingNames = []
  try {
    const { results } = await hsGet('/crm/v3/properties/deals', apiKey)
    existingNames = results.map(p => p.name.toLowerCase())
  } catch (err) {
    return jsonResponse(500, { error: 'Could not fetch existing properties: ' + err.message })
  }

  const created = []
  const alreadyExisted = []
  const failed = []

  for (const prop of REQUIRED_PROPERTIES) {
    if (existingNames.includes(prop.name.toLowerCase())) {
      alreadyExisted.push(prop.name)
      continue
    }

    try {
      await hsPost('/crm/v3/properties/deals', {
        name: prop.name,
        label: prop.label,
        type: prop.type,
        fieldType: prop.fieldType,
        groupName: prop.groupName,
        description: prop.description,
      }, apiKey)
      created.push(prop.name)
    } catch (err) {
      const msg = err.message || ''
      if (msg.includes('403') || msg.includes('MISSING_SCOPES')) {
        // Missing crm.schemas.deals.write — return instructions
        return jsonResponse(403, {
          error: 'missing_scope',
          message:
            'Your Private App is missing the crm.schemas.deals.write scope. ' +
            'To add it: HubSpot → Settings → Integrations → Private Apps → [Your App] → Scopes tab. ' +
            'Check "CRM → Write" under Schemas. Then save and re-run this.',
          manualInstructions: REQUIRED_PROPERTIES.filter(
            p => !existingNames.includes(p.name) && !created.includes(p.name)
          ),
        })
      }
      failed.push({ name: prop.name, error: msg })
    }
  }

  return jsonResponse(200, { created, alreadyExisted, failed })
}
