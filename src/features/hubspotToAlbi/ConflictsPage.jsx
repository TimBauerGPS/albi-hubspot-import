import { useCallback, useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { getH2AConflict, getH2AConflicts, getH2AOverview, resolveH2AConflict } from '../../lib/hubspotToAlbi'
import ConflictDetail from './ConflictDetail'
import { conflictEvidenceSummary } from './operations.js'

const MANY_TO_ONE_MESSAGE = 'This target is already mapped. Explicit many-to-one approval is required.'
const RESUME_PENDING_MESSAGE = 'Resolution was saved; its targeted resume remains pending for retry.'
const buttonSecondary = 'rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'
const statusTone = {
  open: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  resolving: 'bg-brand-50 text-brand-800 ring-brand-600/20',
  resolved: 'bg-green-50 text-green-800 ring-green-600/20',
  skipped: 'bg-gray-100 text-gray-700 ring-gray-500/20',
}

function label(value) {
  return String(value ?? 'Unknown').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase())
}

function dateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function conflictTitle(conflict) {
  const snapshot = conflict?.source_snapshot ?? {}
  return snapshot.name || [snapshot.firstName ?? snapshot.firstname, snapshot.lastName ?? snapshot.lastname].filter(Boolean).join(' ') ||
    snapshot.email || `${label(conflict?.object_type)} review`
}

