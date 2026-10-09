import { ApiError, createHttpClient, id, invalid, isRecord, malformed, responseId } from './http.js'

const ROOT = '/v5/Integrations'
const CREATE_PATHS = { contacts_create: 'Contacts/Create', organizations_create: 'Organizations/Create', activities_create: 'Activities/Create' }
const text = value => typeof value === 'string' && Boolean(value.trim())
const ADDRESS_FIELDS = ['address1', 'address2', 'city', 'state', 'zipCode', 'country', 'latitude', 'longitude', 'email', 'phoneNumber', 'referralSourceId', 'relationshipStatusId', 'salespersonId', 'sandbox', 'parentOrganizationId']
const WRITE_FIELDS = {
  createContact: ['firstName', 'lastName', 'contactTypeIds', 'organizationId', 'organizationName', 'useOrganizationAddress', 'parentOrganizationName', 'status', 'salespersonName', 'jobTitle', ...ADDRESS_FIELDS],
  createOrganization: ['name', 'organizationTypeIds', 'taxID', 'priceListID', ...ADDRESS_FIELDS],
  createActivity: ['contactId', 'organizationId', 'relationshipName', 'typeId', 'date', 'notes', 'source', 'sourceId'],
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
function numericId(value, operation) {
  const parsed = Number(id(value, operation))
  if (!Number.isSafeInteger(parsed)) invalid(operation)
  return parsed
}
function validatePayload(payload, required, operation) {
  if (!isRecord(payload) || Object.keys(payload).some(key => !WRITE_FIELDS[operation].includes(key)) ||
    required.some(key => key.endsWith('Ids') ? !Array.isArray(payload[key]) || !payload[key].length : !text(payload[key]))) invalid(operation)
  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith('Ids')) {
      if (!Array.isArray(value)) invalid(operation)
      payload = { ...payload, [key]: value.map(item => numericId(item, operation)) }
    } else if ((key.endsWith('Id') || key === 'priceListID') && value != null) payload = { ...payload, [key]: numericId(value, operation) }
    else if (value != null && ['latitude', 'longitude'].includes(key)) { if (typeof value !== 'number' || !Number.isFinite(value)) invalid(operation) }
    else if (key === 'useOrganizationAddress') { if (typeof value !== 'boolean') invalid(operation) }
    else if (value != null && typeof value !== 'string') invalid(operation)
  }
  return payload
}
const CONTACT_FIELDS = ['firstName', 'lastName', 'email', 'phoneNumber', 'mobileNumber', 'organizationId', 'organizationName', 'parentOrganizationId', 'contactTypeIds', 'address1', 'address2', 'city', 'state', 'zipcode', 'country', 'referralSourceID', 'relationshipStatusID']
const ORGANIZATION_FIELDS = ['name', 'email', 'phoneNumber', 'organizationTypeIds', 'parentOrganizationId', 'address1', 'address2', 'city', 'state', 'zipcode', 'country', 'referralSourceID', 'relationshipStatusID']
const ACTIVITY_FIELDS = ['contactId', 'organizationId', 'relationshipName', 'date', 'type', 'notes', 'source', 'sourceId']
function normalizeRecord(value, fields, operation) {
  if (!isRecord(value)) malformed(operation)
  const result = { id: responseId(value.id, operation) }
  for (const field of fields) {
    if (value[field] === undefined) continue
    if (value[field] === null || value[field] === 0) result[field] = null
    else if (/Ids$/.test(field)) {
      if (!Array.isArray(value[field])) malformed(operation)
      result[field] = value[field].map(item => responseId(item, operation))
    } else if (/Id$|ID$/.test(field)) result[field] = responseId(value[field], operation)
    else {
      if (typeof value[field] !== 'string') malformed(operation)
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

export class AlbiClient {
  #request
  constructor({ apiKey, ...http } = {}) {
    if (!text(apiKey)) invalid('credentials')
    this.#request = createHttpClient({ ...http, baseUrl: 'https://api.albiware.com', headers: { ApiKey: apiKey } })
  }
  async verifyCredentials() {
    await this.listContacts({ pageSize: 1 })
    const capabilities = { contacts_update: false, organizations_update: false, contacts_associate_organization: false }
    const diagnostics = {
      contacts_update: 'not_implemented',
      organizations_update: 'not_implemented',
      contacts_associate_organization: 'not_implemented',
    }
    for (const [capability, path] of Object.entries(CREATE_PATHS)) {
      try {
        // OPTIONS is read-only. A 2xx alone does not prove POST support; require Allow to name POST.
        const result = await this.#request(`${ROOT}/${path}`, { method: 'OPTIONS', operation: 'preflightOptions', retrySafe: false, statusOnly: true })
        capabilities[capability] = result.allow.split(',').some(method => method.trim().toUpperCase() === 'POST')
        if (!capabilities[capability]) diagnostics[capability] = 'probe_inconclusive'
      } catch (error) {
        capabilities[capability] = false
        diagnostics[capability] = error.category === 'auth' ? 'authentication_rejected'
          : error.category === 'permission' ? 'permission_denied'
            : ['transient', 'rate_limit'].includes(error.category) ? 'provider_unavailable'
              : 'probe_inconclusive'
      }
    }
    return { authenticated: true, capabilities, diagnostics }
  }
  async listOptions() {
    const relationshipTypes = optionList(await this.#request(`${ROOT}/Options/GetRelationshipTypeOptions`, { operation: 'listOptions' }))
    const referralSources = optionList(await this.#request(`${ROOT}/Options/GetReferralSourceOptions`, { operation: 'listOptions' }))
    const relationshipStatuses = optionList(await this.#request(`${ROOT}/Options/GetRelationshipStatusOptions`, { operation: 'listOptions' }))
    const activityTypes = optionList(await this.#request(`${ROOT}/Options/GetActivityTypeOptions`, { operation: 'listOptions' }))
    // The documented relationship-type IDs are shared by contactTypeIds and organizationTypeIds.
    return { contactTypes: relationshipTypes.map(value => ({ ...value })), organizationTypes: relationshipTypes.map(value => ({ ...value })), relationshipTypes, referralSources, relationshipStatuses, activityTypes }
  }
  async #list(resource, fields, { cursor = '1', pageSize = 25, ...filters } = {}) {
    if (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) < 1 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('list')
    const query = new URLSearchParams({ page: String(cursor), pageSize: String(pageSize), ...filters })
    const data = await this.#request(`${ROOT}/${resource}?${query}`, { operation: `list${resource}` })
    if (!Array.isArray(data) || data.length > pageSize) malformed(`list${resource}`)
    return { records: data.map(value => normalizeRecord(value, fields, `list${resource}`)), cursor: data.length === pageSize ? String(Number(cursor) + 1) : null }
  }
  async listContacts(args = {}) {
    if (!isRecord(args) || Object.keys(args).some(key => !['cursor', 'pageSize'].includes(key))) invalid('listContacts')
    return this.#list('Contacts', CONTACT_FIELDS, args)
  }
  async listOrganizations(args = {}) {
    if (!isRecord(args) || Object.keys(args).some(key => !['cursor', 'pageSize'].includes(key))) invalid('listOrganizations')
    return this.#list('Organizations', ORGANIZATION_FIELDS, args)
  }
  async listActivities({ contactId, organizationId, startDate, endDate, page = 1 } = {}) {
    const filters = {}
    if (contactId != null) filters.contactId = id(contactId, 'listActivities')
    if (organizationId != null) filters.organizationId = id(organizationId, 'listActivities')
    for (const [key, value] of Object.entries({ startDate, endDate })) {
      if (value === undefined) continue
      if (!validDate(value)) invalid('listActivities')
      filters[key] = value
    }
    return this.#list('Activities', ACTIVITY_FIELDS, { cursor: page, ...filters })
  }
  async #create(resource, payload, operation) {
    // Non-idempotent writes are single-attempt. Worker delivery reconciliation owns ambiguous outcomes.
    const data = await this.#request(`${ROOT}/${resource}/Create`, { method: 'POST', body: payload, operation, retrySafe: false })
    if (!isRecord(data)) malformed(operation)
    if (data.status !== 1) throw new ApiError('validation', { operation, code: 'application_error' })
    return { id: responseId(data.data, operation) }
  }
  async createContact(payload) { return this.#create('Contacts', validatePayload(payload, ['firstName', 'lastName', 'contactTypeIds'], 'createContact'), 'createContact') }
  async createOrganization(payload) { return this.#create('Organizations', validatePayload(payload, ['name', 'organizationTypeIds'], 'createOrganization'), 'createOrganization') }
  async createActivity(payload) {
    const validated = validatePayload(payload, ['date', 'notes'], 'createActivity')
    numericId(validated.typeId, 'createActivity')
    if ((!validated.contactId && !validated.organizationId) || !validDate(validated.date.slice(0, 10)) || !Number.isFinite(Date.parse(validated.date))) invalid('createActivity')
    return this.#create('Activities', validated, 'createActivity')
  }
  async updateContact() { throw new ApiError('permanent', { operation: 'updateContact', code: 'unsupported_contract' }) }
  async updateOrganization() { throw new ApiError('permanent', { operation: 'updateOrganization', code: 'unsupported_contract' }) }
  async associateContact() { throw new ApiError('permanent', { operation: 'associateContact', code: 'unsupported_contract' }) }
}
