import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { getH2ADryRunReview, getH2ADryRunReviews, recheckH2ADryRunReview, resolveH2ADryRunReview } from '../../lib/hubspotToAlbi'
import { presentSampleReviewItem, presentSampleReviewProgress, SAMPLE_REVIEW_REASON_OPTIONS } from './sampleReview.js'
import { presentSampleReviewQueryFilters } from './preflightPresentation.js'
import SampleReviewDetail from './SampleReviewDetail'

const secondaryButton = 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'
const selectClass = 'mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500'
const statusLabels = { needs_review: 'Needs review', cleared: 'Cleared', no_longer_in_scope: 'No longer in scope' }
const statusTone = { needs_review: 'bg-amber-50 text-amber-800 ring-amber-600/20', cleared: 'bg-green-50 text-green-800 ring-green-600/20', no_longer_in_scope: 'bg-green-50 text-green-800 ring-green-600/20' }
const resolutionLabels = { pending: 'Needs decision', applying: 'Applying', waiting_on_albi: 'Waiting on Albi',
  ready_to_recheck: 'Ready to recheck', completed: 'Completed', failed: 'Action failed', superseded: 'Superseded' }
const initialFilters = { status: '', objectType: '', reason: '' }

function queuePresentation(item) {
  return presentSampleReviewItem({ ...item, sourceSnapshot: item.sourceSnapshot ?? {
    fullName: item.displayName, email: item.identity?.email, phoneNumber: item.identity?.phone,
    organizationName: item.identity?.organizationName, domain: item.identity?.domain,
  } })
}

function recheckTime(value) {
  return value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not rechecked yet'
}

