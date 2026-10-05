import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'
import { H2AConflictError, conflictResumePayload, resolveConflict } from './_h2a/conflicts.js'

const response = (statusCode, body) => ({ statusCode, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}, body: JSON.stringify(body) })

function parseBody(event) {
  let body
  try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body } catch {
    throw new H2AConflictError(400, 'Invalid request body.')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new H2AConflictError(400, 'A conflict resolution is required.')
  const allowed = new Set(['companyId', 'company_id', 'conflictId', 'expectedUpdatedAt', 'action', 'targetId',
    'approveManyToOne', 'fields'])
  if (Object.keys(body).some(key => !allowed.has(key))) throw new H2AConflictError(400, 'Unsupported conflict resolution fields.')
  return body
}

async function defaultDispatchResume(intent, options) {
  const base = options.siteUrl ?? process.env.URL
  const secret = options.internalCronSecret ?? process.env.INTERNAL_CRON_SECRET
  if (!base || !secret) return false
  const endpoint = options.resumeEndpoint ?? '/.netlify/functions/h2a-run-background'
  const target = new URL(endpoint, base)
  const result = await (options.fetch ?? fetch)(target.toString(), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Cron-Secret': secret },
    body: JSON.stringify(conflictResumePayload(intent)),
  })
  return result.ok
}

export function createConflictResolveHandler(options = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return response(200, {})
    if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed.' })
    try {
      const body = parseBody(event)
      const selectors = [body.companyId, body.company_id].filter(value => value !== undefined)
      if (selectors.some(value => typeof value !== 'string' || !value.trim()) || new Set(selectors).size > 1) {
        throw new H2AConflictError(400, 'A single company selector is required.')
      }
      const context = await (options.requireRequest ?? requireH2ARequest)({ ...event, body }, {
        supabase: options.supabase, getSupabase: options.getSupabase, requireAdmin: true, requestedCompanyId: selectors[0],
      })
      const repository = options.repository ?? createH2ARepository(context.supabase)
      const { company_id: _companyIdAlias, ...resolutionBody } = body
      const result = await resolveConflict({ repository,
        dispatchResume: options.dispatchResume ?? (intent => defaultDispatchResume(intent, options)),
        now: options.now,
      }, { ...resolutionBody, companyId: context.companyId, actorId: context.userId })
      return response(200, result)
    } catch (error) {
      const status = error instanceof H2AAuthError || error instanceof H2AConflictError ? error.statusCode : 500
      const message = error instanceof H2AAuthError || error instanceof H2AConflictError ? error.message : 'Unable to resolve this conflict.'
      return response(status, { error: message })
    }
  }
}

export const handler = createConflictResolveHandler()
