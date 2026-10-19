export const H2A_BLOCKED_REASONS = Object.freeze({
  referrer_type_missing: 'Albi has no “Referrer” relationship type. Add it in Albi, then recheck this record.',
  active_status_missing: 'Albi has no “Active” relationship status. Add it in Albi, then recheck this record.',
  owner_not_found: 'The HubSpot owner for this record could not be read. Check the owner in HubSpot, then recheck.',
  source_already_mapped: 'This HubSpot record is already linked to an Albi record, so a new one can’t be created from here.',
  multiple_organizations: 'This contact has more than one HubSpot organization. Keep one association in HubSpot, then recheck.',
  salesperson_not_found: 'The HubSpot owner’s name does not exactly match one Albi salesperson. Correct the name in Albi or HubSpot, then recheck.',
  organization_not_synced: 'This contact’s HubSpot organization is not in Albi yet. Create or link the organization first.',
})

export function blockedReasonCopy(code) {
  return typeof code === 'string' && Object.hasOwn(H2A_BLOCKED_REASONS, code) ? H2A_BLOCKED_REASONS[code] : null
}
