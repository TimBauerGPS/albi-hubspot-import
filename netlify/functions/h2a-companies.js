import { getAdminSupabase } from './_supabaseAdmin.js'

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
    body: JSON.stringify(body),
  }
}

function bearerToken(headers = {}) {
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === 'authorization')
  const match = key && typeof headers[key] === 'string' && headers[key].match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

function safeCompanies(rows) {
  const unique = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.id !== 'string' || !row.id || typeof row?.name !== 'string' || !row.name.trim()) continue
    if (!unique.has(row.id)) unique.set(row.id, { id: row.id, name: row.name.trim() })
  }
  return [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

export function createCompaniesHandler(options = {}) {
  return async function companiesHandler(event) {
    if (event.httpMethod === 'OPTIONS') return response(200, {})
    if (event.httpMethod !== 'GET') return response(405, { error: 'Method not allowed.' })

    const jwt = bearerToken(event.headers)
    if (!jwt) return response(401, { error: 'Authentication required.' })

    let supabase
    try {
      supabase = options.supabase ?? (options.getSupabase ?? getAdminSupabase)()
    } catch {
      return response(500, { error: 'Unable to load company options.' })
    }

    try {
      const { data: { user } = {}, error: authError } = await supabase.auth.getUser(jwt)
      if (authError || !user?.id) return response(401, { error: 'Authentication required.' })

      const { data: superAdmin, error: roleError } = await supabase
        .from('super_admins')
        .select('user_id')
        .eq('user_id', user.id)
        .maybeSingle()
      if (roleError) return response(500, { error: 'Unable to load company options.' })
      if (!superAdmin) return response(403, { error: 'Company options are unavailable.' })

      const { data: companies, error: companyError } = await supabase
        .from('companies')
        .select('id, name')
        .order('name', { ascending: true })
        .order('id', { ascending: true })
      if (companyError) return response(500, { error: 'Unable to load company options.' })

      return response(200, { companies: safeCompanies(companies) })
    } catch {
      return response(500, { error: 'Unable to load company options.' })
    }
  }
}

export const handler = createCompaniesHandler()
