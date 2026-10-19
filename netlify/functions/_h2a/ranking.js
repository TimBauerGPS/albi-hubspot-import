import { exactPhone, mappedSourceId, mappedTargetId } from './match.js'
import { normalizeAddress, normalizeDomain, normalizeEmail, normalizeName } from './normalize.js'

// Presentation-only ranking of review candidates. It never influences automatic linking.
const STRENGTH_ORDER = { Strong: 0, Likely: 1, Weak: 2 }
const present = value => value !== undefined && value !== null && String(value).trim() !== ''
const same = (normalize, a, b) => {
  const left = present(a) ? normalize(a) : null
  const right = present(b) ? normalize(b) : null
  return left !== null && left === right
}
const samePhone = (a, b) => present(a) && present(b) && exactPhone(a, b)
const isOrganization = type => ['organization', 'organizations', 'company', 'companies'].includes(type)

function fullName(record) {
  const parts = [record.firstName, record.lastName].filter(present)
  return parts.length === 2 ? parts.join(' ') : (record.fullName ?? record.name ?? null)
}

function sourceEmails(source) {
  const primary = present(source.email) ? [normalizeEmail(source.email)] : []
  const others = present(source.additionalEmails) ? String(source.additionalEmails).split(';').map(normalizeEmail).filter(Boolean) : []
  return { primary: primary[0] ?? null, others }
}

function linkedElsewhereCount(candidateId, mappings, sourceId, portalId) {
  return (Array.isArray(mappings) ? mappings : []).filter(mapping => {
    if (mappedTargetId(mapping) !== String(candidateId)) return false
    const mappingPortal = mapping.portal_id ?? mapping.portalId
    if (portalId != null && mappingPortal != null && String(mappingPortal) !== String(portalId)) return false
    const owner = mappedSourceId(mapping)
    return owner === null || sourceId == null || owner !== String(sourceId)
  }).length
}

function rankOne({ candidate, source, organization, mappings, sourceId, portalId }) {
  const reasons = []
  const warnings = []
  const emails = sourceEmails(source)
  const candidateEmail = present(candidate.email) ? normalizeEmail(candidate.email) : null
  const emailMatch = candidateEmail !== null && candidateEmail === emails.primary
  const otherEmailMatch = candidateEmail !== null && emails.others.includes(candidateEmail)
  if (emailMatch) reasons.push('same_email')
  if (otherEmailMatch) reasons.push('same_other_email')

  if (organization) {
    if (same(normalizeName, source.name, candidate.name)) reasons.push('same_name')
  } else {
    if (samePhone(source.phoneNumber, candidate.phoneNumber) || samePhone(source.mobileNumber, candidate.mobileNumber)) reasons.push('same_phone')
    if (samePhone(source.phoneNumber, candidate.mobileNumber) || samePhone(source.mobileNumber, candidate.phoneNumber)) reasons.push('phone_matches_mobile')
    if (same(normalizeName, fullName(source), fullName(candidate))) reasons.push('same_name')
    else if (same(normalizeName, source.firstName, candidate.firstName)) reasons.push('same_first_name')
    if (same(normalizeName, source.organizationName, candidate.organizationName)) reasons.push('same_organization')
  }
  if (organization) {
    if (samePhone(source.phoneNumber, candidate.phoneNumber)) reasons.push('same_phone')
    if (same(normalizeDomain, source.domain, candidate.domain)) reasons.push('same_domain')
  }
  if (same(normalizeAddress, source.address1, candidate.address1) &&
    (!present(source.zipcode) || !present(candidate.zipcode) || same(normalizeName, source.zipcode, candidate.zipcode))) reasons.push('same_address')

  const differentEmail = (emails.primary !== null || emails.others.length > 0) && candidateEmail !== null &&
    present(source.email) && !emailMatch && !otherEmailMatch
  if (differentEmail) warnings.push('different_email')
  const linkedElsewhere = linkedElsewhereCount(candidate.id, mappings, sourceId, portalId)
  if (linkedElsewhere > 0) warnings.push('already_linked_elsewhere')

  const has = reason => reasons.includes(reason)
  let strength = 'Weak'
  if ((has('same_email') || has('same_other_email') || organization && has('same_domain')) && !differentEmail) strength = 'Strong'
  else if (has('same_phone') || has('phone_matches_mobile') || has('same_name') && has('same_organization')) strength = 'Likely'
  return { id: String(candidate.id), matchReasons: reasons, warnings, strength, linkedElsewhere }
}

export function rankReviewCandidates({ objectType, source, candidates, mappings, portalId, sourceId } = {}) {
  const organization = isOrganization(objectType)
  const safeSource = source && typeof source === 'object' ? source : {}
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate && present(candidate.id))
    .map(candidate => rankOne({ candidate, source: safeSource, organization, mappings, sourceId, portalId }))
    .sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] ||
      b.matchReasons.length - a.matchReasons.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const strong = ranked.filter(candidate => candidate.strength === 'Strong')
  const suggested = strong.length === 1 && strong[0].linkedElsewhere === 0 ? strong[0].id : null
  return { candidates: ranked, suggestedCandidateId: suggested }
}
