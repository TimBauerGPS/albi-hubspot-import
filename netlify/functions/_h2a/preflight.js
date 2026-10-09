import { HUBSPOT_ACTIVITY_TYPES } from './constants.js'
import { isRecord } from './http.js'

export const PREFLIGHT_CAPABILITIES = {
  hubspot: {
    contacts_read: 'HubSpot contact reads', companies_read: 'HubSpot company reads',
    meetings_read: 'HubSpot meeting reads', calls_read: 'HubSpot call reads',
    emails_read: 'HubSpot direct CRM email reads', communications_read: 'HubSpot communication reads', notes_read: 'HubSpot note reads',
  },
  albi: {
    company_access: 'Authorized Albi company', contacts_read: 'Albi contact reads', organizations_read: 'Albi organization reads',
    contacts_create: 'Albi contact creation', organizations_create: 'Albi organization creation',
    contacts_update: 'Albi contact updates', organizations_update: 'Albi organization updates',
    contacts_associate_organization: 'Albi contact organization associations', activities_create: 'Albi activity creation',
    activities_read: 'Albi activity reads', options_read: 'Albi option reads',
  },
}
export const REQUIRED_OPTION_LABELS = {
  contactTypes: 'Albi contact type options', organizationTypes: 'Albi organization type options',
  relationshipTypes: 'Albi relationship type options', referralSources: 'Albi referral source options',
  relationshipStatuses: 'Albi relationship status options', activityTypes: 'Albi activity type options',
}
const STATUSES = new Set(['unchecked', 'running', 'valid', 'invalid', 'informational'])
const DIAGNOSTIC_REASONS = new Set([
  'authentication_rejected', 'permission_denied', 'unexpected_response', 'provider_unavailable',
  'verified_on_first_use', 'handled_through_conflicts',
])
const WRAPPER_SCOPES = new Set([
  'contacts:list', 'contacts:create', 'organizations:list', 'organizations:create', 'activities:list', 'activities:create',
  'options.relationship-types:list', 'options.referral-sources:list', 'options.relationship-statuses:list', 'options.activity-types:list',
])
const INFORMATIONAL_CAPABILITIES = Object.freeze({
  contacts_create: { reason: 'verified_on_first_use', requiredScope: 'contacts:create' },
  organizations_create: { reason: 'verified_on_first_use', requiredScope: 'organizations:create' },
  activities_create: { reason: 'verified_on_first_use', requiredScope: 'activities:create' },
  contacts_update: { reason: 'handled_through_conflicts' },
  organizations_update: { reason: 'handled_through_conflicts' },
  contacts_associate_organization: { reason: 'handled_through_conflicts' },
})
function diagnosticReason(error, authenticated = false) {
  if (error?.category === 'auth') return authenticated ? 'permission_denied' : 'authentication_rejected'
  if (error?.category === 'permission') return 'permission_denied'
  if (error?.category === 'transient' || error?.category === 'rate_limit') return 'provider_unavailable'
  if (error?.code === 'unsupported_contract') return 'not_implemented'
  return 'unexpected_response'
}
function safeOptionText(value, protectedValues) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value) && !protectedValues.some(secret => value.includes(secret)) &&
    !/(bearer\s+|authorization\s*:|pat-[a-z0-9]+-|sqlstate|postgrest|duplicate key|database error)/i.test(value)
}
// One explicit nested response/storage projection, shared with Settings. No raw error fields.
export function safePreflightDetails(value, protectedValues = []) {
  if (!isRecord(value)) return {}
  const result = {}
  const labels = new Set([...Object.values(PREFLIGHT_CAPABILITIES).flatMap(capabilities => Object.values(capabilities)), ...Object.values(REQUIRED_OPTION_LABELS)])
  if (Array.isArray(value.missing)) result.missing = value.missing.filter(label => typeof label === 'string' && labels.has(label))
  for (const provider of ['hubspot', 'albi']) {
    const source = value[provider]
    if (!isRecord(source)) continue
    const safe = {}
    if (STATUSES.has(source.status)) safe.status = source.status
    if (typeof source.authenticated === 'boolean') safe.authenticated = source.authenticated
    if (provider === 'albi' && isRecord(source.company) && /^[A-Za-z0-9_-]{1,64}$/.test(source.company.id ?? '') &&
      safeOptionText(source.company.name, protectedValues)) {
      safe.company = { id: source.company.id, name: source.company.name.trim() }
    }
    if (Array.isArray(source.checks)) {
      safe.checks = source.checks.filter(check => isRecord(check) &&
        Object.hasOwn(PREFLIGHT_CAPABILITIES[provider], check.capability) && STATUSES.has(check.status))
        .map(check => ({ capability: check.capability, status: check.status, label: PREFLIGHT_CAPABILITIES[provider][check.capability],
          ...(['invalid', 'informational'].includes(check.status) && DIAGNOSTIC_REASONS.has(check.reason) ? { reason: check.reason } : {}),
          ...(WRAPPER_SCOPES.has(check.requiredScope) ? { requiredScope: check.requiredScope } : {}) }))
    }
    result[provider] = safe
  }
  if (isRecord(value.options)) {
    result.options = {}
    for (const group of Object.keys(REQUIRED_OPTION_LABELS)) {
      if (!Array.isArray(value.options[group])) continue
      result.options[group] = value.options[group].filter(option => isRecord(option) &&
        safeOptionText(option.id, protectedValues) && /^[a-z0-9_.:-]+$/i.test(option.id) && safeOptionText(option.label, protectedValues))
        .map(option => ({ id: option.id, label: option.label }))
    }
  }
  return result
}

