import { ApiError, createHttpClient, id, invalid, isRecord, malformed, responseId } from './http.js'
import { ALBI_SCOPES } from '../../../shared/h2aAlbiScopes.js'
import { albiKeyFingerprint } from './albiCache.js'

// Albi Public API (https://albi-public.readme.io). One key per company; the key itself selects the tenant.
export const ALBI_BASE_URL = 'https://publicapi.albiware.com'
const API_ROOT = '/api/v1'
const CAPABILITIES = Object.freeze({
  contacts_create: 'verified_on_first_use',
  organizations_create: 'verified_on_first_use',
  activities_create: 'verified_on_first_use',
  contacts_update: 'verified_on_first_use',
  organizations_update: 'verified_on_first_use',
  contacts_associate_organization: 'verified_on_first_use',
})
// Reference lookups accept Contacts.View or Organizations.View; Contacts.View is the one named on a refusal.
const SCOPES = Object.freeze({
  listContacts: ALBI_SCOPES.contactsView, createContact: ALBI_SCOPES.contactsCreate,
  listOrganizations: ALBI_SCOPES.organizationsView, createOrganization: ALBI_SCOPES.organizationsCreate, getOrganization: ALBI_SCOPES.organizationsView,
  listActivities: ALBI_SCOPES.activitiesView, createActivity: ALBI_SCOPES.activitiesEdit,
  updateContact: ALBI_SCOPES.contactsEdit, updateOrganization: ALBI_SCOPES.organizationsEdit,
  listRelationshipTypes: ALBI_SCOPES.contactsView,
  listReferralSources: ALBI_SCOPES.contactsView,
  listRelationshipStatuses: ALBI_SCOPES.contactsView,
  listActivityTypes: ALBI_SCOPES.contactsView,
  listSalespeople: ALBI_SCOPES.usersView,
  discoverCompany: ALBI_SCOPES.contactsView,
  listProjects: ALBI_SCOPES.projectsView, getProject: ALBI_SCOPES.projectsView, getProjectFinancials: ALBI_SCOPES.projectsFinancial,
})
const text = value => typeof value === 'string' && Boolean(value.trim())
// Option lists rarely change; the connection check clears them.
export const OPTIONS_CACHE_MS = 24 * 60 * 60000
// Albi's limits are per key and the key is shared with other apps, so its rate headers count everyone. Below this
// hourly budget requests stop until Albi's reset; near the minute limit they wait a moment. A refused request still
// costs quota, so waiting beats being told no.
export const HOURLY_FLOOR = 100
export const MINUTE_RESERVE = 20
export const MINUTE_WAIT_MS = 10000
// One budget per key in this process: the Outbox makes a new client for every action.
const budgets = new Map()
function budgetFor(apiKey) {
  const key = albiKeyFingerprint(apiKey)
  if (!budgets.has(key)) budgets.set(key, { remainingHour: null, remainingMinute: null, minuteSeenAt: 0, resetHourAt: 0, blockedUntil: 0 })
  return budgets.get(key)
}
const headerNumber = (headers, name) => {
  const raw = headers?.get?.(name)
  if (raw === null || raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}
const validCompany = value => isRecord(value) && typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.id) && text(value.name)
// Albi can take well over 10s to answer a create; giving up early leaves it unknown whether the record was made.
export const CREATE_TIMEOUT_MS = 20000
const ADDRESS_FIELDS = ['address1', 'address2', 'city', 'state', 'zipCode', 'country', 'latitude', 'longitude', 'email', 'phoneNumber', 'referralSourceId', 'relationshipStatusId', 'salespersonId', 'parentOrganizationId']
// Exactly the request fields Albi's create endpoints document.
const WRITE_FIELDS = {
  createContact: ['firstName', 'lastName', 'contactTypeIds', 'organizationId', 'jobTitle', ...ADDRESS_FIELDS],
  createOrganization: ['name', 'organizationTypeIds', 'taxId', 'priceListId', ...ADDRESS_FIELDS],
  createActivity: ['contactId', 'organizationId', 'activityTypeId', 'date', 'notes', 'htmlNotes', 'source'],
}
// The fields H2A sends in a partial update (PUT): what HubSpot can supply. Status, type, referral and salesperson
// changes are never sent from here (a status in an update is a real status change in Albi).
const UPDATE_FIELDS = {
  updateContact: ['firstName', 'lastName', 'email', 'phoneNumber', 'jobTitle', 'organizationId', 'address1', 'address2', 'city', 'state', 'zipCode', 'country'],
  updateOrganization: ['name', 'email', 'phoneNumber', 'address1', 'address2', 'city', 'state', 'zipCode', 'country'],
}
function validateUpdate(payload, operation) {
  if (!isRecord(payload) || !Object.keys(payload).length || Object.keys(payload).some(key => !UPDATE_FIELDS[operation].includes(key))) invalid(operation)
  const result = {}
  for (const [key, value] of Object.entries(payload)) {
    // A blank would not clear the field (Albi treats it like an omitted one), so it is refused rather than sent.
    if (key === 'organizationId') result[key] = stringId(value, operation)
    else if (!text(value) || value.length > 500) invalid(operation)
    else result[key] = value.trim()
  }
  return result
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
// Albi ids are opaque strings on the wire; they are sent as strings, never parsed into numbers.
const stringId = (value, operation) => id(value, operation)
function validatePayload(payload, required, operation) {
  if (!isRecord(payload) || Object.keys(payload).some(key => !WRITE_FIELDS[operation].includes(key)) ||
    required.some(key => key.endsWith('Ids') ? !Array.isArray(payload[key]) || !payload[key].length : !text(payload[key]))) invalid(operation)
  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith('Ids')) {
      if (!Array.isArray(value)) invalid(operation)
      payload = { ...payload, [key]: value.map(item => stringId(item, operation)) }
    } else if (key.endsWith('Id') && value != null) payload = { ...payload, [key]: stringId(value, operation) }
    else if (value != null && ['latitude', 'longitude'].includes(key)) { if (typeof value !== 'number' || !Number.isFinite(value)) invalid(operation) }
    else if (value != null && typeof value !== 'string') invalid(operation)
  }
  return payload
}
// Field names plus masked phone/ID formats; never the values themselves.
function requestShape(payload) {
  const mask = value => String(value).replace(/\d/g, '9').replace(/[A-Za-z]/g, 'a').slice(0, 20)
  const extras = [payload.phoneNumber != null ? `phone=${mask(payload.phoneNumber)}` : '',
    Array.isArray(payload.contactTypeIds) ? `types=${payload.contactTypeIds.length}x${mask(payload.contactTypeIds[0])}` : '']
  return `sent=${Object.keys(payload).join(',')};${extras.filter(Boolean).join(';')}`
}
const CONTACT_FIELDS = ['firstName', 'lastName', 'email', 'phoneNumber', 'mobileNumber', 'jobTitle', 'organizationId', 'organizationName', 'parentOrganizationId', 'contactTypeIds', 'address1', 'address2', 'city', 'state', 'zipcode', 'country', 'referralSourceID', 'relationshipStatusID']
const ORGANIZATION_FIELDS = ['name', 'email', 'phoneNumber', 'organizationTypeIds', 'parentOrganizationId', 'address1', 'address2', 'city', 'state', 'zipcode', 'country', 'referralSourceID', 'relationshipStatusID']
const ACTIVITY_FIELDS = ['contactId', 'organizationId', 'relationshipName', 'date', 'type', 'notes', 'source', 'sourceId']
// Albi's record names mapped onto the domain names the sync logic compares (zipCode -> zipcode, and so on).
// Nested shapes (address, organization, referralSource) are ignored: every value is also sent flat.
const RECORD_ALIASES = { zipcode: 'zipCode', referralSourceID: 'referralSourceId', relationshipStatusID: 'relationshipStatusId', type: 'activityTypeName' }
function domainRecord(value) {
  if (!isRecord(value)) return value
  const result = { ...value }
  for (const [domain, provider] of Object.entries(RECORD_ALIASES)) if (result[domain] === undefined && value[provider] !== undefined) result[domain] = value[provider]
  return result
}
function normalizeRecord(raw, fields, operation) {
  const value = domainRecord(raw)
  if (!isRecord(value)) malformed(operation, 'record_invalid')
  let recordId
  try { recordId = responseId(value.id, operation) } catch { malformed(operation, 'record_id_invalid') }
  const result = { id: recordId }
  for (const field of fields) {
    if (value[field] === undefined) continue
    if (value[field] === null || value[field] === 0) result[field] = null
    else if (/Ids$/.test(field)) {
      if (!Array.isArray(value[field])) malformed(operation, 'record_field_invalid')
      try { result[field] = value[field].map(item => responseId(item, operation)) } catch { malformed(operation, 'record_field_invalid') }
    } else if (/Id$|ID$/.test(field)) {
      try { result[field] = responseId(value[field], operation) } catch { malformed(operation, 'record_field_invalid') }
    }
    else {
      if (typeof value[field] !== 'string') malformed(operation, 'record_field_invalid')
      result[field] = value[field]
    }
  }
  return result
}
function optionList(data) {
  if (!Array.isArray(data)) malformed('listOptions')
  const seen = new Set()
  return data.map(value => {
    const optionId = responseId(value?.id, 'listOptions')
    if (!text(value?.name) || value.name.length > 200 || /[\u0000-\u001f\u007f]/.test(value.name) || seen.has(optionId)) malformed('listOptions')
    seen.add(optionId)
    return { id: optionId, label: value.name.trim() }
  })
}
// A paged list answers { data: [...], continuationToken } with the token null (or absent) on the last page.
function listEnvelope(value, expectedPageSize, operation) {
  if (!isRecord(value)) malformed(operation, 'envelope_invalid')
  if (!Array.isArray(value.data)) malformed(operation, 'data_invalid')
  if (value.data.length > expectedPageSize) malformed(operation, 'record_count_mismatch')
  const token = value.continuationToken
  if (token != null && (typeof token !== 'string' || !token || token.length > 2000)) malformed(operation, 'pagination_invalid')
  return { records: value.data, token: token || null }
}
function listArgs(args, operation) {
  if (!isRecord(args) || Object.keys(args).some(key => !['cursor', 'pageSize', 'changedSince'].includes(key))) invalid(operation)
  if (args.changedSince === undefined) return args
  if (typeof args.changedSince !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(args.changedSince) ||
    !Number.isFinite(Date.parse(args.changedSince))) invalid(operation)
  return args
}
// Reference lookups answer the whole catalogue in one array.
const lookupData = value => isRecord(value) && Array.isArray(value.data) ? value.data : value

