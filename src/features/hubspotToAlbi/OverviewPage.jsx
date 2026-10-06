import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { getH2AOverview, runH2ASync } from '../../lib/hubspotToAlbi'
import { presentRunTotals } from './operations.js'

const ACTIVE_STATUSES = new Set(['queued', 'running', 'paused'])
const MAX_ACTIVE_POLLS = 12
const POLL_DELAY_MS = 5000
const statusTone = {
  completed: 'bg-green-50 text-green-800 ring-green-600/20',
  partially_failed: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  failed: 'bg-red-50 text-red-800 ring-red-600/20',
  paused: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  cancelled: 'bg-gray-100 text-gray-700 ring-gray-500/20',
  queued: 'bg-brand-50 text-brand-800 ring-brand-600/20',
  running: 'bg-brand-50 text-brand-800 ring-brand-600/20',
}
const buttonPrimary = 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const buttonSecondary = 'rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'

function words(value) {
  return String(value ?? 'Unknown').replaceAll('_', ' ')
}

function dateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not yet'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold capitalize ring-1 ring-inset ${statusTone[status] ?? statusTone.cancelled}`}>
      {words(status)}
    </span>
  )
}

function RunTotals({ run }) {
  const totals = presentRunTotals(run)
  if (totals.length === 0) return <span className="text-xs text-gray-500">No outcome totals recorded</span>
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1">
      {totals.map(total => (
        <div key={total.key} className="flex gap-1 text-xs">
          <dt className="text-gray-500">{total.label}</dt>
          <dd className="font-semibold tabular-nums text-gray-900">{total.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function OverviewPage() {
  const { session, companyId, companyName, isAdmin, tenantRevision, completeTenantTransition } = useOutletContext()
  const [overview, setOverview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [runningNow, setRunningNow] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const requestRevision = useRef(0)
  const pollCount = useRef(0)
  const mutationControllers = useRef(new Set())
  const tenantKey = `${companyId ?? 'none'}:${tenantRevision}`
  const tenantKeyRef = useRef(tenantKey)
  tenantKeyRef.current = tenantKey

  const loadFirstPage = useCallback(async signal => {
    const value = await getH2AOverview(session, companyId, { limit: 15, signal })
    if (tenantKeyRef.current === tenantKey) setOverview(value)
    return value
  }, [companyId, session, tenantKey])

  useEffect(() => {
    const controller = new AbortController()
    const request = ++requestRevision.current
    setOverview(null)
    setLoadError('')
    setActionError('')
    setNotice('')
    setLoading(true)
    pollCount.current = 0
    if (!companyId) {
      setLoading(false)
      setLoadError('Select a company to load the sync overview.')
      completeTenantTransition(tenantRevision)
      return () => controller.abort()
    }
    loadFirstPage(controller.signal)
      .catch(cause => {
        if (cause?.name !== 'AbortError' && requestRevision.current === request && tenantKeyRef.current === tenantKey) {
          setLoadError(cause.message)
        }
      })
      .finally(() => {
        if (requestRevision.current === request && tenantKeyRef.current === tenantKey) {
          setLoading(false)
          completeTenantTransition(tenantRevision)
        }
      })
    return () => controller.abort()
  }, [companyId, completeTenantTransition, loadFirstPage, retryToken, tenantKey, tenantRevision])

  useEffect(() => () => {
    for (const controller of mutationControllers.current) controller.abort()
    mutationControllers.current.clear()
  }, [tenantKey])

  const activeStatus = overview?.summary?.activeRun?.status
  const activeId = overview?.summary?.activeRun?.id
  useEffect(() => {
    if (!ACTIVE_STATUSES.has(activeStatus) || pollCount.current >= MAX_ACTIVE_POLLS) return undefined
    const controller = new AbortController()
    const startedFor = tenantKey
    const timer = window.setTimeout(async () => {
      pollCount.current += 1
      try {
        await loadFirstPage(controller.signal)
      } catch (cause) {
        if (cause?.name !== 'AbortError' && tenantKeyRef.current === startedFor) {
          setActionError('Run status could not be refreshed. Use Refresh to try again.')
        }
      }
    }, POLL_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [activeId, activeStatus, loadFirstPage, tenantKey, overview])

  const recentTotal = useMemo(() => presentRunTotals(overview?.summary?.recentRun)
    .reduce((sum, item) => sum + item.value, 0), [overview?.summary?.recentRun])

  async function runNow() {
    const controller = new AbortController()
    mutationControllers.current.add(controller)
    const startedFor = tenantKey
    setRunningNow(true)
    setActionError('')
    setNotice('')
    try {
      const result = await runH2ASync(session, companyId, 'live', { signal: controller.signal })
      if (tenantKeyRef.current !== startedFor) return
      setNotice(result?.status === 'already_running' ? 'A sync is already active for this company.' : 'Live sync queued.')
      pollCount.current = 0
      await loadFirstPage(controller.signal)
    } catch (cause) {
      if (cause?.name !== 'AbortError' && tenantKeyRef.current === startedFor) setActionError(cause.message)
    } finally {
      mutationControllers.current.delete(controller)
      if (tenantKeyRef.current === startedFor) setRunningNow(false)
    }
  }

  async function loadMore() {
    if (!overview?.nextCursor) return
    const controller = new AbortController()
    mutationControllers.current.add(controller)
    const startedFor = tenantKey
    setLoadingMore(true)
    setActionError('')
    try {
      const page = await getH2AOverview(session, companyId, { cursor: overview.nextCursor, limit: 15, signal: controller.signal })
      if (tenantKeyRef.current !== startedFor) return
      setOverview(current => ({ ...current, runs: [...current.runs, ...page.runs], nextCursor: page.nextCursor }))
    } catch (cause) {
      if (cause?.name !== 'AbortError' && tenantKeyRef.current === startedFor) setActionError(cause.message)
    } finally {
      mutationControllers.current.delete(controller)
      if (tenantKeyRef.current === startedFor) setLoadingMore(false)
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600" role="status" aria-live="polite">Loading sync overview…</div>
  }

  if (loadError) {
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 px-5 py-6" role="alert">
        <h2 className="font-semibold text-red-900">Overview could not be loaded</h2>
        <p className="mt-1 text-sm text-red-800">{loadError}</p>
        <button className={`${buttonSecondary} mt-4`} onClick={() => setRetryToken(value => value + 1)}>Try again</button>
      </section>
    )
  }

  const summary = overview?.summary ?? {}
  const activeRun = summary.activeRun
  const recentRun = summary.recentRun
  const lastSuccess = summary.lastSuccessfulRun
  const runDisabled = runningNow || ACTIVE_STATUSES.has(activeRun?.status)

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">{companyName || 'Selected company'}</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-gray-900">Operations overview</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500">A safe, tenant-scoped view of recent sync health and outcomes.</p>
        </div>
        {isAdmin ? (
          <button className={buttonPrimary} onClick={runNow} disabled={runDisabled}>
            {runningNow ? 'Queueing…' : ACTIVE_STATUSES.has(activeRun?.status) ? 'Run active' : 'Run now'}
          </button>
        ) : (
          <p className="max-w-xs rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600">Run now is an admin-only action. Your operational view is read-only.</p>
        )}
      </header>

      <div className="min-h-5 text-sm" aria-live="polite">
        {notice && <p className="text-green-800" role="status">{notice}</p>}
        {actionError && <p className="text-red-700" role="alert">{actionError}</p>}
      </div>

      {activeRun && (
        <section className="flex flex-col gap-3 border-l-4 border-brand-500 bg-brand-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="h2a-active-run">
          <div>
            <h3 id="h2a-active-run" className="text-sm font-semibold text-brand-950">Active sync · {words(activeRun.status)}</h3>
            <p className="mt-0.5 text-xs text-brand-800">{words(activeRun.mode)} mode, started {dateTime(activeRun.started_at || activeRun.created_at)}. Status refresh is bounded to one minute.</p>
          </div>
          <StatusBadge status={activeRun.status} />
        </section>
      )}

      <section aria-labelledby="h2a-health-title">
        <h3 id="h2a-health-title" className="sr-only">Sync health</h3>
        <dl className="grid gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Recent status', recentRun ? words(recentRun.status) : 'No runs yet'],
            ['Last successful sync', lastSuccess ? dateTime(lastSuccess.finished_at) : 'Not yet'],
            ['Open conflicts', summary.unresolvedConflictCount ?? 0],
            ['Recent processed / proposed', recentRun ? recentTotal : 0],
          ].map(([label, value]) => (
            <div key={label} className="bg-white px-4 py-4">
              <dt className="text-xs font-medium text-gray-500">{label}</dt>
              <dd className="mt-1 text-lg font-semibold text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="h2a-runs-title">
        <div className="border-b border-gray-200 px-5 py-4 sm:px-6">
          <h3 id="h2a-runs-title" className="font-semibold text-gray-900">Recent runs</h3>
          <p className="mt-1 text-xs text-gray-500">Newest first. Dry runs describe what would happen; live runs show recorded outcomes.</p>
        </div>
        {overview.runs.length === 0 ? (
          <div className="px-5 py-8 sm:px-6">
            <p className="text-sm font-medium text-gray-900">No sync runs yet</p>
            <p className="mt-1 text-sm text-gray-500">Finish activation in Settings, then queue a dry or live run.</p>
            <Link className="mt-4 inline-flex text-sm font-semibold text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" to="/hubspot-to-albi/settings">Open Settings</Link>
          </div>
        ) : (
          <ol className="divide-y divide-gray-100">
            {overview.runs.map(item => (
              <li key={item.id} className="px-5 py-4 sm:px-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={item.status} />
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{item.mode === 'dry_run' ? 'Dry run' : 'Live'} · {words(item.trigger)}</span>
                    </div>
                    <p className="mt-2 text-sm font-medium text-gray-900">{dateTime(item.started_at || item.created_at)}</p>
                    <div className="mt-2"><RunTotals run={item} /></div>
                    {item.errorCategory && <p className="mt-2 text-xs font-medium text-red-700">{item.errorCategory}</p>}
                  </div>
                  <p className="text-xs text-gray-500">{item.finished_at ? `Finished ${dateTime(item.finished_at)}` : 'Not finished'}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
        {overview.nextCursor && (
          <div className="border-t border-gray-100 px-5 py-4 sm:px-6">
            <button className={buttonSecondary} onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
          </div>
        )}
      </section>
    </div>
  )
}
