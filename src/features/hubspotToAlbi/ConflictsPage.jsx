import { useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { getH2AConflicts, getH2AOverview, prepareH2ALiveReviews } from '../../lib/hubspotToAlbi'
import { conflictEvidenceSummary } from './operations.js'
import ReviewWorkspace from './ReviewWorkspace.jsx'

const buttonSecondary = 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'
// Contact and organization conflicts are reviewed in the live workspace. Everything else (activity-only
// conflict types) keeps a read-only legacy view until those types are inventoried.
const WORKSPACE_TYPES = new Set(['contacts', 'companies'])
const PREPARE_MAX_PAGES = 200
const statusTone = {
  open: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  resolving: 'bg-brand-50 text-brand-800 ring-brand-600/20',
  resolved: 'bg-green-50 text-green-800 ring-green-600/20',
  skipped: 'bg-gray-100 text-gray-700 ring-gray-500/20',
}
const label = value => String(value ?? 'Unknown').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase())
const activityOnly = items => (Array.isArray(items) ? items : []).filter(item => item?.id && !WORKSPACE_TYPES.has(item.object_type))
const count = value => Number.isFinite(Number(value)) ? Number(value) : 0

function dateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function conflictTitle(conflict) {
  const snapshot = conflict?.source_snapshot ?? {}
  return snapshot.name || [snapshot.firstName ?? snapshot.firstname, snapshot.lastName ?? snapshot.lastname].filter(Boolean).join(' ') ||
    snapshot.email || `${label(conflict?.object_type)} review`
}

