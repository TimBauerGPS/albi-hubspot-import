const GENERIC_GUIDANCE = 'Review the HubSpot source and Albi record, then correct the source data or identity evidence before running a new sample.'

const guidance = (label, text = GENERIC_GUIDANCE) => Object.freeze({ label, guidance: text })

export const SAMPLE_REVIEW_GUIDANCE = Object.freeze({
  existing_mapping: guidance('Already mapped', 'Confirm the existing mapping points to the intended Albi record.'),
  unique_exact_match: guidance('Exact match found', 'Confirm the exact match and correct stale source or mapping data if needed.'),
  unique_exact_domain: guidance('Organization domain match', 'Confirm the organization domain belongs to the intended Albi organization.'),
  name_and_corroboration: guidance('Name and supporting evidence', 'Check the supporting identity evidence and correct any inaccurate source values.'),
  no_match: guidance('No match found', 'Confirm whether the record is in scope and whether its identifying values are complete.'),
  target_already_mapped: guidance('Albi record already mapped', 'Review the existing mapping and correct duplicate or stale mappings.'),
  duplicate_candidates: guidance('Possible duplicate records', 'Resolve duplicate Albi records so the intended identity is clear.'),
  email_phone_disagree: guidance('Email and phone disagree', 'Determine which email or phone value is incorrect and make the identities agree.'),
  unsupported_phone_evidence: guidance('Phone could not be used', 'Replace the phone with a supported direct number or remove unusable phone evidence.'),
  name_only_candidate: guidance('Match is based on name only', 'Add reliable email, supported phone, or organization domain evidence; avoid creating a duplicate.'),
  missing_required_name: guidance('Required name is missing', 'Restore the required HubSpot name fields or remove the record from the intended sync scope.'),
  contradictory_evidence: guidance('Matching evidence conflicts', 'Correct the conflicting identity values in HubSpot or Albi.'),
  albi_organization_update_contract_unverified: guidance('Organization update needs verification', 'Correct the existing Albi organization or HubSpot source directly.'),
  albi_contact_update_contract_unverified: guidance('Contact update needs verification', 'Correct the existing Albi contact or HubSpot source directly.'),
  nonblank_field_difference: guidance('Fields have different values', 'Choose the correct source of truth and make the conflicting values agree.'),
  organization_fields_require_review: guidance('Organization fields need review', 'Correct the organization values directly in HubSpot or Albi.'),
  contact_fields_require_review: guidance('Contact fields need review', 'Correct the contact values directly in HubSpot or Albi.'),
  albi_contact_association_contract_unverified: guidance('Contact organization link needs verification', 'Correct the contact-organization relationship directly in Albi or its HubSpot association.'),
  association_contract_unverified: guidance('Contact organization link needs review', 'Correct the contact-organization relationship directly in Albi or its HubSpot association.'),
  organization_type_confirmation_required: guidance('Organization type needs confirmation', 'Confirm the intended organization type in the H2A settings.'),
  contact_type_confirmation_required: guidance('Contact type needs confirmation', 'Confirm the intended contact type in the H2A settings.'),
  activity_type_confirmation_required: guidance('Activity type needs confirmation', 'Confirm the intended activity type in the H2A settings.'),
  unsupported_international_format: guidance('Phone format is not supported', 'Replace the value with a supported direct phone format or remove unusable identity evidence.'),
  invalid_phone_length: guidance('Phone number has an invalid length', 'Replace the value with a supported direct phone format or remove unusable identity evidence.'),
  extension_not_supported: guidance('Phone extensions are not supported', 'Replace the value with a supported direct phone format or remove unusable identity evidence.'),
  organization_unresolved: guidance('Organization needs review', 'Correct the HubSpot organization association or resolve the organization identity first.'),
  multiple_associated_organizations: guidance('Multiple associated organizations', 'Correct HubSpot company associations so the contact has one intended organization context.'),
  missing_hubspot_company: guidance('HubSpot company is missing', 'Restore the required HubSpot company fields or remove the record from the intended sync scope.'),
  missing_hubspot_contact: guidance('HubSpot contact is missing', 'Restore the required HubSpot contact fields or remove the record from the intended sync scope.'),
  multiple_candidates: guidance('Multiple possible Albi matches', 'Resolve duplicates until one intended Albi record remains.'),
  missing_target: guidance('No matching Albi record', 'Confirm the record is in scope and its identifying values are complete.'),
  unresolved_target: guidance('Albi match needs review', 'Correct the identity evidence so the intended Albi record is clear.'),
  dry_run_preview: guidance('Expected in a dry run', 'This record depends on another record that would be created first; review it after correcting any upstream issue.'),
  reviewer_skipped: guidance('Review was skipped', 'Check the source and Albi values, then run a new sample.'),
  not_verified_direct_crm_email: guidance('Email needs verification', 'Verify the direct CRM email value and correct it at the source if needed.'),
  delivery_reconciled: guidance('Delivery was reconciled', 'Review the current source and Albi values for any remaining identity issue.'),
  already_delivered: guidance('Already delivered', 'Review the current source and Albi values for any remaining identity issue.'),
  delivered: guidance('Delivered', 'Review the current source and Albi values for any remaining identity issue.'),
  reconciled: guidance('Reconciled', 'Review the current source and Albi values for any remaining identity issue.'),
  stale_attempt: guidance('Previous attempt is stale', 'Refresh the sample and review the latest source and Albi values.'),
  retry_scheduled: guidance('Retry scheduled', 'Refresh the sample and review the latest source and Albi values.'),
  failed: guidance('Previous attempt failed', 'Refresh the sample and review the latest source and Albi values.'),
  still_needs_review: guidance('Still needs review'),
  safe_to_link: guidance('Safe to link'),
  safe_to_create: guidance('Safe to create'),
  source_missing: guidance('Source record is missing', 'Confirm the record was intentionally removed from HubSpot and run a new sample.'),
  recheck_failed: guidance('Recheck failed', 'Try the recheck again after confirming the source and Albi records are available.'),
  other_review_reason: guidance('Other review reason'),
  ...Object.fromEntries(['auth', 'permission', 'validation', 'permanent', 'transient', 'rate_limit', 'error'].flatMap(category =>
    ['pagination_loop', 'malformed_response', 'application_error', 'unsupported_contract', 'timeout', 'network', 'operation_failed']
      .map(code => [`${category}:${code}`, guidance('Recheck details')])),
  ),
})

