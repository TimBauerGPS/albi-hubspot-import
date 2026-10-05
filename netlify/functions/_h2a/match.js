import {
  normalizeAddress,
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from './normalize.js'

const EMPTY_CHANGES = () => ({ updates: {}, conflicts: {}, unchanged: [] })

const CONTACT_FIELDS = [
  { name: 'firstName', aliases: ['firstName', 'firstname'], normalize: normalizeName },
  { name: 'lastName', aliases: ['lastName', 'lastname'], normalize: normalizeName },
  { name: 'email', aliases: ['email', 'emailAddress'], normalize: normalizeEmail },
  { name: 'phoneNumber', aliases: ['phoneNumber', 'phone', 'phone_number'], phone: true },
  { name: 'mobileNumber', aliases: ['mobileNumber', 'mobilePhone', 'mobilephone', 'mobile'], phone: true },
  { name: 'address1', aliases: ['address1', 'address', 'streetAddress', 'street_address'], normalize: normalizeAddress },
  { name: 'address2', aliases: ['address2', 'addressLine2'], normalize: normalizeAddress },
  { name: 'city', aliases: ['city'], normalize: normalizeName },
  { name: 'state', aliases: ['state', 'stateCode'], normalize: normalizeName },
  { name: 'zipcode', aliases: ['zipcode', 'zipCode', 'zip', 'postalCode'], normalize: normalizeName },
  { name: 'country', aliases: ['country', 'countryCode'], normalize: normalizeName },
  { name: 'organizationName', aliases: ['organizationName', 'company', 'companyName'], normalize: normalizeName },
  { name: 'jobTitle', aliases: ['jobTitle', 'jobtitle', 'title'], normalize: normalizeName },
]

const ORGANIZATION_FIELDS = [
  { name: 'name', aliases: ['name', 'companyName'], normalize: normalizeName },
  { name: 'email', aliases: ['email', 'emailAddress'], normalize: normalizeEmail },
  { name: 'phoneNumber', aliases: ['phoneNumber', 'phone', 'phone_number'], phone: true },
  { name: 'address1', aliases: ['address1', 'address', 'streetAddress', 'street_address'], normalize: normalizeAddress },
  { name: 'address2', aliases: ['address2', 'addressLine2'], normalize: normalizeAddress },
  { name: 'city', aliases: ['city'], normalize: normalizeName },
  { name: 'state', aliases: ['state', 'stateCode'], normalize: normalizeName },
  { name: 'zipcode', aliases: ['zipcode', 'zipCode', 'zip', 'postalCode'], normalize: normalizeName },
  { name: 'country', aliases: ['country', 'countryCode'], normalize: normalizeName },
]

const CONTACT_PHONE_GROUPS = [
  { name: 'phoneNumber', aliases: ['phoneNumber', 'phone', 'phone_number'] },
  { name: 'mobileNumber', aliases: ['mobileNumber', 'mobilePhone', 'mobilephone', 'mobile'] },
]
function propertiesOf(record) {
  if (!record || typeof record !== 'object') return {}
  return record.properties && typeof record.properties === 'object'
    ? { ...record, ...record.properties }
    : record
}

function sourceOf(input, entityType) {
  return propertiesOf(input.source ?? input[entityType === 'contact' ? 'sourceContact' : 'sourceCompany'] ?? {})
}

function rawValue(record, aliases) {
  for (const alias of aliases) {
    const value = record?.[alias]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    return value
  }
  return null
}

function idOf(record) {
  const value = record?.id ?? record?.targetId ?? record?.albiId
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value)
}

function mappedSourceId(record) {
  const value = record?.sourceId ?? record?.hubspotId ?? record?.hubspot_id
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value)
}

function mappedTargetId(record) {
  const value = record?.targetId ?? record?.albiId ?? record?.albi_contact_id ??
    record?.albi_organization_id ?? record?.target_id
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value)
}

function identityId(input, source) {
  const value = input.sourceId ?? source?.id
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value)
}

function phoneInfo(value) {
  return normalizePhone(value)
}

function exactPhone(left, right) {
  const a = phoneInfo(left)
  const b = phoneInfo(right)
  return !a.conflictReason && !b.conflictReason && a.comparable !== null && a.comparable === b.comparable
}

