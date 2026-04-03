import { createClient } from '@supabase/supabase-js'

export function getAdminSupabase() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Server misconfiguration: missing Supabase service credentials.')
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}

export async function getUserContextById(supabase, userId) {
  const [memberRes, ownConfigRes] = await Promise.all([
    supabase
      .from('company_members')
      .select('company_id, role, companies(name)')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('hs_user_config')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle(),
  ])

  const member = memberRes.data
  const ownConfig = ownConfigRes.data
  const companyId = member?.company_id ?? null
  const companyName = member?.companies?.name ?? null

  let effectiveConfig = ownConfig
  if (!effectiveConfig?.hubspot_api_key && companyId) {
    const { data: companyConfig } = await supabase
      .from('hs_user_config')
      .select('*')
      .eq('company_id', companyId)
      .not('hubspot_api_key', 'is', null)
      .maybeSingle()

    if (companyConfig) effectiveConfig = companyConfig
  }

  return {
    userId,
    companyId,
    companyName,
    memberRole: member?.role ?? null,
    userConfig: ownConfig,
    effectiveConfig,
  }
}

export function isInternalJobRequest(event, body) {
  const secret = process.env.INTERNAL_CRON_SECRET
  return Boolean(
    secret &&
    body?.userId &&
    event.headers?.['x-internal-cron-secret'] === secret
  )
}
