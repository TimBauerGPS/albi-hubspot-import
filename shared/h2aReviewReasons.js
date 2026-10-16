const GENERIC_GUIDANCE = 'Review the HubSpot source and Albi record, then correct the source data or identity evidence before running a new sample.'

export const H2A_REVIEW_ERROR_CATEGORIES = Object.freeze(['auth', 'permission', 'validation', 'permanent', 'transient', 'rate_limit', 'error'])
export const H2A_REVIEW_ERROR_CODES = Object.freeze(['pagination_loop', 'malformed_response', 'application_error', 'unsupported_contract', 'timeout', 'network', 'operation_failed'])

const reason = (code, label, category, actions = [], guidance = GENERIC_GUIDANCE) =>
  Object.freeze({ code, label, category, actions: Object.freeze(actions), guidance })

export const H2A_REVIEW_REASON_CATALOG = Object.freeze({
  existing_mapping: reason("existing_mapping", "Already mapped", "identity", ["link_existing","create_albi","force_create_albi"], "Confirm the existing mapping points to the intended Albi record."),
  unique_exact_match: reason("unique_exact_match", "Exact match found", "identity", ["link_existing","create_albi","force_create_albi"], "Confirm the exact match and correct stale source or mapping data if needed."),
  unique_exact_domain: reason("unique_exact_domain", "Organization domain match", "identity", ["link_existing","create_albi","force_create_albi"], "Confirm the organization domain belongs to the intended Albi organization."),
  name_and_corroboration: reason("name_and_corroboration", "Name and supporting evidence", "identity", ["link_existing","create_albi","force_create_albi"], "Check the supporting identity evidence and correct any inaccurate source values."),
  no_match: reason("no_match", "No match found", "identity", ["link_existing","create_albi","force_create_albi"], "Confirm whether the record is in scope and whether its identifying values are complete."),
  target_already_mapped: reason("target_already_mapped", "Albi record is already mapped", "identity", ["link_existing","create_albi","force_create_albi"], "Review the existing mapping and correct duplicate or stale mappings."),
  duplicate_candidates: reason("duplicate_candidates", "Possible duplicate records", "identity", ["link_existing","create_albi","force_create_albi"], "Resolve duplicate Albi records so the intended identity is clear."),
  email_phone_disagree: reason("email_phone_disagree", "Email and phone point to different records", "identity", ["link_existing","create_albi","force_create_albi"], "Determine which email or phone value is incorrect and make the identities agree."),
  unsupported_phone_evidence: reason("unsupported_phone_evidence", "Phone could not be used for matching", "identity", ["link_existing","create_albi","force_create_albi"], "Replace the phone with a supported direct number or remove unusable phone evidence."),
  name_only_candidate: reason("name_only_candidate", "Match is based on name only", "identity", ["link_existing","create_albi","force_create_albi"], "Add reliable email, supported phone, or organization domain evidence; avoid creating a duplicate."),
  missing_required_name: reason("missing_required_name", "A required name is missing", "identity", ["link_existing","create_albi","force_create_albi"], "Restore the required HubSpot name fields or remove the record from the intended sync scope."),
  contradictory_evidence: reason("contradictory_evidence", "Matching evidence conflicts", "identity", ["link_existing","create_albi","force_create_albi"], "Correct the conflicting identity values in HubSpot or Albi."),
  albi_organization_update_contract_unverified: reason("albi_organization_update_contract_unverified", "Organization update needs verification", "field", ["resolve_fields"], "Choose the correct source of truth for supported differences; Albi corrections remain manual."),
  albi_contact_update_contract_unverified: reason("albi_contact_update_contract_unverified", "Contact update needs verification", "field", ["resolve_fields"], "Choose the correct source of truth for supported differences; Albi corrections remain manual."),
  nonblank_field_difference: reason("nonblank_field_difference", "HubSpot and Albi have different values", "field", ["resolve_fields"], "Choose the correct source of truth and make the conflicting values agree."),
  organization_fields_require_review: reason("organization_fields_require_review", "Related organization fields need review", "field", ["resolve_fields"], "Correct the organization values directly in HubSpot or Albi."),
  contact_fields_require_review: reason("contact_fields_require_review", "Related contact fields need review", "field", ["resolve_fields"], "Correct the contact values directly in HubSpot or Albi."),
  albi_contact_association_contract_unverified: reason("albi_contact_association_contract_unverified", "Contact organization link needs verification", "association", ["choose_organization"], "Choose the intended organization context; Albi reassociation remains manual."),
  association_contract_unverified: reason("association_contract_unverified", "Related contact-organization link needs review", "association", ["choose_organization"], "Choose the intended organization context; Albi reassociation remains manual."),
  organization_type_confirmation_required: reason("organization_type_confirmation_required", "Organization type needs confirmation", "configuration", [], "Confirm the intended organization type in the H2A settings."),
  contact_type_confirmation_required: reason("contact_type_confirmation_required", "Contact type needs confirmation", "configuration", [], "Confirm the intended contact type in the H2A settings."),
  activity_type_confirmation_required: reason("activity_type_confirmation_required", "Activity type needs confirmation", "configuration", [], "Confirm the intended activity type in the H2A settings."),
  unsupported_international_format: reason("unsupported_international_format", "Phone format is not supported", "identity", ["link_existing","create_albi","force_create_albi"], "Replace the value with a supported direct phone format or remove unusable identity evidence."),
  invalid_phone_length: reason("invalid_phone_length", "Phone number has an invalid length", "identity", ["link_existing","create_albi","force_create_albi"], "Replace the value with a supported direct phone format or remove unusable identity evidence."),
  extension_not_supported: reason("extension_not_supported", "Phone extensions are not supported", "identity", ["link_existing","create_albi","force_create_albi"], "Replace the value with a supported direct phone format or remove unusable identity evidence."),
  organization_unresolved: reason("organization_unresolved", "Organization needs review", "association", ["choose_organization"], "Correct the HubSpot organization association or resolve the organization identity first."),
  multiple_associated_organizations: reason("multiple_associated_organizations", "Multiple associated organizations", "association", ["choose_organization"], "Correct HubSpot company associations so the contact has one intended organization context."),
  missing_hubspot_company: reason("missing_hubspot_company", "HubSpot company is missing", "association", ["choose_organization"], "Restore the required HubSpot company fields or remove the record from the intended sync scope."),
  missing_hubspot_contact: reason("missing_hubspot_contact", "HubSpot contact is missing", "provider", [], "Restore the required HubSpot contact fields or remove the record from the intended sync scope."),
  multiple_candidates: reason("multiple_candidates", "Multiple possible Albi matches", "identity", ["link_existing","create_albi","force_create_albi"], "Resolve duplicates until one intended Albi record remains."),
  missing_target: reason("missing_target", "No matching Albi record", "identity", ["link_existing","create_albi","force_create_albi"], "Confirm the record is in scope and its identifying values are complete."),
  unresolved_target: reason("unresolved_target", "Albi match needs review", "identity", ["link_existing","create_albi","force_create_albi"], "Correct the identity evidence so the intended Albi record is clear."),
  dry_run_preview: reason("dry_run_preview", "Expected in a dry run", "preview", [], "This record depends on another record that would be created first; review it after correcting any upstream issue."),
  reviewer_skipped: reason("reviewer_skipped", "Review was skipped", "outcome", [], "Check the source and Albi values, then run a new sample."),
  not_verified_direct_crm_email: reason("not_verified_direct_crm_email", "Email needs verification", "provider", [], "Verify the direct CRM email value and correct it at the source if needed."),
  delivery_reconciled: reason("delivery_reconciled", "Delivery was reconciled", "outcome", [], "Review the current source and Albi values for any remaining identity issue."),
  already_delivered: reason("already_delivered", "Already delivered", "outcome", [], "Review the current source and Albi values for any remaining identity issue."),
  delivered: reason("delivered", "Delivered", "outcome", [], "Review the current source and Albi values for any remaining identity issue."),
  reconciled: reason("reconciled", "Reconciled", "outcome", [], "Review the current source and Albi values for any remaining identity issue."),
  forced_created: reason("forced_created", "Created as a separate Albi record", "outcome", [], "The reviewed Albi candidates were intentionally ignored and the new mapping was audited."),
  stale_attempt: reason("stale_attempt", "Previous attempt is stale", "outcome", [], "Refresh the sample and review the latest source and Albi values."),
  retry_scheduled: reason("retry_scheduled", "Retry scheduled", "outcome", [], "Refresh the sample and review the latest source and Albi values."),
  failed: reason("failed", "Previous attempt failed", "outcome", [], "Refresh the sample and review the latest source and Albi values."),
  still_needs_review: reason("still_needs_review", "Still needs review", "outcome", [], "Review the HubSpot source and Albi record, then correct the source data or identity evidence before running a new sample."),
  safe_to_link: reason("safe_to_link", "Safe to link", "outcome", [], "Review the HubSpot source and Albi record, then correct the source data or identity evidence before running a new sample."),
  safe_to_create: reason("safe_to_create", "Safe to create", "outcome", [], "Review the HubSpot source and Albi record, then correct the source data or identity evidence before running a new sample."),
  source_missing: reason("source_missing", "Source record is missing", "outcome", [], "Confirm the record was intentionally removed from HubSpot and run a new sample."),
  recheck_failed: reason("recheck_failed", "Recheck failed", "outcome", [], "Try the recheck again after confirming the source and Albi records are available."),
  ...Object.fromEntries(H2A_REVIEW_ERROR_CATEGORIES.flatMap(category => H2A_REVIEW_ERROR_CODES.map(code => {
    const value = `${category}:${code}`
    return [value, reason(value, 'Recheck details', 'provider')]
  }))),
})

