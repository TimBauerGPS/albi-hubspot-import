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

  // Verify caller is admin
  const { data: callerConfig } = await supabase
    .from('hs_user_config')
    .select('is_admin')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!callerConfig?.is_admin) return jsonResponse(403, { error: 'Forbidden: admin access required.' })

  let body
  try { body = JSON.parse(event.body) } catch { return jsonResponse(400, { error: 'Invalid JSON' }) }
  const { targetUserId } = body
  if (!targetUserId) return jsonResponse(400, { error: 'targetUserId is required' })

  // Prevent self-revoke
  if (targetUserId === user.id) return jsonResponse(400, { error: 'Cannot revoke your own access.' })

  // Prevent revoking another admin
  const { data: targetConfig } = await supabase
    .from('hs_user_config')
    .select('is_admin')
    .eq('user_id', targetUserId)
    .maybeSingle()
  if (targetConfig?.is_admin) return jsonResponse(400, { error: 'Cannot revoke another admin account.' })

  const { error: deleteError } = await supabase.auth.admin.deleteUser(targetUserId)
  if (deleteError) return jsonResponse(500, { error: deleteError.message })

  return jsonResponse(200, { success: true })
}
