const DIAGNOSTIC_LABELS = Object.freeze({
  authentication_rejected: 'Authentication rejected',
  permission_denied: 'Permission denied',
  unexpected_response: 'Unexpected response',
  provider_unavailable: 'Provider unavailable',
  verified_on_first_use: 'Verified when first used',
  handled_through_conflicts: 'Handled through Conflicts',
})

const WRAPPER_SCOPES = new Set([
  'contacts:list', 'contacts:create', 'organizations:list', 'organizations:create', 'activities:list', 'activities:create',
  'options.relationship-types:list', 'options.referral-sources:list', 'options.relationship-statuses:list', 'options.activity-types:list',
])

const PROTOCOL_ISSUE_LABELS = Object.freeze({
  envelope_invalid: 'response envelope',
  data_invalid: 'data list',
  pagination_missing: 'missing pagination',
  pagination_invalid: 'pagination field types',
  page_mismatch: 'pagination page mismatch',
  page_size_mismatch: 'pagination page size mismatch',
  total_invalid: 'pagination total',
  total_pages_invalid: 'pagination page range',
  total_pages_mismatch: 'pagination total pages',
  record_count_mismatch: 'pagination record count',
  record_invalid: 'record shape',
  record_id_invalid: 'record ID',
  record_field_invalid: 'record field type',
})

export function presentPreflightCheck(check = {}) {
  const status = ['valid', 'invalid', 'informational'].includes(check.status) ? check.status : 'invalid'
  const label = status === 'valid' ? 'available' : DIAGNOSTIC_LABELS[check.reason] ?? 'Unavailable'
  const scope = WRAPPER_SCOPES.has(check.requiredScope) ? ` · Required scope: ${check.requiredScope}` : ''
  const diagnostic = status === 'invalid' && PROTOCOL_ISSUE_LABELS[check.protocolIssue]
    ? ` · Diagnostic: ${PROTOCOL_ISSUE_LABELS[check.protocolIssue]}` : ''
  return {
    detail: `${label}${diagnostic}${scope}`,
    markerClass: status === 'valid' ? 'bg-green-500' : status === 'informational' ? 'bg-blue-400' : 'bg-amber-500',
    textClass: 'text-gray-700',
  }
}

export function presentAuthorizedCompany(company) {
  const id = typeof company?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(company.id) ? company.id : ''
  const name = typeof company?.name === 'string' ? company.name.trim() : ''
  if (!id || !name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return ''
  return `Authorized company: ${name} (${id})`
}
