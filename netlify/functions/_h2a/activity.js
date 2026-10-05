import { HUBSPOT_ACTIVITY_TYPES } from './constants.js'
import { makeSourceMarker } from './keys.js'

const SINGULAR_TYPES = Object.freeze({ meetings: 'meeting', calls: 'call', emails: 'email', communications: 'communication', notes: 'note' })
const DIRECT_EMAIL_DIRECTIONS = new Set(['EMAIL'])
const text = value => typeof value === 'string' ? value.trim() : ''
const identity = value => value === undefined || value === null || String(value).trim() === '' ? null : String(value)

function conflict(entityType, record, fallbackReason = 'unresolved_target') {
  return {
    entityType,
    sourceId: identity(record?.id ?? record?.sourceId ?? record?.hubspot_id),
    reason: text(record?.reason) || fallbackReason,
  }
}

function safeTarget(record, entityType) {
  if (!record || record.action !== 'link' || !identity(record.targetId ?? record.albiId ?? record.albi_id)) return null
  return {
    type: entityType,
    id: String(record.targetId ?? record.albiId ?? record.albi_id),
    sourceId: identity(record.id ?? record.sourceId ?? record.hubspot_id),
  }
}

export function resolveActivityTargets(input = {}) {
  const contacts = Array.isArray(input.contacts) ? input.contacts : []
  const organizations = Array.isArray(input.organizations) ? input.organizations : []
  const targets = []
  const conflicts = []
  let hadUnsafeContact = false

  for (const contact of contacts) {
    const target = safeTarget(contact, 'contact')
    if (target) targets.push(target)
    else {
      hadUnsafeContact = true
      conflicts.push(conflict('contact', contact))
    }
  }
  if (targets.length) return { targets, conflicts }
  // Even an ambiguous associated contact prevents organization fallback: the activity
  // was contact-associated and must not be copied to a different timeline as a guess.
  if (contacts.length || hadUnsafeContact) return { targets, conflicts }

  const safeOrganizations = organizations.map(record => safeTarget(record, 'organization')).filter(Boolean)
  const unsafeOrganizations = organizations.filter(record => !safeTarget(record, 'organization'))
  conflicts.push(...unsafeOrganizations.map(record => conflict('organization', record)))
  if (safeOrganizations.length === 1 && unsafeOrganizations.length === 0) {
    targets.push(safeOrganizations[0])
  } else if (safeOrganizations.length > 1) {
    for (const record of organizations) {
      const target = safeTarget(record, 'organization')
      if (target) conflicts.push({ entityType: 'organization', sourceId: target.sourceId, reason: 'multiple_candidates' })
    }
  } else if (organizations.length === 0) {
    conflicts.push({ entityType: 'activity', sourceId: null, reason: 'missing_target' })
  }
  return { targets, conflicts }
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' }
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return ''
      return String.fromCodePoint(codePoint)
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function plainTextExcerpt(value, maxLength) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const plain = decodeEntities(value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|iframe|object|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const safe = plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return Array.from(safe).slice(0, maxLength).join('')
}

function hasDirectEmailEvidence(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    value.source === 'hubspot_crm_engagement' && value.objectType === 'emails' &&
    DIRECT_EMAIL_DIRECTIONS.has(text(value.direction).toUpperCase())
}

function validActivity(input) {
  if (!HUBSPOT_ACTIVITY_TYPES.includes(input.objectType) || !identity(input.activityId)) throw new TypeError('Unsupported HubSpot activity identity')
  if (input.objectType === 'emails') {
    if (input.isBulkMarketing === true || input.isMarketingEmail === true || input.marketingCampaignId) {
      throw new TypeError('Bulk marketing email activities are not eligible')
    }
    if (!hasDirectEmailEvidence(input.emailEvidence)) throw new TypeError('Direct CRM email evidence is required')
  }
  if (typeof input.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.occurredAt))) throw new TypeError('Activity occurrence time is required')
  if (!identity(input.activityTypeId)) throw new TypeError('A confirmed tenant activity type ID is required')
  if (!input.target || !['contact', 'organization'].includes(input.target.type) || !identity(input.target.id)) throw new TypeError('A resolved Albi target is required')
}

export function buildAlbiActivity(input = {}) {
  validActivity(input)
  const type = SINGULAR_TYPES[input.objectType]
  const maximum = Number.isInteger(input.maxExcerptLength) && input.maxExcerptLength > 0 ? Math.min(input.maxExcerptLength, 4000) : 1200
  const excerpt = plainTextExcerpt(input.body ?? input.description ?? '', maximum)
  const lines = []
  const owner = plainTextExcerpt(input.ownerName, 300)
  const subject = plainTextExcerpt(input.subject ?? input.title, 300)
  const outcome = plainTextExcerpt(input.outcome, 300)
  if (owner) lines.push(`Owner: ${owner}`)
  if (subject) lines.push(`Subject: ${subject}`)
  if (outcome) lines.push(`Outcome: ${outcome}`)
  if (excerpt) lines.push(excerpt)
  // Albi's source/sourceId behavior is not yet verified; the footer is the deterministic fallback.
  lines.push(makeSourceMarker({ objectType: type, activityId: String(input.activityId) }))
  const notes = Array.from(lines.join('\n')).slice(0, 5000).join('')
  const payload = {
    typeId: String(input.activityTypeId),
    date: input.occurredAt,
    notes,
    source: 'hubspot',
    sourceId: String(input.activityId),
  }
  if (input.target.type === 'contact') payload.contactId = String(input.target.id)
  else payload.organizationId = String(input.target.id)
  return payload
}
