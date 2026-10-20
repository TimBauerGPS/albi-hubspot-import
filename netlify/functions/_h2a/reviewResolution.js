import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { H2A_REVIEW_ERROR_CATEGORIES, H2A_REVIEW_ERROR_CODES, getH2AReviewActions, sameH2AEmail } from '../../../shared/h2aReviewReasons.js'
import { buildAlbiRecordUrl } from '../../../shared/h2aProviderLinks.js'
import { resolveContactType } from './options.js'
import { normalizePhone } from './normalize.js'

const ACTION_FIELDS = Object.freeze({
  resolve_fields: new Set(['fieldChoices']),
  link_existing: new Set(['candidateId', 'approveManyToOne', 'ignoreContactDifferences', 'ignoredFields']),
  create_albi: new Set(['referralSourceId']),
  force_create_albi: new Set(['ignoredCandidateIds', 'referralSourceId']),
  choose_organization: new Set(['organizationSourceId', 'addHubSpotAssociation']),
  // Live rows only: closes every linked conflict as skipped. No provider work, no plan.
  skip_live: new Set([]),
})
const CONTACT_FIELDS = ['firstName', 'lastName', 'email', 'phoneNumber', 'mobileNumber', 'jobTitle',
  'address1', 'address2', 'city', 'state', 'zipcode', 'country']
const ORGANIZATION_FIELDS = ['name', 'domain', 'phoneNumber', 'address1', 'address2', 'city', 'state', 'zipcode', 'country']
const DECISION_FIELDS = new Set([...CONTACT_FIELDS, ...ORGANIZATION_FIELDS])
export const RESOLUTION_STATUSES = Object.freeze(['pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded'])
export const RESOLUTION_EVENT_TYPES = Object.freeze(['planned', 'claimed', 'provider_applied', 'provider_reconciled',
  'waiting_on_albi', 'recheck_requested', 'completed', 'failed', 'superseded'])
export const RESOLUTION_OUTCOME_CODES = Object.freeze([...H2A_REVIEW_ERROR_CODES, 'authorization_rejected',
  'provider_applied', 'provider_reconciled', 'waiting_on_albi', 'recheck_requested', 'completed', 'failed', 'superseded',
  'safe_to_link', 'safe_to_create', 'still_needs_review', 'source_missing', 'recheck_failed', 'linked', 'created', 'forced_created', 'updated', 'reconciled', 'skipped'])
export const RESOLUTION_EVENT_LIMIT = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const record = value => object(value) ? value : {}
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const timestamp = value => typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) ? value : null
const member = (value, choices) => choices.includes(value) ? value : null

export function isResolutionProviderId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
}
const providerId = value => isResolutionProviderId(value) ? value : null

