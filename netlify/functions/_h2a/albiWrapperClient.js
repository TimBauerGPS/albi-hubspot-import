import { ApiError, createHttpClient, id, invalid, isRecord, malformed, responseId } from './http.js'
import { ALBI_SCOPES } from '../../../shared/h2aAlbiScopes.js'

// The Guardian Albi wrapper, kept for one read only: the activity list behind the delivery duplicate check, for an
// Albi Public API key without Permissions.Activities.View. Everything else goes through the Public API (albiClient.js).
export const ALBI_WRAPPER_BASE_URL = 'https://albi.guardianrestoration.com'
const COMPANY_ROOT = '/v1/companies'
const PAGE_SIZE = 100

function activityPage(value, page) {
  if (!isRecord(value)) malformed('listActivities', 'envelope_invalid')
  if (!Array.isArray(value.data) || value.data.length > PAGE_SIZE) malformed('listActivities', 'data_invalid')
  const pagination = value.pagination
  if (pagination === undefined) return { rows: value.data, more: value.data.length === PAGE_SIZE }
  if (!isRecord(pagination) || !Number.isSafeInteger(pagination.totalPages)) malformed('listActivities', 'pagination_invalid')
  if (pagination.page !== page) malformed('listActivities', 'page_mismatch')
  return { rows: value.data, more: page < pagination.totalPages }
}

export class AlbiWrapperClient {
  #request
  #companyPromise
  constructor({ apiKey, ...http } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) invalid('credentials')
    this.#request = createHttpClient({ ...http, baseUrl: ALBI_WRAPPER_BASE_URL, headers: { 'X-API-Key': apiKey } })
  }
  async #discoverCompany() {
    const result = await this.#request(COMPANY_ROOT, { operation: 'discoverCompany' })
    const company = isRecord(result) && Array.isArray(result.data) && result.data.length === 1 ? result.data[0] : null
    if (!isRecord(company) || typeof company.companyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(company.companyId)) {
      throw new ApiError('permanent', { operation: 'discoverCompany', code: 'company_access_invalid' })
    }
    return company.companyId
  }
  company() {
    this.#companyPromise ??= this.#discoverCompany()
    return this.#companyPromise
  }
  // Same arguments and page shape as AlbiClient.listActivities: numbered pages, records with id, notes and source.
  async listActivities({ contactId, organizationId, page = 1 } = {}) {
    const number = Number(page)
    if (!Number.isSafeInteger(number) || number < 1) invalid('listActivities')
    const query = new URLSearchParams({ page: String(number), pageSize: String(PAGE_SIZE) })
    if (contactId != null) query.set('contactId', id(contactId, 'listActivities'))
    if (organizationId != null) query.set('organizationId', id(organizationId, 'listActivities'))
    let data
    try {
      data = await this.#request(`${COMPANY_ROOT}/${encodeURIComponent(await this.company())}/activities?${query}`, { operation: 'listActivities' })
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      throw new ApiError(error.category, { operation: error.operation, status: error.status, code: error.code, retryAfterMs: error.retryAfterMs,
        requiredScope: ALBI_SCOPES.wrapperActivitiesList, protocolIssue: error.protocolIssue })
    }
    const { rows, more } = activityPage(data, number)
    const records = rows.map(row => {
      if (!isRecord(row)) malformed('listActivities', 'record_invalid')
      return { id: responseId(row.id, 'listActivities'), notes: typeof row.notes === 'string' ? row.notes : '', source: typeof row.source === 'string' ? row.source : null }
    })
    return { records, cursor: more ? String(number + 1) : null }
  }
}

// The Public API reads activities when the key may; only its permission refusal falls back to the wrapper, so the
// wrapper stops being used on its own once Albi adds the scope. A wrapper key for another company is refused:
// searching the wrong company would find nothing, and "not found" allows a resend.
export function withAlbiActivityFallback(albi, wrapper) {
  if (!wrapper) return albi
  let verified = null
  const sameCompany = () => verified ??= (async () => {
    const [own, theirs] = await Promise.all([albi.verifyCredentials(), wrapper.company()])
    if (String(own?.company?.id ?? '') !== String(theirs)) throw new ApiError('permanent', { operation: 'discoverCompany', code: 'company_access_invalid' })
  })().catch(error => { verified = null; throw error })
  return new Proxy(albi, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property === 'listActivities') {
        return async args => {
          try { return await value.call(target, args) } catch (error) {
            if (!(error instanceof ApiError) || error.category !== 'permission') throw error
            await sameCompany()
            return wrapper.listActivities(args)
          }
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// The saved wrapper envelope, or null when none is saved or it cannot be read (including before its SQL is applied).
// Without it the Public API's refusal stands, so a delivery is held rather than resent.
export async function readAlbiWrapperCredential(supabase, companyId) {
  try {
    const result = await supabase.rpc('h2a_get_albi_wrapper_credential', { p_company_id: companyId })
    return !result?.error && isRecord(result?.data) && result.data.ciphertext ? result.data : null
  } catch { return null }
}
