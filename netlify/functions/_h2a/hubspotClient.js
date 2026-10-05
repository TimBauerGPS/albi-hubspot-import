import { HUBSPOT_ACTIVITY_TYPES } from './constants.js'
import { ApiError, createHttpClient, id, invalid, isRecord, malformed, responseId } from './http.js'

// Verified against the official stable reference on 2026-10-02; never use "latest" at runtime.
export const HUBSPOT_API_VERSION = '2026-09'
const ROOT = `/crm/objects/${HUBSPOT_API_VERSION}`
const PROPERTIES = {
  meetings: ['hs_timestamp', 'hs_meeting_start_time', 'hs_meeting_title', 'hs_meeting_body', 'hs_meeting_outcome', 'hubspot_owner_id'],
  calls: ['hs_timestamp', 'hs_call_title', 'hs_call_body', 'hs_call_status', 'hs_call_disposition', 'hs_call_direction', 'hubspot_owner_id'],
  emails: ['hs_timestamp', 'hs_email_subject', 'hs_email_text', 'hs_email_direction', 'hs_email_status', 'hubspot_owner_id'],
  communications: ['hs_timestamp', 'hs_communication_channel_type', 'hs_communication_logged_from', 'hs_communication_body', 'hubspot_owner_id'],
  notes: ['hs_timestamp', 'hs_note_body', 'hubspot_owner_id'],
  contacts: ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'address', 'city', 'state', 'zip', 'country', 'jobtitle'],
  companies: ['name', 'domain', 'phone', 'address', 'city', 'state', 'zip', 'country'],
}
const timestamp = (value, operation) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(operation)
  return new Date(value).toISOString()
}
function page(data, operation) {
  if (!isRecord(data) || !Array.isArray(data.results)) malformed(operation)
  if (data.paging != null && !isRecord(data.paging)) malformed(operation)
  const after = data.paging?.next?.after
  if (data.paging?.next && (typeof after !== 'string' || !after || after.length > 2000)) malformed(operation)
  return { results: data.results, after: after ?? null }
}
function record(value, objectType, operation) {
  if (!isRecord(value) || !isRecord(value.properties)) malformed(operation)
  const properties = {}
  for (const name of PROPERTIES[objectType]) {
    const prop = value.properties[name]
    if (prop !== undefined && prop !== null && typeof prop !== 'string') malformed(operation)
    if (prop !== undefined) properties[name] = prop
  }
  const normalized = { id: responseId(value.id, operation), properties, archived: value.archived === true }
  if (HUBSPOT_ACTIVITY_TYPES.includes(objectType)) {
    try { normalized.occurredAt = timestamp(properties.hs_timestamp, operation) } catch { malformed(operation) }
    normalized.objectType = objectType
  }
  return normalized
}
function cursorSeen(seen, cursor) {
  if (cursor && (seen.has(cursor) || seen.size >= 1000)) throw new ApiError('permanent', { code: 'pagination_loop' })
  if (cursor) seen.add(cursor)
}

