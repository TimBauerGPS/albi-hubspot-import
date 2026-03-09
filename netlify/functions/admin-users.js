import { createClient } from '@supabase/supabase-js'
import { jsonResponse } from './_getHubspotKey.js'

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {})
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' })

  const authHeader = event.headers['authorization']
  if (!authHeader?.startsWith('Bearer ')) return jsonResponse(401, { error: 'Unauthorized' })

  const jwt = authHeader.slice(7)
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: 'Server misconfiguration: missing Supabase service credentials.' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  // Validate caller JWT
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt)
  if (authError || !user) return jsonResponse(401, { error: 'Unauthorized: invalid or expired session.' })

  // Verify caller is admin
  const { data: callerConfig } = await supabase
    .from('hs_user_config')
    .select('is_admin')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!callerConfig?.is_admin) return jsonResponse(403, { error: 'Forbidden: admin access required.' })

  // Fetch all auth users (service role only)
  const { data: authData, error: usersError } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  if (usersError) return jsonResponse(500, { error: usersError.message })

  // Fetch all hs_user_config rows (no user_id filter — service role bypasses RLS)
  const { data: configs } = await supabase
    .from('hs_user_config')
    .select('user_id, company_name, config_status, is_admin')

  // Fetch most recent import per user
  const { data: imports } = await supabase
    .from('hs_imports')
    .select('user_id, imported_at')
    .order('imported_at', { ascending: false })

  // Build lookup maps
  const configMap = Object.fromEntries((configs || []).map(c => [c.user_id, c]))
  const lastImportMap = {}
  for (const imp of (imports || [])) {
    if (!lastImportMap[imp.user_id]) lastImportMap[imp.user_id] = imp.imported_at
  }

  const users = authData.users.map(u => ({
    id: u.id,
    email: u.email,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
    company_name: configMap[u.id]?.company_name ?? null,
    config_status: configMap[u.id]?.config_status ?? null,
    is_admin: configMap[u.id]?.is_admin ?? false,
    last_import: lastImportMap[u.id] ?? null,
  }))

  // Sort: admins first, then by company name
  users.sort((a, b) => {
    if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1
    return (a.company_name || a.email).localeCompare(b.company_name || b.email)
  })

  return jsonResponse(200, { users })
}
