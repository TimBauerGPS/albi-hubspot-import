export const H2A_STATES = Object.freeze(['disabled', 'ready', 'dry_run', 'live'])
export const HUBSPOT_ACTIVITY_TYPES = Object.freeze(['meetings', 'calls', 'emails', 'communications', 'notes'])

export const DRY_RUN_PROPOSED_ACTION_TOTALS = Object.freeze({
  create_organization: 'would_create_organizations',
  create_contact: 'would_create_contacts',
  link_organization: 'would_link',
  link_contact: 'would_link',
  deliver_activity: 'would_deliver_activities',
  review_conflict: 'requires_review',
})

export const DRY_RUN_REVIEW_TOTAL_FIELDS = Object.freeze([
  'would_create_organizations',
  'would_create_contacts',
  'would_link',
  'would_deliver_activities',
  'requires_review',
  'skipped',
])