function phoneSignature(value) {
  const raw = String(value).trim()
  const info = phoneInfo(raw)
  if (info.comparable !== null) return `${info.comparable};${info.extension ?? ''}`
  return raw.replace(/\D/g, '') || null
}

function phoneSetsContradict(leftValues, rightValues) {
  if (!leftValues.length || !rightValues.length) return false
  const left = new Set(leftValues.map(phoneSignature).filter(Boolean))
  const right = new Set(rightValues.map(phoneSignature).filter(Boolean))
  return ![...left].some((value) => right.has(value))
}

function canonicalFields(entityType) {
  return entityType === 'organization' ? ORGANIZATION_FIELDS : CONTACT_FIELDS
}

function fieldValues(record, fields) {
  const result = new Map()
  for (const definition of fields) {
    const value = rawValue(record, definition.aliases)
    if (value !== null) result.set(definition.name, value)
  }
  return result
}

function changesFor(entityType, source, target) {
  const changes = EMPTY_CHANGES()
  const fields = canonicalFields(entityType)
  const sourceValues = fieldValues(propertiesOf(source), fields)
  const targetValues = fieldValues(propertiesOf(target), fields)

  for (const definition of fields) {
    if (!sourceValues.has(definition.name)) continue
    const sourceValue = sourceValues.get(definition.name)
    const targetValue = targetValues.get(definition.name) ?? null
    if (definition.phone) {
      const phone = normalizePhone(sourceValue)
      if (phone.conflictReason) {
        changes.conflicts[definition.name] = {
          current: targetValue,
          proposed: sourceValue,
          reason: phone.conflictReason,
        }
        continue
      }
      if (targetValue === null) {
        changes.updates[definition.name] = phone.writable
        continue
      }
    }
    if (targetValue === null) {
      changes.updates[definition.name] = sourceValue
      continue
    }
    const normalize = definition.phone ? (value) => phoneInfo(value).comparable : definition.normalize
    const sourceNormalized = normalize ? normalize(sourceValue) : sourceValue
    const targetNormalized = normalize ? normalize(targetValue) : targetValue
    if (sourceNormalized !== null && sourceNormalized !== undefined && sourceNormalized === targetNormalized) {
      changes.unchanged.push(definition.name)
    } else {
      changes.conflicts[definition.name] = { current: targetValue, proposed: sourceValue }
    }
  }
  return changes
}

export function decideFieldChanges(input = {}) {
  const entityType = input.entityType === 'organization' ? 'organization' : 'contact'
  const source = input.source ?? input.sourceFields ?? {}
  const target = input.target ?? input.targetFields ?? {}
  return changesFor(entityType, source, target)
}

function result(action, reason, targetId = null, evidence = [], proposedChanges = EMPTY_CHANGES()) {
  return { action, targetId, reason, evidence, proposedChanges }
}

function ownershipConflict(sourceId, targetId, mappings = []) {
  return mappings.some((mapping) => {
    if (mappedTargetId(mapping) !== String(targetId)) return false
    const ownerId = mappedSourceId(mapping)
    return sourceId === null || ownerId === null || ownerId !== String(sourceId)
  })
}

function resolveMapping(input, entityType, source, candidates) {
  const mapping = input.existingMapping ?? input.mapping
  if (!mapping) return null
  const targetId = mappedTargetId(mapping) ?? idOf(mapping)
  const sourceId = identityId(input, source)
  const mappingSourceId = mappedSourceId(mapping)
  if (!targetId || sourceId === null || mappingSourceId === null || mappingSourceId !== sourceId ||
      ownershipConflict(sourceId, targetId, input.mappings ?? input.existingMappings ?? [])) {
    return result('conflict', 'target_already_mapped', targetId)
  }
  const candidate = candidates.find((item) => idOf(item) === targetId)
  return result('link', 'existing_mapping', targetId, ['existing_mapping'], candidate
    ? changesFor(entityType, source, candidate)
    : EMPTY_CHANGES())
}

function phoneValues(record, groups) {
  const fields = propertiesOf(record)
  return groups.map((group) => ({
    name: group.name,
    value: rawValue(fields, group.aliases),
  })).filter((entry) => entry.value !== null)
}

