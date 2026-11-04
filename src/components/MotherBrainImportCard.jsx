import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { queueMotherBrainImport } from '../lib/hubspot'

const PREFIX = 'Mother Brain:%'
// The stored value predates Mother Brain; it still means "not the Google Sheet".
const SOURCE = 'albi_api'
const POLL_MS = 3000
const POLL_TIMEOUT_MS = 30 * 60 * 1000

async function latestImport(userId) {
  const { data } = await supabase.from('hs_imports')
    .select('id, imported_at, status, created_count, updated_count, error_count')
    .eq('user_id', userId).like('filename', PREFIX).order('imported_at', { ascending: false }).limit(1).maybeSingle()
  return data ?? null
}

// Import deals from Mother Brain, and choose it for the nightly run.
export default function MotherBrainImportCard({ session, userConfig, setUserConfig, disabled }) {
  const [status, setStatus] = useState(null)
  const [saving, setSaving] = useState(false)
  const poll = useRef(null)
  const nightlyFromMotherBrain = userConfig?.import_source === SOURCE
  useEffect(() => () => clearInterval(poll.current), [])

  async function runNow() {
    clearInterval(poll.current)
    try {
      const before = await latestImport(session.user.id)
      setStatus({ state: 'queued', message: 'Queuing the Mother Brain import…' })
      await queueMotherBrainImport(session)
      const startedAt = Date.now()
      poll.current = setInterval(async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          clearInterval(poll.current)
          setStatus({ state: 'error', message: 'The Mother Brain import is taking longer than expected. Check Import History in a few minutes.' })
          return
        }
        const latest = await latestImport(session.user.id)
        if (!latest?.id || latest.id === before?.id) return
        if (['processing', 'pending'].includes(latest.status)) { setStatus({ state: 'running', message: 'Importing projects from Mother Brain…' }); return }
        clearInterval(poll.current)
        setStatus(latest.status === 'complete'
          ? { state: 'complete', message: `Mother Brain import finished: ${latest.created_count || 0} created, ${latest.updated_count || 0} updated${latest.error_count ? `, ${latest.error_count} error${latest.error_count === 1 ? '' : 's'}` : ''}.` }
          : { state: 'error', message: 'The Mother Brain import finished with an error. Check Import History; an email alert has the reason.' })
      }, POLL_MS)
    } catch (err) {
      setStatus({ state: 'error', message: err.message })
    }
  }

  async function setNightly(useMotherBrain) {
    setSaving(true)
    const { error } = await supabase.from('hs_user_config')
      .upsert({ user_id: session.user.id, import_source: useMotherBrain ? SOURCE : 'google_sheet' }, { onConflict: 'user_id' })
    setSaving(false)
    if (error) { setStatus({ state: 'error', message: `Could not save the nightly source: ${error.message}` }); return }
    setUserConfig(prev => ({ ...(prev || {}), import_source: useMotherBrain ? SOURCE : 'google_sheet' }))
    setStatus({ state: 'saved', message: useMotherBrain ? 'The nightly 8pm import now reads from Mother Brain.' : 'The nightly 8pm import now reads the Google Sheet.' })
  }

  return <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-5 space-y-4">
    <div>
      <h2 className="text-sm font-semibold text-gray-900">Mother Brain Import</h2>
      <p className="text-xs text-gray-600 mt-1">
        Reads every project from Mother Brain, with the same filters as the sheet. It uses no Albi requests.
        The nightly run skips when Mother Brain has not refreshed since the last clean import.
      </p>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button onClick={runNow} disabled={disabled || status?.state === 'running' || status?.state === 'queued'}
        className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
        {status?.state === 'running' ? 'Import Running…' : 'Import From Mother Brain'}
      </button>
      <label className="flex items-center gap-2 text-xs text-gray-700">
        <input type="checkbox" className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" checked={nightlyFromMotherBrain}
          disabled={disabled || saving} onChange={event => setNightly(event.target.checked)} />
        Use Mother Brain for the nightly 8pm import
      </label>
    </div>
    {status?.message && <p className={`text-xs ${status.state === 'error' ? 'text-red-600' : status.state === 'complete' ? 'text-green-700' : 'text-gray-600'}`}>{status.message}</p>}
  </div>
}
