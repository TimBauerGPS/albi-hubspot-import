export const DRY_RUN_TOTAL_LABELS = Object.freeze([
  ['would_create_organizations', 'Would create organizations'],
  ['would_create_contacts', 'Would create contacts'],
  ['would_link', 'Would link existing records'],
  ['would_deliver_activities', 'Would deliver activities'],
  ['requires_review', 'Needs review'],
  ['skipped', 'Skipped'],
])

export function presentDryRunTotals(totals) {
  return DRY_RUN_TOTAL_LABELS.flatMap(([key, label]) => {
    const value = totals?.[key]
    return Number.isSafeInteger(value) && value > 0 ? [{ key, label, value }] : []
  })
}
