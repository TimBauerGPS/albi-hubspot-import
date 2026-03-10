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

export default function Admin({ session, isAdmin, isSuperAdmin, companyName, companyId }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  // Invite modal state
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteCompany, setInviteCompany] = useState('')       // new company name
  const [inviteCompanyId, setInviteCompanyId] = useState('')   // existing company id
  const [inviteMode, setInviteMode] = useState('new')          // 'new' | 'existing'
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState(null) // { success } | { error }

  // Remove state
  const [removing, setRemoving] = useState(null) // userId being removed

  useEffect(() => { loadUsers() }, [])

  async function loadUsers() {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/.netlify/functions/admin-list-users', {
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
      const body = { email: inviteEmail.trim() }
      if (isSuperAdmin) {
        if (inviteMode === 'existing') body.company_id = inviteCompanyId
        else body.company_name = inviteCompany.trim()
      }
      const res = await fetch('/.netlify/functions/admin-invite-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Invite failed')
      const msg = data.isNew
        ? `Invite sent to ${inviteEmail.trim()}`
        : `${inviteEmail.trim()} already has an account — added to company.`
      setInviteResult({ success: msg })
      setInviteEmail('')
      setInviteCompany('')
      await loadUsers()
    } catch (err) {
      setInviteResult({ error: err.message })
    } finally {
      setInviting(false)
    }
  }

  async function handleRemove(targetUser) {
    if (!window.confirm(
      `Remove "${targetUser.email}" from ${targetUser.company_name || 'this company'}?\n\nThey will lose access immediately. Their account will not be deleted.`
    )) return

    setRemoving(targetUser.id)
    try {
      const res = await fetch('/.netlify/functions/admin-remove-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId: targetUser.id, companyId: targetUser.company_id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Remove failed')
      await loadUsers()
    } catch (err) {
      alert(err.message)
    } finally {
      setRemoving(null)
    }
  }

  function openInviteModal() {
    setInviteEmail('')
    setInviteCompany('')
    setInviteCompanyId('')
    setInviteMode('new')
    setInviteResult(null)
    setShowInvite(true)
  }

  // Unique companies derived from the loaded user list (for super admin existing-company picker)
  const existingCompanies = [...new Map(
    users
      .filter(u => u.company_id && u.company_name)
      .map(u => [u.company_id, { id: u.company_id, name: u.company_name }])
  ).values()].sort((a, b) => a.name.localeCompare(b.name))

  const pageTitle = isSuperAdmin ? 'Companies' : 'Team'
  const inviteButtonLabel = isSuperAdmin ? 'Add Company' : 'Invite Member'
  const countLabel = isSuperAdmin
    ? `${users.length} ${users.length === 1 ? 'member' : 'members'} across all companies`
    : `${users.length} team ${users.length === 1 ? 'member' : 'members'}`

  return (
    <AppShell session={session} isAdmin={isAdmin} companyName={companyName}>
      <div className="max-w-5xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{pageTitle}</h1>
            <p className="text-sm text-gray-500 mt-1">
              {loading ? 'Loading…' : countLabel}
            </p>
          </div>
          <button
            onClick={openInviteModal}
            className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
          >
            {inviteButtonLabel}
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
                  {isSuperAdmin && (
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Company</th>
                  )}
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Email</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Role</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Config</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Last Activity</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Joined</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.length === 0 && (
                  <tr>
                    <td colSpan={isSuperAdmin ? 7 : 6} className="px-4 py-8 text-center text-sm text-gray-400">
                      No members yet
                    </td>
                  </tr>
                )}
                {users.map(u => (
                  <tr key={`${u.id}-${u.company_id}`} className="hover:bg-gray-50 transition-colors">
                    {isSuperAdmin && (
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {u.company_name || <span className="text-gray-400 italic font-normal">No company</span>}
                      </td>
                    )}
                    <td className="px-4 py-3 text-gray-600">{u.email}</td>
                    <td className="px-4 py-3">
                      {u.is_super_admin ? (
                        <span className="inline-flex items-center text-xs font-medium text-brand-700 bg-brand-50 rounded-full px-2 py-0.5">
                          Super Admin
                        </span>
                      ) : u.role === 'admin' ? (
                        <span className="inline-flex items-center text-xs font-medium text-gray-700 bg-gray-100 rounded-full px-2 py-0.5">
                          Admin
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Member</span>
                      )}
                    </td>
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
                      {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!u.is_super_admin && u.id !== session.user.id && (
                        <button
                          onClick={() => handleRemove(u)}
                          disabled={removing === u.id}
                          className="text-xs text-red-600 hover:text-red-800 disabled:opacity-40 font-medium transition-colors"
                        >
                          {removing === u.id ? 'Removing…' : 'Remove'}
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
            <h3 className="font-semibold text-gray-900 mb-1">
              {isSuperAdmin ? (inviteMode === 'new' ? 'Add Company' : 'Add Member to Company') : 'Invite Member'}
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              {isSuperAdmin
                ? inviteMode === 'new'
                  ? 'Creates a new company and sends an invite to the first user.'
                  : 'Adds a member to an existing company.'
                : "They'll receive an email to set up their account."}
            </p>

            <form onSubmit={handleInvite} className="space-y-3">
              {isSuperAdmin && (
                <>
                  {/* Mode toggle */}
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
                    <button
                      type="button"
                      onClick={() => setInviteMode('new')}
                      className={`flex-1 py-1.5 transition-colors ${inviteMode === 'new' ? 'bg-brand-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      New Company
                    </button>
                    <button
                      type="button"
                      onClick={() => setInviteMode('existing')}
                      className={`flex-1 py-1.5 transition-colors ${inviteMode === 'existing' ? 'bg-brand-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      Existing Company
                    </button>
                  </div>

                  {inviteMode === 'new' ? (
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
                  ) : (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Company</label>
                      <select
                        value={inviteCompanyId}
                        onChange={e => setInviteCompanyId(e.target.value)}
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                      >
                        <option value="">Select a company…</option>
                        {existingCompanies.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email address</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  required
                  autoFocus={!isSuperAdmin}
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
                  {inviting ? 'Sending…' : (isSuperAdmin && inviteMode === 'existing' ? 'Add Member' : 'Send Invite')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  )
}
