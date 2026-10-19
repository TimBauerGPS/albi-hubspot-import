import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { getConflict, H2AConflictError, listConflicts } from './_h2a/conflicts.js'
import { backfillLiveReviews } from './_h2a/liveReview.js'

const response = (statusCode, body) => ({ statusCode, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

const AUTH_MESSAGES = new Set(['Authentication required.', 'Invalid authentication token.', 'Administrator access is required.',
  'You are not authorized to access H2A.', 'You are not authorized to access the requested company.', 'A company must be selected.', 'Company not found.'])

function prepareBody(event) {
  let body
  try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body } catch {
    throw new H2AConflictError(400, 'Invalid request body.')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.op !== 'prepare_live_reviews' ||
    Object.keys(body).some(key => !['companyId', 'op', 'cursor'].includes(key))) throw new H2AConflictError(400, 'Unsupported request fields.')
  if (Object.keys(event.queryStringParameters ?? {}).some(key => key !== 'companyId')) throw new H2AConflictError(400, 'Unsupported query parameters.')
  const selectors = [event.queryStringParameters?.companyId, body.companyId].filter(value => value !== undefined)
  if (selectors.some(value => typeof value !== 'string' || !value.trim()) || new Set(selectors).size > 1) {
    throw new H2AConflictError(400, 'A single company selector is required.')
  }
  return { companyId: selectors[0], cursor: decodeCursor(body.cursor) }
}

// "Prepare open conflicts for review": one admin-only backfill page of open contact/company conflicts
// into live review rows. The client repeats it with nextCursor until it is null.
async function prepareLiveReviews(event, options) {
  const input = prepareBody(event)
  const context = await (options.requireRequest ?? requireH2ARequest)(event, {
    supabase: options.supabase, getSupabase: options.getSupabase, requireAdmin: true, requestedCompanyId: input.companyId,
  })
  const repository = options.repository ?? createH2ARepository(context.supabase)
  const result = await (options.backfillLiveReviews ?? backfillLiveReviews)({ repository },
    { companyId: context.companyId, limit: 50, cursor: input.cursor })
  return response(200, { captured: result.captured, linked: result.linked, skipped: result.skipped ?? 0, failed: result.failed ?? 0,
    nextCursor: encodeCursor(result.nextCursor) })
}

export function createConflictListHandler(options = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return response(200, {})
    if (event.httpMethod === 'POST') {
      try { return await prepareLiveReviews(event, options) } catch (error) {
        const known = error instanceof H2AConflictError || error instanceof H2AAuthError && AUTH_MESSAGES.has(error.message)
        return response(error instanceof H2AAuthError || error instanceof H2AConflictError ? error.statusCode : 500,
          { error: known ? error.message : 'Unable to prepare open conflicts for review.' })
      }
    }
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
