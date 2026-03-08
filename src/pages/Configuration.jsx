import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { syncHubspotData } from '../lib/hubspot'
import ApiKeySetup from '../components/ApiKeySetup'
import ConfigChecker from '../components/ConfigChecker'
import UserSettings from '../components/UserSettings'
import SetupGuide from '../components/SetupGuide'
import AppShell from '../components/AppShell'

const TABS = ['Setup', 'Settings']

export default function Configuration({ session, onConfigValid }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('Setup')
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [configStatus, setConfigStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncStep, setSyncStep] = useState(null) // 'contacts' | 'companies' | 'deals'
  const [syncResult, setSyncResult] = useState(null)

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
    setSyncing(true)
    setSyncStep(null)
    setSyncResult(null)
    try {
      const res = await syncHubspotData(session, step => setSyncStep(step))
      setSyncResult({ ok: true, ...res.synced })
    } catch (err) {
      setSyncResult({ ok: false, error: err.message })
    }
    setSyncStep(null)
    setSyncing(false)
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
                    disabled={syncing}
                    className="ml-4 shrink-0 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    {syncing ? (
                      <span className="flex items-center gap-2">
                        <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-500" />
                        {syncStep ? `Syncing ${syncStep}…` : 'Syncing…'}
                      </span>
                    ) : 'Sync Now'}
                  </button>
                </div>

                {syncResult && (
                  <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${
                    syncResult.ok
                      ? 'bg-green-50 border border-green-200 text-green-800'
                      : 'bg-red-50 border border-red-200 text-red-700'
                  }`}>
                    {syncResult.ok
                      ? `Synced: ${syncResult.contacts} contacts · ${syncResult.companies} companies · ${syncResult.deals} deals`
                      : `Sync failed: ${syncResult.error}`}
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