export const SAMPLE_REVIEW_REASON_OPTIONS = Object.freeze(Object.entries(SAMPLE_REVIEW_GUIDANCE).filter(([value]) => value !== 'other_review_reason').map(([value, copy]) =>
  Object.freeze({ value, label: copy.label })))

const SOURCE_FIELDS = Object.freeze([
  ['id', 'ID'], ['fullName', 'Full name'], ['firstName', 'First name'], ['lastName', 'Last name'], ['name', 'Name'],
  ['email', 'Email'], ['phoneNumber', 'Phone'], ['mobileNumber', 'Mobile'], ['organizationId', 'Organization ID'],
  ['organizationName', 'Organization'], ['domain', 'Domain'], ['address1', 'Address'], ['address2', 'Address line 2'],
  ['city', 'City'], ['state', 'State / region'], ['zipcode', 'Postal code'], ['country', 'Country'],
])
const COMPARISON_FIELDS = Object.freeze([
  ['id', 'ID'], ['fullName', 'Full name'], ['name', 'Name'], ['firstName', 'First name'], ['lastName', 'Last name'],
  ['email', 'Email'], ['phoneNumber', 'Phone'], ['mobileNumber', 'Mobile'], ['organizationId', 'Organization ID'],
  ['organizationName', 'Organization'], ['domain', 'Domain'], ['address1', 'Address'], ['address2', 'Address line 2'],
  ['city', 'City'], ['state', 'State / region'], ['zipcode', 'Postal code'], ['country', 'Country'],
])
const STATUSES = new Set(['needs_review', 'cleared', 'no_longer_in_scope'])
const EVIDENCE = new Set(['existing_mapping', 'email', 'phone', 'mobilePhone', 'name', 'domain', 'address'])
const CHANGE_FIELDS = new Set(SOURCE_FIELDS.map(([key]) => key))

function safeRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function safeScalar(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return null
  const safe = String(value).trim().slice(0, 500)
  return safe || null
}

function safeSnapshot(snapshot) {
  const input = safeRecord(snapshot)
  return Object.fromEntries(SOURCE_FIELDS.flatMap(([key]) => {
    const value = safeScalar(input[key])
    return value === null ? [] : [[key, value]]
  }))
}

function comparisons(hubspot, albi) {
  return COMPARISON_FIELDS.map(([key, label]) => ({
    key, label, hubspot: hubspot[key] ?? 'Not provided', albi: albi[key] ?? 'Not provided',
  }))
}

function safeChanges(value) {
  const changes = safeRecord(value)
  const conflicts = safeRecord(changes.conflicts)
  return Object.keys(conflicts).filter(key => CHANGE_FIELDS.has(key)).sort().map(key => {
    const conflict = safeRecord(conflicts[key])
    return { key, label: SOURCE_FIELDS.find(([field]) => field === key)?.[1] ?? key,
      hubspot: safeScalar(conflict.proposed) ?? 'Not provided', albi: safeScalar(conflict.current) ?? 'Not provided' }
  })
}

export function presentSampleReviewItem(item) {
  const input = safeRecord(item)
  const reason = Object.hasOwn(SAMPLE_REVIEW_GUIDANCE, input.reason) ? input.reason : 'other_review_reason'
  const copy = SAMPLE_REVIEW_GUIDANCE[reason]
  const source = safeSnapshot(input.sourceSnapshot)
  const rawCandidates = Array.isArray(input.candidateSnapshots) ? input.candidateSnapshots : []
  const candidates = rawCandidates.slice(0, 10).map(candidate => {
    const snapshot = safeSnapshot(candidate)
    return { id: snapshot.id ?? 'Not provided', snapshot, comparisons: comparisons(source, snapshot) }
  })
  const displayName = source.fullName ?? [source.firstName, source.lastName].filter(Boolean).join(' ') ?? source.name ?? ''
  return {
    id: safeScalar(input.id), runId: safeScalar(input.runId), objectType: ['contacts', 'companies'].includes(input.objectType) ? input.objectType : 'contacts',
    sourceId: safeScalar(input.sourceId) ?? source.id ?? 'Not provided', reason,
    reasonLabel: copy.label, guidance: copy.guidance,
    status: STATUSES.has(input.status) ? input.status : 'needs_review',
    displayName: displayName || source.name || 'Not provided', source,
    candidates, matchEvidence: Array.isArray(input.matchEvidence) ? [...new Set(input.matchEvidence.filter(value => EVIDENCE.has(value)))] : [],
    proposedChanges: safeChanges(input.proposedChanges),
    lastRecheckedAt: safeScalar(input.lastRecheckedAt), createdAt: safeScalar(input.createdAt), updatedAt: safeScalar(input.updatedAt),
  }
}

export function presentSampleReviewProgress(progress) {
  const value = safeRecord(progress)
  const count = number => Number.isSafeInteger(number) && number >= 0 ? number : 0
  return [
    { key: 'needsReview', label: 'Needs review', value: count(value.needsReview) },
    { key: 'cleared', label: 'Cleared', value: count(value.cleared) },
    { key: 'noLongerInScope', label: 'No longer in scope', value: count(value.noLongerInScope) },
  ]
}
