import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Configuration from './pages/Configuration'
import Import from './pages/Import'
import Dashboard from './pages/Dashboard'
import HeldDeals from './pages/HeldDeals'

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
 * Protected route — redirects to /login if unauthenticated.
 * If authenticated but config is unchecked/invalid, redirects to /configuration.
 */
function ProtectedRoute({ session, configStatus, children }) {
  if (session === undefined) return <Spinner />
  if (!session) return <Navigate to="/login" replace />
  return children
}

/**
 * Redirects authenticated users away from /configuration if config is already valid,
 * unless they are explicitly navigating there.
 */
function ConfigRoute({ session, configStatus, children }) {
  if (session === undefined) return <Spinner />
  if (!session) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  const [session, setSession] = useState(undefined)
  const [configStatus, setConfigStatus] = useState(null) // null | 'unchecked' | 'valid' | 'invalid'
  const [showResetModal, setShowResetModal] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadConfigStatus(session.user.id)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session)
      if (event === 'PASSWORD_RECOVERY') setShowResetModal(true)
      if (session) loadConfigStatus(session.user.id)
      else setConfigStatus(null)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadConfigStatus(userId) {
    const { data } = await supabase
      .from('hs_user_config')
      .select('config_status')
      .eq('user_id', userId)
      .maybeSingle()
    setConfigStatus(data?.config_status ?? 'unchecked')
  }

  // After login, decide where to send the user
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
        <Route
          path="/login"
          element={
            session
              ? <Navigate to={getDefaultRedirect()} replace />
              : <Login />
          }
        />
        <Route
          path="/configuration"
          element={
            <ConfigRoute session={session} configStatus={configStatus}>
              <Configuration
                session={session}
                onConfigValid={() => setConfigStatus('valid')}
              />
            </ConfigRoute>
          }
        />
        <Route
          path="/import"
          element={
            <ProtectedRoute session={session} configStatus={configStatus}>
              <Import session={session} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute session={session} configStatus={configStatus}>
              <Dashboard session={session} configStatus={configStatus} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/held-deals"
          element={
            <ProtectedRoute session={session} configStatus={configStatus}>
              <HeldDeals session={session} />
            </ProtectedRoute>
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