export default function ConflictsPage() {
  const { session, companyId, companyName, isAdmin, tenantRevision, completeTenantTransition } = useOutletContext()
  const [items, setItems] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [unresolvedCount, setUnresolvedCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState('info')
  const [staleRefreshRequired, setStaleRefreshRequired] = useState(null)
  const [busyConflict, setBusyConflict] = useState('')
  const [retryToken, setRetryToken] = useState(0)
  const requestRevision = useRef(0)
  const mutationControllers = useRef(new Set())
  const tenantKey = `${companyId ?? 'none'}:${tenantRevision}`
  const tenantKeyRef = useRef(tenantKey)
  tenantKeyRef.current = tenantKey

  const replaceConflict = useCallback(item => {
    if (!item?.id) return
    setItems(current => current.some(existing => existing.id === item.id)
      ? current.map(existing => existing.id === item.id ? item : existing)
      : [item, ...current])
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const request = ++requestRevision.current
    setItems([])
    setNextCursor(null)
    setSelectedId(null)
    setUnresolvedCount(0)
    setLoading(true)
    setLoadError('')
    setActionError('')
    setNotice('')
    setNoticeKind('info')
    setStaleRefreshRequired(null)
    if (!companyId) {
      setLoading(false)
      setLoadError('Select a company to load conflicts.')
      completeTenantTransition(tenantRevision)
      return () => controller.abort()
    }
    Promise.all([
      getH2AConflicts(session, companyId, { limit: 25, signal: controller.signal }),
      getH2AOverview(session, companyId, { limit: 1, signal: controller.signal }),
    ]).then(([page, overview]) => {
      if (requestRevision.current !== request || tenantKeyRef.current !== tenantKey) return
      const loaded = Array.isArray(page?.items) ? page.items : []
      setItems(loaded)
      setNextCursor(page?.nextCursor ?? null)
      setSelectedId(loaded.find(item => item.status === 'open')?.id ?? loaded[0]?.id ?? null)
      setUnresolvedCount(overview?.summary?.unresolvedConflictCount ?? 0)
    }).catch(cause => {
      if (cause?.name !== 'AbortError' && requestRevision.current === request && tenantKeyRef.current === tenantKey) setLoadError(cause.message)
    }).finally(() => {
      if (requestRevision.current === request && tenantKeyRef.current === tenantKey) {
        setLoading(false)
        completeTenantTransition(tenantRevision)
      }
    })
    return () => controller.abort()
  }, [companyId, completeTenantTransition, retryToken, session, tenantKey, tenantRevision])

  useEffect(() => () => {
    for (const controller of mutationControllers.current) controller.abort()
    mutationControllers.current.clear()
  }, [tenantKey])

  async function refreshFocused(conflictId, signal) {
    const [focused, overview] = await Promise.all([
      getH2AConflict(session, companyId, conflictId, { signal }),
      getH2AOverview(session, companyId, { limit: 1, signal }),
    ])
    if (tenantKeyRef.current !== tenantKey) return null
    replaceConflict(focused?.item)
    setUnresolvedCount(overview?.summary?.unresolvedConflictCount ?? 0)
    return focused?.item ?? null
  }

  async function handleResolve(resolution) {
    const controller = new AbortController()
    mutationControllers.current.add(controller)
    const startedFor = tenantKey
    setBusyConflict(resolution.conflictId)
    setActionError('')
    setNotice('')
    try {
      await resolveH2AConflict(session, companyId, resolution, { signal: controller.signal })
      if (tenantKeyRef.current !== startedFor) return null
      await refreshFocused(resolution.conflictId, controller.signal)
      if (tenantKeyRef.current === startedFor) {
        setStaleRefreshRequired(current => current === resolution.conflictId ? null : current)
        setNoticeKind('success')
        setNotice('Resolution saved. The selected item and unresolved count are up to date.')
      }
      return { ok: true }
    } catch (cause) {
      if (cause?.name === 'AbortError' || tenantKeyRef.current !== startedFor) return null
      if (cause?.status === 409 && cause.message === MANY_TO_ONE_MESSAGE) return { manyToOneRequired: true }
      if (cause?.status === 409) {
        try {
          await refreshFocused(resolution.conflictId, controller.signal)
          if (tenantKeyRef.current !== startedFor) return null
          setStaleRefreshRequired(current => current === resolution.conflictId ? null : current)
          setNoticeKind('warning')
          setNotice('This conflict changed. Its detail and unresolved count were refreshed; review it before submitting again.')
        } catch (refreshCause) {
          if (refreshCause?.name === 'AbortError' || tenantKeyRef.current !== startedFor) return null
          setStaleRefreshRequired(resolution.conflictId)
          setActionError('This conflict changed, but its fresh detail and unresolved count could not be refreshed. Refresh selected item before resolving it again.')
        }
        return { stale: true }
      }
      if (cause?.status === 502 && cause.message === RESUME_PENDING_MESSAGE) {
        try { await refreshFocused(resolution.conflictId, controller.signal) } catch (refreshCause) {
          if (refreshCause?.name === 'AbortError' || tenantKeyRef.current !== startedFor) return null
          /* The saved state remains durable even if this focused read fails. */
        }
        if (tenantKeyRef.current !== startedFor) return null
        setNoticeKind('warning')
        setNotice('Resolution saved; the targeted activity resume is pending a safe retry.')
        return { saved: true }
      }
      setActionError(cause.message)
      return null
    } finally {
      mutationControllers.current.delete(controller)
      if (tenantKeyRef.current === startedFor) setBusyConflict('')
    }
  }

  async function refreshSelectedItem() {
    if (!selectedId) return
    const controller = new AbortController()
    mutationControllers.current.add(controller)
    const startedFor = tenantKey
    setBusyConflict(selectedId)
    setActionError('')
    try {
      await refreshFocused(selectedId, controller.signal)
      if (tenantKeyRef.current !== startedFor) return
      setStaleRefreshRequired(current => current === selectedId ? null : current)
      setNoticeKind('info')
      setNotice('The selected item and unresolved count are now up to date. Review the new values before resolving.')
    } catch (cause) {
      if (cause?.name !== 'AbortError' && tenantKeyRef.current === startedFor) {
        setStaleRefreshRequired(selectedId)
        setActionError('The selected conflict could not be refreshed. Try Refresh selected item again.')
      }
    } finally {
      mutationControllers.current.delete(controller)
      if (tenantKeyRef.current === startedFor) setBusyConflict('')
    }
  }

  async function loadMore() {
    if (!nextCursor) return
    const controller = new AbortController()
    mutationControllers.current.add(controller)
    const startedFor = tenantKey
    setLoadingMore(true)
    setActionError('')
    try {
      const page = await getH2AConflicts(session, companyId, { cursor: nextCursor, limit: 25, signal: controller.signal })
      if (tenantKeyRef.current !== startedFor) return
      setItems(current => [...current, ...(page?.items ?? [])])
      setNextCursor(page?.nextCursor ?? null)
    } catch (cause) {
      if (cause?.name !== 'AbortError' && tenantKeyRef.current === startedFor) setActionError(cause.message)
    } finally {
      mutationControllers.current.delete(controller)
      if (tenantKeyRef.current === startedFor) {
        setLoadingMore(false)
      }
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600" role="status" aria-live="polite">Loading conflict queue…</div>
  }

  if (loadError) {
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 px-5 py-6" role="alert">
        <h2 className="font-semibold text-red-900">Conflicts could not be loaded</h2>
        <p className="mt-1 text-sm text-red-800">{loadError}</p>
        <button className={`${buttonSecondary} mt-4`} onClick={() => setRetryToken(value => value + 1)}>Try again</button>
      </section>
    )
  }

  const selected = items.find(item => item.id === selectedId) ?? null

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">{companyName || 'Selected company'}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-gray-900">Conflict review</h2>
            <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-600/20" aria-label={`${unresolvedCount} unresolved conflicts`}>
              {unresolvedCount} unresolved
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500">Review why an identity or field value needs a decision before allowing the sync to continue.</p>
        </div>
        {!isAdmin && <p className="max-w-sm rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600">Member read-only mode: you can inspect evidence and audit history, but only an admin can resolve conflicts.</p>}
      </header>

      <div className="min-h-5 text-sm" aria-live="polite">
        {notice && <p className={noticeKind === 'success' ? 'text-green-800' : noticeKind === 'warning' ? 'text-amber-800' : 'text-brand-800'} role="status">{notice}</p>}
        {actionError && <p className="text-red-700" role="alert">{actionError}</p>}
        {staleRefreshRequired === selectedId && (
          <button className={`${buttonSecondary} mt-3`} type="button" onClick={refreshSelectedItem} disabled={busyConflict === selectedId}>
            Refresh selected item
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-center">
          <h3 className="font-semibold text-gray-900">No conflicts recorded</h3>
          <p className="mt-1 text-sm text-gray-500">New review items will appear here with the evidence needed to decide safely.</p>
        </section>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(16rem,0.7fr)_minmax(0,1.6fr)] lg:items-start">
          <aside className="overflow-hidden rounded-xl border border-gray-200 bg-white lg:sticky lg:top-4" aria-labelledby="conflict-queue-title">
            <div className="border-b border-gray-200 px-4 py-3">
              <h3 id="conflict-queue-title" className="text-sm font-semibold text-gray-900">Review queue and history</h3>
              <p className="mt-1 text-xs text-gray-500">Newest first; status stays visible after resolution.</p>
            </div>
            <ol className="max-h-[36rem] divide-y divide-gray-100 overflow-y-auto">
              {items.map(item => (
                <li key={item.id}>
                  <button type="button" onClick={() => {
                    setSelectedId(item.id)
                    setActionError('')
                    setNotice('')
                    setNoticeKind('info')
                  }} aria-current={selectedId === item.id ? 'true' : undefined}
                    className={`w-full px-4 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${selectedId === item.id ? 'bg-brand-50' : 'hover:bg-gray-50'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-gray-900">{conflictTitle(item)}</span>
                      <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[0.68rem] font-semibold capitalize ring-1 ring-inset ${statusTone[item.status] ?? statusTone.skipped}`}>{label(item.status)}</span>
                    </div>
                    <p className="mt-1 text-xs font-medium text-gray-600">{label(item.conflict_type)} · {label(item.reason)}</p>
                    <p className="mt-1 truncate text-xs text-gray-600">{conflictEvidenceSummary(item)}</p>
                    <p className="mt-1 text-xs text-gray-500">{label(item.object_type)} · {dateTime(item.created_at)}</p>
                  </button>
                </li>
              ))}
            </ol>
            {nextCursor && (
              <div className="border-t border-gray-100 px-4 py-3">
                <button className={`${buttonSecondary} w-full`} onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
              </div>
            )}
          </aside>

          {selected ? (
            <ConflictDetail conflict={selected} isAdmin={isAdmin} busy={busyConflict === selected.id} resolutionBlocked={staleRefreshRequired === selected.id} onResolve={handleResolve} />
          ) : (
            <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-500">Select an item to inspect its evidence.</section>
          )}
        </div>
      )}
    </div>
  )
}
