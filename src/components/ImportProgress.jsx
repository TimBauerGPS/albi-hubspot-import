/**
 * ImportProgress — displays live row-by-row status during the import pipeline.
 * Shows a progress bar, running totals (created/updated/errors), and per-row outcomes.
 */

// Status badge for each row outcome
function RowBadge({ action }) {
  const styles = {
    created: 'bg-green-100 text-green-700',
    updated: 'bg-blue-100 text-blue-700',
    skipped: 'bg-gray-100 text-gray-500',
    error: 'bg-red-100 text-red-700',
    pending: 'bg-gray-50 text-gray-400',
    processing: 'bg-yellow-100 text-yellow-700',
  }
  return (
    <span className={`inline-block text-xs font-semibold rounded px-1.5 py-0.5 capitalize ${styles[action] || styles.pending}`}>
      {action || 'pending'}
    </span>
  )
}

function ProgressBar({ completed, total }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{completed} of {total} rows processed</span>
        <span>{pct}%</span>
      </div>
      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-brand-600 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default function ImportProgress({ rows, rowStatuses, completed, isRunning, summary }) {
  const total = rows.length
  const created = summary?.created ?? 0
  const updated = summary?.updated ?? 0
  const skipped = summary?.skipped ?? 0
  const errors = summary?.errors ?? 0

  const isDone = !isRunning && completed === total && total > 0

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      {(isRunning || isDone) && (
        <ProgressBar completed={completed} total={total} />
      )}

      {/* Totals */}
      {(isRunning || isDone) && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Created', value: created, color: 'text-green-700 bg-green-50 border-green-200' },
            { label: 'Updated', value: updated, color: 'text-blue-700 bg-blue-50 border-blue-200' },
            { label: 'Skipped', value: skipped, color: 'text-gray-500 bg-gray-50 border-gray-200' },
            { label: 'Errors',  value: errors,  color: errors > 0 ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-500 bg-gray-50 border-gray-200' },
          ].map(({ label, value, color }) => (
            <div key={label} className={`rounded-lg border px-4 py-3 text-center ${color}`}>
              <p className="text-2xl font-bold tabular-nums">{value}</p>
              <p className="text-xs font-medium mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Done message */}
      {isDone && (
        <div className={`rounded-lg border px-4 py-3 text-sm font-semibold ${
          errors === 0
            ? 'bg-green-50 border-green-200 text-green-800'
            : 'bg-yellow-50 border-yellow-200 text-yellow-800'
        }`}>
          {errors === 0
            ? `Import complete — ${created} created, ${updated} updated${skipped > 0 ? `, ${skipped} unchanged/skipped` : ''}.`
            : `Import complete with ${errors} error${errors !== 1 ? 's' : ''}. Download the error report below.`}
        </div>
      )}

      {/* Row-by-row table */}
      {rows.length > 0 && (isRunning || isDone) && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 max-h-72 overflow-y-auto">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Job ID</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Deal Name</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Result</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">HubSpot ID</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row, idx) => {
                const s = rowStatuses[idx] || {}
                return (
                  <tr key={idx} className={s.action === 'error' ? 'bg-red-50/30' : ''}>
                    <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{row.name}</td>
                    <td className="px-3 py-2 text-gray-700 truncate max-w-xs">{row.dealName}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <RowBadge action={s.action || (idx < completed ? 'pending' : 'pending')} />
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap text-xs">
                      {s.hubspotDealId || '—'}
                    </td>
                    <td className="px-3 py-2 text-red-600 max-w-xs truncate">
                      {s.error || ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
