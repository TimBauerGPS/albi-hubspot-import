// HubSpot keeps one company when it merges several and lists the merged-away IDs in hs_merged_object_ids.
// Our mappings still name the merged-away IDs, so for the surviving company they are read under its own ID:
// it is the Albi organization they were mapped to. Nothing is written; the stored mappings stay as reviewed.
// Merged records mapped to different Albi organizations are left alone, so the reviewer decides.
const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const sourceOf = row => row?.hubspot_id ?? row?.sourceId
const targetOf = row => row?.albi_organization_id ?? row?.targetId

function mergedIds(company) {
  const raw = company?.properties?.hs_merged_object_ids
  if (typeof raw !== 'string') return []
  return [...new Set(raw.split(';').map(value => value.trim()).filter(id => providerId(id) && id !== company.id))]
}

function merge(rows, company, portalId) {
  if (!Array.isArray(rows) || !providerId(company?.id)) return null
  const merged = mergedIds(company)
  if (!merged.length) return null
  const here = row => String(row?.portal_id ?? row?.portalId) === String(portalId)
  if (rows.some(row => here(row) && sourceOf(row) === company.id)) return null
  const absorbed = rows.filter(row => here(row) && merged.includes(sourceOf(row)))
  return absorbed.length ? { absorbed, targets: new Set(absorbed.map(targetOf)) } : null
}

export function followOrganizationMerge(rows, company, portalId) {
  const found = merge(rows, company, portalId)
  if (!found || found.targets.size !== 1) return rows
  const [kept] = found.absorbed
  return [...rows.filter(row => !found.absorbed.includes(row)),
    { ...kept, hubspot_id: company.id, ...(Object.hasOwn(kept, 'sourceId') ? { sourceId: company.id } : {}),
      merged_from: found.absorbed.map(sourceOf) }]
}

// True when the company's merged records are mapped to more than one Albi organization.
export function organizationMergeConflict(rows, company, portalId) {
  return (merge(rows, company, portalId)?.targets.size ?? 0) > 1
}

// True only when Albi itself answers that it has no such organization (a merge in Albi deletes the one merged away).
// No by-id read, or a read that fails, is not proof.
export async function organizationGone(getOrganization, targetId) {
  if (typeof getOrganization !== 'function' || !providerId(targetId)) return false
  try { return await getOrganization(targetId) === null } catch { return false }
}

// followOrganizationMerge, ignoring merged records' links to organizations Albi no longer has, so a dead link cannot
// hold the surviving company in a conflict. Only a target missing from the list in hand (known) costs an Albi read.
// A company's own link is never ignored here: saving a different one over it is refused.
export async function followLiveOrganizationMerge(rows, company, portalId, { getOrganization, known = [] } = {}) {
  const found = merge(rows, company, portalId)
  if (!found) return rows
  const gone = new Set()
  for (const target of found.targets) {
    if (!known.some(item => item?.id === target) && await organizationGone(getOrganization, target)) gone.add(target)
  }
  const live = gone.size ? rows.filter(row => !found.absorbed.includes(row) || !gone.has(targetOf(row))) : rows
  return followOrganizationMerge(live, company, portalId)
}