export function mappingsMatchOptions(mappings, options) {
  if (!Array.isArray(mappings) || !isRecord(options)) return false
  const contains = (group, optionId) => typeof optionId === 'string' && Array.isArray(options[group]) &&
    options[group].some(option => isRecord(option) && option.id === optionId)
  return mappings.every(mapping => {
    const { mappingKind, sourceKey, albiId } = mapping
    if (mappingKind === 'activity_type') return HUBSPOT_ACTIVITY_TYPES.includes(sourceKey) && contains('activityTypes', albiId)
    if (mappingKind === 'default_contact_type') return sourceKey === 'default' && contains('contactTypes', albiId)
    if (mappingKind === 'default_organization_type') return sourceKey === 'default' && contains('organizationTypes', albiId)
    if (mappingKind === 'organization_to_contact_type') return contains('organizationTypes', sourceKey) && contains('contactTypes', albiId)
    return false
  })
}
export function completeConfirmedMappings(mappings, options) {
  if (!mappings.every(mapping => mapping.confirmed_at) || !mappingsMatchOptions(mappings.map(mapping => ({
    mappingKind: mapping.mapping_kind, sourceKey: mapping.source_key, albiId: mapping.albi_id,
  })), options)) return false
  return ['default_contact_type', 'default_organization_type'].every(kind => mappings.some(mapping => mapping.mapping_kind === kind && mapping.source_key === 'default')) &&
    HUBSPOT_ACTIVITY_TYPES.every(type => mappings.some(mapping => mapping.mapping_kind === 'activity_type' && mapping.source_key === type))
}

export async function runPreflight({ hubspot, albi, protectedValues = [] }) {
  const details = { missing: [], hubspot: { status: 'invalid', authenticated: false, checks: [] }, albi: { status: 'invalid', authenticated: false, checks: [] }, options: {} }
  let portalId = null
  try {
    const account = await hubspot.getAccountInfo()
    if (typeof account?.portalId === 'string' && /^[1-9]\d*$/.test(account.portalId)) { portalId = account.portalId; details.hubspot.authenticated = true }
  } catch { /* A sanitized failed capability is the only user-facing error. */ }
  async function check(provider, capability, operation, configuredReason) {
    let status = 'invalid'
    let reason = configuredReason
    let requiredScope
    try {
      if (await operation() !== false) status = 'valid'
      else reason ??= 'unexpected_response'
    } catch (error) {
      reason = diagnosticReason(error, provider === 'albi' && details.albi.authenticated)
      if (WRAPPER_SCOPES.has(error?.requiredScope)) requiredScope = error.requiredScope
    }
    const label = PREFLIGHT_CAPABILITIES[provider][capability]
    details[provider].checks.push({ capability, status, label, ...(status === 'invalid' ? { reason } : {}), ...(requiredScope ? { requiredScope } : {}) })
    if (status !== 'valid') details.missing.push(label)
  }
  for (const type of ['contacts', 'companies']) await check('hubspot', `${type}_read`, () => hubspot.checkRead(type))
  for (const objectType of HUBSPOT_ACTIVITY_TYPES) await check('hubspot', `${objectType}_read`, () =>
    hubspot.listActivities({ objectType, occurredAtGte: '1970-01-01T00:00:00.000Z', limit: 1 }))
  let capabilities = {}
  let capabilityReportReceived = false
  let credentialFailureReason
  try {
    const credentials = await albi.verifyCredentials()
    details.albi.authenticated = credentials?.authenticated === true
    capabilities = credentials?.capabilities ?? {}
    capabilityReportReceived = true
    if (isRecord(credentials?.company)) details.albi.company = credentials.company
  } catch (error) {
    capabilities = {}
    credentialFailureReason = diagnosticReason(error)
  }
  await check('albi', 'company_access', async () => isRecord(details.albi.company) &&
    /^[A-Za-z0-9_-]{1,64}$/.test(details.albi.company.id ?? '') && safeOptionText(details.albi.company.name, protectedValues), credentialFailureReason)
  await check('albi', 'contacts_read', () => albi.listContacts({ pageSize: 1 }))
  await check('albi', 'organizations_read', () => albi.listOrganizations({ pageSize: 1 }))
  await check('albi', 'activities_read', () => albi.listActivities({ page: 1 }))
  for (const [capability, expected] of Object.entries(INFORMATIONAL_CAPABILITIES)) {
    const matches = !capabilityReportReceived || capabilities[capability] === expected.reason
    if (matches) details.albi.checks.push({ capability, status: 'informational',
      label: PREFLIGHT_CAPABILITIES.albi[capability], reason: expected.reason,
      ...(expected.requiredScope ? { requiredScope: expected.requiredScope } : {}) })
    else await check('albi', capability, async () => false, 'unexpected_response')
  }
  await check('albi', 'options_read', async () => {
    const loaded = await albi.listOptions()
    details.options = safePreflightDetails({ options: loaded }, protectedValues).options ?? {}
    return Object.keys(REQUIRED_OPTION_LABELS).every(group => Array.isArray(loaded[group]) && details.options[group]?.length === loaded[group].length)
  })
  for (const [group, label] of Object.entries(REQUIRED_OPTION_LABELS)) if (!details.options[group]?.length) details.missing.push(label)
  for (const provider of ['hubspot', 'albi']) details[provider].status = details[provider].authenticated && details[provider].checks.every(check => check.status !== 'invalid') &&
    (provider !== 'albi' || Object.keys(REQUIRED_OPTION_LABELS).every(group => details.options[group]?.length)) ? 'valid' : 'invalid'
  return { status: details.hubspot.status === 'valid' && details.albi.status === 'valid' ? 'valid' : 'invalid', portalId, details: safePreflightDetails(details, protectedValues) }
}