export default function SampleReviewPage() {
  const { session, companyId, companyName, tenantRevision, completeTenantTransition } = useOutletContext()
  const location = useLocation()
  const navigate = useNavigate()
  const initialQuery = useRef(presentSampleReviewQueryFilters(location.search))
  const tenantKey = `${companyId ?? 'none'}:${tenantRevision}`
  const tenantKeyRef = useRef(tenantKey)
  tenantKeyRef.current = tenantKey
  const requestRevision = useRef(0)
  const detailRevision = useRef(0)
  const controllers = useRef(new Set())
  const recheckLock = useRef(null)
  const [stateTenant, setStateTenant] = useState(tenantKey)
  const [filters, setFilters] = useState(initialQuery.current.filters)
  const [items, setItems] = useState([])
  const [sample, setSample] = useState(null)
  const [progress, setProgress] = useState(null)
  const [nextCursor, setNextCursor] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [retryToken, setRetryToken] = useState(0)
  const [detailRetry, setDetailRetry] = useState(0)

  const replaceItem = useCallback(item => {
    if (!item?.id) return
    setItems(current => current.map(existing => existing.id === item.id ? { ...existing, ...item } : existing))
  }, [])

  useEffect(() => {
    if (initialQuery.current.invalid) navigate(location.pathname, { replace: true })
  }, [location.pathname, navigate])

  useEffect(() => {
    for (const pending of controllers.current) pending.abort()
    controllers.current.clear()
    recheckLock.current = null
    const controller = new AbortController()
    controllers.current.add(controller)
    const request = ++requestRevision.current
    const startedFor = tenantKey
    setStateTenant(startedFor)
    setItems([]); setSample(null); setProgress(null); setSelectedId(null); setDetail(null); setNextCursor(null)
    setLoading(true); setLoadingMore(false); setBusyId(null)
    setLoadError(''); setDetailError(''); setActionError(''); setNotice('')
    const current = () => !controller.signal.aborted && requestRevision.current === request && tenantKeyRef.current === startedFor
    async function load() {
      try {
        if (!companyId) { setLoadError('Select a company to load sample reviews.'); return }
        const result = await getH2ADryRunReviews(session, companyId, { ...filters, limit: 25, signal: controller.signal })
        if (!current()) return
        const loaded = Array.isArray(result?.items) ? result.items : []
        setItems(loaded); setSample(result?.sample ?? null); setProgress(result?.progress ?? null)
        setNextCursor(result?.nextCursor ?? null)
        setSelectedId(loaded.find(item => item.status === 'needs_review')?.id ?? loaded[0]?.id ?? null)
      } catch (cause) {
        if (current() && cause?.name !== 'AbortError') setLoadError(cause.message)
      } finally {
        controllers.current.delete(controller)
        if (current()) { setLoading(false); completeTenantTransition(tenantRevision) }
      }
    }
    load()
    return () => {
      controller.abort()
      for (const pending of controllers.current) pending.abort()
      controllers.current.clear()
    }
  }, [companyId, session, tenantKey, tenantRevision, completeTenantTransition, filters, retryToken])

  useEffect(() => {
    const controller = new AbortController()
    controllers.current.add(controller)
    const request = ++detailRevision.current
    const listRequest = requestRevision.current
    const startedFor = tenantKey
    setDetail(null); setDetailError(''); setDetailLoading(Boolean(selectedId))
    const current = () => !controller.signal.aborted && request === detailRevision.current && listRequest === requestRevision.current &&
      tenantKeyRef.current === startedFor && selectedIdRef.current === selectedId
    if (selectedId) getH2ADryRunReview(session, companyId, selectedId, { signal: controller.signal }).then(result => {
      if (current()) { setDetail(result?.item ?? null); replaceItem(result?.item) }
    }).catch(cause => {
      if (current() && cause?.name !== 'AbortError') setDetailError(cause.message)
    }).finally(() => {
      controllers.current.delete(controller)
      if (current()) setDetailLoading(false)
    })
    return () => { controller.abort(); controllers.current.delete(controller) }
  }, [companyId, session, tenantKey, selectedId, detailRetry, replaceItem])

  async function loadMore() {
    if (!nextCursor || loadingMore || recheckLock.current) return
    const controller = new AbortController()
    controllers.current.add(controller)
    const request = requestRevision.current
    const startedFor = tenantKey
    const current = () => !controller.signal.aborted && requestRevision.current === request && tenantKeyRef.current === startedFor
    setLoadingMore(true); setActionError('')
    try {
      const result = await getH2ADryRunReviews(session, companyId, { ...filters, cursor: nextCursor, limit: 25, signal: controller.signal })
      if (!current()) return
      if (result?.sample?.id !== sample?.id) {
        // A cursor belongs to the old sample. Discard this page and reload the
        // current first page before publishing any replacement evidence.
        ++requestRevision.current; ++detailRevision.current
        for (const pending of controllers.current) pending.abort()
        controllers.current.clear(); recheckLock.current = null; selectedIdRef.current = null
        setItems([]); setSample(null); setProgress(null); setNextCursor(null); setSelectedId(null); setDetail(null)
        setLoading(true); setLoadingMore(false); setDetailLoading(false); setBusyId(null)
        setLoadError(''); setDetailError(''); setActionError(''); setNotice('')
        setRetryToken(value => value + 1)
        return
      }
      setItems(existing => {
        const unique = new Map(existing.map(item => [item.id, item]))
        for (const item of result?.items ?? []) if (!unique.has(item.id)) unique.set(item.id, item)
        return [...unique.values()]
      })
      setSample(result?.sample ?? null); setProgress(result?.progress ?? null)
      setNextCursor(result?.nextCursor ?? null)
    } catch (cause) {
      if (current() && cause?.name !== 'AbortError') setActionError(cause.message)
    } finally {
      controllers.current.delete(controller)
      if (current()) setLoadingMore(false)
    }
  }

  async function handleRecheck() {
    if (!detail?.updatedAt || detail.id !== selectedId || recheckLock.current) return
    // Recheck owns a new generation so prior pages cannot restore stale
    // progress. Keep the current queue and cursor for a later pagination retry.
    const request = ++requestRevision.current
    ++detailRevision.current
    for (const pending of controllers.current) pending.abort()
    controllers.current.clear()
    setLoadingMore(false); setDetailLoading(false)
    const controller = new AbortController()
    controllers.current.add(controller)
    recheckLock.current = controller
    const startedFor = tenantKey
    const reviewId = detail.id
    const current = () => !controller.signal.aborted && requestRevision.current === request && tenantKeyRef.current === startedFor
    setBusyId(reviewId); setActionError(''); setNotice('')
    try {
      const result = await recheckH2ADryRunReview(session, companyId, { reviewId, expectedUpdatedAt: detail.updatedAt }, { signal: controller.signal })
      if (!current()) return
      replaceItem(result?.item)
      if (selectedIdRef.current === reviewId) { ++detailRevision.current; setDetail(result?.item ?? null); setDetailLoading(false) }
      setProgress(result?.progress ?? null)
      setNotice('Recheck complete. The record and review progress are up to date.')
    } catch (cause) {
      if (!current() || cause?.name === 'AbortError') return
      if (cause?.status === 409) {
        try {
          const result = await getH2ADryRunReview(session, companyId, reviewId, { signal: controller.signal })
          if (!current()) return
          replaceItem(result?.item)
          if (selectedIdRef.current === reviewId) { ++detailRevision.current; setDetail(result?.item ?? null); setDetailLoading(false) }
          setNotice('This sample review changed. Its current detail was refreshed; review it before rechecking again.')
        } catch (refreshCause) {
          if (!current() || refreshCause?.name === 'AbortError') return
          if (selectedIdRef.current === reviewId) { setDetail(null); setDetailError('This sample review changed and could not be refreshed. Retry loading the record or reload the current queue.') }
          setActionError('The current sample may have changed. Reload the queue to review the latest sample.')
        }
      } else setActionError(`Recheck failed. ${cause.message} Your previous evidence is unchanged. Try Recheck this record again.`)
    } finally {
      controllers.current.delete(controller)
      if (recheckLock.current === controller) recheckLock.current = null
      if (current()) setBusyId(null)
    }
  }

  async function handleResolve(decision, clientRequestId, expectedUpdatedAt) {
    if (!detail?.updatedAt || detail.id !== selectedId || recheckLock.current) return null
    if (detail.updatedAt !== expectedUpdatedAt) throw Object.assign(new Error('This sample review changed. Review and confirm again.'), { status: 409 })
    const request = ++requestRevision.current
    ++detailRevision.current
    for (const pending of controllers.current) pending.abort()
    controllers.current.clear()
    setLoadingMore(false); setDetailLoading(false)
    const controller = new AbortController()
    controllers.current.add(controller)
    recheckLock.current = controller
    const startedFor = tenantKey
    const reviewId = detail.id
    const current = () => !controller.signal.aborted && requestRevision.current === request && tenantKeyRef.current === startedFor
    setBusyId(reviewId); setActionError(''); setNotice('')
    try {
      const result = await resolveH2ADryRunReview(session, companyId,
        { reviewId, expectedUpdatedAt, clientRequestId, ...decision }, { signal: controller.signal })
      if (!current()) return null
      try {
        const fresh = await getH2ADryRunReview(session, companyId, reviewId, { signal: controller.signal })
        if (current()) {
          replaceItem(fresh?.item)
          if (selectedIdRef.current === reviewId) { ++detailRevision.current; setDetail(fresh?.item ?? null); setDetailLoading(false) }
        }
      } catch (refreshCause) {
        if (current() && refreshCause?.name !== 'AbortError') setActionError('Resolution was saved, but current detail could not be loaded. Retry loading the record.')
      }
      return result
    } catch (cause) {
      if (!current() || cause?.name === 'AbortError') return null
      if (cause?.status === 409) {
        try {
          const fresh = await getH2ADryRunReview(session, companyId, reviewId, { signal: controller.signal })
          if (current()) {
            replaceItem(fresh?.item)
            if (selectedIdRef.current === reviewId) { ++detailRevision.current; setDetail(fresh?.item ?? null); setDetailLoading(false) }
          }
        } catch (refreshCause) {
          if (current() && refreshCause?.name !== 'AbortError') {
            setDetail(null); setDetailError('This sample review changed and current detail could not be loaded. Retry loading the record.')
          }
        }
      }
      throw cause
    } finally {
      controllers.current.delete(controller)
      if (recheckLock.current === controller) recheckLock.current = null
      if (current()) setBusyId(null)
    }
  }

  const visible = stateTenant === tenantKey
  const counters = presentSampleReviewProgress(visible ? progress : null)
  const historical = sample && (sample.historical || sample.reviewCaptureVersion !== 1)
  const clean = sample?.reviewCaptureVersion === 1 && progress?.total === 0 && progress?.fullDryRunReady === true
  const allCleared = sample?.reviewCaptureVersion === 1 && progress?.total > 0 && progress?.needsReview === 0
  const setFilter = (key, value) => setFilters(current => ({ ...current, [key]: value }))
  const clearFilters = () => setFilters({ ...initialFilters })

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">{companyName || 'Selected company'}</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-gray-900">Sample review</h2>
          <p className="mt-1 max-w-xl text-sm leading-6 text-gray-600">Review underlying contacts and organizations, correct them in HubSpot or Albi, then recheck the evidence.</p>
        </div>
        <dl className="grid shrink-0 grid-cols-3 gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3" aria-label="Sample review progress" aria-live="polite" aria-busy={loading || !visible}>
          {counters.map(counter => <div key={counter.key}><dt className="text-xs font-medium text-gray-600">{counter.label}</dt><dd className={`mt-1 text-xl font-semibold tabular-nums ${counter.key === 'needsReview' && counter.value ? 'text-amber-800' : counter.value ? 'text-green-800' : 'text-gray-900'}`}>{loading || !visible ? '—' : counter.value}</dd></div>)}
        </dl>
      </header>

      <div className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end" role="group" aria-label="Filter sample reviews">
        <label htmlFor="sample-review-status" className="text-xs font-medium text-gray-700">Status<select id="sample-review-status" value={filters.status} onChange={event => setFilter('status', event.target.value)} className={selectClass}><option value="">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label htmlFor="sample-review-object" className="text-xs font-medium text-gray-700">Object type<select id="sample-review-object" value={filters.objectType} onChange={event => setFilter('objectType', event.target.value)} className={selectClass}><option value="">All records</option><option value="contacts">Contacts</option><option value="companies">Organizations</option></select></label>
        <label htmlFor="sample-review-reason" className="text-xs font-medium text-gray-700">Reason<select id="sample-review-reason" value={filters.reason} onChange={event => setFilter('reason', event.target.value)} className={selectClass}><option value="">All reasons</option>{SAMPLE_REVIEW_REASON_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <button type="button" className={secondaryButton} onClick={clearFilters}>Clear filters</button>
      </div>

      <div className="text-sm" aria-live="polite">
        {visible && notice && <p className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-brand-800" role="status">{notice}</p>}
        {visible && actionError && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800" role="alert"><p>{actionError}</p><button type="button" onClick={() => setRetryToken(value => value + 1)} className={`${secondaryButton} mt-3`}>Reload queue</button></div>}
        {visible && !loading && allCleared && <p className="mt-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-800" role="status">Corrections are clear for this sample. Run a fresh sample to verify them; this sample does not unlock the full dry run.</p>}
      </div>

      {loading || !visible ? <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600" role="status">Loading sample reviews…</section>
        : loadError ? <section className="rounded-xl border border-red-200 bg-red-50 px-5 py-6" role="alert"><h3 className="font-semibold text-red-900">Sample reviews could not be loaded</h3><p className="mt-1 text-sm text-red-800">{loadError}</p><button type="button" className={`${secondaryButton} mt-4`} onClick={() => setRetryToken(value => value + 1)}>Try again</button></section>
          : historical || !sample || clean ? <section className="rounded-xl border border-gray-200 bg-white px-5 py-10" role="status">
            <h3 className="font-semibold text-gray-900">{historical ? 'Run a new sample to create detailed review data' : clean ? 'No underlying records need correction' : 'No completed sample is available'}</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">{historical ? 'This historical sample did not capture detailed evidence. Start a new sample in Settings.' : clean ? 'This fresh sample captured zero underlying review records. The full dry run is now available in Settings.' : 'If a sample is running, wait for it to finish. Go to Settings to check its status or start a sample.'}</p>
            <Link to="/hubspot-to-albi/settings" className="mt-4 inline-block text-sm font-semibold text-brand-700 underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Go to Settings</Link>
          </section> : items.length === 0 ? <section className="rounded-xl border border-gray-200 bg-white px-5 py-10" role="status"><h3 className="font-semibold text-gray-900">No records match these filters</h3><p className="mt-2 text-sm text-gray-600">Review progress still includes every record in this sample.</p><button type="button" className={`${secondaryButton} mt-4`} onClick={clearFilters}>Clear filters</button></section>
            : <div className="grid gap-5 lg:grid-cols-[minmax(16rem,0.7fr)_minmax(0,1.6fr)] lg:items-start">
              <aside className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white lg:sticky lg:top-4" aria-labelledby="sample-review-queue-title">
                <div className="border-b border-gray-200 px-4 py-3"><h3 id="sample-review-queue-title" className="text-sm font-semibold text-gray-900">Underlying review records</h3><p className="mt-1 text-xs leading-5 text-gray-600">Newest first. Rechecked records stay in the sample history.</p></div>
                <ol className="max-h-[36rem] divide-y divide-gray-100 overflow-y-auto">{items.map(item => {
                  const review = queuePresentation(item)
                  return <li key={review.id}><button type="button" onClick={() => { setSelectedId(review.id); setActionError(''); setNotice('') }} aria-current={selectedId === review.id ? 'true' : undefined}
                    className={`w-full px-4 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${selectedId === review.id ? 'bg-brand-50' : 'hover:bg-gray-50'}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-semibold text-gray-900">{review.displayName}</span><span className={`rounded-md px-1.5 py-0.5 text-[0.68rem] font-semibold ring-1 ring-inset ${statusTone[review.status]}`}>{statusLabels[review.status]}</span></div>
                    <p className="mt-1 text-xs font-medium text-gray-600">{review.objectType === 'companies' ? 'Organization' : 'Contact'} · {review.reasonLabel}</p>
                    {review.resolutionStatus && <span className="mt-1 inline-flex rounded-md bg-blue-50 px-1.5 py-0.5 text-[0.68rem] font-semibold text-blue-800 ring-1 ring-inset ring-blue-600/20">{resolutionLabels[review.resolutionStatus]}</span>}
                    <div className="mt-2 space-y-1 break-words text-xs text-gray-700">{[review.source.email, review.source.phoneNumber, review.source.organizationName, review.source.domain].filter(Boolean).map((value, index) => <p key={index}>{value}</p>)}</div>
                    <p className="mt-2 break-all text-xs text-gray-600">HubSpot ID: {review.sourceId}</p><p className="mt-1 text-xs text-gray-500">Last recheck: {recheckTime(review.lastRecheckedAt)}</p>
                  </button></li>
                })}</ol>
                {nextCursor && <div className="border-t border-gray-100 px-4 py-3"><button type="button" onClick={loadMore} disabled={loadingMore || Boolean(busyId)} className={`${secondaryButton} w-full`}>{loadingMore ? 'Loading…' : 'Load more'}</button></div>}
              </aside>
              {detailLoading ? <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600" role="status">Loading selected record…</section>
                : detailError ? <section className="rounded-xl border border-red-200 bg-red-50 px-5 py-6" role="alert"><h3 className="font-semibold text-red-900">Record could not be loaded</h3><p className="mt-1 text-sm text-red-800">{detailError}</p><button type="button" className={`${secondaryButton} mt-3`} onClick={() => setDetailRetry(value => value + 1)}>Retry loading record</button></section>
                  : detail?.id === selectedId ? <SampleReviewDetail item={detail} busy={busyId === selectedId} recheckPending={Boolean(busyId)} onRecheck={handleRecheck} onResolve={handleResolve} />
                    : <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600">Select a record to review its evidence.</section>}
            </div>}
      {visible && sample?.reviewCaptureVersion === 1 && !loading && <p className="text-xs leading-5 text-gray-600">Review progress reflects individual rechecks. Original sample run totals remain unchanged.</p>}
    </div>
  )
}
