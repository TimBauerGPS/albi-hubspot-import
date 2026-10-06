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
