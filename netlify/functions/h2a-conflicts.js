import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { getConflict, H2AConflictError, listConflicts } from './_h2a/conflicts.js'

const response = (statusCode, body) => ({ statusCode, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}, body: JSON.stringify(body) })

function decodeCursor(value) {
  if (value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new H2AConflictError(400, 'Invalid conflict cursor.')
  }
  let cursor
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch {
    throw new H2AConflictError(400, 'Invalid conflict cursor.')
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).length !== 2 ||
    typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') {
    throw new H2AConflictError(400, 'Invalid conflict cursor.')
  }
  return cursor
}

function encodeCursor(cursor) {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

export function createConflictListHandler(options = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return response(200, {})
    if (event.httpMethod !== 'GET') return response(405, { error: 'Method not allowed.' })
    try {
      const query = event.queryStringParameters ?? {}
      if (Object.keys(query).some(key => !['companyId', 'company_id', 'limit', 'cursor', 'conflictId'].includes(key))) {
        throw new H2AConflictError(400, 'Unsupported query parameters.')
      }
      const selectors = [query.companyId, query.company_id].filter(value => value !== undefined)
      if (selectors.some(value => typeof value !== 'string' || !value.trim()) || new Set(selectors).size > 1) {
        throw new H2AConflictError(400, 'A single company selector is required.')
      }
      let limit = 25
      if (query.limit !== undefined) {
        if (typeof query.limit !== 'string' || !/^[0-9]{1,3}$/.test(query.limit)) throw new H2AConflictError(400, 'Invalid conflict page size.')
        limit = Number(query.limit)
      }
      const context = await (options.requireRequest ?? requireH2ARequest)(event, {
        supabase: options.supabase, getSupabase: options.getSupabase,
        requireAdmin: false, requestedCompanyId: selectors[0],
      })
      const repository = options.repository ?? createH2ARepository(context.supabase)
      if (query.conflictId !== undefined) {
        if (query.limit !== undefined || query.cursor !== undefined) throw new H2AConflictError(400, 'Unsupported query parameters.')
        const item = await getConflict({ repository, companyId: context.companyId, conflictId: query.conflictId })
        return response(200, { item })
      }
      const page = await listConflicts({ repository, companyId: context.companyId, limit, cursor: decodeCursor(query.cursor) })
      return response(200, { items: page.items, nextCursor: encodeCursor(page.nextCursor) })
    } catch (error) {
      const status = error instanceof H2AAuthError || error instanceof H2AConflictError ? error.statusCode : 500
      const message = error instanceof H2AAuthError || error instanceof H2AConflictError ? error.message : 'Unable to load conflicts.'
      return response(status, { error: message })
    }
  }
}

export const handler = createConflictListHandler()
