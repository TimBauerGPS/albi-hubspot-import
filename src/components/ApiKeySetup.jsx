import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function ApiKeySetup({ userId, currentKey, onSaved }) {
  const [key, setKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const masked = currentKey
    ? currentKey.slice(0, 8) + '••••••••••••••••' + currentKey.slice(-4)
    : null

  async function handleSave(e) {
    e.preventDefault()
    if (!key.trim()) return
    setLoading(true)
    setError(null)
    setSaved(false)

    const { error } = await supabase
      .from('hs_user_config')
      .upsert(
        {
          user_id: userId,
          hubspot_api_key: key.trim(),
          config_status: 'unchecked',
          config_errors: [],
        },
        { onConflict: 'user_id' }
      )

    if (error) {
      setError(error.message)
    } else {
      setSaved(true)
      setKey('')
      onSaved?.()
    }
    setLoading(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="font-semibold text-gray-900 mb-1">HubSpot API Key</h3>
      <p className="text-sm text-gray-500 mb-4">
        Enter your HubSpot Private App API key. It will be stored securely and never
        exposed to the browser after this step.
      </p>

      {masked && (
        <div className="mb-4 flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          <span className="text-xs text-green-700 font-medium">Current key:</span>
          <code className="text-xs text-green-800 font-mono">{masked}</code>
        </div>
      )}

      <form onSubmit={handleSave} className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder={masked ? 'Enter new key to replace…' : 'pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={loading || !key.trim()}
          className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {loading ? 'Saving…' : 'Save Key'}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</p>
      )}
      {saved && (
        <p className="mt-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
          API key saved. Run the configuration check below to validate it.
        </p>
      )}

      <p className="mt-4 text-xs text-gray-400">
        In HubSpot: Settings → Integrations → Private Apps → Create a private app.
        Copy the Access Token from the Auth tab.
      </p>
    </div>
  )
}
