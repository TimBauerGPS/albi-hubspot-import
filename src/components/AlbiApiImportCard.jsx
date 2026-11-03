import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { queueAlbiProjectImport } from '../lib/hubspot'

const PREFIX = 'Albi API:%'
const POLL_MS = 3000
const POLL_TIMEOUT_MS = 30 * 60 * 1000

async function latestImport(userId) {
  const { data } = await supabase.from('hs_imports')
    .select('id, imported_at, status, created_count, updated_count, error_count')
    .eq('user_id', userId).like('filename', PREFIX).order('imported_at', { ascending: false }).limit(1).maybeSingle()
  return data ?? null
}

// Import deals straight from Albi's Projects API (with the company's saved Albi key), and choose it for the nightly run.
export default function AlbiApiImportCard({ session, userConfig, setUserConfig, disabled }) {
  const [status, setStatus] = useState(null)
  const [saving, setSaving] = useState(false)
  const poll = useRef(null)
  const nightlyFromAlbi = userConfig?.import_source === 'albi_api'
  useEffect(() => () => clearInterval(poll.current), [])

  async function runNow() {
    clearInterval(poll.current)
    try {
      const before = await latestImport(session.user.id)
      setStatus({ state: 'queued', message: 'Queuing the Albi import…' })
      await queueAlbiProjectImport(session)
      const startedAt = Date.now()
      poll.current = setInterval(async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          clearInterval(poll.current)
          setStatus({ state: 'error', message: 'The Albi import is taking longer than expected. Check Import History in a few minutes.' })
          return
        }
        const latest = await latestImport(session.user.id)
        if (!latest?.id || latest.id === before?.id) return
        if (['processing', 'pending'].includes(latest.status)) { setStatus({ state: 'running', message: 'Reading changed projects from Albi…' }); return }
        clearInterval(poll.current)
        setStatus(latest.status === 'complete'
          ? { state: 'complete', message: `Albi import finished: ${latest.created_count || 0} created, ${latest.updated_count || 0} updated${latest.error_count ? `, ${latest.error_count} error${latest.error_count === 1 ? '' : 's'}` : ''}.` }
          : { state: 'error', message: 'The Albi import finished with an error. Check Import History; an email alert has the reason.' })
      }, POLL_MS)
    } catch (err) {
      setStatus({ state: 'error', message: err.message })
    }
  }

  async function setNightly(useAlbi) {
    setSaving(true)
    const { error } = await supabase.from('hs_user_config')
      .upsert({ user_id: session.user.id, import_source: useAlbi ? 'albi_api' : 'google_sheet' }, { onConflict: 'user_id' })
    setSaving(false)
    if (error) { setStatus({ state: 'error', message: `Could not save the nightly source: ${error.message}` }); return }
    setUserConfig(prev => ({ ...(prev || {}), import_source: useAlbi ? 'albi_api' : 'google_sheet' }))
    setStatus({ state: 'saved', message: useAlbi ? 'The nightly 8pm import now reads from Albi.' : 'The nightly 8pm import now reads the Google Sheet.' })
  }

  return <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-5 space-y-4">
    <div>
      <h2 className="text-sm font-semibold text-gray-900">Albi API Import</h2>
      <p className="text-xs text-gray-600 mt-1">
        Reads projects straight from Albi using the company’s Albi key (HubSpot to Albi settings), with the same filters as the sheet.
        Each run reads only projects that changed since the last one; the first run looks back 30 days.
      </p>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button onClick={runNow} disabled={disabled || status?.state === 'running' || status?.state === 'queued'}
        className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
        {status?.state === 'running' ? 'Import Running…' : 'Import From Albi'}
      </button>
      <label className="flex items-center gap-2 text-xs text-gray-700">
        <input type="checkbox" className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" checked={nightlyFromAlbi}
          disabled={disabled || saving} onChange={event => setNightly(event.target.checked)} />
        Use Albi for the nightly 8pm import
      </label>
    </div>
    {status?.message && <p className={`text-xs ${status.state === 'error' ? 'text-red-600' : status.state === 'complete' ? 'text-green-700' : 'text-gray-600'}`}>{status.message}</p>}
  </div>
}
