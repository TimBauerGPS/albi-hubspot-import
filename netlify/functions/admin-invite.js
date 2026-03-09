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

  // Parse body
  let body
  try { body = JSON.parse(event.body) } catch { return jsonResponse(400, { error: 'Invalid JSON' }) }
  const { email, company_name } = body
  if (!email || !company_name) return jsonResponse(400, { error: 'email and company_name are required' })

  // SITE_URL must be set in Netlify environment variables (e.g. https://your-app.netlify.app).
  // It must also be added to Supabase Auth → URL Configuration → Redirect URLs.
  const siteUrl = process.env.SITE_URL?.replace(/\/$/, '')
  if (!siteUrl) {
    return jsonResponse(500, { error: 'Server misconfiguration: SITE_URL environment variable is not set.' })
  }

  const { data, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { company_name },
    redirectTo: `${siteUrl}/signup`,
  })

  if (inviteError) return jsonResponse(400, { error: inviteError.message })

  return jsonResponse(200, { success: true, userId: data.user?.id })
}