export function normalizeResolutionDecision(input) {
  if (!object(input) || typeof input.action !== 'string' || !Object.hasOwn(ACTION_FIELDS, input.action) ||
    Object.keys(input).some(key => key !== 'action' && !ACTION_FIELDS[input.action].has(key))) {
    throw new TypeError('Invalid resolution decision')
  }
  const decision = { action: input.action }
  if (input.action === 'resolve_fields') {
    if (!object(input.fieldChoices) || !Object.keys(input.fieldChoices).length ||
      Object.entries(input.fieldChoices).some(([field, winner]) => !DECISION_FIELDS.has(field) || !['hubspot', 'albi'].includes(winner))) {
      throw new TypeError('Invalid resolution field choices')
    }
    decision.fieldChoices = Object.fromEntries(Object.keys(input.fieldChoices).sort().map(key => [key, input.fieldChoices[key]]))
  }
  if (input.action === 'force_create_albi') {
    if (!Array.isArray(input.ignoredCandidateIds) || !input.ignoredCandidateIds.length || input.ignoredCandidateIds.length > 10 ||
      input.ignoredCandidateIds.some(value => !isResolutionProviderId(value)) ||
      new Set(input.ignoredCandidateIds).size !== input.ignoredCandidateIds.length) throw new TypeError('Invalid ignored candidates')
    decision.ignoredCandidateIds = [...input.ignoredCandidateIds].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
  }
  if (ACTION_FIELDS[input.action].has('referralSourceId') && Object.hasOwn(input, 'referralSourceId')) {
    if (!isResolutionProviderId(input.referralSourceId)) throw new TypeError('Invalid referral source')
    decision.referralSourceId = input.referralSourceId
  }
  for (const field of ['candidateId', 'organizationSourceId']) {
    if (ACTION_FIELDS[input.action].has(field)) {
      if (!isResolutionProviderId(input[field])) throw new TypeError('Invalid resolution provider identity')
      decision[field] = input[field]
    }
  }
  if (ACTION_FIELDS[input.action].has('ignoredFields') && Object.hasOwn(input, 'ignoredFields')) {
    const fields = input.ignoredFields
    if (!Array.isArray(fields) || !fields.length || fields.length > 20 || new Set(fields).size !== fields.length ||
      fields.some(field => typeof field !== 'string' || !DECISION_FIELDS.has(field))) throw new TypeError('Invalid ignored fields')
    decision.ignoredFields = [...fields].sort()
  }
  if (ACTION_FIELDS[input.action].has('ignoreContactDifferences') && Object.hasOwn(input, 'ignoreContactDifferences')) {
    if (input.ignoreContactDifferences !== true) throw new TypeError('Invalid email-match approval')
    decision.ignoreContactDifferences = true
  }
  for (const field of ['approveManyToOne', 'addHubSpotAssociation']) {
    if (Object.hasOwn(input, field)) {
      if (typeof input[field] !== 'boolean') throw new TypeError('Invalid resolution approval')
      decision[field] = input[field]
    }
  }
  return decision
}

