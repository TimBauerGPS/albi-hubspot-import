import { useEffect, useState } from 'react'
import AppShell from '../components/AppShell'

function StatusBadge({ status }) {
  const map = {
    valid:     { bg: 'bg-green-100 text-green-800', dot: 'bg-green-500',  label: 'Valid' },
    invalid:   { bg: 'bg-red-100 text-red-800',     dot: 'bg-red-500',    label: 'Invalid' },
    unchecked: { bg: 'bg-gray-100 text-gray-600',   dot: 'bg-gray-400',   label: 'Unchecked' },
  }
  const s = map[status] || map.unchecked
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${s.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}

export default function Admin({ session, isAdmin, companyName }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  // Invite modal state
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteCompany, setInviteCompany] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState(null) // { success } | { error }

  // Revoke state
  const [revoking, setRevoking] = useState(null) // userId currently being revoked

  useEffect(() => { loadUsers() }, [])

  async function loadUsers() {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/.netlify/functions/admin-users', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load users')
      setUsers(data.users)
    } catch (err) {
      setLoadError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleInvite(e) {
    e.preventDefault()
    setInviting(true)
    setInviteResult(null)
    try {
      const res = await fetch('/.netlify/functions/admin-invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ email: inviteEmail.trim(), company_name: inviteCompany.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Invite failed')
      setInviteResult({ success: `Invite sent to ${inviteEmail.trim()}` })
      setInviteEmail('')
      setInviteCompany('')
      await loadUsers()
    } catch (err) {
      setInviteResult({ error: err.message })
    } finally {
      setInviting(false)
    }
  }

  async function handleRevoke(targetUser) {
    const name = targetUser.company_name || targetUser.email
    if (!window.confirm(
      `Revoke access for "${name}"?\n\nThis permanently deletes their account and all associated data. This cannot be undone.`
    )) return

    setRevoking(targetUser.id)
    try {
      const res = await fetch('/.netlify/functions/admin-revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ targetUserId: targetUser.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Revoke failed')
      await loadUsers()
    } catch (err) {
      alert(err.message)
    } finally {
      setRevoking(null)
    }
  }

  function openInviteModal() {
    setInviteEmail('')
    setInviteCompany('')
    setInviteResult(null)
    setShowInvite(true)
  }

  return (
    <AppShell session={session} isAdmin={isAdmin} companyName={companyName}>
      <div className="max-w-5xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Companies</h1>
            <p className="text-sm text-gray-500 mt-1">
              {loading ? 'Loading…' : `${users.length} registered ${users.length === 1 ? 'company' : 'companies'}`}
            </p>
          </div>
          <button
            onClick={openInviteModal}
            className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
          >
            Invite Company
          </button>
        </div>

        {loadError && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            {loadError}
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Email</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Config</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Last Import</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Joined</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">No users yet</td>
                  </tr>
                )}
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {u.company_name || <span className="text-gray-400 italic font-normal">Not set</span>}
                      {u.is_admin && (
                        <span className="ml-2 text-xs bg-brand-100 text-brand-700 rounded-full px-2 py-0.5 font-medium">
                          Admin
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{u.email}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={u.config_status} />
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {u.last_import
                        ? new Date(u.last_import).toLocaleDateString()
                        : <span className="text-gray-400">Never</span>
                      }
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!u.is_admin && (
                        <button
                          onClick={() => handleRevoke(u)}
                          disabled={revoking === u.id}
                          className="text-xs text-red-600 hover:text-red-800 disabled:opacity-40 font-medium transition-colors"
                        >
                          {revoking === u.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Invite modal */}
      {showInvite && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="font-semibold text-gray-900 mb-1">Invite Company</h3>
            <p className="text-xs text-gray-500 mb-4">
              They'll receive an email to set their password and configure their account.
            </p>

            <form onSubmit={handleInvite} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Company name</label>
                <input
                  type="text"
                  value={inviteCompany}
                  onChange={e => setInviteCompany(e.target.value)}
                  required
                  autoFocus
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Allied Restoration – Denver"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email address</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="manager@example.com"
                />
              </div>

              {inviteResult?.error && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
                  {inviteResult.error}
                </p>
              )}
              {inviteResult?.success && (
                <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
                  {inviteResult.success}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowInvite(false)}
                  className="flex-1 px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviting}
                  className="flex-1 px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 font-medium transition-colors"
                >
                  {inviting ? 'Sending…' : 'Send Invite'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  )
}