export class AlbiClient {
  #request
  #companyPromise
  #tokens = new Map()
  #sleep
  #random
  #now
  #cache
  #budget
  #observer = null
  constructor({ apiKey, cache = null, ...http } = {}) {
    if (!text(apiKey)) invalid('credentials')
    this.#sleep = http.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.#random = http.random ?? Math.random
    this.#now = http.now ?? Date.now
    this.#cache = cache
    this.#budget = budgetFor(apiKey)
    const send = createHttpClient({ ...http, baseUrl: ALBI_BASE_URL, captureValidationReason: true, headers: { Authorization: `Bearer ${apiKey}` },
      onResponse: headers => this.#recordBudget(headers) })
    this.#request = async (path, options) => {
      await this.#pace(options?.operation)
      try { return await send(path, options) } catch (error) {
        if (error instanceof ApiError && error.category === 'rate_limit' && error.retryAfterMs > 1000) {
          this.#budget.blockedUntil = Math.max(this.#budget.blockedUntil, this.#now() + error.retryAfterMs)
        }
        throw error
      }
    }
  }
  #recordBudget(headers) {
    const budget = this.#budget
    const hour = headerNumber(headers, 'x-ratelimit-remaining-hour'), minute = headerNumber(headers, 'x-ratelimit-remaining')
    const reset = headerNumber(headers, 'x-ratelimit-reset-hour')
    if (hour !== null) budget.remainingHour = hour
    if (reset !== null) budget.resetHourAt = reset * 1000
    if (minute !== null) { budget.remainingMinute = minute; budget.minuteSeenAt = this.#now() }
  }
  async #pace(operation = 'request') {
    const budget = this.#budget, now = this.#now()
    const hourSpent = budget.remainingHour !== null && budget.remainingHour <= HOURLY_FLOOR && budget.resetHourAt > now
    const until = Math.max(budget.blockedUntil, hourSpent ? budget.resetHourAt : 0)
    if (until > now) throw new ApiError('rate_limit', { operation, code: 'rate_limit', retryAfterMs: until - now })
    if (budget.remainingMinute !== null && budget.remainingMinute <= MINUTE_RESERVE && now - budget.minuteSeenAt < 60000) {
      budget.remainingMinute = null
      await this.#sleep(MINUTE_WAIT_MS)
    }
  }
  // What Albi last reported for this key, across every app using it. Null until a response has been seen.
  rateBudget() {
    const { remainingHour, resetHourAt } = this.#budget
    return remainingHour === null || resetHourAt <= this.#now() ? null : { remainingHour, resetHourAt }
  }
  // Told the full record of each contact or organization Albi answers a create or update with.
  observeWrites(observer) { this.#observer = observer }
  async #observe(kind, raw, fields, operation) {
    if (!this.#observer || !isRecord(raw)) return
    let record
    try { record = normalizeRecord(raw, fields, operation) } catch { return }
    await this.#observer(kind, record)
  }
  // The key names its own company: every row Albi returns carries companyId. A key that reaches more than one
  // company is refused, so a create can never land in a company nobody chose.
  async #discoverCompany() {
    const statuses = lookupData(await this.#scopedRequest(`${API_ROOT}/relationship-statuses`, { operation: 'discoverCompany' }, SCOPES.discoverCompany))
    const ids = Array.isArray(statuses) ? [...new Set(statuses.map(row => isRecord(row) ? String(row.companyId ?? '') : '').filter(Boolean))] : []
    if (ids.length !== 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(ids[0])) {
      throw new ApiError('permanent', { operation: 'discoverCompany', code: 'company_access_invalid' })
    }
    const companyId = ids[0]
    let name = ''
    try {
      const company = await this.#request(`${API_ROOT}/company/${encodeURIComponent(companyId)}`, { operation: 'getCompany' })
      name = isRecord(company?.data) && typeof company.data.name === 'string' ? company.data.name.trim() : ''
    } catch (error) {
      // Reading the company needs Company.View, which an integration key may not hold; the name is display-only.
      if (!(error instanceof ApiError) || ![403, 404].includes(error.status)) throw error
    }
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) name = `Albi company ${companyId}`
    return { id: companyId, name }
  }
  async #loadCompany() {
    const saved = await this.#cache?.get('company')
    if (validCompany(saved)) return { id: saved.id, name: saved.name }
    const company = await this.#discoverCompany()
    await this.#cache?.set('company', company)
    return company
  }
  async #company() {
    this.#companyPromise ??= this.#loadCompany()
    return this.#companyPromise
  }
  async #scopedRequest(path, options, requiredScope) {
    try { return await this.#request(path, options) } catch (error) {
      if (!(error instanceof ApiError)) throw error
      throw new ApiError(error.category, { operation: error.operation, status: error.status, code: error.code,
        retryAfterMs: error.retryAfterMs, requiredScope, protocolIssue: error.protocolIssue, providerReason: error.providerReason, providerShape: error.providerShape })
    }
  }
  async #lookup(resource, operation) {
    const name = `options:${resource}`
    const saved = await this.#cache?.get(name)
    if (Array.isArray(saved)) return saved
    const company = await this.#company()
    const rows = lookupData(await this.#scopedRequest(`${API_ROOT}/${resource}?${new URLSearchParams({ companyId: company.id })}`, { operation }, SCOPES[operation]))
    if (Array.isArray(rows)) await this.#cache?.set(name, rows, OPTIONS_CACHE_MS)
    return rows
  }
  async verifyCredentials() {
    const company = await this.#company()
    return { authenticated: true, company: { ...company }, capabilities: { ...CAPABILITIES } }
  }
  async listOptions() {
    const relationshipTypes = optionList(await this.#lookup('relationship-types', 'listRelationshipTypes'))
    const referralSources = optionList(await this.#lookup('referral-sources', 'listReferralSources'))
    const relationshipStatuses = optionList(await this.#lookup('relationship-statuses', 'listRelationshipStatuses'))
    const activityTypes = optionList(await this.#lookup('activity-types', 'listActivityTypes'))
    // The documented relationship-type IDs are shared by contactTypeIds and organizationTypeIds.
    return { contactTypes: relationshipTypes.map(value => ({ ...value })), organizationTypes: relationshipTypes.map(value => ({ ...value })), relationshipTypes, referralSources, relationshipStatuses, activityTypes }
  }
  // Salesperson options are matched by name only; accept either a name or first/last name pair.
  async listCreateOptions() {
    // The three lists are independent, so they are read together.
    const [types, statuses, raw] = await Promise.all([
      this.#lookup('relationship-types', 'listRelationshipTypes'),
      this.#lookup('relationship-statuses', 'listRelationshipStatuses'),
      this.#lookup('salespeople', 'listSalespeople'),
    ])
    const relationshipTypes = optionList(types), relationshipStatuses = optionList(statuses)
    const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.items) ? raw.items : null
    if (!list) malformed('listSalespeople', 'salespeople_not_list')
    // A salesperson with no name or no usable id can never be matched or sent, so it is left out rather than
    // failing every create.
    const salespeople = list.flatMap(value => {
      if (!isRecord(value) || !/^[1-9][0-9]*$/.test(String(value.id ?? ''))) return []
      const name = text(value.name) ? value.name : [value.firstName, value.lastName].filter(text).join(' ')
      return name.trim() ? [{ id: String(value.id), label: name.trim() }] : []
    })
    return { relationshipTypes, relationshipStatuses, salespeople }
  }
  async listReferralSources() {
    return optionList(await this.#lookup('referral-sources', 'listReferralSources'))
  }
  // Callers page with numbered cursors ('1', '2', ...). Albi pages with opaque continuation tokens, so the token
  // that leads to each page is remembered per query; a page asked for out of order is reached by walking from page 1.
  async #page(resource, operation, query, pageSize, page) {
    const company = await this.#company()
    const key = `${resource}?${new URLSearchParams({ ...query, pageSize: String(pageSize) })}`
    let reached = 1, token = null
    for (let n = page; n > 1; n--) if (this.#tokens.has(`${key}#${n}`)) { reached = n; token = this.#tokens.get(`${key}#${n}`); break }
    for (;;) {
      const params = new URLSearchParams({ ...query, companyId: company.id, limit: String(pageSize) })
      if (token) params.set('continuationToken', token)
      const data = await this.#readWithRetry(`${API_ROOT}/${resource}?${params}`, operation, `${resource};page=${reached}`)
      const result = listEnvelope(data, pageSize, operation)
      if (result.token) this.#tokens.set(`${key}#${reached + 1}`, result.token)
      if (reached === page) return { records: result.records, cursor: result.token ? String(page + 1) : null }
      if (!result.token) return { records: [], cursor: null }
      reached += 1
      token = result.token
    }
  }
  async #readWithRetry(path, operation, label) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#scopedRequest(path, { operation }, SCOPES[operation])
      } catch (error) {
        // A read that fails with a generic 400 has been seen to succeed on retry. Reads are idempotent.
        const flaky = error instanceof ApiError && error.status === 400 && /unexpected error/i.test(error.providerReason ?? '')
        if (flaky && attempt < 2) { await this.#sleep(250 * (2 ** attempt) * (1 + Math.min(1, Math.max(0, this.#random())))); continue }
        if (flaky) error.providerShape = `list=${label};${error.providerShape ?? ''}`.slice(0, 240)
        throw error
      }
    }
  }
  async #list(resource, fields, operation, { cursor = '1', pageSize = 25, ...filters } = {}) {
    if (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) < 1 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('list')
    const page = await this.#page(resource, operation, filters, pageSize, Number(cursor))
    return { records: page.records.map(value => normalizeRecord(value, fields, operation)), cursor: page.cursor }
  }
  // changedSince (a UTC timestamp) narrows a read to records created or updated since then.
  async listContacts(args = {}) {
    return this.#list('contacts', CONTACT_FIELDS, 'listContacts', listArgs(args, 'listContacts'))
  }
  // One organization by id (with its referral source), or null when Albi has none with that id.
  async getOrganization(organizationId) {
    const organization = id(organizationId, 'getOrganization')
    let data
    try {
      data = await this.#scopedRequest(`${API_ROOT}/organizations/${encodeURIComponent(organization)}`, { operation: 'getOrganization' }, SCOPES.getOrganization)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
    return normalizeRecord(isRecord(data) && isRecord(data.data) ? data.data : data, ORGANIZATION_FIELDS, 'getOrganization')
  }
  async listOrganizations(args = {}) {
    return this.#list('organizations', ORGANIZATION_FIELDS, 'listOrganizations', listArgs(args, 'listOrganizations'))
  }
  // startDate/endDate bound the activity date (Albi's dateAfter/dateBefore).
  async listActivities({ contactId, organizationId, startDate, endDate, page = 1 } = {}) {
    const filters = {}
    if (contactId != null) filters.contactId = id(contactId, 'listActivities')
    if (organizationId != null) filters.organizationId = id(organizationId, 'listActivities')
    for (const [key, value] of Object.entries({ dateAfter: startDate, dateBefore: endDate })) {
      if (value === undefined) continue
      if (!validDate(value)) invalid('listActivities')
      filters[key] = value
    }
    return this.#list('activities', ACTIVITY_FIELDS, 'listActivities', { cursor: page, ...filters })
  }
  async #create(resource, payload, operation) {
    const company = await this.#company()
    // Non-idempotent writes are single-attempt. Worker delivery reconciliation owns ambiguous outcomes.
    let data
    try {
      data = await this.#scopedRequest(`${API_ROOT}/${resource}`,
        { method: 'POST', body: { companyId: company.id, ...payload }, operation, retrySafe: false, retryRefused: true, timeoutMs: CREATE_TIMEOUT_MS }, SCOPES[operation])
    } catch (error) {
      if (error instanceof ApiError && error.providerShape) error.providerShape = `${requestShape(payload)};${error.providerShape}`.slice(0, 240)
      throw error
    }
    if (!isRecord(data)) malformed(operation, 'reply_not_object')
    if (data.status !== 1) throw new ApiError('validation', { operation, code: 'application_error' })
    // Albi answers a create with the new record; take its id (or a bare id, should one be sent).
    const nested = isRecord(data.data) ? data.data : {}
    const found = [nested.id, data.data, nested.activityId, nested.contactId, nested.organizationId, data.id]
      .find(value => /^[1-9][0-9]*$/.test(String(value ?? '')) && (typeof value === 'string' || Number.isSafeInteger(value)))
    if (found === undefined) {
      // Field names only, never values, so an unexpected reply can be recognized and supported.
      const names = value => Object.keys(value).filter(key => /^\w{1,30}$/.test(key)).slice(0, 10).join(',')
      const shape = `reply=${names(data)};data=${isRecord(data.data) ? `object(${names(data.data)})` : Array.isArray(data.data) ? 'array' : typeof data.data}`
      throw new ApiError('permanent', { operation, code: 'malformed_response', protocolIssue: 'reply_no_id', providerShape: shape.slice(0, 240) })
    }
    const fields = { contacts: CONTACT_FIELDS, organizations: ORGANIZATION_FIELDS }[resource]
    if (fields) await this.#observe(resource, data.data, fields, operation)
    return { id: String(found) }
  }
  async createContact(payload) { return this.#create('contacts', validatePayload(payload, ['firstName', 'lastName', 'contactTypeIds'], 'createContact'), 'createContact') }
  async createOrganization(payload) { return this.#create('organizations', validatePayload(payload, ['name', 'organizationTypeIds'], 'createOrganization'), 'createOrganization') }
  // Accepts the domain shape (typeId, relationshipName, sourceId) and sends Albi's: activityTypeId, and exactly one
  // of contactId or organizationId. Albi has no external id, so the source marker in the notes stays the dedupe key.
  async createActivity({ typeId, activityTypeId = typeId, relationshipName, sourceId, ...rest } = {}) {
    const validated = validatePayload({ ...rest, ...(activityTypeId == null ? {} : { activityTypeId }) }, ['date', 'notes'], 'createActivity')
    stringId(validated.activityTypeId, 'createActivity')
    if (Boolean(validated.contactId) === Boolean(validated.organizationId) || !validDate(validated.date.slice(0, 10)) || !Number.isFinite(Date.parse(validated.date))) invalid('createActivity')
    return this.#create('activities', validated, 'createActivity')
  }
  // Projects (jobs), for the Albi-to-HubSpot deal import. Pages carry Albi's own project shape (nested references).
  async listProjects(args = {}) {
    const { cursor = '1', pageSize = 100, ...filters } = listArgs(args, 'listProjects')
    if (!/^\d+$/.test(String(cursor)) || Number(cursor) < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('listProjects')
    const page = await this.#page('projects', 'listProjects', filters, pageSize, Number(cursor))
    return { records: page.records.filter(record => isRecord(record) && /^[1-9][0-9]*$/.test(String(record.id ?? ''))), cursor: page.cursor }
  }
  // One project with its people (customer, referrer, salesperson, project manager), or null when Albi has none.
  async getProject(projectId) { return this.#getOne(`projects/${encodeURIComponent(id(projectId, 'getProject'))}`, 'getProject') }
  // The project's money totals (estimated revenue, accrual revenue, invoiced, paid, expenses).
  async getProjectFinancials(projectId) {
    return this.#getOne(`projects/${encodeURIComponent(id(projectId, 'getProjectFinancials'))}/financials`, 'getProjectFinancials')
  }
  async #getOne(path, operation) {
    let data
    try { data = await this.#scopedRequest(`${API_ROOT}/${path}`, { operation }, SCOPES[operation]) } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
    if (!isRecord(data) || !isRecord(data.data)) malformed(operation, 'record_invalid')
    return data.data
  }
  // A partial update: only the fields sent change. Setting the same values again is harmless, so a refused or
  // timed-out update may be sent again. Answers the updated record (domain field names).
  async #update(resource, recordId, payload, operation, fields) {
    const target = id(recordId, operation)
    let data
    try {
      data = await this.#scopedRequest(`${API_ROOT}/${resource}/${encodeURIComponent(target)}`,
        { method: 'PUT', body: payload, operation, retrySafe: true, retryRefused: true, timeoutMs: CREATE_TIMEOUT_MS }, SCOPES[operation])
    } catch (error) {
      if (error instanceof ApiError && error.providerShape) error.providerShape = `${requestShape(payload)};${error.providerShape}`.slice(0, 240)
      throw error
    }
    if (!isRecord(data)) malformed(operation, 'reply_not_object')
    if (data.status !== 1) throw new ApiError('validation', { operation, code: 'application_error' })
    const record = normalizeRecord(isRecord(data.data) ? data.data : { id: target }, fields, operation)
    await this.#observe(resource, data.data, fields, operation)
    return record
  }
  async updateContact(contactId, payload) { return this.#update('contacts', contactId, validateUpdate(payload, 'updateContact'), 'updateContact', CONTACT_FIELDS) }
  async updateOrganization(organizationId, payload) {
    return this.#update('organizations', organizationId, validateUpdate(payload, 'updateOrganization'), 'updateOrganization', ORGANIZATION_FIELDS)
  }
  // Albi moves a contact to another organization through the contact update.
  async associateContact({ contactId, organizationId } = {}) { return this.updateContact(contactId, { organizationId }) }
}