function canonical(value) {
  if (!object(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export function hashResolutionDecision(input) {
  return createHash('sha256').update(canonical(normalizeResolutionDecision(input))).digest('hex')
}

// Canonical choice names stay independent of each provider's property names.
const SHARED_FIELD_METADATA = {
  phoneNumber: { hubspot: 'phone', albi: ['phoneNumber', 'phone', 'phone_number'] },
  address1: { hubspot: 'address', albi: ['address1', 'address', 'streetAddress', 'street_address'] },
  address2: { hubspot: 'address2', albi: ['address2', 'addressLine2'] },
  city: { hubspot: 'city', albi: ['city'] }, state: { hubspot: 'state', albi: ['state', 'stateCode'] },
  zipcode: { hubspot: 'zip', albi: ['zipcode', 'zipCode', 'zip', 'postalCode'] },
  country: { hubspot: 'country', albi: ['country', 'countryCode'] },
}
const FIELD_METADATA = {
  contacts: { firstName: { hubspot: 'firstname', albi: ['firstName', 'firstname'] },
    lastName: { hubspot: 'lastname', albi: ['lastName', 'lastname'] },
    email: { hubspot: 'email', albi: ['email', 'emailAddress'] },
    mobileNumber: { hubspot: 'mobilephone', albi: ['mobileNumber', 'mobilePhone', 'mobilephone', 'mobile'] },
    jobTitle: { hubspot: 'jobtitle', albi: ['jobTitle', 'jobtitle', 'title'] }, ...SHARED_FIELD_METADATA },
  companies: { name: { hubspot: 'name', albi: ['name', 'companyName'] },
    domain: { hubspot: 'domain', albi: ['domain', 'website', 'websiteUrl'] }, ...SHARED_FIELD_METADATA },
}
export function resolutionCanonicalField(objectType, providerProperty) {
  return Object.entries(FIELD_METADATA[objectType] ?? {}).find(([, metadata]) => metadata.hubspot === providerProperty)?.[0] ?? null
}
const invalidPlan = () => { throw new TypeError('Invalid resolution plan evidence') }
const positiveId = value => { if (!isResolutionProviderId(value)) invalidPlan(); return value }
const list = value => value === undefined ? [] : Array.isArray(value) ? value : invalidPlan()

function requireRecord(value, objectType, expectedId = null) {
  if (!object(value) || value.archived === true || value.objectType !== undefined && value.objectType !== objectType ||
    value.object_type !== undefined && value.object_type !== objectType) invalidPlan()
  if (value.id !== undefined) positiveId(value.id)
  if (expectedId !== null && value.id !== undefined && value.id !== expectedId) invalidPlan()
  return value
}

// Unlike display projections, retain explicit null/empty values and never truncate writes.
function fieldValue(value, aliases, required = true) {
  for (const source of [record(value.properties), value]) {
    for (const alias of aliases) {
      if (!Object.hasOwn(source, alias)) continue
      const descriptor = Object.getOwnPropertyDescriptor(source, alias)
      if (!Object.hasOwn(descriptor, 'value')) invalidPlan()
      const item = descriptor.value
      if (item === null) return ''
      if (typeof item !== 'string' || item.length > 500) invalidPlan()
      return item
    }
  }
  if (required) invalidPlan()
  return null
}

function reviewedAlbi(input, review, type) {
  const albi = requireRecord(input.albi, type)
  const targetId = positiveId(albi.id)
  const candidates = list(review.candidateSnapshots)
  if (candidates.filter(candidate => candidate?.id === targetId).length !== 1) invalidPlan()
  return albi
}

function manualTask(type, targetId, fields, organizationId = null) {
  const url = buildAlbiRecordUrl(type, positiveId(targetId))
  if (!url) invalidPlan()
  return { provider: 'albi', objectType: type, targetId, url,
    ...(organizationId ? { organizationUrl: buildAlbiRecordUrl('companies', positiveId(organizationId)) } : {}), fields }
}

function mappingRows(input, portalId) {
  return list(input.mappings).filter(row => {
    if (!object(row)) invalidPlan()
    const portal = row.portal_id ?? row.portalId
    if (portal !== undefined && !portalId) invalidPlan()
    return portal === undefined || portal === portalId
  })
}
const mappingSource = row => row.hubspot_id ?? row.sourceId ?? row.hubspotId
const sameMappingSource = (row, sourceId, portalId) => mappingSource(row) === sourceId &&
  (row.portal_id ?? row.portalId ?? portalId) === portalId
const mappingTarget = (row, type) => row[type === 'contacts' ? 'albi_contact_id' : 'albi_organization_id'] ?? row.targetId

function selectedOrganization(input, sourceId) {
  const matches = list(input.organizations).filter(item => item?.source?.id === sourceId)
  if (matches.length !== 1) invalidPlan()
  const organization = matches[0]
  requireRecord(organization.source, 'companies', sourceId)
  positiveId(organization.targetId)
  return organization
}

function createPayload(input, hubspot, type, associations) {
  let organization = null
  if (type === 'contacts' && associations.length) {
    if (associations.length !== 1) invalidPlan()
    organization = selectedOrganization(input, associations[0])
    if (!Number.isSafeInteger(Number(organization.targetId))) invalidPlan()
  }
  const options = list(input.optionMappings)
  const selectedOptions = type === 'contacts' ? options : options.filter(row =>
    (row?.mapping_kind ?? row?.mappingKind) === 'default_organization_type' && (row.source_key ?? row.sourceKey) === 'default')
    .map(row => ({ ...row, mapping_kind: 'default_contact_type' }))
  const resolved = resolveContactType({ mappings: selectedOptions, inheritFromOrganization: type === 'contacts',
    organizationTypeId: organization?.organizationTypeId })
  if (resolved.action !== 'resolved') invalidPlan()
  if (!Number.isSafeInteger(Number(positiveId(resolved.contactTypeId)))) invalidPlan()
  // Created records are always typed Referrer and set Active; the salesperson follows the HubSpot owner.
  const defaults = object(input.createDefaults) ? input.createDefaults : invalidPlan()
  const typeId = positiveId(defaults.typeId)
  if (!Number.isSafeInteger(Number(typeId))) invalidPlan()
  const payload = {}
  // Only properties accepted by the existing Albi create contracts are copied.
  // Keep creates on the same minimal contract exercised by the production sync.
  // Richer provider fields remain available for comparison and manual resolution,
  // but have not been proven safe on Albi's create endpoints.
  for (const field of type === 'contacts' ? ['firstName', 'lastName', 'email', 'phoneNumber'] : ['name', 'phoneNumber']) {
    const meta = FIELD_METADATA[type][field]
    let value = fieldValue(hubspot, [meta.hubspot, field], false)
    if (value !== null) value = value.trim()
    if (['firstName', 'lastName', 'name'].includes(field) && !value) invalidPlan()
    if (value === null || value === '') continue
    if (field === 'phoneNumber') {
      const normalized = normalizePhone(value)
      if (normalized.conflictReason || !normalized.writable) invalidPlan()
      value = normalized.writable
    }
    payload[field === 'zipcode' ? 'zipCode' : field] = value
  }
  payload[type === 'contacts' ? 'contactTypeIds' : 'organizationTypeIds'] = [typeId]
  // Albi requires a referral source on create. Its ID is a user choice validated against live options by the service.
  const referralSourceId = positiveId(object(input.decision) ? input.decision.referralSourceId : undefined)
  payload.referralSourceId = referralSourceId
  payload.relationshipStatusId = positiveId(defaults.statusId)
  if (defaults.salespersonId !== null && defaults.salespersonId !== undefined) payload.salespersonId = positiveId(defaults.salespersonId)
  if (organization) payload.organizationId = organization.targetId
  return { payload, typeId, organizationId: organization?.targetId ?? null }
}

// Pure: receives only server-reloaded evidence, returns data, and never accesses capabilities.
export function buildReviewResolutionPlan(input) {
  if (!object(input) || Object.keys(input).some(key => !['review', 'hubspot', 'albi', 'decision', 'mappings',
    'optionMappings', 'associatedCompanyIds', 'organizations', 'portalId', 'createDefaults'].includes(key))) invalidPlan()
  const decision = normalizeResolutionDecision(input.decision)
  const review = record(input.review), type = review.objectType
  // A recheck's verdict is authoritative: a review cleared as safe to create/link allows that action under any captured reason.
  const clearedFor = review.status === 'cleared' ? { safe_to_create: 'create_albi', safe_to_link: 'link_existing' }[review.recheckOutcome] : undefined
  if (!['contacts', 'companies'].includes(type) || !getH2AReviewActions(review.reason, type).includes(decision.action) && clearedFor !== decision.action) invalidPlan()
  const sourceId = positiveId(review.sourceId)
  const portalId = input.portalId ?? review.portalId ?? null
  if (portalId !== null) positiveId(portalId)
  if (review.portalId !== undefined && review.portalId !== portalId) invalidPlan()
  const hubspot = requireRecord(input.hubspot, type, sourceId)
  const associations = [...new Set(list(input.associatedCompanyIds).map(positiveId))]
  const result = { decisionHash: hashResolutionDecision(decision), action: decision.action, providerOperation: null,
    ignoredCandidateIds: [], manualTasks: [], mapping: null, organizationChoice: null,
    verification: { successStatus: 'ready_to_recheck', properties: null, association: null, create: null } }
  if (decision.action === 'resolve_fields') {
    const albi = reviewedAlbi(input, review, type), properties = {}, fields = []
    const changes = record(review.proposedChanges)
    for (const [field, winner] of Object.entries(decision.fieldChoices)) {
      if (!Object.hasOwn(FIELD_METADATA[type], field)) invalidPlan()
      const meta = FIELD_METADATA[type][field]
      // A field the review did not flag can only be filled from Albi where HubSpot is blank; that is a HubSpot write.
      if (!Object.hasOwn(record(changes.conflicts), field) && !Object.hasOwn(record(changes.updates), field)) {
        const blank = (fieldValue(hubspot, [meta.hubspot, field], false) ?? '').trim() === ''
        const fill = fieldValue(albi, meta.albi, false) ?? ''
        if (winner !== 'albi' || !blank || fill.trim() === '') invalidPlan()
        properties[meta.hubspot] = fill
        continue
      }
      // Review snapshots trim values, so compare and hand off trimmed HubSpot values too.
      const hs = fieldValue(hubspot, [meta.hubspot, field]).trim()
      // When HubSpot wins, an Albi field that is simply not returned is blank for comparison; the write is a manual Albi task.
      const target = winner === 'hubspot' ? fieldValue(albi, meta.albi, false) ?? '' : fieldValue(albi, meta.albi)
      if (hs === target) continue
      if (winner === 'albi') properties[meta.hubspot] = target
      else fields.push({ field, value: hs })
    }
    if (Object.keys(properties).length) {
      result.providerOperation = { provider: 'hubspot', operation: type === 'contacts' ? 'updateContact' : 'updateCompany', id: sourceId, properties }
      result.verification.properties = { ...properties }
    }
    if (fields.length) result.manualTasks.push(manualTask(type, albi.id, fields))
  } else if (decision.action === 'link_existing') {
    const albi = reviewedAlbi(input, review, type)
    if (decision.candidateId !== albi.id) invalidPlan()
    // Ignoring phone/address differences is only allowed for a contact whose email matches exactly.
    if (decision.ignoreContactDifferences === true && (type !== 'contacts' ||
      !sameH2AEmail(fieldValue(hubspot, ['email'], false), fieldValue(albi, FIELD_METADATA.contacts.email.albi, false)))) invalidPlan()
    // Ignored differences must be fields this record type has.
    if (decision.ignoredFields?.some(field => !Object.hasOwn(FIELD_METADATA[type], field))) invalidPlan()
    const mappings = mappingRows(input, portalId)
    if (mappings.some(row => mappingSource(row) === sourceId && mappingTarget(row, type) !== albi.id) ||
      list(input.mappings).some(row => !sameMappingSource(row, sourceId, portalId) && mappingTarget(row, type) === albi.id) && !decision.approveManyToOne) invalidPlan()
    result.mapping = { objectType: type, sourceId, targetId: albi.id, approveManyToOne: decision.approveManyToOne === true }
  } else if (['create_albi', 'force_create_albi'].includes(decision.action)) {
    if (mappingRows(input, portalId).some(row => mappingSource(row) === sourceId)) invalidPlan()
    if (decision.action === 'force_create_albi') {
      const captured = list(review.candidateSnapshots).map(item => positiveId(item?.id))
        .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
      if (!captured.length || !isDeepStrictEqual(captured, decision.ignoredCandidateIds)) invalidPlan()
      result.ignoredCandidateIds = [...decision.ignoredCandidateIds]
    }
    // A contact is created only against an already-mapped organization; there is no deferred association.
    const create = createPayload(input, hubspot, type, associations)
    result.providerOperation = { provider: 'albi', operation: type === 'contacts' ? 'createContact' : 'createOrganization', payload: create.payload }
    result.mapping = { objectType: type, sourceId, targetId: null, approveManyToOne: false }
    // Existing record creates have no provider source-marker field. Identity is for fenced service reconciliation.
    result.verification.create = { objectType: type, sourceId, portalId, typeId: create.typeId,
      organizationId: create.organizationId, payload: { ...create.payload,
        [type === 'contacts' ? 'contactTypeIds' : 'organizationTypeIds']: [create.typeId] } }
  } else {
    if (type !== 'contacts') invalidPlan()
    const organization = selectedOrganization(input, decision.organizationSourceId)
    if (!associations.includes(decision.organizationSourceId)) {
      if (decision.addHubSpotAssociation !== true) invalidPlan()
      result.providerOperation = { provider: 'hubspot', operation: 'addContactCompanyAssociation', contactId: sourceId, companyId: decision.organizationSourceId }
      result.verification.association = { contactId: sourceId, companyId: decision.organizationSourceId }
    }
    result.organizationChoice = { contactId: sourceId, organizationSourceId: decision.organizationSourceId }
    if (input.albi !== undefined && input.albi !== null) {
      // Association evaluation can stop before identity matching, leaving no captured candidates.
      // The service must select this current contact through tenant-scoped matching/mappings.
      const albi = requireRecord(input.albi, type)
      positiveId(albi.id)
      const current = fieldValue(albi, ['organizationId', 'organization_id'])
      if (current !== '') positiveId(current)
      if (current !== organization.targetId) result.manualTasks.push(manualTask(type, albi.id,
        [{ field: 'organizationId', value: organization.targetId }], organization.targetId))
    }
  }
  if (result.manualTasks.length) result.verification.successStatus = 'waiting_on_albi'
  return result
}

function projectedDecision(value, action) {
  const input = record(value)
  if (typeof action !== 'string' || !Object.hasOwn(ACTION_FIELDS, action) || input.action !== action) return null
  const cleaned = { action }
  for (const key of ACTION_FIELDS[action]) if (Object.hasOwn(input, key)) cleaned[key] = input[key]
  if (action === 'resolve_fields') cleaned.fieldChoices = Object.fromEntries(Object.entries(record(input.fieldChoices))
    .filter(([field, winner]) => DECISION_FIELDS.has(field) && ['hubspot', 'albi'].includes(winner)))
  try { return normalizeResolutionDecision(cleaned) } catch { return null }
}

function safeManualTasks(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 10).flatMap(item => {
    const task = record(item)
    if (task.provider !== 'albi' || !['contacts', 'companies'].includes(task.objectType) || !providerId(task.targetId)) return []
    const allowed = task.objectType === 'contacts' ? [...CONTACT_FIELDS, 'organizationId'] : ORGANIZATION_FIELDS
    const fields = (Array.isArray(task.fields) ? task.fields : []).slice(0, 20).flatMap(item => {
      const field = record(item)
      if (!allowed.includes(field.field)) return []
      if (field.field === 'organizationId' && !providerId(field.value)) return []
      const value = typeof field.value === 'string' ? field.value.slice(0, 500)
        : typeof field.value === 'number' && Number.isFinite(field.value) ? String(field.value) : field.value === null ? null : undefined
      return value === undefined ? [] : [{ field: field.field, value }]
    })
    return fields.length ? [{ provider: 'albi', objectType: task.objectType, targetId: task.targetId, fields }] : []
  })
}

export function safeResolutionEventDetails(value) {
  const input = record(value)
  const details = {}
  if (RESOLUTION_OUTCOME_CODES.includes(input.code)) details.code = input.code
  if (H2A_REVIEW_ERROR_CATEGORIES.includes(input.category)) details.category = input.category
  if (Number.isInteger(input.providerStatus) && input.providerStatus >= 400 && input.providerStatus <= 599) {
    details.providerStatus = input.providerStatus
  }
  if (typeof input.providerReason === 'string' && input.providerReason.length > 0 && input.providerReason.length <= 200) {
    details.providerReason = input.providerReason
  }
  if (typeof input.providerShape === 'string' && input.providerShape.length > 0 && input.providerShape.length <= 240) {
    details.providerShape = input.providerShape
  }
  if (['source', 'target', 'target_missing', 'plan', 'review', 'candidates', 'mapping', 'portal', 'other'].includes(input.staleCheck)) {
    details.staleCheck = input.staleCheck
    details.staleFields = (Array.isArray(input.staleFields) ? input.staleFields : [])
      .filter(field => typeof field === 'string' && /^\w{1,40}$/.test(field)).slice(0, 10)
  }
  if (RESOLUTION_OUTCOME_CODES.includes(input.outcome)) details.outcome = input.outcome
  if (Array.isArray(input.manualTasks)) details.manualTasks = safeManualTasks(input.manualTasks)
  return details
}

// Executor-only proof. Reject rather than truncate: every stored value must be
// exactly the one verified before the provider attempt. Public events omit it.
export function safeResolutionExecutionContext(value) {
  const shape = (item, keys) => object(item) && Object.keys(item).length === keys.length &&
    keys.every(key => Object.hasOwn(item, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(item, key), 'value'))
  const text = item => typeof item === 'string' && item.length <= 500
  const properties = (item, type) => object(item) && Object.keys(item).length > 0 &&
    Object.entries(item).every(([key, value]) => Object.values(FIELD_METADATA[type]).some(field => field.hubspot === key) && text(value))
  const payload = (item, type) => {
    const fields = type === 'contacts' ? ['firstName', 'lastName', 'email', 'phoneNumber', 'jobTitle', 'organizationId'] : ['name', 'phoneNumber']
    const ids = type === 'contacts' ? 'contactTypeIds' : 'organizationTypeIds'
    const allowed = [...fields, 'address1', 'address2', 'city', 'state', 'zipCode', 'country', 'referralSourceId', 'relationshipStatusId', 'salespersonId', ids]
    return object(item) && Object.keys(item).every(key => allowed.includes(key)) &&
      Object.entries(item).every(([key, value]) => key === ids ? Array.isArray(value) && value.length === 1 && providerId(value[0])
        : ['organizationId', 'referralSourceId', 'relationshipStatusId', 'salespersonId'].includes(key) ? providerId(value) : text(value)) && Object.hasOwn(item, ids)
  }
  try {
    const legacyKeys = ['decisionHash', 'action', 'providerOperation', 'manualTasks', 'mapping', 'organizationChoice', 'verification']
    const currentKeys = ['decisionHash', 'action', 'ignoredCandidateIds', 'providerOperation', 'manualTasks', 'mapping', 'organizationChoice', 'verification']
    if (!shape(value, legacyKeys) && !shape(value, currentKeys) ||
      typeof value.decisionHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.decisionHash) ||
      !Object.hasOwn(ACTION_FIELDS, value.action) || !Array.isArray(value.manualTasks) || value.manualTasks.length > 10 ||
      !shape(value.verification, ['successStatus', 'properties', 'association', 'create'])) return null
    const ignoredCandidateIds = Object.hasOwn(value, 'ignoredCandidateIds') ? value.ignoredCandidateIds : []
    if (!Array.isArray(ignoredCandidateIds) || ignoredCandidateIds.length > 10 ||
      ignoredCandidateIds.some(item => !providerId(item)) || new Set(ignoredCandidateIds).size !== ignoredCandidateIds.length ||
      (value.action === 'force_create_albi') !== (ignoredCandidateIds.length > 0)) return null
    const manualTasks = value.manualTasks.map(task => {
      if (!object(task) || Object.keys(task).some(key => !['provider', 'objectType', 'targetId', 'fields', 'url', 'organizationUrl'].includes(key)) ||
        task.provider !== 'albi' || !['contacts', 'companies'].includes(task.objectType) || !providerId(task.targetId) ||
        !Array.isArray(task.fields) || !task.fields.length || task.fields.length > 20 ||
        task.fields.some(field => !shape(field, ['field', 'value']) || !text(field.value) ||
          !(task.objectType === 'contacts' ? [...CONTACT_FIELDS, 'organizationId'] : ORGANIZATION_FIELDS).includes(field.field) ||
          field.field === 'organizationId' && !providerId(field.value))) throw new TypeError()
      return { provider: 'albi', objectType: task.objectType, targetId: task.targetId, fields: task.fields.map(field => ({ ...field })) }
    })
    const op = value.providerOperation, verification = value.verification
    if (verification.successStatus !== (manualTasks.length ? 'waiting_on_albi' : 'ready_to_recheck')) return null
    let operation = null
    if (op !== null) {
      if (op?.provider === 'hubspot' && ['updateContact', 'updateCompany'].includes(op.operation)) {
        if (!shape(op, ['provider', 'operation', 'id', 'properties']) || !providerId(op.id) ||
          !properties(op.properties, op.operation === 'updateContact' ? 'contacts' : 'companies') ||
          canonical(verification.properties) !== canonical(op.properties) || verification.association !== null || verification.create !== null) return null
      } else if (op?.provider === 'hubspot' && op.operation === 'addContactCompanyAssociation') {
        if (!shape(op, ['provider', 'operation', 'contactId', 'companyId']) || !providerId(op.contactId) || !providerId(op.companyId) ||
          !shape(verification.association, ['contactId', 'companyId']) || verification.association.contactId !== op.contactId ||
          verification.association.companyId !== op.companyId || verification.properties !== null || verification.create !== null) return null
      } else if (op?.provider === 'albi' && ['createContact', 'createOrganization'].includes(op.operation)) {
        const type = op.operation === 'createContact' ? 'contacts' : 'companies', create = verification.create
        if (!shape(op, ['provider', 'operation', 'payload']) || !payload(op.payload, type) ||
          !shape(create, ['objectType', 'sourceId', 'portalId', 'typeId', 'organizationId', 'payload']) ||
          create.objectType !== type || !providerId(create.sourceId) || create.portalId !== null && !providerId(create.portalId) ||
          !providerId(create.typeId) || create.organizationId !== null && !providerId(create.organizationId) ||
          create.typeId !== op.payload[type === 'contacts' ? 'contactTypeIds' : 'organizationTypeIds'][0] ||
          create.organizationId !== (op.payload.organizationId ?? null) || canonical(create.payload) !== canonical(op.payload) ||
          verification.properties !== null || verification.association !== null) return null
      } else return null
      operation = structuredClone(op)
    } else if (verification.properties !== null || verification.association !== null || verification.create !== null) return null
    if (value.mapping !== null && (!shape(value.mapping, ['objectType', 'sourceId', 'targetId', 'approveManyToOne']) ||
      !['contacts', 'companies'].includes(value.mapping.objectType) || !providerId(value.mapping.sourceId) ||
      value.mapping.targetId !== null && !providerId(value.mapping.targetId) || typeof value.mapping.approveManyToOne !== 'boolean')) return null
    if (value.organizationChoice !== null && (!shape(value.organizationChoice, ['contactId', 'organizationSourceId']) ||
      !providerId(value.organizationChoice.contactId) || !providerId(value.organizationChoice.organizationSourceId))) return null
    return { decisionHash: value.decisionHash, action: value.action, ignoredCandidateIds: [...ignoredCandidateIds], providerOperation: operation, manualTasks,
      mapping: structuredClone(value.mapping), organizationChoice: structuredClone(value.organizationChoice), verification: structuredClone(verification) }
  } catch { return null }
}

export function safeResolutionInternalEventDetails(value) {
  const details = safeResolutionEventDetails(value)
  const context = safeResolutionExecutionContext(record(value).executionContext)
  if (context) details.executionContext = context
  if (isResolutionProviderId(record(value).createReceiptId)) details.createReceiptId = value.createReceiptId
  return details
}

export function projectReviewResolutionEvent(row) {
  const stored = record(row)
  return { id: uuid(stored.id), actorId: uuid(stored.actor_id), eventType: member(stored.event_type, RESOLUTION_EVENT_TYPES),
    details: safeResolutionEventDetails(stored.sanitized_details), createdAt: timestamp(stored.created_at) }
}

// Only this projection belongs in browser responses. Repository rows are executor-facing.
export function projectReviewResolution(row, events = []) {
  if (!object(row)) return null
  const action = typeof row.action === 'string' && Object.hasOwn(ACTION_FIELDS, row.action) ? row.action : null
  return { id: uuid(row.id), runId: uuid(row.run_id), reviewId: uuid(row.review_id), portalId: providerId(row.portal_id),
    objectType: member(row.object_type, ['contacts', 'companies']), sourceId: providerId(row.source_id), action,
    status: member(row.status, RESOLUTION_STATUSES), expectedUpdatedAt: timestamp(row.expected_review_updated_at),
    decision: projectedDecision(row.decision, action), providerOutcomeCode: member(row.provider_outcome_code, RESOLUTION_OUTCOME_CODES),
    createdBy: uuid(row.created_by), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    events: (Array.isArray(events) ? events : []).slice(0, RESOLUTION_EVENT_LIMIT).map(projectReviewResolutionEvent) }
}
