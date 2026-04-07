import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AppShell from '../components/AppShell'

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

function StatusBadge({ status }) {
  const styles = {
    complete: 'bg-green-100 text-green-700',
    processing: 'bg-yellow-100 text-yellow-700',
    error: 'bg-red-100 text-red-700',
    pending: 'bg-gray-100 text-gray-500',
  }
  return (
    <span className={`inline-block text-xs font-semibold rounded px-1.5 py-0.5 capitalize ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

function ActionBadge({ action }) {
  const styles = {
    created: 'bg-green-100 text-green-700',
    updated: 'bg-blue-100 text-blue-700',
    skipped: 'bg-gray-100 text-gray-500',
    error: 'bg-red-100 text-red-700',
  }
  return (
    <span className={`inline-block text-xs font-semibold rounded px-1.5 py-0.5 capitalize ${styles[action] || 'bg-gray-100 text-gray-500'}`}>
      {action}
    </span>
  )
}

function DealRowDetail({ importId, userId }) {
  const [deals, setDeals] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState(null)

  useEffect(() => {
    async function loadAllDeals() {
      const PAGE = 1000
      const all = []
      let from = 0

      while (true) {
        const { data } = await supabase
          .from('hs_deals')
          .select('*')
          .eq('user_id', userId)
          .eq('import_id', importId)
          .neq('action_taken', 'skipped')
          .order('processed_at', { ascending: true })
          .range(from, from + PAGE - 1)

        const page = data || []
        all.push(...page)
        if (page.length < PAGE) break
        from += PAGE
      }

      setDeals(all)

      const counts = {
        created: all.filter(d => d.action_taken === 'created').length,
        error: all.filter(d => d.action_taken === 'error').length,
        updated: all.filter(d => d.action_taken === 'updated').length,
      }
      const defaultFilter = ['created', 'error', 'updated'].find(key => counts[key] > 0) || 'created'
      setFilter(defaultFilter)
      setLoading(false)
    }

    loadAllDeals()
  }, [importId])

  if (loading) {
    return (
      <div className="py-4 text-center">
        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-brand-600 mx-auto" />
      </div>
    )
  }

  const counts = {
    created: deals.filter(d => d.action_taken === 'created').length,
    error: deals.filter(d => d.action_taken === 'error').length,
    updated: deals.filter(d => d.action_taken === 'updated').length,
  }
  const filtered = deals.filter(d => d.action_taken === filter)

  return (
    <div className="border-t border-gray-100 bg-gray-50/50">
      {/* Filter tabs */}
      <div className="flex gap-1 px-6 pt-3 pb-2">
        {[
          { key: 'created', label: 'Created' },
          { key: 'error', label: 'Error' },
          { key: 'updated', label: 'Updated' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-2 py-1 text-xs font-medium rounded capitalize transition-colors ${
              filter === key ? 'bg-brand-600 text-white' : 'bg-white border border-gray-200 text-gray-500 hover:text-gray-800'
            }`}
          >
            {label} ({counts[key]})
          </button>
        ))}
      </div>

      <div className="overflow-x-auto px-6 pb-4">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="pb-2 pr-4 font-semibold">Job ID</th>
              <th className="pb-2 pr-4 font-semibold">Deal Name</th>
              <th className="pb-2 pr-4 font-semibold">Result</th>
              <th className="pb-2 pr-4 font-semibold">HubSpot ID</th>
              <th className="pb-2 font-semibold">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map(deal => (
              <tr key={deal.id} className={deal.action_taken === 'error' ? 'bg-red-50/30' : ''}>
                <td className="py-2 pr-4 font-mono text-gray-700 whitespace-nowrap">
                  {deal.project_url
                    ? (
                      <a
                        href={deal.project_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-600 hover:underline"
                      >
                        {deal.job_id}
                      </a>
                    )
                    : deal.job_id}
                </td>
                <td className="py-2 pr-4 text-gray-700 truncate max-w-xs">{deal.job_name}</td>
                <td className="py-2 pr-4 whitespace-nowrap"><ActionBadge action={deal.action_taken} /></td>
                <td className="py-2 pr-4 font-mono text-gray-500 whitespace-nowrap">
                  {deal.hubspot_deal_id
                    ? <a
                        href={`https://app.hubspot.com/contacts/deals/${deal.hubspot_deal_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-600 hover:underline"
                      >{deal.hubspot_deal_id}</a>
                    : '—'}
                </td>
                <td className="py-2 text-red-600 truncate max-w-xs">{deal.error_message || ''}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-gray-400">No rows match this filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ImportRow({ imp, userId }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        className="w-full flex items-center gap-4 px-6 py-4 hover:bg-gray-50/50 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <svg
          className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800 truncate">{imp.filename}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {dateFmt.format(new Date(imp.imported_at))}
          </p>
        </div>
        <StatusBadge status={imp.status} />
        <div className="text-xs text-gray-500 tabular-nums text-right shrink-0">
          <p><span className="text-green-700 font-semibold">{imp.created_count}</span> created</p>
          <p><span className="text-blue-700 font-semibold">{imp.updated_count}</span> updated</p>
          {imp.error_count > 0 && (
            <p><span className="text-red-700 font-semibold">{imp.error_count}</span> errors</p>
          )}
        </div>
      </button>

      {expanded && (
        <DealRowDetail importId={imp.id} userId={userId} />
      )}
    </div>
  )
}

export default function Dashboard({ session, configStatus, isAdmin, companyName }) {
  const navigate = useNavigate()
  const [imports, setImports] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadImports()
  }, [session])

  async function loadImports() {
    const { data } = await supabase
      .from('hs_imports')
      .select('*')
      .eq('user_id', session.user.id)
      .order('imported_at', { ascending: false })
    setImports(data || [])
    setLoading(false)
  }

  const totalCreated = imports.reduce((sum, i) => sum + (i.created_count || 0), 0)
  const totalUpdated = imports.reduce((sum, i) => sum + (i.updated_count || 0), 0)
  const totalErrors = imports.reduce((sum, i) => sum + (i.error_count || 0), 0)

  return (
    <AppShell session={session} isAdmin={isAdmin} companyName={companyName}>
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
            <p className="text-sm text-gray-500 mt-1">Import history for your HubSpot account.</p>
          </div>
          <button
            onClick={() => navigate('/import')}
            disabled={configStatus !== 'valid'}
            className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
            title={configStatus !== 'valid' ? 'Complete configuration first' : undefined}
          >
            New Import
          </button>
        </div>

        {/* Config warning */}
        {configStatus && configStatus !== 'valid' && (
          <div className="mb-5 bg-yellow-50 border border-yellow-200 rounded-xl px-5 py-4">
            <p className="text-sm font-semibold text-yellow-800">
              {configStatus === 'unchecked' ? 'HubSpot not configured yet' : 'Configuration has errors'}
            </p>
            <p className="text-sm text-yellow-700 mt-1">
              {configStatus === 'unchecked'
                ? 'Set up your HubSpot connection before importing deals.'
                : 'Fix the configuration errors before importing.'}
            </p>
            <button
              onClick={() => navigate('/configuration')}
              className="mt-2 text-xs text-brand-600 font-medium hover:underline"
            >
              Go to Configuration →
            </button>
          </div>
        )}

        {/* Summary stats */}
        {imports.length > 0 && (
          <div className="grid grid-cols-4 gap-4 mb-6">
            {[
              { label: 'Total Imports', value: imports.length, color: 'text-gray-800' },
              { label: 'Deals Created', value: totalCreated, color: 'text-green-700' },
              { label: 'Deals Updated', value: totalUpdated, color: 'text-blue-700' },
              { label: 'Total Errors', value: totalErrors, color: totalErrors > 0 ? 'text-red-700' : 'text-gray-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-white rounded-xl border border-gray-200 px-5 py-4">
                <p className={`text-2xl font-bold tabular-nums ${color}`}>{value.toLocaleString()}</p>
                <p className="text-xs text-gray-500 mt-1">{label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Import history */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-800">Import History</h2>
          </div>

          {loading ? (
            <div className="py-12 flex justify-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600" />
            </div>
          ) : imports.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-gray-500 text-sm">No imports yet.</p>
              <button
                onClick={() => navigate('/import')}
                disabled={configStatus !== 'valid'}
                className="mt-3 text-sm text-brand-600 font-medium hover:underline disabled:opacity-50"
              >
                Start your first import →
              </button>
            </div>
          ) : (
            <div>
              {imports.map(imp => (
                <ImportRow key={imp.id} imp={imp} userId={session.user.id} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