function phoneCandidateEvidence(source, candidate, groups) {
  const sourcePhones = phoneValues(source, groups)
  const candidatePhones = phoneValues(candidate, groups)
  const matches = []
  for (const left of sourcePhones) {
    for (const right of candidatePhones) {
      if (exactPhone(left.value, right.value)) matches.push(left.name === 'mobileNumber' || right.name === 'mobileNumber' ? 'mobilePhone' : 'phone')
    }
  }
  const unsupportedSameBase = sourcePhones.some((left) => candidatePhones.some((right) => {
    const a = phoneInfo(left.value)
    const b = phoneInfo(right.value)
    return a.comparable !== null && a.comparable === b.comparable && (a.conflictReason || b.conflictReason)
  }))
  return { matches: [...new Set(matches)], unsupportedSameBase, sourcePhones, candidatePhones }
}

function nameMatches(source, candidates) {
  const sourceFields = propertiesOf(source)
  const firstName = normalizeName(rawValue(sourceFields, ['firstName', 'firstname']))
  const lastName = normalizeName(rawValue(sourceFields, ['lastName', 'lastname']))
  if (!firstName && !lastName) return []
  return candidates.filter((candidate) => {
    const candidateFields = propertiesOf(candidate)
    const candidateFirst = normalizeName(rawValue(candidateFields, ['firstName', 'firstname']))
    const candidateLast = normalizeName(rawValue(candidateFields, ['lastName', 'lastname']))
    return (!firstName || candidateFirst === firstName) && (!lastName || candidateLast === lastName)
  })
}

function contactMatches(source, candidates) {
  const sourceFields = propertiesOf(source)
  const email = normalizeEmail(rawValue(sourceFields, ['email', 'emailAddress']))
  const groups = CONTACT_PHONE_GROUPS
  const byEmail = email ? candidates.filter((candidate) =>
    normalizeEmail(rawValue(propertiesOf(candidate), ['email', 'emailAddress'])) === email) : []
  const phoneResults = candidates.map((candidate) => ({ candidate, ...phoneCandidateEvidence(source, candidate, groups) }))
  const byPhone = phoneResults.filter((entry) => entry.matches.length).map((entry) => entry.candidate)
  const unsupportedPhone = phoneResults.filter((entry) => entry.unsupportedSameBase).map((entry) => entry.candidate)
  return { byEmail, byPhone, unsupportedPhone, phoneResults }
}

function matchDecisionConflict(sourceId, targetId, input) {
  return ownershipConflict(sourceId, targetId, input.mappings ?? input.existingMappings ?? [])
}

export function decideContactMatch(input = {}) {
  const source = sourceOf(input, 'contact')
  const candidates = input.candidates ?? input.albiCandidates ?? []
  const sourceId = identityId(input, source)
  const mapped = resolveMapping(input, 'contact', source, candidates)
  if (mapped) return mapped

  const { byEmail, byPhone, unsupportedPhone, phoneResults } = contactMatches(source, candidates)
  if (byEmail.length > 1 || byPhone.length > 1) return result('conflict', 'duplicate_candidates')
  const emailTarget = byEmail[0] ? idOf(byEmail[0]) : null
  const phoneTarget = byPhone[0] ? idOf(byPhone[0]) : null
  if (emailTarget && phoneTarget && emailTarget !== phoneTarget) return result('conflict', 'email_phone_disagree')
  if (unsupportedPhone.length && !byPhone.length) return result('conflict', 'unsupported_phone_evidence')

  const candidate = byEmail[0] ?? byPhone[0]
  if (candidate) {
    const targetId = idOf(candidate)
    if (matchDecisionConflict(sourceId, targetId, input)) return result('conflict', 'target_already_mapped', targetId)
    const phoneEntry = phoneResults.find((entry) => entry.candidate === candidate)
    if (phoneEntry && phoneSetsContradict(phoneEntry.sourcePhones.map((item) => item.value), phoneEntry.candidatePhones.map((item) => item.value))) {
      return result('conflict', 'email_phone_disagree', targetId)
    }
    const evidence = []
    if (byEmail.includes(candidate)) evidence.push('email')
    if (byPhone.includes(candidate)) {
      const entry = phoneResults.find((item) => item.candidate === candidate)
      evidence.push(...entry.matches)
    }
    return result('link', 'unique_exact_match', targetId, [...new Set(evidence)], changesFor('contact', source, candidate))
  }

  if (nameMatches(source, candidates).length) return result('conflict', 'name_only_candidate')
  const sourceFields = propertiesOf(source)
  if (!normalizeName(rawValue(sourceFields, ['firstName', 'firstname'])) ||
      !normalizeName(rawValue(sourceFields, ['lastName', 'lastname']))) {
    return result('conflict', 'missing_required_name')
  }
  return result('create', 'no_match')
}

