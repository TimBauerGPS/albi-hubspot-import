const OBJECT_LABELS = Object.freeze({
  organizations: 'Organizations',
  contacts: 'Contacts',
  meetings: 'Meetings',
  calls: 'Calls',
  emails: 'Emails',
  communications: 'Communications',
  notes: 'Notes',
  other: 'Other records',
})

const REASON_LABELS = Object.freeze({
  planned_record_dependency: 'Depends on a record that would be created',
  missing_target: 'No matching Albi record',
  multiple_candidates: 'Multiple possible Albi matches',
  multiple_associated_organizations: 'Multiple associated organizations',
  missing_hubspot_contact: 'HubSpot contact is missing',
  missing_hubspot_company: 'HubSpot company is missing',
  contact_type_confirmation_required: 'Contact type needs confirmation',
  activity_type_confirmation_required: 'Activity type needs confirmation',
  organization_type_confirmation_required: 'Organization type needs confirmation',
  target_already_mapped: 'Albi record is already mapped',
  duplicate_candidates: 'Possible duplicate records',
  email_phone_disagree: 'Email and phone point to different records',
  unsupported_phone_evidence: 'Phone could not be used for matching',
  name_only_candidate: 'Match is based on name only',
  missing_required_name: 'A required name is missing',
  contradictory_evidence: 'Matching evidence conflicts',
  albi_organization_update_contract_unverified: 'Organization update needs verification',
  nonblank_field_difference: 'HubSpot and Albi have different values',
  albi_contact_update_contract_unverified: 'Contact update needs verification',
  albi_contact_association_contract_unverified: 'Contact organization link needs verification',
  invalid_phone_length: 'Phone number has an invalid length',
  unsupported_international_format: 'Phone format is not supported',
  extension_not_supported: 'Phone extensions are not supported',
  other_review_reason: 'Other review reason',
})

const GROUP_COPY = Object.freeze({
  simulation: {
    label: 'Expected in a dry run',
    description: 'These depend on a contact or organization that would be created first, so they are not necessarily real problems.',
  },
  attention: {
    label: 'Needs attention',
    description: 'These are match, data, or mapping questions to review before a live sync.',
  },
})

function safeEntry(entry) {
  if (!Number.isSafeInteger(entry?.count) || entry.count <= 0) return null
  const kind = entry.kind === 'simulation' ? 'simulation' : 'attention'
  const objectType = Object.hasOwn(OBJECT_LABELS, entry.objectType) ? entry.objectType : 'other'
  const reason = Object.hasOwn(REASON_LABELS, entry.reason) ? entry.reason : 'other_review_reason'
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

  const groups = ['simulation', 'attention'].flatMap(kind => {
    const items = [...grouped.values()]
      .filter(item => item.kind === kind)
      .sort((left, right) => right.count - left.count
        || OBJECT_LABELS[left.objectType].localeCompare(OBJECT_LABELS[right.objectType])
        || REASON_LABELS[left.reason].localeCompare(REASON_LABELS[right.reason]))
      .map(item => ({
        key: `${item.objectType}:${item.reason}`,
        objectLabel: OBJECT_LABELS[item.objectType],
        reasonLabel: REASON_LABELS[item.reason],
        count: item.count,
      }))
    return items.length > 0 ? [{ key: kind, ...GROUP_COPY[kind], items }] : []
  })

  return groups.length > 0 ? { count, groups } : null
}
