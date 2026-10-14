const MODES = new Set(['disabled', 'super_admin', 'admins'])
const HUBSPOT_ACTIONS = new Set(['resolve_fields', 'choose_organization'])
export const WRITE_AUTH_REJECTION_MESSAGE = 'Authentication or write scope rejected'

export function resolutionMode(value) { return MODES.has(value) ? value : 'disabled' }
export function canResolve({ mode, isAdmin = false, isSuperAdmin = false }) {
  return resolutionMode(mode) === 'admins' ? isAdmin === true || isSuperAdmin === true
    : resolutionMode(mode) === 'super_admin' && isSuperAdmin === true
}

// A read/reconciliation is not proof that a credential can perform a write.
export function hubspotWriteReadiness(resolution, events = [], credentialUpdatedAt) {
  if (!HUBSPOT_ACTIONS.has(resolution?.action) || !Number.isFinite(Date.parse(credentialUpdatedAt))) return 'verified_when_first_used'
  const cutoff = Date.parse(credentialUpdatedAt)
  const fresh = value => Number.isFinite(Date.parse(value)) && Date.parse(value) > cutoff
  if (fresh(resolution.updated_at) && resolution.provider_outcome_code === 'authorization_rejected') return 'rejected'
  if (fresh(resolution.updated_at) && resolution.provider_outcome_code === 'provider_applied') return 'available'
  const proof = [...events].filter(event => fresh(event?.created_at)).reverse().find(event => event?.event_type === 'provider_applied' ||
    event?.event_type === 'failed' && event.sanitized_details?.code === 'authorization_rejected')
  return proof?.event_type === 'provider_applied' ? 'available' : proof ? 'rejected' : 'verified_when_first_used'
}

export function projectResolutionCapability(auth, mode, hubspotWrites = 'verified_when_first_used') {
  const safeMode = resolutionMode(mode)
  return { enabled: safeMode !== 'disabled', mode: safeMode,
    canResolve: canResolve({ mode: safeMode, isAdmin: auth.role === 'admin', isSuperAdmin: auth.isSuperAdmin }),
    hubspotWrites: ['available', 'rejected'].includes(hubspotWrites) ? hubspotWrites : 'verified_when_first_used' }
}

// Query only durable outcome events, scoped to the authenticated tenant and
// current portal. A credential replacement invalidates older proof.
export async function loadHubspotWriteReadiness(supabase, companyId, config, credentialUpdatedAt) {
  if (!config?.portal_id || !Number.isFinite(Date.parse(credentialUpdatedAt))) return 'verified_when_first_used'
  try {
    let query = supabase.from('h2a_dry_run_review_resolution_events')
      .select('event_type,sanitized_details,created_at,resolution:h2a_dry_run_review_resolutions!inner(action,portal_id)')
      .eq('company_id', companyId).eq('resolution.portal_id', config.portal_id)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100)
    if (typeof credentialUpdatedAt === 'string' && Number.isFinite(Date.parse(credentialUpdatedAt))) query = query.gt('created_at', credentialUpdatedAt)
    const result = await query
    if (result?.error || !Array.isArray(result?.data)) return 'verified_when_first_used'
    for (const event of result.data) {
      if (!HUBSPOT_ACTIONS.has(event?.resolution?.action) || event.resolution.portal_id !== config.portal_id) continue
      if (event.event_type === 'provider_applied') return 'available'
      if (event.event_type === 'failed' && event.sanitized_details?.code === 'authorization_rejected') return 'rejected'
    }
  } catch { /* Missing rollout storage or unreadable proof must never claim write availability. */ }
  return 'verified_when_first_used'
}
