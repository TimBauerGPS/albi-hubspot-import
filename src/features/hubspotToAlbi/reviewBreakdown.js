import { getH2AReviewReason } from '../../../shared/h2aReviewReasons.js'

const OBJECT_LABELS = Object.freeze({
  organizations: 'Organizations',
  companies: 'Organizations',
  contacts: 'Contacts',
  meetings: 'Meetings',
  calls: 'Calls',
  emails: 'Emails',
  communications: 'Communications',
  notes: 'Notes',
  other: 'Other records',
})

const GROUP_COPY = Object.freeze({
  record: {
    label: 'Underlying records to review',
    description: 'These contacts and organizations need a matching, data, or mapping decision.',
  },
  activity: {
    label: 'Activities blocked by those records',
    description: 'These activities are blocked by a related record or another prerequisite that needs review.',
  },
  simulation: {
    label: 'Expected in a dry run',
    description: 'These depend on a contact or organization that would be created first, so they are not necessarily real problems.',
  },
})

function safeEntry(entry) {
  if (!Number.isSafeInteger(entry?.count) || entry.count <= 0) return null
  const kind = entry.kind === 'record' || entry.kind === 'simulation' ? entry.kind : 'activity'
  const objectType = Object.hasOwn(OBJECT_LABELS, entry.objectType) ? entry.objectType : 'other'
  const reason = getH2AReviewReason(entry.reason).code
  return { kind, objectType, reason, count: entry.count }
}

export function presentReviewBreakdown(run) {
  const count = run?.totals?.requires_review
  if (run?.mode !== 'dry_run' || !Number.isSafeInteger(run?.sampleLimitPerType) || run.sampleLimitPerType <= 0
    || !Number.isSafeInteger(count) || count <= 0 || !Array.isArray(run?.reviewBreakdown)) return null

  const grouped = new Map()
  for (const rawEntry of run.reviewBreakdown) {
    const entry = safeEntry(rawEntry)
    if (!entry) continue
    const key = `${entry.kind}:${entry.objectType}:${entry.reason}`
    const previous = grouped.get(key)
    const nextCount = (previous?.count ?? 0) + entry.count
    if (!Number.isSafeInteger(nextCount)) continue
    grouped.set(key, { ...entry, count: nextCount })
  }

  const groups = ['record', 'activity', 'simulation'].flatMap(kind => {
    const items = [...grouped.values()]
      .filter(item => item.kind === kind)
      .sort((left, right) => right.count - left.count
        || OBJECT_LABELS[left.objectType].localeCompare(OBJECT_LABELS[right.objectType])
        || getH2AReviewReason(left.reason).label.localeCompare(getH2AReviewReason(right.reason).label))
      .map(item => ({
        key: `${item.objectType}:${item.reason}`,
        objectLabel: OBJECT_LABELS[item.objectType],
        reasonLabel: getH2AReviewReason(item.reason).label,
        count: item.count,
      }))
    const total = items.reduce((sum, item) => sum + item.count, 0)
    return items.length > 0 ? [{ key: kind, ...GROUP_COPY[kind], total, items }] : []
  })

  return groups.length > 0 ? { count, groups } : null
}
