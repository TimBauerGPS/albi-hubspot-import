import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

/**
 * Invite landing page.
 *
 * When a new user receives an invite email, the link is:
 *   https://app.com/signup#access_token=...&type=invite
 *
 * Supabase processes the hash on mount, fires SIGNED_IN, and the user is
 * authenticated. This page prompts them to set a password, then redirects
 * to /configuration for the HubSpot API key setup.
 *
 * Company assignment is handled server-side (admin-invite-user creates the
 * company_members row before the invite email is sent).
 *
 * If this page is visited without an invite token in the hash, the user is
 * redirected to /login.
 */
export default function Signup() {
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [companyId, setCompanyId] = useState(null)
  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const hash = window.location.hash
    if (!hash.includes('type=invite')) {
      navigate('/login', { replace: true })
      return
    }

    setReady(true)

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setSession(session)
        loadCompanyId(session.user.id)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        setSession(session)
        loadCompanyId(session.user.id)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadCompanyId(userId) {
    const { data } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', userId)
      .maybeSingle()
    setCompanyId(data?.company_id ?? null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }

    setLoading(true)
    setError(null)

    // Set the user's password
    const { error: pwError } = await supabase.auth.updateUser({ password })
    if (pwError) { setError(pwError.message); setLoading(false); return }

    // Create their hs_user_config row with company_id + default settings
    const { error: configError } = await supabase
      .from('hs_user_config')
      .upsert(
        {
          user_id: session.user.id,
          company_id: companyId,
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
            Set a password to activate your account.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
              autoFocus
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
