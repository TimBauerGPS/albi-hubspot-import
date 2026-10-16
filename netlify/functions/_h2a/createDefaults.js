// Fixed defaults for records created from a review resolution. Values are matched by label against live
// Albi options and the HubSpot owner's name; nothing here is a user-supplied provider value.
export const CREATE_TYPE_LABEL = 'Referrer'
export const CREATE_STATUS_LABEL = 'Active'

const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')

function single(options, label) {
  const matches = (Array.isArray(options) ? options : []).filter(option => providerId(option?.id) && normalize(option.label) === normalize(label))
  return matches.length === 1 ? matches[0].id : null
}

// Pure. Returns ids or the single reason creation cannot proceed.
export function resolveCreateDefaults({ relationshipTypes, relationshipStatuses, salespeople, ownerId, owners }) {
  const typeId = single(relationshipTypes, CREATE_TYPE_LABEL)
  if (!typeId) return { ok: false, reason: 'referrer_type_missing' }
  const statusId = single(relationshipStatuses, CREATE_STATUS_LABEL)
  if (!statusId) return { ok: false, reason: 'active_status_missing' }
  if (ownerId === null || ownerId === undefined || ownerId === '') return { ok: true, typeId, statusId, salespersonId: null }
  const owner = (Array.isArray(owners) ? owners : []).find(item => item?.id === ownerId)
  const name = owner ? `${owner.firstName ?? ''} ${owner.lastName ?? ''}` : ''
  if (!owner || !normalize(name)) return { ok: false, reason: 'owner_not_found' }
  const salespersonId = single(salespeople, name)
  if (!salespersonId) return { ok: false, reason: 'salesperson_not_found' }
  return { ok: true, typeId, statusId, salespersonId }
}

// Reads only. Two small HubSpot calls plus three Albi option lists.
export async function loadCreateDefaults({ hubspotRead, albiRead, objectType, sourceId }) {
  const options = await albiRead.listCreateOptions()
  const ownerId = await hubspotRead.getOwnerId(objectType === 'contacts' ? 'contacts' : 'companies', sourceId)
  const owners = ownerId ? await hubspotRead.listOwners() : []
  return resolveCreateDefaults({ ...options, ownerId, owners })
}
