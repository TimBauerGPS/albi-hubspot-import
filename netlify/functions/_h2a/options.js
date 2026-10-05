const text = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : null
const truthy = value => value === true || value === 'true'
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function validConfirmationTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return false
  const date = value.slice(0, 10)
  return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
}

function confirmed(mapping) {
  return Boolean(mapping && (truthy(mapping.confirmed) || truthy(mapping.is_confirmed) ||
    validConfirmationTimestamp(mapping.confirmed_at)))
}

function byKind(mappings, kind) {
  return (Array.isArray(mappings) ? mappings : []).filter(mapping => (mapping.mapping_kind ?? mapping.mappingKind) === kind)
}

function resultConflict(kind) {
  return { action: 'conflict', reason: 'contact_type_confirmation_required', conflict: { kind, actionable: true } }
}

export function resolveContactType(input = {}) {
  const mappings = Array.isArray(input.mappings) ? input.mappings : []
  if (input.inheritFromOrganization === true && text(input.organizationTypeId)) {
    const organizationMappings = byKind(mappings, 'organization_to_contact_type').filter(mapping =>
      text(mapping.source_key ?? mapping.sourceKey) === String(input.organizationTypeId))
    if (organizationMappings.length === 1 && confirmed(organizationMappings[0])) {
      const contactTypeId = text(organizationMappings[0].albi_id ?? organizationMappings[0].albiId)
      if (contactTypeId) return { action: 'resolved', contactTypeId, source: 'organization_mapping' }
    }
  }

  const defaults = byKind(mappings, 'default_contact_type').filter(confirmed)
  if (defaults.length === 1) {
    const contactTypeId = text(defaults[0].albi_id ?? defaults[0].albiId)
    if (contactTypeId) return { action: 'resolved', contactTypeId, source: 'default' }
  }
  const directDefault = text(input.defaultContactTypeId)
  if (directDefault && (truthy(input.defaultConfirmed) || validConfirmationTimestamp(input.defaultConfirmedAt))) {
    return { action: 'resolved', contactTypeId: directDefault, source: 'default' }
  }
  return resultConflict('default_contact_type')
}

export function resolveActivityType(input = {}) {
  const kind = 'activity_type'
  const matches = byKind(input.mappings, kind).filter(mapping =>
    (mapping.source_key ?? mapping.sourceKey) === input.objectType && confirmed(mapping))
  if (matches.length === 1) {
    const activityTypeId = text(matches[0].albi_id ?? matches[0].albiId)
    if (activityTypeId) return { action: 'resolved', activityTypeId }
  }
  return { action: 'conflict', reason: 'activity_type_confirmation_required', conflict: { kind, sourceKey: input.objectType, actionable: true } }
}