export class HubSpotClient {
  #request
  constructor({ token, ...http } = {}) {
    if (typeof token !== 'string' || !token.trim()) invalid('credentials')
    this.#request = createHttpClient({ ...http, baseUrl: 'https://api.hubapi.com', headers: { Authorization: `Bearer ${token}` } })
  }
  async getAccountInfo() {
    const data = await this.#request(`/account-info/${HUBSPOT_API_VERSION}/details`, { operation: 'getAccountInfo' })
    return { portalId: responseId(data?.portalId, 'getAccountInfo') }
  }
  async listOwners() {
    const owners = [], seen = new Set()
    let after = null
    do {
      const query = new URLSearchParams({ limit: '100' })
      if (after) query.set('after', after)
      const data = page(await this.#request(`/crm/owners/${HUBSPOT_API_VERSION}?${query}`, { operation: 'listOwners' }), 'listOwners')
      for (const value of data.results) {
        if (!isRecord(value) || !['firstName', 'lastName'].every(key => typeof value[key] === 'string')) malformed('listOwners')
        owners.push({ id: responseId(value.id, 'listOwners'), firstName: value.firstName, lastName: value.lastName, archived: value.archived === true })
      }
      after = data.after
      cursorSeen(seen, after)
    } while (after)
    return owners
  }
  async listActivities({ objectType, occurredAtGte, occurredAtLt, after, limit = 100 } = {}) {
    if (!HUBSPOT_ACTIVITY_TYPES.includes(objectType) || !Number.isInteger(limit) || limit < 1 || limit > 200 ||
      (after != null && (typeof after !== 'string' || after.length > 2000))) invalid('listActivities')
    const lower = timestamp(occurredAtGte, 'listActivities')
    const upper = occurredAtLt === undefined ? undefined : timestamp(occurredAtLt, 'listActivities')
    if (upper && lower >= upper) invalid('listActivities')
    const filters = [{ propertyName: 'hs_timestamp', operator: 'GTE', value: lower }]
    if (upper) filters.push({ propertyName: 'hs_timestamp', operator: 'LT', value: upper })
    const data = await this.#request(`${ROOT}/${objectType}/search`, { method: 'POST', retrySafe: true, operation: 'listActivities',
      body: { filterGroups: [{ filters }], properties: PROPERTIES[objectType], sorts: ['hs_timestamp'], limit, ...(after ? { after } : {}) } })
    const result = page(data, 'listActivities')
    if (!Number.isSafeInteger(data.total) || data.total < 0) malformed('listActivities')
    return { records: result.results.map(value => record(value, objectType, 'listActivities')), after: result.after, total: data.total }
  }
  async estimateActivities(args) {
    const { total } = await this.listActivities({ ...args, limit: 1 })
    return { count: Math.min(total, 10000), capped: total >= 10000 }
  }
  async getAssociations({ objectType, objectIds, toObjectTypes } = {}) {
    if (!Object.hasOwn(PROPERTIES, objectType) || !Array.isArray(objectIds) || objectIds.length > 100 ||
      !Array.isArray(toObjectTypes) || !toObjectTypes.length || toObjectTypes.some(type => !['contacts', 'companies'].includes(type))) invalid('getAssociations')
    const ids = objectIds.map(value => id(value, 'getAssociations'))
    const results = []
    for (const fromId of ids) for (const toObjectType of new Set(toObjectTypes)) {
      const toIds = [], seen = new Set()
      let after = null
      do {
        const query = new URLSearchParams({ limit: '500' })
        if (after) query.set('after', after)
        const data = page(await this.#request(`${ROOT}/${objectType}/${fromId}/associations/${toObjectType}?${query}`, { operation: 'getAssociations' }), 'getAssociations')
        toIds.push(...data.results.map(value => responseId(value?.toObjectId, 'getAssociations')))
        after = data.after
        cursorSeen(seen, after)
      } while (after)
      results.push({ fromId, toObjectType, toIds: [...new Set(toIds)] })
    }
    return results
  }
  async #getRecords(objectType, ids) {
    if (!Array.isArray(ids) || ids.length > 10000) invalid('getRecords')
    const inputs = [...new Set(ids.map(value => id(value, 'getRecords')))].map(value => ({ id: value }))
    const records = []
    for (let offset = 0; offset < inputs.length; offset += 100) {
      const data = await this.#request(`${ROOT}/${objectType}/batch/read`, { method: 'POST', retrySafe: true, operation: 'getRecords',
        body: { inputs: inputs.slice(offset, offset + 100), properties: PROPERTIES[objectType] } })
      if (data?.status !== 'COMPLETE' || data.numErrors > 0 || data.errors?.length) malformed('getRecords')
      records.push(...page(data, 'getRecords').results.map(value => record(value, objectType, 'getRecords')))
    }
    return records
  }
  async getContacts(ids) { return this.#getRecords('contacts', ids) }
  async getCompanies(ids) { return this.#getRecords('companies', ids) }
  async checkRead(objectType) {
    if (!['contacts', 'companies'].includes(objectType)) invalid('checkRead')
    const data = page(await this.#request(`${ROOT}/${objectType}?limit=1&properties=${PROPERTIES[objectType].join(',')}`, { operation: 'checkRead' }), 'checkRead')
    return data.results.map(value => record(value, objectType, 'checkRead'))
  }
}
