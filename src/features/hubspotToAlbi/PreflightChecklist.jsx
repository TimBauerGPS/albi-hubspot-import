function CheckGroup({ title, group }) {
  const checks = Array.isArray(group?.checks) ? group.checks : []
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-gray-900">{title}</h4>
        <span className={`text-xs font-semibold ${group?.status === 'valid' ? 'text-green-700' : 'text-gray-500'}`}>
          {group?.status === 'valid' ? 'Verified' : group?.status === 'invalid' ? 'Needs attention' : 'Not checked'}
        </span>
      </div>
      {checks.length ? (
        <ul className="mt-2 space-y-1.5">
          {checks.map(check => (
            <li key={`${title}-${check.capability}`} className="flex items-start gap-2 text-sm text-gray-700">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${check.status === 'valid' ? 'bg-green-500' : 'bg-amber-500'}`} aria-hidden="true" />
              <span>{check.label} — {check.status === 'valid' ? 'available' : 'missing'}</span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-sm text-gray-500">Run the check to verify this connection.</p>}
    </div>
  )
}

export default function PreflightChecklist({ preflight, credentialsReady, isAdmin, busy, onRun, disabledReason }) {
  const details = preflight?.details ?? {}
  const missing = Array.isArray(details?.missing) ? details.missing : []
  const hubspotChecks = Array.isArray(details?.hubspot?.checks) ? details.hubspot.checks : []
  const albiChecks = Array.isArray(details?.albi?.checks) ? details.albi.checks : []
  const hubspot = { status: details?.hubspot?.status, checks: hubspotChecks }
  const albi = { status: details?.albi?.status, checks: albiChecks }
  const canRun = isAdmin && credentialsReady && !busy

  return (
    <div className="mt-5">
      {missing.length > 0 && (
        <div className="border-l-2 border-amber-400 bg-amber-50 px-3 py-2.5" role="alert">
          <p className="text-sm font-semibold text-amber-900">Resolve these items before continuing</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-900">
            {missing.map(label => <li key={label}>{label}</li>)}
          </ul>
        </div>
      )}

      <div className="mt-4 grid gap-5 border-y border-gray-100 py-4 md:grid-cols-2">
        <CheckGroup title="HubSpot" group={hubspot} />
        <CheckGroup title="Albi" group={albi} />
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-500">This is a read-only capability check. It does not create records.</p>
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          className="rounded-lg border border-brand-600 bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400"
        >
          {busy ? 'Checking…' : 'Run connection check'}
        </button>
      </div>
      {!isAdmin && <p className="mt-2 text-xs text-gray-500">{disabledReason}</p>}
      {isAdmin && !credentialsReady && <p className="mt-2 text-xs text-gray-500">Save both credentials before running the connection check.</p>}
    </div>
  )
}
