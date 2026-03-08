import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
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

            {/* Sync has moved to the Import page */}
            {isValid && (
              <div className="bg-gray-50 rounded-xl border border-gray-200 px-5 py-4">
                <p className="text-sm text-gray-600">
                  HubSpot data sync is available on the{' '}
                  <button
                    onClick={() => navigate('/import')}
                    className="text-brand-600 font-medium hover:underline"
                  >
                    Import page
                  </button>
                  {' '}— run it before each import session.
                </p>
                {config?.updated_at && (
                  <p className="text-xs text-gray-400 mt-1">
                    Last synced: {new Date(config.updated_at).toLocaleString()}
                  </p>
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
