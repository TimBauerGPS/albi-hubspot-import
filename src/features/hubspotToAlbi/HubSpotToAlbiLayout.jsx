import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import AppShell from '../../components/AppShell'
import { getH2ASettings } from '../../lib/hubspotToAlbi'
import CompanySelector from './CompanySelector'

const TABS = [
  { to: '/hubspot-to-albi', label: 'Overview', end: true },
  { to: '/hubspot-to-albi/conflicts', label: 'Conflicts' },
  { to: '/hubspot-to-albi/sample-review', label: 'Sample Review', adminOnly: true, setupOnly: true },
  { to: '/hubspot-to-albi/settings', label: 'Settings' },
]

export default function HubSpotToAlbiLayout({
  session,
  companyId,
  companyName,
  isAdmin,
  isSuperAdmin,
}) {
  const [selectedCompany, setSelectedCompany] = useState({ id: companyId, name: companyName })
  const [tenantRevision, setTenantRevision] = useState(0)
  const [tenantChanging, setTenantChanging] = useState(false)
  // The selected company's sync state; once live, dry-run and sample review screens are hidden.
  const [syncState, setSyncState] = useState({ companyId: null, state: null })

  useEffect(() => {
    if (!isSuperAdmin || !selectedCompany.id) {
      setSelectedCompany({ id: companyId, name: companyName })
    }
  }, [companyId, companyName, isSuperAdmin, selectedCompany.id])

  useEffect(() => {
    const id = selectedCompany.id
    if (!id || !session) return undefined
    const controller = new AbortController()
    getH2ASettings(session, id, { signal: controller.signal })
      .then(settings => { if (!controller.signal.aborted) setSyncState({ companyId: id, state: settings?.config?.state ?? null }) })
      .catch(() => { /* Unknown state keeps every tab visible. */ })
    return () => controller.abort()
  }, [selectedCompany.id, session])

  const reportSyncState = useCallback((id, state) => {
    if (id) setSyncState({ companyId: id, state: state ?? null })
  }, [])

  const syncLive = syncState.companyId === selectedCompany.id && syncState.state === 'live'

  const handleCompanyChange = useCallback(company => {
    setTenantChanging(true)
    setTenantRevision(revision => revision + 1)
    setSelectedCompany(company)
  }, [])

  const completeTenantTransition = useCallback(completedRevision => {
    setTenantChanging(current => completedRevision === tenantRevision ? false : current)
  }, [tenantRevision])

  const outletContext = useMemo(() => ({
    session,
    companyId: selectedCompany.id ?? null,
    companyName: selectedCompany.name ?? null,
    isAdmin,
    isSuperAdmin,
    tenantRevision,
    tenantChanging,
    completeTenantTransition,
    syncLive,
    reportSyncState,
  }), [
    completeTenantTransition,
    reportSyncState,
    syncLive,
    isAdmin,
    isSuperAdmin,
    selectedCompany.id,
    selectedCompany.name,
    session,
    tenantChanging,
    tenantRevision,
  ])

  return (
    <AppShell session={session} isAdmin={isAdmin} companyName={companyName}>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="border-b border-gray-200 pb-5">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">Relationship &amp; activity sync</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-gray-900">HubSpot <span aria-hidden="true">→</span><span className="sr-only">to</span> Albi</h1>
              <p className="mt-1 max-w-2xl text-sm text-gray-500">Manage tenant sync setup, operations, and review from one place.</p>
            </div>

            <CompanySelector
              session={session}
              isSuperAdmin={isSuperAdmin}
              value={selectedCompany.id}
              currentCompany={selectedCompany}
              onChange={handleCompanyChange}
              disabled={tenantChanging}
            />

            {!isSuperAdmin && (
              <div className="min-w-0 border-l-2 border-brand-600 pl-3 sm:max-w-xs">
                <p className="text-xs font-medium text-gray-500">Company context</p>
                <p className="truncate text-sm font-semibold text-gray-900" title={selectedCompany.name || undefined}>
                  {selectedCompany.name || 'No company assigned'}
                </p>
              </div>
            )}
          </div>

          <nav aria-label="HubSpot to Albi" className="mt-6 -mb-px overflow-x-auto">
            <div className="flex min-w-max gap-6">
              {TABS.filter(tab => (!tab.adminOnly || isAdmin) && !(tab.setupOnly && syncLive)).map(tab => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) => `border-b-2 px-1 py-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                    isActive
                      ? 'border-brand-600 text-brand-700'
                      : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800'
                  }`}
                >
                  {tab.label}
                </NavLink>
              ))}
            </div>
          </nav>
        </header>

        <div className="pt-6">
          {tenantChanging && (
            <div className="mb-4 flex items-center gap-2 text-sm text-gray-600" role="status" aria-live="polite">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-brand-600" aria-hidden="true" />
              Updating company context…
            </div>
          )}
          <Outlet key={`${selectedCompany.id ?? 'none'}:${tenantRevision}`} context={outletContext} />
        </div>
      </div>
    </AppShell>
  )
}
