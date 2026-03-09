/**
 * HeldDeals — shows all deals held due to unmatched referrers.
 *
 * A deal is held when:
 *   - It has a non-Google referrer in the Albi CSV
 *   - The referrer could not be matched to a HubSpot contact or company
 *
 * From this page the user can:
 *   - See which referrer is missing for each deal
 *   - Blacklist a deal (adds it to the excluded list so future imports ignore it)
 *   - Send an email to each sales person with a list of their referrers to add to HubSpot
 *
 * Deals are automatically resolved on the next import run if the referrer is
 * added to HubSpot and a sync is run beforehand.
 */

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import AppShell from '../components/AppShell'

// ── Email-draft modal ─────────────────────────────────────────────────────────

function EmailModal({ drafts, onClose }) {
  const [copied, setCopied] = useState(null)

  function copyBody(idx, text) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(idx)
      setTimeout(() => setCopied(null), 2000)
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">Email Referrer Requests</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              One draft per sales person. Click "Open in email" to send via your email client.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
          {drafts.map((draft, idx) => (
            <div key={idx} className="px-6 py-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-800">{draft.name}</p>
                  {draft.email ? (
                    <p className="text-xs text-gray-500">{draft.email}</p>
                  ) : (
                    <p className="text-xs text-amber-600">Email not found in sales team config</p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => copyBody(idx, draft.body)}
                    className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    {copied === idx ? 'Copied!' : 'Copy body'}
                  </button>
                  {draft.email && (
                    <a
                      href={`mailto:${draft.email}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}
                      className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
                    >
                      Open in email
                    </a>
                  )}
                </div>
              </div>
              <pre className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3 whitespace-pre-wrap font-sans">
                {draft.body}
              </pre>
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HeldDeals({ session }) {
  const [heldDeals, setHeldDeals] = useState([])
  const [salesTeam, setSalesTeam] = useState([])
  const [loading, setLoading] = useState(true)
  const [blacklisting, setBlacklisting] = useState(null)   // job_id being single-blacklisted
  const [bulkBlacklisting, setBulkBlacklisting] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set()) // Set of held deal IDs (uuid)
  const [emailModal, setEmailModal] = useState(null) // array of drafts | null

  useEffect(() => {
    loadData()
  }, [session])

  async function loadData() {
    setLoading(true)
    const [{ data: deals }, { data: config }] = await Promise.all([
      supabase
        .from('hs_held_deals')
        .select('*')
        .eq('user_id', session.user.id)
        .is('resolved_at', null)
        .order('created_at', { ascending: false }),
      supabase
        .from('hs_user_config')
        .select('sales_team, blacklist')
        .eq('user_id', session.user.id)
        .maybeSingle(),
    ])
    setHeldDeals(deals || [])
    setSalesTeam(config?.sales_team || [])
    setLoading(false)
  }

  async function handleBlacklist(deal) {
    if (!window.confirm(`Blacklist "${deal.job_id}"? It will be excluded from all future imports.`)) return
    setBlacklisting(deal.job_id)
    try {
      // Add to blacklist in hs_user_config
      const { data: config } = await supabase
        .from('hs_user_config')
        .select('blacklist')
        .eq('user_id', session.user.id)
        .single()
      const current = config?.blacklist || []
      if (!current.includes(deal.job_id)) {
        await supabase
          .from('hs_user_config')
          .update({ blacklist: [...current, deal.job_id] })
          .eq('user_id', session.user.id)
      }

      // Mark held deal as resolved (without a HubSpot deal ID)
      await supabase
        .from('hs_held_deals')
        .update({ resolved_at: new Date().toISOString() })
        .eq('id', deal.id)

      // Refresh list
      await loadData()
    } catch (err) {
      alert('Failed to blacklist deal: ' + err.message)
    }
    setBlacklisting(null)
  }

  // ── Selection helpers ──────────────────────────────────────────────────────
  const allSelected = heldDeals.length > 0 && selectedIds.size === heldDeals.length
  const someSelected = selectedIds.size > 0 && !allSelected

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(heldDeals.map(d => d.id)))
    }
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Bulk blacklist ─────────────────────────────────────────────────────────
  async function handleBulkBlacklist() {
    const count = selectedIds.size
    if (!window.confirm(`Blacklist ${count} deal${count !== 1 ? 's' : ''}? They will be excluded from all future imports.`)) return
    setBulkBlacklisting(true)
    try {
      const selectedDeals = heldDeals.filter(d => selectedIds.has(d.id))
      const jobIds = selectedDeals.map(d => d.job_id)

      // Fetch current blacklist and merge
      const { data: config } = await supabase
        .from('hs_user_config')
        .select('blacklist')
        .eq('user_id', session.user.id)
        .single()
      const current = config?.blacklist || []
      const merged = [...new Set([...current, ...jobIds])]
      await supabase
        .from('hs_user_config')
        .update({ blacklist: merged })
        .eq('user_id', session.user.id)

      // Mark all selected held deals as resolved
      const now = new Date().toISOString()
      await supabase
        .from('hs_held_deals')
        .update({ resolved_at: now })
        .eq('user_id', session.user.id)
        .in('id', [...selectedIds])

      setSelectedIds(new Set())
      await loadData()
    } catch (err) {
      alert('Failed to blacklist deals: ' + err.message)
    }
    setBulkBlacklisting(false)
  }

  function handleEmailRequest() {
    if (heldDeals.length === 0) return

    // Build a map: sales person name (lowercase) → { name, email, deals[] }
    const salesTeamMap = {}
    for (const member of salesTeam) {
      const key = String(member.name || '').trim().toLowerCase()
      if (key) salesTeamMap[key] = { name: member.name, email: member.email || null, deals: [] }
    }

    // Group held deals by sales_person
    const grouped = {}
    const ungrouped = [] // held deals with no sales_person or unrecognised name

    for (const deal of heldDeals) {
      const spKey = String(deal.sales_person || '').trim().toLowerCase()
      if (spKey && salesTeamMap[spKey]) {
        salesTeamMap[spKey].deals.push(deal)
        grouped[spKey] = true
      } else {
        ungrouped.push(deal)
      }
    }

    // Build email drafts (one per sales person who has held deals)
    const drafts = []
    for (const [, member] of Object.entries(salesTeamMap)) {
      if (member.deals.length === 0) continue
      const dealLines = member.deals
        .map(d => `  • ${d.job_id} — ${d.deal_name} (Referrer: ${d.referrer})`)
        .join('\n')

      const subject = `Action Required: Please Add Missing Referrers to HubSpot`
      const body = `Hi ${member.name},

The following jobs you're assigned to have referrers that couldn't be found in HubSpot. These deals are on hold and won't be imported until their referrers are added as a Contact or Company in HubSpot.

${dealLines}

Please add each referrer listed above to HubSpot (as a Contact or Company). Once added, run a HubSpot sync in the importer and the next import will automatically link and create these deals.

Thank you!`

      drafts.push({ name: member.name, email: member.email, subject, body })
    }

    // If there are ungrouped deals (sales person not in config), add a catch-all draft
    if (ungrouped.length > 0) {
      const dealLines = ungrouped
        .map(d => `  • ${d.job_id} — ${d.deal_name} (Referrer: ${d.referrer}, Sales Person: ${d.sales_person || 'Unknown'})`)
        .join('\n')
      drafts.push({
        name: 'Unassigned / Unknown Sales Person',
        email: null,
        subject: 'Held Deals — No Matching Sales Person',
        body: `The following held deals could not be matched to a configured sales person:\n\n${dealLines}\n\nPlease update the Sales Team configuration or manually link these deals in HubSpot.`,
      })
    }

    if (drafts.length === 0) {
      alert('No held deals could be matched to sales team members. Make sure your Sales Team is configured in Settings.')
      return
    }

    setEmailModal(drafts)
  }

  const formatDate = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
  const formatCurrency = val => val != null ? `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'

  if (loading) {
    return (
      <AppShell session={session}>
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell session={session}>
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Held Deals</h1>
            <p className="text-sm text-gray-500 mt-1">
              Deals whose referrer could not be matched to a HubSpot contact or company.
              They will be created automatically on the next import after the referrer is added to HubSpot and a sync is run.
            </p>
          </div>
          {heldDeals.length > 0 && (
            <div className="flex items-center gap-2 shrink-0">
              {selectedIds.size > 0 && (
                <button
                  onClick={handleBulkBlacklist}
                  disabled={bulkBlacklisting}
                  className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {bulkBlacklisting ? 'Blacklisting…' : `Blacklist Selected (${selectedIds.size})`}
                </button>
              )}
              <button
                onClick={handleEmailRequest}
                className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
              >
                Email Referrer Requests
              </button>
            </div>
          )}
        </div>

        {heldDeals.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-12 text-center">
            <p className="text-gray-500 text-sm">No held deals — all referrers were matched.</p>
          </div>
        ) : (
          <>
            {/* Info banner */}
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
              <span className="font-semibold">{heldDeals.length} deal{heldDeals.length !== 1 ? 's' : ''} on hold.</span>
              {' '}To resolve: add the referrer to HubSpot as a Contact or Company, run a Sync in Configuration, then re-import.
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3 w-8">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={el => { if (el) el.indeterminate = someSelected }}
                          onChange={toggleSelectAll}
                          className="rounded border-gray-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                        />
                      </th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 whitespace-nowrap">Job ID</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600">Deal Name</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 whitespace-nowrap">Referrer (Missing in HubSpot)</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 whitespace-nowrap">Sales Person</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 whitespace-nowrap">Pipeline</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600 whitespace-nowrap">Est. Revenue</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 whitespace-nowrap">Held Since</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {heldDeals.map(deal => (
                      <tr
                        key={deal.id}
                        className={`hover:bg-gray-50 cursor-pointer ${selectedIds.has(deal.id) ? 'bg-brand-50' : ''}`}
                        onClick={() => toggleSelect(deal.id)}
                      >
                        <td className="px-4 py-3 w-8" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(deal.id)}
                            onChange={() => toggleSelect(deal.id)}
                            className="rounded border-gray-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-700 whitespace-nowrap">
                          {deal.job_id}
                        </td>
                        <td className="px-4 py-3 text-gray-700 max-w-xs">
                          <span className="block truncate">{deal.deal_name}</span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5 text-amber-700 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                            {deal.referrer}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                          {deal.sales_person || <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                          {deal.pipeline || <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 tabular-nums whitespace-nowrap">
                          {formatCurrency(deal.estimated_revenue)}
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                          {formatDate(deal.created_at)}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => handleBlacklist(deal)}
                            disabled={blacklisting === deal.job_id}
                            className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-50 transition-colors"
                          >
                            {blacklisting === deal.job_id ? 'Blacklisting…' : 'Blacklist'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {emailModal && (
        <EmailModal drafts={emailModal} onClose={() => setEmailModal(null)} />
      )}
    </AppShell>
  )
}
