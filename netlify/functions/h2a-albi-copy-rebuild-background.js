import { requireH2ARequest } from './_h2a/auth.js'
import { createH2AProviderClients } from './_h2a/providerClients.js'
import { createH2ARepository } from './_h2a/repository.js'

const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

// One company's weekly full walk of Albi's contacts and organizations, queued by h2a-albi-copy-weekly.
export function createCopyRebuildHandler(options = {}) {
  return async event => {
    if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' })
    let body
    try { body = JSON.parse(event.body || '{}') } catch { return reply(400, { error: 'Invalid request body.' }) }
    if (typeof body?.companyId !== 'string' || !body.companyId) return reply(400, { error: 'A company is required.' })
    try {
      const auth = await (options.requireRequest ?? requireH2ARequest)(event, { supabase: options.supabase, getSupabase: options.getSupabase,
        internalCronSecret: options.internalCronSecret, internalJob: true, requestedCompanyId: body.companyId })
      const repository = options.repository ?? createH2ARepository(auth.supabase)
      const clients = await (options.makeClients ?? (companyId => createH2AProviderClients({ companyId, repository })))(auth.companyId)
      if (typeof clients.albi.rebuildAlbiCopy !== 'function') return reply(200, { status: 'no_copy' })
      return reply(200, { status: 'ok', ...await clients.albi.rebuildAlbiCopy() })
    } catch (error) {
      // A budget or outage stop keeps the current copy; the next hour in the window tries again.
      console.error('[h2a-albi-copy] rebuild failed', { category: error?.category, code: error?.code })
      return reply(error?.statusCode ?? 500, { status: 'failed' })
    }
  }
}

export const handler = createCopyRebuildHandler()
