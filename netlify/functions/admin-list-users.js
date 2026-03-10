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

  // Check caller permissions
  const [{ data: superAdmin }, { data: callerMember }] = await Promise.all([
    supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('company_members').select('company_id, role').eq('user_id', user.id).maybeSingle(),
  ])

  const isSuperAdmin = !!superAdmin
  const isCompanyAdmin = callerMember?.role === 'admin'

  if (!isSuperAdmin && !isCompanyAdmin) {
    return jsonResponse(403, { error: 'Forbidden: admin access required.' })
  }

  // Fetch company members (all for super admin; own company for company admin)
  let membersQuery = supabase
    .from('company_members')
    .select('user_id, company_id, role, companies(id, name)')
  if (!isSuperAdmin) {
    membersQuery = membersQuery.eq('company_id', callerMember.company_id)
  }

  const [{ data: members }, { data: configs }, { data: { users: authUsers } }] = await Promise.all([
    membersQuery,
    supabase.from('hs_user_config').select('user_id, company_id, config_status, updated_at'),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
  ])

  // Build a set of super admin IDs (for marking them in the response)
  let superAdminIds = new Set()
  if (isSuperAdmin) {
    const { data: superAdmins } = await supabase.from('super_admins').select('user_id')
    superAdminIds = new Set((superAdmins || []).map(s => s.user_id))
  }

  const configMap = new Map((configs || []).map(c => [c.user_id, c]))
  const authMap = new Map((authUsers || []).map(u => [u.id, u]))

  // Set of company_ids that have at least one valid config row — members inherit this
  const companyValidSet = new Set(
    (configs || [])
      .filter(c => c.config_status === 'valid' && c.company_id)
      .map(c => c.company_id)
  )

  const users = (members || []).map(m => {
    const auth = authMap.get(m.user_id)
    const config = configMap.get(m.user_id)
    const ownStatus = config?.config_status || 'unchecked'
    const effectiveStatus = ownStatus === 'valid' || companyValidSet.has(m.company_id)
      ? 'valid'
      : ownStatus
    return {
      id: m.user_id,
      email: auth?.email,
      company_id: m.company_id,
      company_name: m.companies?.name,
      role: m.role,
      is_super_admin: superAdminIds.has(m.user_id),
      config_status: effectiveStatus,
      last_import: config?.updated_at || null,
      created_at: auth?.created_at,
    }
  })

  // Sort by company name then email
  users.sort((a, b) => {
    const cn = (a.company_name || '').localeCompare(b.company_name || '')
    if (cn !== 0) return cn
    return (a.email || '').localeCompare(b.email || '')
  })

  return jsonResponse(200, { users })
}
