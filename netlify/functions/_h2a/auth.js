import { getAdminSupabase } from '../_supabaseAdmin.js'

export class H2AAuthError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'H2AAuthError'
    this.statusCode = statusCode
  }
}

function fail(statusCode, message) {
  throw new H2AAuthError(statusCode, message)
}

function checkLookup(result) {
  if (result.error) fail(500, 'Unable to resolve H2A authorization context.')
  return result.data
}

async function getCompany(supabase, companyId) {
  let result
  try {
    result = await supabase
      .from('companies')
      .select('id, name')
      .eq('id', companyId)
      .maybeSingle()
  } catch {
    fail(500, 'Unable to resolve H2A authorization context.')
  }
  const company = checkLookup(result)
  if (!company) fail(404, 'Company not found.')
  return company
}

async function authenticate(supabase, jwt) {
  if (!jwt || typeof jwt !== 'string') fail(401, 'Authentication required.')
  let result
  try {
    result = await supabase.auth.getUser(jwt)
  } catch {
    fail(401, 'Invalid authentication token.')
  }
  if (result?.error || !result?.data?.user?.id) fail(401, 'Invalid authentication token.')
  return result.data.user.id
}

export async function resolveH2AContext({ supabase, jwt, requestedCompanyId, requireAdmin = false }) {
  if (!supabase) fail(500, 'H2A authorization is not configured.')

  const userId = await authenticate(supabase, jwt)
  let superAdminResult
  let memberResult
  try {
    [superAdminResult, memberResult] = await Promise.all([
      supabase.from('super_admins').select('user_id').eq('user_id', userId).maybeSingle(),
      supabase.from('company_members').select('company_id, role').eq('user_id', userId).maybeSingle(),
    ])
  } catch {
    fail(500, 'Unable to resolve H2A authorization context.')
  }

  const superAdmin = checkLookup(superAdminResult)
  const member = checkLookup(memberResult)
  const isSuperAdmin = Boolean(superAdmin)
  if (!isSuperAdmin && !member?.company_id) fail(403, 'You are not authorized to access H2A.')

  if (requireAdmin && !isSuperAdmin && member.role !== 'admin') {
    fail(403, 'Administrator access is required.')
  }

  let companyId
  if (isSuperAdmin) {
    companyId = requestedCompanyId || member?.company_id
    if (!companyId) fail(403, 'A company must be selected.')
  } else {
    companyId = member.company_id
    if (requestedCompanyId && requestedCompanyId !== companyId) {
      fail(403, 'You are not authorized to access the requested company.')
    }
  }

  const company = await getCompany(supabase, companyId)
  return {
    userId,
    companyId: company.id,
    companyName: company.name ?? null,
    role: isSuperAdmin ? 'super_admin' : member.role,
    isSuperAdmin,
    supabase,
  }
}

function getHeader(headers = {}, name) {
  const target = name.toLowerCase()
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === target)
  return key ? headers[key] : undefined
}

function parseBody(event) {
  if (!event?.body) return {}
  if (typeof event.body === 'object') return event.body
  try {
    return JSON.parse(event.body)
  } catch {
    fail(400, 'Invalid request body.')
  }
}

function getBearerToken(event) {
  const authorization = getHeader(event?.headers, 'authorization')
  const match = typeof authorization === 'string' && authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

export async function requireH2ARequest(event, options = {}) {
  let supabase = options.supabase
  if (!supabase) {
    try {
      supabase = (options.getSupabase ?? getAdminSupabase)()
    } catch {
      fail(500, 'H2A authorization is not configured.')
    }
  }

  if (options.internalJob) {
    const configuredSecret = options.internalCronSecret ?? process.env.INTERNAL_CRON_SECRET
    const providedSecret = getHeader(event?.headers, 'x-internal-cron-secret')
    if (!configuredSecret || providedSecret !== configuredSecret) {
      fail(401, 'Invalid internal job credentials.')
    }
    const body = parseBody(event)
    const companyId = body.companyId ?? body.company_id
    if (typeof companyId !== 'string' || !companyId.trim()) {
      fail(400, 'An explicit company ID is required for internal jobs.')
    }
    const company = await getCompany(supabase, companyId)
    return {
      userId: null,
      companyId: company.id,
      companyName: company.name ?? null,
      role: 'internal',
      isSuperAdmin: false,
      supabase,
    }
  }

  const body = parseBody(event)
  const requestedCompanyId = options.requestedCompanyId ?? body.companyId ?? body.company_id
  return resolveH2AContext({
    supabase,
    jwt: options.jwt ?? getBearerToken(event),
    requestedCompanyId,
    requireAdmin: options.requireAdmin,
  })
}
