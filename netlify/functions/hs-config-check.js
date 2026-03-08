/**
 * POST /.netlify/functions/hs-config-check
 *
 * Runs all HubSpot configuration validations for the logged-in user.
 * Returns an array of check results, each with { id, label, status, message }.
 *
 * Reference: Verify Setup.js in _reference/ (validateConfiguration function)
 */

import { getHubspotKey, jsonResponse, hsGet, hsPost } from './_getHubspotKey.js'

const REQUIRED_DEAL_PROPERTIES = [
  'project_id',
  'total_estimates',
  'accrual_revenue',
  'referral_date',
]

const REQUIRED_SCOPES = [
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.schemas.deals.read',
]

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

  const { hubspot_api_key: apiKey, pipeline_mapping = {}, sales_team = [] } = config
  const checks = []

  // Helper to add a result
  const pass = (id, label, message) => checks.push({ id, label, status: 'pass', message })
  const fail = (id, label, message) => checks.push({ id, label, status: 'fail', message })
  const warn = (id, label, message) => checks.push({ id, label, status: 'warn', message })

  // ─── 1. API key validity ───────────────────────────────────────────────────
  let accountInfo
  try {
    accountInfo = await hsGet('/account-info/v3/details', apiKey)
    pass('api_key', 'HubSpot API Key', `Connected to portal: ${accountInfo.portalId}`)
  } catch (err) {
    fail('api_key', 'HubSpot API Key',
      'API key is invalid or the request failed. Check that your Private App key is correct.')
    // Can't run further checks without a valid key
    await saveResults(supabase, user.id, checks, 'invalid')
    return jsonResponse(200, { checks })
  }

  // ─── 2. Required API scopes ────────────────────────────────────────────────
  try {
    const tokenInfo = await hsPost('/oauth/v2/private-apps/get/access-token-info', {}, apiKey)
    const grantedScopes = (tokenInfo.scopes || []).map(s => s.toLowerCase())
    const missingScopes = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s))

    if (missingScopes.length === 0) {
      pass('scopes', 'API Token Scopes', 'All required scopes are present.')
    } else {
      fail('scopes', 'API Token Scopes',
        `Missing scopes: ${missingScopes.join(', ')}. ` +
        'In HubSpot: Settings → Integrations → Private Apps → [Your App] → Scopes tab.')
    }
  } catch (err) {
    warn('scopes', 'API Token Scopes',
      'Could not verify scopes. Ensure your Private App has all required CRM scopes.')
  }

  // ─── 3. Pipelines ─────────────────────────────────────────────────────────
  let pipelineMap = {} // label (lower) → { id, stages: { label (lower) → id } }
  try {
    const { results } = await hsGet('/crm/v3/pipelines/deals', apiKey)
    results.forEach(p => {
      const stages = {}
      p.stages.forEach(s => { stages[s.label.toLowerCase().trim()] = s.id })
      pipelineMap[p.label.toLowerCase().trim()] = { id: p.id, stages }
    })

    const configuredPipelines = Object.values(pipeline_mapping)
    const uniquePipelines = [...new Set(configuredPipelines)]
    const missingPipelines = uniquePipelines.filter(
      name => !pipelineMap[name.toLowerCase().trim()]
    )

    if (missingPipelines.length === 0) {
      pass('pipelines', 'Deal Pipelines',
        `All configured pipelines found: ${uniquePipelines.join(', ')}`)
    } else {
      fail('pipelines', 'Deal Pipelines',
        `These pipelines are not found in HubSpot: ${missingPipelines.join(', ')}. ` +
        'In HubSpot: Settings → CRM → Deals → Pipelines. ' +
        'Also check your Pipeline Mapping in Configuration.')
    }
  } catch (err) {
    fail('pipelines', 'Deal Pipelines', 'Could not fetch pipelines: ' + err.message)
  }

  // ─── 4. Custom deal properties ────────────────────────────────────────────
  try {
    const { results } = await hsGet('/crm/v3/properties/deals', apiKey)
    const existingProps = results.map(p => p.name.toLowerCase())
    const missingProps = REQUIRED_DEAL_PROPERTIES.filter(p => !existingProps.includes(p))

    if (missingProps.length === 0) {
      pass('properties', 'Custom Deal Properties',
        `All required properties found: ${REQUIRED_DEAL_PROPERTIES.join(', ')}`)
    } else {
      fail('properties', 'Custom Deal Properties',
        `Missing custom deal properties: ${missingProps.join(', ')}. ` +
        'In HubSpot: Settings → Properties → Deal Properties → Create property. ' +
        `Required: ${REQUIRED_DEAL_PROPERTIES.join(', ')}`)
    }
  } catch (err) {
    fail('properties', 'Custom Deal Properties', 'Could not fetch deal properties: ' + err.message)
  }

  // ─── 5. HubSpot owners (sales team) ───────────────────────────────────────
  if (sales_team.length > 0) {
    try {
      const { results } = await hsGet('/crm/v3/owners/', apiKey)
      const ownerEmails = results.map(o => (o.email || '').toLowerCase())
      const ownerNames = results.map(o =>
        `${o.firstName || ''} ${o.lastName || ''}`.trim().toLowerCase()
      )

      const notFound = sales_team.filter(person => {
        const emailMatch = ownerEmails.includes((person.email || '').toLowerCase())
        const nameMatch = ownerNames.includes((person.name || '').toLowerCase())
        return !emailMatch && !nameMatch
      })

      if (notFound.length === 0) {
        pass('owners', 'Sales Team / HubSpot Owners',
          `All ${sales_team.length} team member(s) found in HubSpot.`)
      } else {
        fail('owners', 'Sales Team / HubSpot Owners',
          `These team members were not found as HubSpot owners: ` +
          notFound.map(p => `${p.name} (${p.email})`).join(', ') + '. ' +
          'In HubSpot: Settings → Users & Teams → Users. ' +
          'Check that email addresses match exactly.')
      }
    } catch (err) {
      warn('owners', 'Sales Team / HubSpot Owners',
        'Could not verify owners: ' + err.message)
    }
  } else {
    warn('owners', 'Sales Team / HubSpot Owners',
      'No sales team configured. Add team members in Configuration → Settings to enable owner validation.')
  }

  // ─── 6. project_id field search (upsert key exists) ───────────────────────
  try {
    const { results } = await hsGet('/crm/v3/properties/deals', apiKey)
    const hasProjectId = results.some(p => p.name === 'project_id')
    if (hasProjectId) {
      pass('upsert_key', 'Upsert Key (project_id field)',
        'The project_id field exists and will be used as the upsert key.')
    } else {
      fail('upsert_key', 'Upsert Key (project_id field)',
        'The project_id deal property is missing. ' +
        'In HubSpot: Settings → Properties → Deal Properties → Create property named "project_id" (Single-line text).')
    }
  } catch {
    // Already caught in properties check above
  }

  // ─── Determine overall status ──────────────────────────────────────────────
  const hasFail = checks.some(c => c.status === 'fail')
  const overallStatus = hasFail ? 'invalid' : 'valid'

  await saveResults(supabase, user.id, checks, overallStatus)

  return jsonResponse(200, { checks, status: overallStatus })
}

async function saveResults(supabase, userId, checks, status) {
  const errors = checks
    .filter(c => c.status === 'fail')
    .map(c => ({ id: c.id, label: c.label, message: c.message }))

  await supabase
    .from('hs_user_config')
    .upsert(
      {
        user_id: userId,
        config_status: status,
        config_checked_at: new Date().toISOString(),
        config_errors: errors,
      },
      { onConflict: 'user_id' }
    )
}
