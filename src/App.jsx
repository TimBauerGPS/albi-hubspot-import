import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Configuration from './pages/Configuration'
import Import from './pages/Import'
import Dashboard from './pages/Dashboard'
import HeldDeals from './pages/HeldDeals'
import Admin from './pages/Admin'

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
    </div>
  )
}

function SetNewPasswordModal({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      setDone(true)
      setTimeout(onDone, 2500)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full mx-4">
        <h3 className="font-semibold text-gray-900 mb-1">Set New Password</h3>
        <p className="text-xs text-gray-500 mb-4">Choose a new password for your account.</p>
        {done ? (
          <div className="text-center py-4">
            <p className="text-sm font-semibold text-green-700">Password updated!</p>
            <p className="text-xs text-gray-500 mt-1">Redirecting to dashboard…</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">New password</label>
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
            {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 font-medium"
            >
              {loading ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

/**
 * Protected route — redirects to /login if unauthenticated, /no-access if app access denied.
 * Shows spinner while session or app access is still resolving.
 */
function ProtectedRoute({ session, hasAppAccess, children }) {
  if (session === undefined || hasAppAccess === null) return <Spinner />
  if (!session) return <Navigate to="/login" replace />
  if (!hasAppAccess) return <Navigate to="/no-access" replace />
  return children
}

/**
 * Admin-only route — redirects to / if not an admin.
 * Shows spinner while isAdmin or app access is still loading (null).
 */
function AdminRoute({ session, isAdmin, hasAppAccess, children }) {
  if (session === undefined || isAdmin === null || hasAppAccess === null) return <Spinner />
  if (!session) return <Navigate to="/login" replace />
  if (!hasAppAccess) return <Navigate to="/no-access" replace />
  if (!isAdmin) return <Navigate to="/" replace />
  return children
}

export default function App() {
  const [session, setSession] = useState(undefined)
  const [configStatus, setConfigStatus] = useState(null)
  const [isAdmin, setIsAdmin] = useState(null)         // null = loading, true/false = loaded
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [hasAppAccess, setHasAppAccess] = useState(null) // null = loading, true/false = resolved
  const [companyName, setCompanyName] = useState(null)
  const [companyId, setCompanyId] = useState(null)
  const [showResetModal, setShowResetModal] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadMembership(session.user.id)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session)
      if (event === 'PASSWORD_RECOVERY') setShowResetModal(true)
      if (session) loadMembership(session.user.id)
      else {
        setConfigStatus(null)
        setIsAdmin(null)
        setIsSuperAdmin(false)
        setHasAppAccess(null)
        setCompanyName(null)
        setCompanyId(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadMembership(userId) {
    const [memberRes, superRes] = await Promise.all([
      supabase
        .from('company_members')
        .select('company_id, role, companies(name)')
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('super_admins')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle(),
    ])
    const member = memberRes.data
    const companyId = member?.company_id ?? null

    // Check user's own config + any valid config in the company (in parallel).
    // The company query returns results after the RLS migration (Step 3) is applied;
    // until then it falls back gracefully to the user's own row.
    const [{ data: userConfig }, { data: companyValid }] = await Promise.all([
      supabase.from('hs_user_config').select('config_status').eq('user_id', userId).maybeSingle(),
      companyId
        ? supabase.from('hs_user_config').select('config_status').eq('company_id', companyId).eq('config_status', 'valid').maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    const { data: access } = await supabase
      .from('user_app_access')
      .select('role')
      .eq('app_name', 'albi-hubspot-import')
      .maybeSingle()

    setCompanyId(companyId)
    setCompanyName(member?.companies?.name ?? null)
    setIsSuperAdmin(!!superRes.data)
    setIsAdmin(!!superRes.data || member?.role === 'admin')
    setHasAppAccess(!!access)
    setConfigStatus(companyValid ? 'valid' : (userConfig?.config_status ?? 'unchecked'))
  }

  function getDefaultRedirect() {
    if (configStatus === 'valid') return '/dashboard'
    return '/configuration'
  }

  return (
    <BrowserRouter>
      {showResetModal && (
        <SetNewPasswordModal onDone={() => setShowResetModal(false)} />
      )}
      <Routes>
        {/* Public — no auth required */}
        <Route
          path="/login"
          element={
            session
              ? <Navigate to={getDefaultRedirect()} replace />
              : <Login />
          }
        />

        {/* Invite landing — must be accessible before account is fully set up */}
        <Route path="/signup" element={<Signup />} />

        {/* No app access */}
        <Route
          path="/no-access"
          element={
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
              <div className="bg-white rounded-2xl shadow p-8 max-w-sm w-full text-center">
                <p className="text-gray-900 font-semibold mb-1">Access Not Granted</p>
                <p className="text-sm text-gray-500">Your account doesn't have access to this app. Contact your administrator.</p>
              </div>
            </div>
          }
        />

        {/* Protected app routes */}
        <Route
          path="/configuration"
          element={
            <ProtectedRoute session={session} hasAppAccess={hasAppAccess}>
              <Configuration
                session={session}
                isAdmin={isAdmin}
                companyName={companyName}
                companyId={companyId}
                onConfigValid={() => setConfigStatus('valid')}
              />
            </ProtectedRoute>
          }
        />
        <Route
          path="/import"
          element={
            <ProtectedRoute session={session} hasAppAccess={hasAppAccess}>
              <Import session={session} isAdmin={isAdmin} companyName={companyName} companyId={companyId} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute session={session} hasAppAccess={hasAppAccess}>
              <Dashboard session={session} configStatus={configStatus} isAdmin={isAdmin} companyName={companyName} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/held-deals"
          element={
            <ProtectedRoute session={session} hasAppAccess={hasAppAccess}>
              <HeldDeals session={session} isAdmin={isAdmin} companyName={companyName} />
            </ProtectedRoute>
          }
        />

        {/* Admin-only */}
        <Route
          path="/admin"
          element={
            <AdminRoute session={session} isAdmin={isAdmin} hasAppAccess={hasAppAccess}>
              <Admin session={session} isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} companyName={companyName} companyId={companyId} />
            </AdminRoute>
          }
        />

        <Route
          path="/"
          element={<Navigate to={session ? getDefaultRedirect() : '/login'} replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
