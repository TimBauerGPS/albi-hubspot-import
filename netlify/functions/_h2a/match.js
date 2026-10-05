import {
  normalizeAddress,
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from './normalize.js'

const EMPTY_CHANGES = () => ({ updates: {}, conflicts: {}, unchanged: [] })

function fieldValue(fields, ...names) {
  for (const name of names) {
    if (fields?.[name] !== undefined && fields?.[name] !== null && fields?.[name] !== '') return fields[name]
  }
  return null
}

function idOf(record) {
  const value = record?.id ?? record?.targetId ?? record?.albiId
  return value === undefined || value === null ? null : String(value)
}

function mappedTargetId(record) {
  const value = record?.targetId ?? record?.albiId ?? record?.albi_contact_id ??
    record?.albi_organization_id ?? record?.target_id
  return value === undefined || value === null ? null : String(value)
}

function phoneComparable(value) {
  return normalizePhone(value).comparable
}

function normalized(field, value) {
  if (field === 'email') return normalizeEmail(value)
  if (['phone', 'phoneNumber', 'mobilePhone', 'mobilephone', 'mobileNumber'].includes(field)) return phoneComparable(value)
  if (['name', 'companyName', 'firstName', 'firstname', 'lastName', 'lastname'].includes(field)) return normalizeName(value)
  if (field === 'domain' || field === 'website') return normalizeDomain(value)
  if (field === 'address' || field === 'streetAddress') return normalizeAddress(value)
  const text = typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US') : value
  return text === '' ? null : text
}

function isPhoneField(field) {
  return ['phone', 'phoneNumber', 'mobilePhone', 'mobilephone', 'mobileNumber', 'mobile'].includes(field)
}

function valuesEqual(field, sourceValue, targetValue) {
  const sourceNormalized = normalized(field, sourceValue)
  const targetNormalized = normalized(field, targetValue)
  if (sourceNormalized !== null && sourceNormalized !== undefined &&
      targetNormalized !== null && targetNormalized !== undefined) {
    return sourceNormalized === targetNormalized
  }
  return String(sourceValue).trim().toLocaleLowerCase('en-US') ===
    String(targetValue).trim().toLocaleLowerCase('en-US')
}

const FIELD_ALIASES = {
  email: ['email', 'emailAddress'],
  phone: ['phone', 'phoneNumber'],
  phoneNumber: ['phoneNumber', 'phone'],
  mobilePhone: ['mobilePhone', 'mobilephone', 'mobileNumber', 'mobile'],
  mobilephone: ['mobilephone', 'mobilePhone', 'mobileNumber', 'mobile'],
  mobileNumber: ['mobileNumber', 'mobilePhone', 'mobilephone', 'mobile'],
  firstName: ['firstName', 'firstname'],
  firstname: ['firstname', 'firstName'],
  lastName: ['lastName', 'lastname'],
  lastname: ['lastname', 'lastName'],
  name: ['name', 'companyName'],
  domain: ['domain', 'website', 'websiteUrl'],
  address: ['address', 'streetAddress'],
}

export function decideFieldChanges(input = {}) {
  const source = input.source ?? input.sourceFields ?? {}
  const target = input.target ?? input.targetFields ?? {}
  const changes = EMPTY_CHANGES()
  const fields = new Set([...Object.keys(source), ...Object.keys(target)])

  for (const field of fields) {
    const sourceValue = fieldValue(source, ...(FIELD_ALIASES[field] ?? [field]))
    const targetValue = fieldValue(target, ...(FIELD_ALIASES[field] ?? [field]))
    if (sourceValue === null) continue
    if (isPhoneField(field) && normalizePhone(sourceValue).conflictReason) {
      changes.conflicts[field] = {
        current: targetValue,
        proposed: sourceValue,
        reason: normalizePhone(sourceValue).conflictReason,
      }
      continue
    }
    if (targetValue === null) {
      changes.updates[field] = sourceValue
      continue
    }
    if (valuesEqual(field, sourceValue, targetValue)) {
      changes.unchanged.push(field)
      continue
    }
    changes.conflicts[field] = { current: targetValue, proposed: sourceValue }
  }
  return changes
}

function result(action, reason, targetId = null, evidence = [], proposedChanges = EMPTY_CHANGES()) {
  return { action, targetId, reason, evidence, proposedChanges }
}

function mappingConflict(sourceId, targetId, mappings = []) {
  if (sourceId == null || targetId == null) return false
  return mappings.some((mapping) => String(mapping.sourceId ?? mapping.hubspotId ?? mapping.hubspot_id ?? '') !== String(sourceId) &&
    mappedTargetId(mapping) === String(targetId))
}

function resolveMapping(input) {
  const mapping = input.existingMapping ?? input.mapping
  if (!mapping) return null
  const targetId = mappedTargetId(mapping) ?? idOf(mapping)
  if (!targetId || mappingConflict(input.sourceId, targetId, input.mappings ?? input.existingMappings ?? [])) {
    return result('conflict', 'target_already_mapped', targetId)
  }
  const candidate = (input.candidates ?? input.albiCandidates ?? []).find((item) => idOf(item) === targetId)
  return result('link', 'existing_mapping', targetId, ['existing_mapping'], candidate
    ? decideFieldChanges({ source: input.source ?? input.sourceContact ?? input.sourceCompany, target: candidate })
    : EMPTY_CHANGES())
}

function contactMatches(source, candidates) {
  const email = normalizeEmail(fieldValue(source, 'email', 'emailAddress'))
  const phone = phoneComparable(fieldValue(source, 'phone', 'phoneNumber'))
  const byEmail = email ? candidates.filter((candidate) => normalizeEmail(fieldValue(candidate, 'email', 'emailAddress')) === email) : []
  const byPhone = phone ? candidates.filter((candidate) => phoneComparable(fieldValue(candidate, 'phone', 'phoneNumber')) === phone) : []
  return { byEmail, byPhone }
}

function nameMatches(source, candidates) {
  const firstName = normalizeName(fieldValue(source, 'firstName', 'firstname'))
  const lastName = normalizeName(fieldValue(source, 'lastName', 'lastname'))
  if (!firstName && !lastName) return []
  return candidates.filter((candidate) => {
    const candidateFirst = normalizeName(fieldValue(candidate, 'firstName', 'firstname'))
    const candidateLast = normalizeName(fieldValue(candidate, 'lastName', 'lastname'))
    return (!firstName || candidateFirst === firstName) && (!lastName || candidateLast === lastName)
  })
}

export function decideContactMatch(input = {}) {
  const source = input.source ?? input.sourceContact ?? {}
  const candidates = input.candidates ?? input.albiCandidates ?? []
  const mapped = resolveMapping({ ...input, source, candidates })
  if (mapped) return mapped

  const { byEmail, byPhone } = contactMatches(source, candidates)
  if (byEmail.length > 1 || byPhone.length > 1) return result('conflict', 'duplicate_candidates')
  const emailTarget = byEmail[0] ? idOf(byEmail[0]) : null
  const phoneTarget = byPhone[0] ? idOf(byPhone[0]) : null
  if (emailTarget && phoneTarget && emailTarget !== phoneTarget) return result('conflict', 'email_phone_disagree')

  const candidate = byEmail[0] ?? byPhone[0]
  if (candidate) {
    const targetId = idOf(candidate)
    if (mappingConflict(input.sourceId, targetId, input.mappings ?? input.existingMappings ?? [])) {
      return result('conflict', 'target_already_mapped', targetId, byEmail[0] ? ['email'] : ['phone'])
    }
    const evidence = []
    if (byEmail.length) evidence.push('email')
    if (byPhone.length) evidence.push('phone')
    return result('link', 'unique_exact_match', targetId, evidence, decideFieldChanges({ source, target: candidate }))
  }

  if (nameMatches(source, candidates).length) return result('conflict', 'name_only_candidate')
  if (!normalizeName(fieldValue(source, 'firstName', 'firstname')) ||
      !normalizeName(fieldValue(source, 'lastName', 'lastname'))) {
    return result('conflict', 'missing_required_name')
  }
  return result('create', 'no_match')
}

function organizationEvidence(source, candidate) {
  const evidence = []
  const name = normalizeName(fieldValue(source, 'name', 'companyName'))
  const candidateName = normalizeName(fieldValue(candidate, 'name', 'companyName'))
  if (name && name === candidateName) evidence.push('name')
  const domain = normalizeDomain(fieldValue(source, 'domain', 'website', 'websiteUrl'))
  const candidateDomain = normalizeDomain(fieldValue(candidate, 'domain', 'website', 'websiteUrl'))
  if (domain && domain === candidateDomain) evidence.push('domain')
  const phone = phoneComparable(fieldValue(source, 'phone', 'phoneNumber'))
  const candidatePhone = phoneComparable(fieldValue(candidate, 'phone', 'phoneNumber'))
  if (phone && phone === candidatePhone) evidence.push('phone')
  const address = normalizeAddress(fieldValue(source, 'address', 'streetAddress'))
  const candidateAddress = normalizeAddress(fieldValue(candidate, 'address', 'streetAddress'))
  if (address && address === candidateAddress) evidence.push('address')
  return evidence
}

export function decideOrganizationMatch(input = {}) {
  const source = input.source ?? input.sourceCompany ?? {}
  const candidates = input.candidates ?? input.albiCandidates ?? []
  const mapped = resolveMapping({ ...input, source, candidates })
  if (mapped) return mapped

  const domain = normalizeDomain(fieldValue(source, 'domain', 'website', 'websiteUrl'))
  const domainMatches = domain ? candidates.filter((candidate) =>
    normalizeDomain(fieldValue(candidate, 'domain', 'website', 'websiteUrl')) === domain) : []
  if (domainMatches.length > 1) return result('conflict', 'duplicate_candidates')

  const normalizedSourceName = normalizeName(fieldValue(source, 'name', 'companyName'))
  const sameName = normalizedSourceName ? candidates.filter((candidate) =>
    normalizeName(fieldValue(candidate, 'name', 'companyName')) === normalizedSourceName) : []
  const corroborated = sameName.map((candidate) => ({
    candidate,
    evidence: organizationEvidence(source, candidate).filter((item) => item === 'phone' || item === 'address'),
  })).filter((entry) => entry.evidence.length > 0)

  if (domainMatches.length === 1) {
    const domainCandidate = domainMatches[0]
    const domainId = idOf(domainCandidate)
    if (corroborated.some((entry) => idOf(entry.candidate) !== domainId)) {
      return result('conflict', 'contradictory_evidence', null, ['domain', ...corroborated.flatMap((entry) => entry.evidence)])
    }
    const targetId = domainId
    if (mappingConflict(input.sourceId, targetId, input.mappings ?? input.existingMappings ?? [])) {
      return result('conflict', 'target_already_mapped', targetId, ['domain'])
    }
    return result('link', 'unique_exact_domain', targetId, ['domain'], decideFieldChanges({ source, target: domainCandidate }))
  }

  if (corroborated.length > 1) return result('conflict', 'duplicate_candidates')
  if (corroborated.length === 1) {
    const { candidate, evidence } = corroborated[0]
    const targetId = idOf(candidate)
    if (mappingConflict(input.sourceId, targetId, input.mappings ?? input.existingMappings ?? [])) {
      return result('conflict', 'target_already_mapped', targetId, ['name', ...evidence])
    }
    return result('link', 'name_and_corroboration', targetId, ['name', ...evidence], decideFieldChanges({ source, target: candidate }))
  }

  if (sameName.length) return result('conflict', 'name_only_candidate')
  return result('create', 'no_match')
}
