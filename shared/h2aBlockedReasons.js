export const H2A_BLOCKED_REASONS = Object.freeze({
  referrer_type_missing: 'Albi has no “Referrer” relationship type. Add it in Albi, then recheck this record.',
  active_status_missing: 'Albi has no “Active” relationship status. Add it in Albi, then recheck this record.',
  owner_not_found: 'The HubSpot owner for this record could not be read. Check the owner in HubSpot, then recheck.',
  source_already_mapped: 'This HubSpot record is already linked to an Albi record, so a new one can’t be created from here.',
  multiple_organizations: 'This contact has more than one HubSpot organization. Keep one association in HubSpot, then recheck.',
  salesperson_not_found: 'The HubSpot owner’s name does not exactly match one Albi salesperson. Correct the name in Albi or HubSpot, then recheck.',
  organization_not_synced: 'This contact’s HubSpot organization is not in Albi yet. Create or link the organization first.',
  source_changed: 'This HubSpot record changed since it was last checked. Recheck this record, then create it.',
  phone_unusable: 'The HubSpot phone isn’t a US number Albi accepts (it’s international or the wrong length). Fix or clear it in HubSpot, then recheck.',
  missing_name: 'The HubSpot record has no name (a contact needs a first or last name, an organization a company name). Add it in HubSpot, then recheck.',
  default_type_unconfirmed: 'The default Albi type isn’t confirmed. Confirm the default contact and organization types in Settings, then recheck.',
  referral_sources_unavailable: 'Albi’s referral sources could not be loaded. Reload this record to try again.',
  organization_mapping_ambiguous: 'This contact’s HubSpot organization is linked to more than one Albi organization. Fix the duplicate link first.',
  organization_missing_in_hubspot: 'This contact’s HubSpot organization could not be read. Check the association in HubSpot, then recheck.',
  evidence_unavailable: 'The checks for creating this record didn’t finish in time. Reload the record or Recheck it.',
  source_unavailable: 'The HubSpot record could not be read (it may have been deleted, archived or merged). Check it in HubSpot, then recheck.',
})

export function blockedReasonCopy(code) {
  return typeof code === 'string' && Object.hasOwn(H2A_BLOCKED_REASONS, code) ? H2A_BLOCKED_REASONS[code] : null
}
