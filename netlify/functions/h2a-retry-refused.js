import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'
import { createH2ARepository } from './_h2a/repository.js'

const response = (statusCode, body) => ({ statusCode, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}, body: JSON.stringify(body) })

// Queues every activity Albi refused to be sent again, after its cause is fixed. The hourly scheduler sends them;
// one Albi refuses again is set aside again with its new reason.
export function createRetryRefusedHandler(options = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return response(200, {})
    if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed.' })
    try {
      let body
      try { body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body ?? {}) } catch { return response(400, { error: 'Invalid request body.' }) }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'companyId')) {
        return response(400, { error: 'Only a company selector is accepted.' })
      }
      if (body.companyId !== undefined && (typeof body.companyId !== 'string' || !body.companyId.trim())) {
        return response(400, { error: 'A valid company selector is required.' })
      }
      const context = await (options.requireRequest ?? requireH2ARequest)({ ...event, body }, {
        supabase: options.supabase, getSupabase: options.getSupabase, requireAdmin: true, requestedCompanyId: body.companyId,
      })
      const repository = options.repository ?? createH2ARepository(context.supabase)
      const result = await repository.retryRefusedActivities(context.companyId)
      return response(200, { queued: Number.isSafeInteger(result?.queued) ? result.queued : 0 })
    } catch (error) {
      return response(error instanceof H2AAuthError ? error.statusCode : 500,
        { error: error instanceof H2AAuthError ? error.message : 'Unable to queue the refused activities.' })
    }
  }
}

export const handler = createRetryRefusedHandler()