function orgEvidence(source, candidate) {
  const sourceFields = propertiesOf(source)
  const candidateFields = propertiesOf(candidate)
  const evidence = []
  const sourceName = normalizeName(rawValue(sourceFields, ['name', 'companyName']))
  if (sourceName && sourceName === normalizeName(rawValue(candidateFields, ['name', 'companyName']))) evidence.push('name')
  const sourceDomain = normalizeDomain(rawValue(sourceFields, ['domain', 'website', 'websiteUrl']))
  if (sourceDomain && sourceDomain === normalizeDomain(rawValue(candidateFields, ['domain', 'website', 'websiteUrl']))) evidence.push('domain')
  const sourcePhone = rawValue(sourceFields, ['phoneNumber', 'phone', 'phone_number'])
  const candidatePhone = rawValue(candidateFields, ['phoneNumber', 'phone', 'phone_number'])
  if (sourcePhone !== null && candidatePhone !== null && exactPhone(sourcePhone, candidatePhone)) evidence.push('phone')
  const sourceAddress = normalizeAddress(rawValue(sourceFields, ['address1', 'address', 'streetAddress', 'street_address']))
  const candidateAddress = normalizeAddress(rawValue(candidateFields, ['address1', 'address', 'streetAddress', 'street_address']))
  if (sourceAddress && sourceAddress === candidateAddress) evidence.push('address')
  return evidence
}

export function decideOrganizationMatch(input = {}) {
  const source = sourceOf(input, 'organization')
  const candidates = input.candidates ?? input.albiCandidates ?? []
  const sourceId = identityId(input, source)
  const mapped = resolveMapping(input, 'organization', source, candidates)
  if (mapped) return mapped

  const sourceFields = propertiesOf(source)
  const domain = normalizeDomain(rawValue(sourceFields, ['domain', 'website', 'websiteUrl']))
  const domainMatches = domain ? candidates.filter((candidate) =>
    normalizeDomain(rawValue(propertiesOf(candidate), ['domain', 'website', 'websiteUrl'])) === domain) : []
  if (domainMatches.length > 1) return result('conflict', 'duplicate_candidates')

  const normalizedSourceName = normalizeName(rawValue(sourceFields, ['name', 'companyName']))
  const sameName = normalizedSourceName ? candidates.filter((candidate) =>
    normalizeName(rawValue(propertiesOf(candidate), ['name', 'companyName'])) === normalizedSourceName) : []
  const corroborated = sameName.map((candidate) => ({
    candidate,
    evidence: orgEvidence(source, candidate).filter((item) => item === 'phone' || item === 'address'),
  })).filter((entry) => entry.evidence.length > 0)

  if (domainMatches.length === 1) {
    const domainCandidate = domainMatches[0]
    const domainId = idOf(domainCandidate)
    if (corroborated.some((entry) => idOf(entry.candidate) !== domainId)) {
      return result('conflict', 'contradictory_evidence', null, ['domain', ...corroborated.flatMap((entry) => entry.evidence)])
    }
    if (matchDecisionConflict(sourceId, domainId, input)) return result('conflict', 'target_already_mapped', domainId, ['domain'])
    return result('link', 'unique_exact_domain', domainId, ['domain'], changesFor('organization', source, domainCandidate))
  }

  if (corroborated.length > 1) return result('conflict', 'duplicate_candidates')
  if (corroborated.length === 1) {
    const { candidate, evidence } = corroborated[0]
    const targetId = idOf(candidate)
    if (matchDecisionConflict(sourceId, targetId, input)) return result('conflict', 'target_already_mapped', targetId, ['name', ...evidence])
    return result('link', 'name_and_corroboration', targetId, ['name', ...evidence], changesFor('organization', source, candidate))
  }

  if (sameName.length) return result('conflict', 'name_only_candidate')
  if (!normalizedSourceName) return result('conflict', 'missing_required_name')
  return result('create', 'no_match')
}
