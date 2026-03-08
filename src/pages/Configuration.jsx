import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { syncHubspotData } from '../lib/hubspot'
import ApiKeySetup from '../components/ApiKeySetup'
import ConfigChecker from '../components/ConfigChecker'
import UserSettings from '../components/UserSettings'
import SetupGuide from '../components/SetupGuide'
import AppShell from '../components/AppShell'

const TABS = ['Setup', 'Settings']

// Poll every 3 s, give up after 3 minutes
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS  = 3 * 60 * 1000

const SYNC_TABLES = [
  { key: 'contacts',  table: 'hs_cached_contacts'  },
  { key: 'companies', table: 'hs_cached_companies'  },
  { key: 'deals',     table: 'hs_cached_deals'      },
]

export default function Configuration({ session, onConfigValid }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('Setup')
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [configStatus, setConfigStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncStep, setSyncStep] = useState(null) // 'contacts' | 'companies' | 'deals'
  const [syncResult, setSyncResult] = useState(null)

  // Polling state: null | { contacts: number|null, companies: number|null, deals: number|null, done: bool, timedOut: bool }
  const [syncPolling, setSyncPolling] = useState(null)
  const pollIntervalRef = useRef(null)

  // Clean up the polling interval when the component unmounts
  useEffect(() => () => clearInterval(pollIntervalRef.current), [])

  useEffect(() => {
    loadConfig()
  }, [session])

  async function loadConfig() {
    setLoading(true)
    const { data } = await supabase
      .from('hs_user_config')
      .select('*')
      .eq('user_id', session.user.id)
      .maybeSingle()

    // If no row yet, create a default one
    if (!data) {
      await supabase.from('hs_user_config').insert({
        user_id: session.user.id,
        pipeline_mapping: {
          WTR: 'Water Mitigation',
          EMS: 'Water Mitigation',
          FIRE: 'Fire Mitigation',
          CON: 'Contents',
          RBL: 'Rebuild',
        },
        excluded_suffixes: ['WTY', 'LTR', 'SUB', 'BDUP', 'LUX'],
        sales_team: [],
      })
      setConfig(null)
    } else {
      setConfig(data)
      setConfigStatus(data.config_status)
    }

    setLoading(false)
  }

  function handleConfigValid(status) {
    setConfigStatus(status)
    if (status === 'valid') {
      onConfigValid?.()
    }
  }

  async function handleSync() {
    // Cancel any previous poll
    clearInterval(pollIntervalRef.current)
    setSyncing(true)
    setSyncStep(null)
    setSyncResult(null)
    setSyncPolling(null)

    // Snapshot the current time so we can detect rows written AFTER this moment
    const snapshotTime = new Date().toISOString()

    try {
      await syncHubspotData(session, step => setSyncStep(step))
    } catch (err) {
      setSyncResult({ ok: false, error: err.message })
      setSyncStep(null)
      setSyncing(false)
      return
    }

    setSyncStep(null)
    setSyncing(false)

    // ── Begin polling ──────────────────────────────────────────────────────
    // Each background function writes synced_at on every cache row it inserts.
    // When we see a row with synced_at > snapshotTime we know that type is done.
    setSyncPolling({ contacts: null, companies: null, deals: null, done: false, timedOut: false })

    const doneByType = { contacts: false, companies: false, deals: false }
    const pollStart = Date.now()

    pollIntervalRef.current = setInterval(async () => {
      // Bail out after POLL_TIMEOUT_MS with a soft warning
      if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
        clearInterval(pollIntervalRef.current)
        setSyncPolling(prev => ({ ...prev, timedOut: true }))
        return
      }

      for (const { key, table } of SYNC_TABLES) {
        if (doneByType[key]) continue

        // Check for any row written after snapshotTime
        const { data: latest } = await supabase
          .from(table)
          .select('synced_at')
          .eq('user_id', session.user.id)
          .gt('synced_at', snapshotTime)
          .limit(1)

        if (latest && latest.length > 0) {
          // This type finished — fetch its total cached count
          const { count } = await supabase
            .from(table)
            .select('*', { count: 'exact', head: true })
            .eq('user_id', session.user.id)

          doneByType[key] = true
          setSyncPolling(prev => ({ ...prev, [key]: count ?? 0 }))
        }
      }

      if (doneByType.contacts && doneByType.companies && doneByType.deals) {
        clearInterval(pollIntervalRef.current)
        setSyncPolling(prev => ({ ...prev, done: true }))
        await loadConfig()   // refresh "Last synced" timestamp
      }
    }, POLL_INTERVAL_MS)
  }

  const hasApiKey = !!config?.hubspot_api_key
  const isValid = configStatus === 'valid'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  return (
    <AppShell session={session}>

      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Configuration</h1>
            <p className="text-sm text-gray-500 mt-1">
              Set up your HubSpot connection before importing deals.
            </p>
          </div>

          {isValid && (
            <button
              onClick={() => navigate('/dashboard')}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
            >
              Go to Dashboard
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* Config status badge */}
        {configStatus && (
          <div className={`mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
            configStatus === 'valid' ? 'bg-green-100 text-green-800' :
            configStatus === 'invalid' ? 'bg-red-100 text-red-800' :
            'bg-gray-100 text-gray-600'
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              configStatus === 'valid' ? 'bg-green-500' :
              configStatus === 'invalid' ? 'bg-red-500' :
              'bg-gray-400'
            }`} />
            {configStatus === 'valid' ? 'Configuration valid' :
             configStatus === 'invalid' ? 'Configuration has errors' :
             'Not yet checked'}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200 mb-6">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'Setup' && (
          <div className="space-y-4">
            {/* Setup guide — open by default for new users without an API key */}
            <SetupGuide defaultOpen={!hasApiKey} />

            <ApiKeySetup
              userId={session.user.id}
              currentKey={config?.hubspot_api_key}
              onSaved={loadConfig}
            />

            <ConfigChecker
              session={session}
              hasApiKey={hasApiKey}
              onStatusChange={handleConfigValid}
            />

            {/* HubSpot data sync — only show if config is valid */}
            {isValid && (
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900">Sync HubSpot Data</h3>
                    <p className="text-sm text-gray-500 mt-0.5">
                      Pulls your contacts, companies, and existing deals into a local cache
                      to speed up imports. Run this before each import session.
                    </p>
                  </div>
                  <button
                    onClick={handleSync}
                    disabled={syncing || (syncPolling && !syncPolling.done && !syncPolling.timedOut)}
                    className="ml-4 shrink-0 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    {syncing ? (
                      <span className="flex items-center gap-2">
                        <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-500" />
                        {syncStep ? `Queuing ${syncStep}…` : 'Queuing…'}
                      </span>
                    ) : 'Sync Now'}
                  </button>
                </div>

                {/* Last synced timestamp — hide while a sync is in progress */}
                {config?.updated_at && !syncPolling && !syncResult && (
                  <p className="text-xs text-gray-400 mt-2">
                    Last synced: {new Date(config.updated_at).toLocaleString()}
                  </p>
                )}

                {/* Error */}
                {syncResult && !syncResult.ok && (
                  <div className="mt-3 text-xs rounded-lg px-3 py-2 bg-red-50 border border-red-200 text-red-700">
                    Sync failed: {syncResult.error}
                  </div>
                )}

                {/* Live polling status */}
                {syncPolling && (
                  <div className="mt-4 space-y-2">
                    {/* Per-type rows */}
                    {[
                      { key: 'contacts',  label: 'Contacts'  },
                      { key: 'companies', label: 'Companies' },
                      { key: 'deals',     label: 'Deals'     },
                    ].map(({ key, label }) => {
                      const count = syncPolling[key]
                      const done  = count !== null
                      return (
                        <div key={key} className="flex items-center gap-2 text-sm">
                          {done ? (
                            <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                              <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-400" />
                            </span>
                          )}
                          <span className={done ? 'text-gray-700' : 'text-gray-400'}>
                            {label}
                            {done && (
                              <span className="ml-1.5 text-gray-400 font-normal">
                                — {count.toLocaleString()} cached
                              </span>
                            )}
                          </span>
                        </div>
                      )
                    })}

                    {/* Done banner */}
                    {syncPolling.done && (
                      <div className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 bg-green-50 border border-green-200 text-green-800 text-xs font-medium">
                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Sync complete — cache is up to date. Last synced: {config?.updated_at ? new Date(config.updated_at).toLocaleString() : 'just now'}
                      </div>
                    )}

                    {/* Timed-out soft warning */}
                    {syncPolling.timedOut && !syncPolling.done && (
                      <div className="mt-1 rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs">
                        The sync is still running in the background — this can take a few minutes for large accounts. You can start your import once it finishes; the import page will warn you if the cache is stale.
                      </div>
                    )}

                    {/* Waiting hint (not yet done/timed-out) */}
                    {!syncPolling.done && !syncPolling.timedOut && (
                      <p className="text-xs text-gray-400 pt-0.5">
                        Fetching data from HubSpot in the background — this usually takes 15–60 seconds.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'Settings' && (
          <UserSettings
            userId={session.user.id}
            initialConfig={config}
            onSaved={loadConfig}
          />
        )}
      </div>
    </AppShell>
  )
}