const OTHER_REASON = reason('other_review_reason', 'Other review reason', 'provider')
// Dry-run dependency grouping is presentation metadata, not a stored review classification.
const PLANNED_DEPENDENCY = reason('planned_record_dependency', 'Depends on a record that would be created', 'preview', [],
  'This record depends on another record that would be created first; review it after correcting any upstream issue.')

export function getH2AReviewReason(code) {
  if (code === 'planned_record_dependency') return PLANNED_DEPENDENCY
  return Object.hasOwn(H2A_REVIEW_REASON_CATALOG, code) ? H2A_REVIEW_REASON_CATALOG[code] : OTHER_REASON
}

// Contact field differences can also correct which organization the contact belongs to.
export function getH2AReviewActions(code, objectType) {
  const entry = getH2AReviewReason(code)
  return objectType === 'contacts' && entry.category === 'field' && !entry.actions.includes('choose_organization')
    ? Object.freeze([...entry.actions, 'choose_organization']) : entry.actions
}

export function listH2AReviewReasonOptions(codes) {
  const values = codes === undefined ? Object.keys(H2A_REVIEW_REASON_CATALOG) : Array.isArray(codes) ? codes : []
  return Object.freeze([...new Set(values)].filter(code => Object.hasOwn(H2A_REVIEW_REASON_CATALOG, code))
    .map(code => Object.freeze({ value: code, label: getH2AReviewReason(code).label })))
}

export const H2A_REVIEW_GUIDANCE = Object.freeze({ ...H2A_REVIEW_REASON_CATALOG, other_review_reason: OTHER_REASON })
