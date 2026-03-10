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

  // Check if caller is super admin or company admin
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

  const { email, company_name, company_id: bodyCompanyId } = body
  if (!email) return jsonResponse(400, { error: 'email is required' })

  // Determine target company_id
  let targetCompanyId
  if (isSuperAdmin && company_name && !bodyCompanyId) {
    // Super admin creating a brand-new company
    const { data: newCompany, error: companyErr } = await supabase
      .from('companies')
      .insert({ name: company_name.trim() })
      .select('id')
      .single()
    if (companyErr) return jsonResponse(400, { error: 'Failed to create company: ' + companyErr.message })
    targetCompanyId = newCompany.id
  } else if (bodyCompanyId) {
    targetCompanyId = bodyCompanyId
  } else if (!isSuperAdmin && isCompanyAdmin) {
    // Company admin invites to their own company
    targetCompanyId = callerMember.company_id
  } else {
    return jsonResponse(400, { error: 'company_name is required when creating a new company.' })
  }

  const siteUrl = process.env.SITE_URL?.replace(/\/$/, '')
  if (!siteUrl) {
    return jsonResponse(500, { error: 'Server misconfiguration: SITE_URL environment variable is not set.' })
  }

  // Try to invite the user; if they already exist, find them and add to company only
  let targetUserId
  let isNew = true

  const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
    email.trim(),
    { redirectTo: `${siteUrl}/signup` }
  )

  if (inviteError) {
    const errMsg = inviteError.message?.toLowerCase() || ''
    const isExistingUser =
      errMsg.includes('already registered') ||
      errMsg.includes('already been registered') ||
      inviteError.code === 'email_exists' ||
      inviteError.status === 422

    if (!isExistingUser) return jsonResponse(400, { error: inviteError.message })

    // Find the existing user by paginating auth.users
    const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 })
    const existingUser = allUsers?.find(u => u.email?.toLowerCase() === email.trim().toLowerCase())
    if (!existingUser) {
      return jsonResponse(400, { error: 'User already exists but could not be located.' })
    }
    targetUserId = existingUser.id
    isNew = false
  } else {
    targetUserId = inviteData?.user?.id
    if (!targetUserId) return jsonResponse(500, { error: 'Failed to resolve invited user ID.' })
  }

  // Add to company_members (skip if already a member of this company)
  const { data: existingMember } = await supabase
    .from('company_members')
    .select('id')
    .eq('company_id', targetCompanyId)
    .eq('user_id', targetUserId)
    .maybeSingle()

  if (!existingMember) {
    const { error: memberErr } = await supabase
      .from('company_members')
      .insert({ company_id: targetCompanyId, user_id: targetUserId, role: 'member' })
    if (memberErr) return jsonResponse(400, { error: 'Failed to add to company: ' + memberErr.message })
  }

  return jsonResponse(200, { success: true, isNew, companyId: targetCompanyId })
}
