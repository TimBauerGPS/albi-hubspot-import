import { createClient } from '@supabase/supabase-js'

const VALID_APPS = ['call-analyzer', 'guardian-sms', 'albi-hubspot-import']

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  }
}

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

  // Validate caller JWT and require super admin
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt)
  if (authError || !user) return jsonResponse(401, { error: 'Unauthorized: invalid or expired session.' })

  const { data: superAdmin } = await supabase
    .from('super_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!superAdmin) return jsonResponse(403, { error: 'Forbidden: super admin access required.' })

  // Parse body
  let body
  try { body = JSON.parse(event.body) } catch { return jsonResponse(400, { error: 'Invalid JSON' }) }

  const { userId, appName } = body
  if (!userId) return jsonResponse(400, { error: 'userId is required' })
  if (!appName) return jsonResponse(400, { error: 'appName is required' })
  if (!VALID_APPS.includes(appName)) {
    return jsonResponse(400, { error: `appName must be one of: ${VALID_APPS.join(', ')}` })
  }

  const { error: upsertErr } = await supabase
    .from('user_app_access')
    .upsert({ user_id: userId, app_name: appName, role: 'member' }, { onConflict: 'user_id,app_name' })

  if (upsertErr) return jsonResponse(500, { error: 'Failed to grant access: ' + upsertErr.message })

  return jsonResponse(200, { success: true, userId, appName })
}
