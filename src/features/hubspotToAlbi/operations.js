import { presentDryRunTotals } from './dryRunTotals.js'

const LIVE_TOTAL_LABELS = Object.freeze([
  ['created', 'Created'],
  ['updated', 'Updated'],
  ['linked', 'Linked'],
  ['delivered', 'Activities delivered'],
  ['reconciled', 'Reconciled'],
  ['skipped', 'Skipped'],
  ['conflict', 'Needs review'],
  ['failed', 'Failed'],
])

const WRITABLE_FIELDS = new Set([
  'firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone', 'phoneNumber', 'mobilephone',
  'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country',
])

export function presentRunTotals(run) {
  if (run?.mode === 'dry_run') return presentDryRunTotals(run?.totals)
  return LIVE_TOTAL_LABELS.flatMap(([key, label]) => {
    const value = run?.totals?.[key]
    return Number.isSafeInteger(value) && value > 0 ? [{ key, label, value }] : []
  })
}

export function mergeOverviewRefresh(current, refreshed) {
  if (!current) return refreshed
  if (!refreshed) return current
  const seen = new Set()
  const runs = [...(refreshed.runs ?? []), ...(current.runs ?? [])].filter(run => {
    if (!run?.id || seen.has(run.id)) return false
    seen.add(run.id)
    return true
  })
  return { ...refreshed, runs, nextCursor: current.nextCursor ?? null }
}

export function proposedConflictFields(conflict) {
  const proposed = conflict?.proposed_changes
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return []
  const names = new Set()
  for (const group of [proposed.updates, proposed.conflicts]) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    for (const key of Object.keys(group)) if (WRITABLE_FIELDS.has(key)) names.add(key)
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

function own(object, key) {
  return object && typeof object === 'object' && !Array.isArray(object) && Object.hasOwn(object, key)
}

export function proposedFieldComparisons(conflict, candidate = null) {
  const proposed = conflict?.proposed_changes ?? {}
  const updates = proposed?.updates
  const conflicts = proposed?.conflicts
  const source = conflict?.source_snapshot ?? {}
  return proposedConflictFields(conflict).map(field => {
    const detail = own(conflicts, field) && conflicts[field] && typeof conflicts[field] === 'object' && !Array.isArray(conflicts[field])
      ? conflicts[field]
      : null
    const hubspot = detail?.hubspot ?? detail?.source ?? (own(updates, field) ? updates[field] : source[field])
    const albi = detail?.albi ?? detail?.target ?? candidate?.[field]
    return { field, hubspot, albi }
  })
}

export function conflictEvidenceSummary(conflict) {
  const evidence = conflict?.match_evidence
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    for (const key of ['email', 'domain', 'phone', 'name']) {
      const value = evidence[key]
      if (typeof value === 'string' || Number.isFinite(value)) {
        return `${key[0].toUpperCase()}${key.slice(1)}: ${value}`
      }
    }
  }
  const count = Array.isArray(conflict?.candidate_snapshots) ? conflict.candidate_snapshots.length : 0
  return count > 0 ? `${count} Albi candidate${count === 1 ? '' : 's'}` : 'No safe automatic match'
}

export function buildConflictResolution(conflict, action, options = {}) {
  if (!conflict?.id || !conflict?.updated_at) throw new TypeError('A current conflict version is required.')
  const payload = { conflictId: conflict.id, expectedUpdatedAt: conflict.updated_at, action }
  if (action === 'link_existing') {
    if (typeof options.targetId !== 'string' || !options.targetId.trim()) throw new TypeError('Select an Albi target.')
    payload.targetId = options.targetId.trim()
    if (options.approveManyToOne === true) payload.approveManyToOne = true
  } else if (action === 'approve_fields' || action === 'retain_albi') {
    const displayed = new Set(proposedConflictFields(conflict))
    if (!Array.isArray(options.fields) || options.fields.length === 0 ||
      options.fields.some(field => !displayed.has(field)) || new Set(options.fields).size !== options.fields.length) {
      throw new TypeError('Select at least one displayed field.')
    }
    payload.fields = [...options.fields]
  } else if (!['create_new', 'skip_item'].includes(action)) {
    throw new TypeError('Unsupported conflict action.')
  }
  return payload
}
