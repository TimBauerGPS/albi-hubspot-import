/**
 * Shared utility for all HubSpot serverless functions.
 *
 * Flow:
 *  1. Extract the user's Supabase JWT from the Authorization header
 *  2. Validate it server-side using the service role key
 *  3. Fetch that user's HubSpot API key and config from hs_user_config
 *  4. Return { user, config } — the API key is never sent from the browser
 *
 * Netlify ignores files starting with _ as function endpoints.
 */

import { createClient } from '@supabase/supabase-js'

export async function getHubspotKey(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Unauthorized: missing session token.')
  }

  const jwt = authHeader.slice(7)

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Server misconfiguration: missing Supabase service credentials.')
  }

  // Service role client — only used server-side, never in the browser
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  // Validate the user's JWT
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt)
  if (authError || !user) {
    throw new Error('Unauthorized: invalid or expired session.')
  }

  // Fetch the user's HubSpot config row
  const { data: config, error: configError } = await supabase
    .from('hs_user_config')
    .select('hubspot_api_key, hubspot_partner_id, config_status, pipeline_mapping, excluded_suffixes, sales_team, blacklist')
    .eq('user_id', user.id)
    .maybeSingle()

  if (configError) {
    throw new Error('Failed to load HubSpot config: ' + configError.message)
  }

  if (config?.hubspot_api_key) {
    return { user, config, supabase }
  }

  // No personal config — fall back to the company's config (shared key)
  const { data: member } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (member?.company_id) {
    const { data: companyConfig } = await supabase
      .from('hs_user_config')
      .select('hubspot_api_key, hubspot_partner_id, config_status, pipeline_mapping, excluded_suffixes, sales_team, blacklist')
      .eq('company_id', member.company_id)
      .not('hubspot_api_key', 'is', null)
      .maybeSingle()

    if (companyConfig?.hubspot_api_key) {
      return { user, config: companyConfig, supabase }
    }
  }

  throw new Error('HubSpot API key not configured. Please set it up in Configuration.')
}

export function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  }
}

export function hsHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

const HS_BASE = 'https://api.hubapi.com'

export async function hsGet(path, apiKey) {
  const res = await fetch(`${HS_BASE}${path}`, {
    headers: hsHeaders(apiKey),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HubSpot ${res.status}: ${body}`)
  }
  return res.json()
}

export async function hsPost(path, body, apiKey) {
  const res = await fetch(`${HS_BASE}${path}`, {
    method: 'POST',
    headers: hsHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HubSpot ${res.status}: ${text}`)
  }
  return res.json()
}

export async function hsPatch(path, body, apiKey) {
  const res = await fetch(`${HS_BASE}${path}`, {
    method: 'PATCH',
    headers: hsHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HubSpot ${res.status}: ${text}`)
  }
  return res.json()
}

export async function hsPut(path, apiKey) {
  const res = await fetch(`${HS_BASE}${path}`, {
    method: 'PUT',
    headers: hsHeaders(apiKey),
  })
  if (!res.ok && res.status !== 204) {
    const text = await res.text()
    throw new Error(`HubSpot ${res.status}: ${text}`)
  }
  return res.status === 204 ? {} : res.json()
}
