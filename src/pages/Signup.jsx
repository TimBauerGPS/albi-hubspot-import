import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

/**
 * Invite landing page.
 *
 * When a new company receives an invite email, the link is:
 *   https://app.com/signup#access_token=...&type=invite
 *
 * Supabase processes the hash on mount, fires SIGNED_IN, and the user is
 * authenticated. This page prompts them to set a company name and password,
 * then redirects to /configuration for the HubSpot API key setup.
 *
 * If this page is visited without an invite token in the hash, the user is
 * redirected to /login.
 */
export default function Signup() {
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [ready, setReady] = useState(false)          // true once we've checked for invite token
  const [companyName, setCompanyName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Invite links contain type=invite in the URL hash.
    // Non-invite visits should be sent to /login.
    const hash = window.location.hash
    if (!hash.includes('type=invite')) {
      navigate('/login', { replace: true })
      return
    }

    setReady(true)

    // Supabase will have already processed the hash and fired SIGNED_IN.
    // Grab the current session (may be set already or arrive via the listener).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setSession(session)
        setCompanyName(session.user?.user_metadata?.company_name ?? '')
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        setSession(session)
        setCompanyName(session.user?.user_metadata?.company_name ?? '')
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!companyName.trim()) { setError('Company name is required'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }

    setLoading(true)
    setError(null)

    // Set the user's password
    const { error: pwError } = await supabase.auth.updateUser({ password })
    if (pwError) { setError(pwError.message); setLoading(false); return }

    // Create their hs_user_config row with company name + default settings
    const { error: configError } = await supabase
      .from('hs_user_config')
      .upsert(
        {
          user_id: session.user.id,
          company_name: companyName.trim(),
          config_status: 'unchecked',
          config_errors: [],
          pipeline_mapping: {
            WTR: 'Water Mitigation',
            EMS: 'Water Mitigation',
            FIRE: 'Fire Mitigation',
            CON: 'Contents',
            RBL: 'Rebuild',
          },
          excluded_suffixes: ['WTY', 'LTR', 'SUB', 'BDUP', 'LUX'],
          sales_team: [],
        },
        { onConflict: 'user_id' }
      )

    if (configError) { setError(configError.message); setLoading(false); return }

    // Send to configuration to enter their HubSpot API key
    navigate('/configuration', { replace: true })
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 max-w-sm w-full mx-4">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-gray-900">Welcome</h1>
          <p className="text-sm text-gray-500 mt-1">
            Set up your account to start importing deals.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Company name</label>
            <input
              type="text"
              value={companyName}
              onChange={e => setCompanyName(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Allied Restoration – Denver"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Minimum 8 characters"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Confirm password</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Re-enter password"
            />
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !session}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Setting up…' : 'Create Account'}
          </button>

          {!session && (
            <p className="text-xs text-center text-gray-400">Verifying invite link…</p>
          )}
        </form>
      </div>
    </div>
  )
}
