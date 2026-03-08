import { useState } from 'react'
import { runConfigCheck, createRequiredProperties } from '../lib/hubspot'

function StatusIcon({ status }) {
  if (status === 'pass') return (
    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
      <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </span>
  )
  if (status === 'fail') return (
    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-red-100 flex items-center justify-center">
      <svg className="w-3 h-3 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </span>
  )
  if (status === 'warn') return (
    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-yellow-100 flex items-center justify-center">
      <svg className="w-3 h-3 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01" />
      </svg>
    </span>
  )
  return (
    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
      <span className="w-2 h-2 rounded-full bg-gray-400" />
    </span>
  )
}

function CheckRow({ check }) {
  const [expanded, setExpanded] = useState(check.status === 'fail')

  return (
    <div className={`border rounded-lg overflow-hidden ${
      check.status === 'pass' ? 'border-green-200 bg-green-50/30' :
      check.status === 'fail' ? 'border-red-200 bg-red-50/30' :
      check.status === 'warn' ? 'border-yellow-200 bg-yellow-50/30' :
      'border-gray-200'
    }`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <StatusIcon status={check.status} />
        <span className="flex-1 text-sm font-medium text-gray-800">{check.label}</span>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pt-0">
          <p className="text-xs text-gray-600 leading-relaxed">{check.message}</p>
        </div>
      )}
    </div>
  )
}

function CreatePropertiesPanel({ session, onDone }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function handleCreate() {
    setLoading(true)
    setError(null)
    try {
      const res = await createRequiredProperties(session)
      setResult(res)
      if (!res.missingScope) onDone?.()
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  if (result?.missingScope) {
    return (
      <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-3">
        <p className="text-sm font-medium text-yellow-800">Manual setup required</p>
        <p className="text-xs text-yellow-700">{result.message}</p>
        <p className="text-xs font-medium text-gray-700">Create these properties in HubSpot
          (Settings → Properties → Deal Properties → Create property):</p>
        <div className="space-y-1">
          {result.manualInstructions?.map(p => (
            <div key={p.name} className="flex gap-2 text-xs text-gray-600 bg-white rounded border border-yellow-200 px-3 py-2">
              <code className="font-mono font-semibold text-gray-800 shrink-0">{p.name}</code>
              <span className="text-gray-400">—</span>
              <span>{p.label}</span>
              <span className="text-gray-400 ml-auto shrink-0">({p.fieldType})</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (result) {
    return (
      <div className="mt-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
        <p className="text-sm font-semibold text-green-800">
          Properties created successfully. Re-run the check above.
        </p>
        {result.created?.length > 0 && (
          <p className="text-xs text-green-700 mt-1">Created: {result.created.join(', ')}</p>
        )}
        {result.alreadyExisted?.length > 0 && (
          <p className="text-xs text-gray-500 mt-1">Already existed: {result.alreadyExisted.join(', ')}</p>
        )}
      </div>
    )
  }

  return (
    <div className="mt-3">
      {error && (
        <p className="mb-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</p>
      )}
      <button
        onClick={handleCreate}
        disabled={loading}
        className="px-3 py-1.5 bg-brand-600 text-white text-xs font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Creating properties…' : 'Auto-create in HubSpot'}
      </button>
      <p className="text-xs text-gray-400 mt-1">
        Requires the <code className="font-mono">crm.schemas.deals.write</code> scope on your Private App.
        If missing, step-by-step instructions will appear.
      </p>
    </div>
  )
}

export default function ConfigChecker({ session, hasApiKey, onStatusChange }) {
  const [loading, setLoading] = useState(false)
  const [checks, setChecks] = useState(null)
  const [overallStatus, setOverallStatus] = useState(null)
  const [error, setError] = useState(null)
  const [showCreateProps, setShowCreateProps] = useState(false)

  async function handleRun() {
    setLoading(true)
    setError(null)
    setChecks(null)
    setOverallStatus(null)
    setShowCreateProps(false)

    try {
      const result = await runConfigCheck(session)
      setChecks(result.checks)
      setOverallStatus(result.status)
      onStatusChange?.(result.status)

      // Show create-properties prompt if the properties check failed
      const propsFailed = result.checks?.some(
        c => c.id === 'properties' && c.status === 'fail'
      )
      setShowCreateProps(propsFailed)
    } catch (err) {
      setError(err.message)
    }

    setLoading(false)
  }

  const passCount = checks?.filter(c => c.status === 'pass').length ?? 0
  const failCount = checks?.filter(c => c.status === 'fail').length ?? 0

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-gray-900">Configuration Check</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Validates your HubSpot setup before allowing imports.
          </p>
        </div>
        <button
          onClick={handleRun}
          disabled={loading || !hasApiKey}
          className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
          title={!hasApiKey ? 'Save your API key first' : undefined}
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
              Checking…
            </span>
          ) : 'Run Check'}
        </button>
      </div>

      {!hasApiKey && (
        <p className="text-sm text-gray-400 italic">Save your HubSpot API key above to enable this check.</p>
      )}

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</p>
      )}

      {checks && (
        <>
          <div className={`flex items-center gap-3 rounded-lg px-4 py-3 mb-4 ${
            overallStatus === 'valid'
              ? 'bg-green-50 border border-green-200'
              : 'bg-red-50 border border-red-200'
          }`}>
            <StatusIcon status={overallStatus === 'valid' ? 'pass' : 'fail'} />
            <div>
              <p className={`text-sm font-semibold ${overallStatus === 'valid' ? 'text-green-800' : 'text-red-800'}`}>
                {overallStatus === 'valid'
                  ? 'All checks passed — you are ready to import!'
                  : `${failCount} check${failCount !== 1 ? 's' : ''} failed — fix the issues below before importing.`}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {passCount} passed · {failCount} failed ·{' '}
                {checks.filter(c => c.status === 'warn').length} warnings
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {checks.map(check => (
              <div key={check.id}>
                <CheckRow check={check} />
                {/* Show auto-create panel inline under the properties check if it failed */}
                {check.id === 'properties' && check.status === 'fail' && showCreateProps && (
                  <CreatePropertiesPanel
                    session={session}
                    onDone={() => { setShowCreateProps(false); handleRun() }}
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
