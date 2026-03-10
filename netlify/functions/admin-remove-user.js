import { createClient } from '@supabase/supabase-js'
import { jsonResponse } from './_getHubspotKey.js'

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {})
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })

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

  // Parse body
  let body
  try { body = JSON.parse(event.body) } catch { return jsonResponse(400, { error: 'Invalid JSON' }) }

  const { userId: targetUserId, companyId: targetCompanyId } = body
  if (!targetUserId) return jsonResponse(400, { error: 'userId is required' })

  // Prevent self-removal
  if (targetUserId === user.id) {
    return jsonResponse(400, { error: 'You cannot remove yourself.' })
  }

  // Determine which company to remove from
  let removeCompanyId = targetCompanyId
  if (!isSuperAdmin) {
    // Company admin can only manage their own company
    removeCompanyId = callerMember.company_id
  }
  if (!removeCompanyId) {
    return jsonResponse(400, { error: 'companyId is required.' })
  }

  // Prevent removing super admins unless the caller is also a super admin
  const { data: targetSuperAdmin } = await supabase
    .from('super_admins')
    .select('user_id')
    .eq('user_id', targetUserId)
    .maybeSingle()
  if (targetSuperAdmin && !isSuperAdmin) {
    return jsonResponse(403, { error: 'Cannot remove a super admin.' })
  }

  // Remove from company_members
  const { error: removeErr } = await supabase
    .from('company_members')
    .delete()
    .eq('company_id', removeCompanyId)
    .eq('user_id', targetUserId)

  if (removeErr) return jsonResponse(400, { error: 'Failed to remove member: ' + removeErr.message })

  return jsonResponse(200, { success: true })
}
