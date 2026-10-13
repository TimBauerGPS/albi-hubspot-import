const ALBI_TYPES = Object.freeze({ contacts: 'Contact', companies: 'Organization', organizations: 'Organization' })
const HUBSPOT_TYPES = Object.freeze({ contacts: '0-1', companies: '0-2', organizations: '0-2' })

function recordId(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null
  const id = String(value)
  return /^[1-9]\d*$/.test(id) ? encodeURIComponent(id) : null
}

export function buildAlbiRecordUrl(objectType, id) {
  const record = recordId(id)
  if (!record || !Object.hasOwn(ALBI_TYPES, objectType)) return null
  return `https://app.albiware.com/Relationships/${encodeURIComponent(ALBI_TYPES[objectType])}/${record}`
}

export function buildHubSpotRecordUrl(portalId, objectType, id) {
  const portal = recordId(portalId), record = recordId(id)
  if (!portal || !record || !Object.hasOwn(HUBSPOT_TYPES, objectType)) return null
  return `https://app.hubspot.com/contacts/${portal}/record/${encodeURIComponent(HUBSPOT_TYPES[objectType])}/${record}`
}