// Conflicts: the same review workspace as Sample review, on live rows, plus the one-off backfill and
// a read-only list for activity-only conflicts.
export default function ConflictsPage() {
  const { session, companyId, companyName, isAdmin, tenantRevision, completeTenantTransition } = useOutletContext()
  const tenantKey = `${companyId ?? 'none'}:${tenantRevision}`
  const tenantKeyRef = useRef(tenantKey)
  tenantKeyRef.current = tenantKey
  const [reloadToken, setReloadToken] = useState(0)
  const [unresolvedCount, setUnresolvedCount] = useState(null)
  const [activity, setActivity] = useState({ tenant: null, items: [], nextCursor: null })
  const [activityError, setActivityError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [prepare, setPrepare] = useState(null)
  const [prepareError, setPrepareError] = useState('')

  useEffect(() => {
    setUnresolvedCount(null); setActivity({ tenant: tenantKey, items: [], nextCursor: null }); setActivityError(''); setLoadingMore(false)
    if (!companyId) return undefined
    const controller = new AbortController()
    const startedFor = tenantKey
    const current = () => !controller.signal.aborted && tenantKeyRef.current === startedFor
    Promise.all([
      getH2AConflicts(session, companyId, { limit: 25, signal: controller.signal }),
      getH2AOverview(session, companyId, { limit: 1, signal: controller.signal }),
    ]).then(([page, overview]) => {
      if (!current()) return
      setActivity({ tenant: startedFor, items: activityOnly(page?.items), nextCursor: page?.nextCursor ?? null })
      setUnresolvedCount(overview?.summary?.unresolvedConflictCount ?? 0)
    }).catch(cause => {
      if (current() && cause?.name !== 'AbortError') setActivityError(cause.message)
    })
    return () => controller.abort()
  }, [companyId, session, tenantKey, reloadToken])

  // A tenant switch abandons a running backfill's report; the server work itself is idempotent.
  useEffect(() => { setPrepare(null); setPrepareError('') }, [tenantKey])

  async function loadMore() {
    if (!activity.nextCursor || loadingMore) return
    const startedFor = tenantKey
    setLoadingMore(true); setActivityError('')
    try {
      const page = await getH2AConflicts(session, companyId, { cursor: activity.nextCursor, limit: 25 })
      if (tenantKeyRef.current !== startedFor) return
      setActivity(previous => previous.tenant !== startedFor ? previous : { tenant: startedFor,
        items: [...previous.items, ...activityOnly(page?.items).filter(item => !previous.items.some(existing => existing.id === item.id))],
        nextCursor: page?.nextCursor ?? null })
    } catch (cause) {
      if (tenantKeyRef.current === startedFor && cause?.name !== 'AbortError') setActivityError(cause.message)
    } finally {
      if (tenantKeyRef.current === startedFor) setLoadingMore(false)
    }
  }

  // "Prepare open conflicts for review": repeat the server backfill page until nextCursor is null.
  async function prepareOpenConflicts() {
    if (!isAdmin || !companyId || prepare?.running) return
    const startedFor = tenantKey
    const totals = { captured: 0, linked: 0, skipped: 0, failed: 0 }
    setPrepare({ running: true, ...totals }); setPrepareError('')
    try {
      let cursor
      for (let page = 0; page < PREPARE_MAX_PAGES; page += 1) {
        const result = await prepareH2ALiveReviews(session, companyId, { cursor })
        if (tenantKeyRef.current !== startedFor) return
        for (const key of Object.keys(totals)) totals[key] += count(result?.[key])
        setPrepare({ running: true, ...totals })
        cursor = result?.nextCursor ?? null
        if (!cursor) break
      }
      setPrepare({ running: false, finished: true, ...totals })
    } catch (cause) {
      if (tenantKeyRef.current !== startedFor) return
      setPrepare({ running: false, ...totals })
      setPrepareError(`${cause.message} Records prepared so far are kept; run it again to continue.`)
    }
    if (tenantKeyRef.current === startedFor) setReloadToken(value => value + 1)
  }

  const prepareSummary = prepare ? `${prepare.captured} captured, ${prepare.linked} linked${prepare.skipped ? `, ${prepare.skipped} skipped` : ''}${prepare.failed ? `, ${prepare.failed} failed` : ''}` : ''
  const activityItems = activity.tenant === tenantKey ? activity.items : []
  const activityCursor = activity.tenant === tenantKey ? activity.nextCursor : null

  return <div className="space-y-5">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="break-words text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">{companyName || 'Selected company'}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-gray-900">Conflict review</h2>
          {unresolvedCount !== null && <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-600/20" aria-label={`${unresolvedCount} unresolved conflicts`}>
            {unresolvedCount} unresolved</span>}
        </div>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">Records the live sync held for a decision. Review them the same way as the sample review.</p>
      </div>
      {!isAdmin && <p className="max-w-sm rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600">Member read-only mode: you can inspect evidence, but only an admin can resolve conflicts.</p>}
    </header>

    {isAdmin && <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="conflicts-prepare-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 id="conflicts-prepare-title" className="text-sm font-semibold text-gray-900">Open conflicts from earlier syncs</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">Captures existing open contact and organization conflicts as review records. Safe to run more than once; nothing is written to Albi or HubSpot.</p>
        </div>
        <button type="button" className={`${buttonSecondary} shrink-0`} disabled={Boolean(prepare?.running) || !companyId} onClick={prepareOpenConflicts}>
          {prepare?.running ? 'Preparing…' : 'Prepare open conflicts for review'}</button>
      </div>
      <div aria-live="polite">
        {prepare && <p className={`mt-3 rounded-lg border px-4 py-3 text-sm ${prepare.finished ? 'border-green-200 bg-green-50 text-green-800' : 'border-brand-200 bg-brand-50 text-brand-800'}`} role="status">
          {prepare.running ? `Preparing… ${prepareSummary} so far.` : prepare.finished ? `Prepared open conflicts: ${prepareSummary}.` : `Stopped after ${prepareSummary}.`}</p>}
        {prepareError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{prepareError}</p>}
      </div>
    </section>}

    <ReviewWorkspace kind="live" session={session} companyId={companyId} tenantRevision={tenantRevision}
      completeTenantTransition={completeTenantTransition} isAdmin={isAdmin} reloadToken={reloadToken} />

    {(activityItems.length > 0 || activityCursor || activityError) && <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="conflicts-activity-title">
      <div className="border-b border-gray-200 px-4 py-3">
        <h3 id="conflicts-activity-title" className="text-sm font-semibold text-gray-900">Activity conflicts</h3>
        <p className="mt-1 text-xs text-gray-600">Read-only. Activity conflicts are listed here for reference; newest first.</p>
      </div>
      {activityError && <p className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{activityError}</p>}
      <ol className="max-h-[24rem] divide-y divide-gray-100 overflow-y-auto">
        {activityItems.length === 0 && !activityError && <li className="px-4 py-4 text-sm text-gray-600">No activity conflicts on this page.</li>}
        {activityItems.map(item => <li key={item.id} className="px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 break-words text-sm font-semibold text-gray-900">{conflictTitle(item)}</span>
            <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[0.68rem] font-semibold capitalize ring-1 ring-inset ${statusTone[item.status] ?? statusTone.skipped}`}>{label(item.status)}</span>
          </div>
          <p className="mt-1 text-xs font-medium text-gray-600">{label(item.conflict_type)} · {label(item.reason)}</p>
          <p className="mt-1 break-words text-xs text-gray-600">{conflictEvidenceSummary(item)}</p>
          <p className="mt-1 text-xs text-gray-500">{label(item.object_type)} · {dateTime(item.created_at)}</p>
        </li>)}
      </ol>
      {activityCursor && <div className="border-t border-gray-100 px-4 py-3">
        <button type="button" className={`${buttonSecondary} w-full`} onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
      </div>}
    </section>}
  </div>
}
