import { useCallback, useEffect, useRef, useState } from 'react'
import { bulkLinkH2AReviews, createH2AOrganizationThenContact, getH2ACreateBatch, startH2ACreateBatch, getH2ADryRunReview, getH2AReviews, prepareH2AMergedSurvivorReview,
  prepareH2AOrganizationReview, recheckH2ADryRunReview, resolveH2ADryRunReview, skipH2ALiveReview, startH2ARecheckAll } from '../../lib/hubspotToAlbi'
import { BUCKETS, createDeferredQueue, fieldLabel, nextRecordId, shortcutFor } from './reviewWorkspace.js'
import { presentSampleReviewItem, SAMPLE_REVIEW_REASON_OPTIONS } from './sampleReview.js'
import { buildResolutionConfirmation } from './sampleReviewResolution.js'
import { btn, Kbd, primary } from './ResolutionBar.jsx'
import AlbiTodo from './AlbiTodo.jsx'
import ReviewQueue from './ReviewQueue.jsx'
import ReviewRecord from './ReviewRecord.jsx'
import ShortcutHelp from './ShortcutHelp.jsx'
import { blockedReasonCopy } from '../../../shared/h2aBlockedReasons.js'

// Why Create selected left a record alone (the batch's reason codes), in the page's words.
const CREATE_SKIP_COPY = {
  changed: 'It changed after it was selected. Open it to see the latest.',
  has_candidates: 'Albi now has a possible match for it. Open it to decide.',
  not_open: 'It is no longer waiting to be created.',
  not_creatable: 'It can’t be created from Quick wins. Open it to see why.',
  not_found: 'It could not be found.',
  not_ready: 'Its create checks did not pass. Open it to see why.',
  create_failed: 'Albi did not confirm the create. Open it to check.',
  error: 'Creating it failed. Open it and try again.',
}
const createSkipCopy = code => blockedReasonCopy(code) ?? CREATE_SKIP_COPY[code] ?? CREATE_SKIP_COPY.not_ready

const UNDO_MS = 5000
const BULK_CHUNK = 25
const BULK_DETAIL_CONCURRENCY = 4
const RECHECK_IDS_MAX = 200
const CHANGED = 'This record changed; review it again.'
const OPEN_BUCKETS = ['quick', 'decision', 'blocked']
const statusLabels = { needs_review: 'Needs review', cleared: 'Cleared', no_longer_in_scope: 'No longer in scope' }
const SKIP_REASONS = { changed: 'changed since you looked', linked_elsewhere: 'linked elsewhere', not_eligible: 'no longer an exact match' }
const blankFilters = { status: '', objectType: '', reason: '' }
const selectClass = 'mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500'
const danger = 'rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
// Keys that write; members (read-only) get navigation, picking, help and the Albi to-do only.
const WRITE_KEYS = new Set(['accept', 'link', 'create', 'skip', 'recheck', 'toggle'])
const inside = (target, selector) => !!target && typeof target.closest === 'function' && !!target.closest(selector)
const text = value => typeof value === 'string' && value.trim() ? value.trim() : ''
const list = value => Array.isArray(value) ? value : []
const without = (record, key) => { if (!Object.hasOwn(record, key)) return record; const next = { ...record }; delete next[key]; return next }
const nameOf = item => text(item?.displayName) || presentSampleReviewItem(item).displayName
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

async function mapLimit(values, limit, run) {
  const results = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await run(values[index]) }
  }))
  return results
}

// Risky-action confirmation with a focus trap. The workspace moves focus in and back out.
function ConfirmDialog({ dialog, panelRef, confirmRef, onConfirm, onCancel }) {
  function onKeyDown(event) {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); onCancel(); return }
    if (event.key !== 'Tab') return
    const controls = [...(panelRef.current?.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled)') ?? [])]
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); panelRef.current?.focus(); return }
    const active = document.activeElement
    if (event.shiftKey && (active === first || !controls.includes(active))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (active === last || !controls.includes(active))) { event.preventDefault(); first.focus() }
  }
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-950/45 px-4 py-4 sm:items-center"
    role="dialog" aria-modal="true" aria-labelledby="review-confirm-title" onKeyDown={onKeyDown}>
    <div ref={panelRef} tabIndex={-1} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl outline-none">
      <h3 id="review-confirm-title" className="text-lg font-semibold text-gray-900">{dialog.title}</h3>
      <ul className="mt-3 space-y-1 break-words text-sm text-gray-700">{dialog.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <div className="mt-5 flex flex-row-reverse flex-wrap gap-2">
        <button ref={confirmRef} type="button" data-dialog-confirm="true" className={dialog.danger ? danger : primary} onClick={onConfirm}>{dialog.confirmLabel}<Kbd>Enter</Kbd></button>
        <button type="button" className={btn} onClick={onCancel}>Cancel<Kbd>Esc</Kbd></button>
      </div>
    </div>
  </div>
}

// Deferred actions waiting for their undo window, newest last.
function UndoToasts({ entries, onUndo, onSendNow }) {
  return <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
    {entries.map(entry => <div key={entry.id} role="status" className="pointer-events-auto flex items-center justify-between gap-3 rounded-lg bg-gray-900 px-4 py-3 text-sm text-white shadow-lg">
      <span className="min-w-0">
        <span className="block break-words">{entry.sending ? `Sending: ${entry.label}` : entry.label}</span>
        {!entry.sending && <span className="mt-1 block h-1 overflow-hidden rounded bg-white/20"><span className="block h-full animate-[h2a-undo_5s_linear_forwards] bg-white" /></span>}
      </span>
      <span className="flex shrink-0 gap-3">
        <button type="button" className="font-semibold text-brand-200 hover:text-white disabled:opacity-50" disabled={entry.sending} onClick={() => onUndo(entry.id)}>Undo<Kbd>u</Kbd></button>
        <button type="button" className="text-white/70 hover:text-white disabled:opacity-50" disabled={entry.sending} onClick={() => onSendNow(entry.id)}>Send now</button>
      </span>
    </div>)}
  </div>
}

// One review workspace for both queues: kind "sample" (dry-run sample rows) and kind "live" (Conflicts).
export default function ReviewWorkspace({
  kind = 'sample', session, companyId, tenantRevision = 0, completeTenantTransition, isAdmin = false, readOnly = !isAdmin,
  initialFilters, reloadToken = 0, renderHeader, renderBeforeQueue, renderGate, renderFooter, onBatchStarted, createBatchPollMs = 3000, recheckReloadMs = 5000,
}) {
  const tenantKey = `${companyId ?? 'none'}:${tenantRevision}`
  const tenantKeyRef = useRef(tenantKey)
  tenantKeyRef.current = tenantKey
  const mountedRef = useRef(true)
  const requestRevision = useRef(0)
  const detailRevision = useRef(0)
  const controllers = useRef(new Set())
  const recheckLock = useRef(null)
  const versions = useRef(new Map())
  const prefetching = useRef(new Set())
  const autoPicked = useRef(false)
  const loadedTenant = useRef(null)
  const queueRef = useRef(null)
  const rootRef = useRef(null)
  const referralRef = useRef(null)
  const dialogPanelRef = useRef(null)
  const dialogConfirmRef = useRef(null)
  const previousFocus = useRef(null)
  const keyHandler = useRef(null)
  const [stateTenant, setStateTenant] = useState(tenantKey)
  const [view, setView] = useState('quick')
  const viewRef = useRef(view)
  viewRef.current = view
  const [filters, setFilters] = useState(() => ({ ...blankFilters, ...(initialFilters ?? {}) }))
  const [items, setItems] = useState([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const [meta, setMeta] = useState({ sample: null, progress: null })
  const metaRef = useRef(meta)
  metaRef.current = meta
  const [bucketCounts, setBucketCounts] = useState(null)
  const [nextCursor, setNextCursor] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [returnToId, setReturnToId] = useState(null)
  const [details, setDetails] = useState({})
  const detailsRef = useRef(details)
  detailsRef.current = details
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
  const [candidateIndex, setCandidateIndex] = useState(0)
  // Referral source per record: starts blank for every record, never remembered or preselected.
  const [referrals, setReferrals] = useState({})
  const [pending, setPending] = useState([])
  const [recordErrors, setRecordErrors] = useState({})
  const [dialog, setDialog] = useState(null)
  const [checked, setChecked] = useState(() => new Set())
  const [bulk, setBulk] = useState(null)
  const [bulkSummary, setBulkSummary] = useState('')
  // The records Create selected left alone, shown under its summary (only while that summary is shown).
  const [createSkips, setCreateSkips] = useState({ summary: '', rows: [] })
  // "Create selected": the open choice dialog, then the running background batch's progress.
  const [createDialog, setCreateDialog] = useState(null)
  const [createProgress, setCreateProgress] = useState(null)
  const [help, setHelp] = useState(false)

  const same = startedFor => mountedRef.current && tenantKeyRef.current === startedFor
  const replaceItem = useCallback(item => {
    if (!item?.id) return
    setItems(current => current.map(existing => existing.id === item.id ? { ...existing, ...item } : existing))
  }, [])
  // Authoritative writes (an action or recheck result) bump the record's version so an older read cannot overwrite them.
  const writeDetail = useCallback((item, authoritative = false) => {
    if (!item?.id) return
    if (authoritative) versions.current.set(item.id, (versions.current.get(item.id) ?? 0) + 1)
    setDetails(current => ({ ...current, [item.id]: item }))
  }, [])
  const pendingIds = () => new Set((queueRef.current?.pending() ?? []).map(entry => entry.id))

  // StrictMode runs cleanup then setup again on mount, so setup must restore the flag.
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // One deferred queue per tenant. Leaving the page or switching company sends what is still waiting.
  useEffect(() => {
    const queue = createDeferredQueue({ delayMs: UNDO_MS, send: entry => entry.run(),
      setTimer: (run, ms) => setTimeout(run, ms), clearTimer: id => clearTimeout(id),
      onChange: snapshot => { if (queueRef.current === queue) setPending(snapshot) } })
    queueRef.current = queue
    setPending([])
    return () => {
      if (queueRef.current === queue) queueRef.current = null
      queue.flushAll().catch(() => {})
    }
  }, [tenantKey])

  const hasPending = pending.length > 0
  useEffect(() => {
    if (!hasPending) return undefined
    const guard = event => { queueRef.current?.flushAll().catch(() => {}); event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [hasPending])

  useEffect(() => {
    for (const controller of controllers.current) controller.abort()
    controllers.current.clear()
    prefetching.current.clear()
    recheckLock.current = null
    const controller = new AbortController()
    controllers.current.add(controller)
    const request = ++requestRevision.current
    const startedFor = tenantKey
    if (loadedTenant.current !== startedFor) {
      loadedTenant.current = startedFor
      autoPicked.current = false
      setReferrals({}); setRecordErrors({}); setBulkSummary(''); setReturnToId(null); setBucketCounts(null); setDialog(null); setHelp(false)
    }
    setStateTenant(startedFor)
    setItems([]); setMeta({ sample: null, progress: null }); setSelectedId(null); setDetails({}); setNextCursor(null); setChecked(new Set())
    setLoading(true); setLoadingMore(false); setBusyId(null)
    setLoadError(''); setDetailError(''); setActionError(''); setNotice('')
    const current = () => !controller.signal.aborted && requestRevision.current === request && tenantKeyRef.current === startedFor
    async function load() {
      try {
        if (!companyId) { setLoadError('Select a company to load reviews.'); return }
        const result = await getH2AReviews(session, companyId, { ...filters, kind, bucket: view, limit: 100, signal: controller.signal })
        if (!current()) return
        const loaded = list(result?.items)
        setItems(loaded); setMeta({ sample: result?.sample ?? null, progress: result?.progress ?? null })
        setBucketCounts(result?.bucketCounts ?? null); setNextCursor(result?.nextCursor ?? null)
        // Open on a bucket that has work: the first visit to an empty Quick wins moves to the next open bucket.
        if (!autoPicked.current && loaded.length === 0 && result?.bucketCounts) {
          autoPicked.current = true
          const better = OPEN_BUCKETS.find(bucket => bucket !== view && Number(result.bucketCounts[bucket]) > 0)
          if (better) { setView(better); return }
        }
        autoPicked.current = true
        const waiting = pendingIds()
        setSelectedId(loaded.find(item => item.status === 'needs_review' && !waiting.has(item.id))?.id ?? loaded[0]?.id ?? null)
      } catch (cause) {
        if (current() && cause?.name !== 'AbortError') setLoadError(cause.message)
      } finally {
        controllers.current.delete(controller)
        if (current()) { setLoading(false); completeTenantTransition?.(tenantRevision) }
      }
    }
    load()
    return () => {
      controller.abort()
      for (const pendingController of controllers.current) pendingController.abort()
      controllers.current.clear()
    }
  }, [companyId, session, tenantKey, tenantRevision, completeTenantTransition, filters, view, kind, retryToken, reloadToken])

  useEffect(() => { setCandidateIndex(0) }, [selectedId])

  useEffect(() => {
    if (!selectedId) { setDetailLoading(false); setDetailError(''); return undefined }
    if (detailsRef.current[selectedId]) { setDetailLoading(false); setDetailError(''); return undefined }
    const controller = new AbortController()
    controllers.current.add(controller)
    const request = ++detailRevision.current
    const listRequest = requestRevision.current
    const startedFor = tenantKey
    const version = versions.current.get(selectedId)
    setDetailError(''); setDetailLoading(true)
    const current = () => !controller.signal.aborted && request === detailRevision.current && listRequest === requestRevision.current &&
      tenantKeyRef.current === startedFor && selectedIdRef.current === selectedId
    getH2ADryRunReview(session, companyId, selectedId, { signal: controller.signal }).then(result => {
      if (current() && versions.current.get(selectedId) === version) { writeDetail(result?.item); replaceItem(result?.item) }
    }).catch(cause => {
      if (current() && cause?.name !== 'AbortError') setDetailError(cause.message)
    }).finally(() => {
      controllers.current.delete(controller)
      if (current()) setDetailLoading(false)
    })
    return () => { controller.abort(); controllers.current.delete(controller) }
  }, [companyId, session, tenantKey, selectedId, detailRetry, replaceItem, writeDetail])

  // Prefetch the record auto-advance will open next, with the same tenant and list-generation guards.
  const selectedLoaded = Boolean(selectedId && details[selectedId])
  useEffect(() => {
    if (!selectedLoaded || view === 'todo') return
    const next = nextRecordId(itemsRef.current.map(item => item.id), selectedId, new Set(pending.map(entry => entry.id)))
    if (!next || detailsRef.current[next] || prefetching.current.has(next)) return
    const controller = new AbortController()
    controllers.current.add(controller)
    prefetching.current.add(next)
    const listRequest = requestRevision.current
    const startedFor = tenantKey
    const version = versions.current.get(next)
    getH2ADryRunReview(session, companyId, next, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && listRequest === requestRevision.current && tenantKeyRef.current === startedFor &&
        versions.current.get(next) === version && result?.item?.id === next) setDetails(current => current[next] ? current : { ...current, [next]: result.item })
    }).catch(() => { /* A failed prefetch just means the record loads when it is opened. */ }).finally(() => {
      controllers.current.delete(controller)
      prefetching.current.delete(next)
    })
  }, [selectedId, selectedLoaded, items, pending, view, session, companyId, tenantKey])

  useEffect(() => {
    if (!dialog) return undefined
    previousFocus.current = document.activeElement
    dialogConfirmRef.current?.focus?.()
    return () => { const target = previousFocus.current; if (target?.isConnected) target.focus() }
  }, [Boolean(dialog)]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = event => keyHandler.current?.(event)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const visible = stateTenant === tenantKey
  const detail = selectedId && details[selectedId]?.id === selectedId ? details[selectedId] : null
  const pendingSet = new Set(pending.map(entry => entry.id))
  const sendingSet = new Set(pending.filter(entry => entry.sending).map(entry => entry.id))

  function selectRecord(id) { setSelectedId(id); setActionError(''); setNotice('') }
  function selectView(value) { autoPicked.current = true; setChecked(new Set()); setView(value) }
  function advanceFrom(id, excluded) {
    if (returnToId && returnToId !== id) { const back = returnToId; setReturnToId(null); setSelectedId(back); return }
    const next = nextRecordId(itemsRef.current.map(item => item.id), id, excluded)
    if (next) setSelectedId(next)
  }

  async function refreshRecord(reviewId, startedFor) {
    const controller = new AbortController()
    controllers.current.add(controller)
    try {
      const fresh = await getH2ADryRunReview(session, companyId, reviewId, { signal: controller.signal })
      if (same(startedFor) && fresh?.item) { writeDetail(fresh.item, true); replaceItem(fresh.item) }
    } catch { /* The record keeps its message; opening it again reloads it. */ } finally { controllers.current.delete(controller) }
  }

  // After a write: reload the record and move it out of this bucket when the server moved it.
  async function afterWrite(reviewId, startedFor, auth, company) {
    let item = null
    try { item = (await getH2ADryRunReview(auth, company, reviewId))?.item ?? null } catch {
      if (same(startedFor)) setNotice('The action was saved, but the record could not be reloaded. Reload the queue to see its current state.')
      return
    }
    if (!same(startedFor) || !item) return item
    writeDetail(item, true)
    const bucket = viewRef.current
    if (item.triageBucket && item.triageBucket !== bucket) {
      setItems(current => current.filter(existing => existing.id !== reviewId))
      setBucketCounts(counts => counts ? { ...counts, [bucket]: Math.max(0, Number(counts[bucket] ?? 0) - 1),
        [item.triageBucket]: Number(counts[item.triageBucket] ?? 0) + 1 } : counts)
      setChecked(current => { if (!current.has(reviewId)) return current; const next = new Set(current); next.delete(reviewId); return next })
    } else replaceItem(item)
    return item
  }

  // A link or create that leaves the record ready to recheck is rechecked in the background, so the record settles
  // without a second visit. Failures keep the saved action and only ask for a manual recheck.
  async function autoRecheck(reviewId, expectedUpdatedAt, startedFor, auth, company) {
    if (!expectedUpdatedAt) return
    try {
      await recheckH2ADryRunReview(auth, company, { reviewId, expectedUpdatedAt })
      await afterWrite(reviewId, startedFor, auth, company)
    } catch (error) {
      if (!same(startedFor) || error?.name === 'AbortError') return
      if (error?.status === 409) { refreshRecord(reviewId, startedFor); return }
      setRecordErrors(current => ({ ...current, [reviewId]: 'Saved. The automatic recheck didn’t finish; Recheck this record to confirm it.' }))
    }
  }

  function handleSendError(reviewId, error, startedFor) {
    if (!same(startedFor)) return
    if (error?.status === 409) { setRecordErrors(current => ({ ...current, [reviewId]: CHANGED })); refreshRecord(reviewId, startedFor) }
    else setRecordErrors(current => ({ ...current, [reviewId]: error?.message || 'The action could not be sent. Try again.' }))
  }

  // The same decision for the same record version always reuses one clientRequestId, so a retry is an idempotent
  // replay; a changed decision or version gets a new id.
  const requestIds = useRef(new Map())
  function requestIdFor(item, decision) {
    const key = JSON.stringify({ reviewId: item.id, decision, expectedUpdatedAt: item.updatedAt })
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID())
    return requestIds.current.get(key)
  }

  // Each run captures the tenant it was made in, so a flushed send still reaches the right company.
  function resolveRun(item, decision) {
    const startedFor = tenantKey, auth = session, company = companyId, clientRequestId = requestIdFor(item, decision)
    return async () => {
      const result = await resolveH2ADryRunReview(auth, company, { reviewId: item.id, expectedUpdatedAt: item.updatedAt, clientRequestId, ...decision })
      const fresh = await afterWrite(item.id, startedFor, auth, company)
      if (result?.resolution?.status === 'ready_to_recheck') autoRecheck(item.id, fresh?.updatedAt ?? item.updatedAt, startedFor, auth, company)
    }
  }
  function skipRun(item) {
    const startedFor = tenantKey, auth = session, company = companyId, clientRequestId = requestIdFor(item, { action: 'skip_live' })
    return async () => {
      await skipH2ALiveReview(auth, company, { reviewId: item.id, expectedUpdatedAt: item.updatedAt, clientRequestId })
      await afterWrite(item.id, startedFor, auth, company)
    }
  }
  function orgFirstRun(item, referralSourceId) {
    const startedFor = tenantKey, auth = session, company = companyId, clientRequestId = requestIdFor(item, { action: 'create_with_organization', referralSourceId })
    const organizationReviewId = text(item.orgFirstCreate?.organizationReviewId)
    return async () => {
      let organization = {}
      if (organizationReviewId) {
        const loaded = await getH2ADryRunReview(auth, company, organizationReviewId)
        if (loaded?.item?.updatedAt) organization = { organizationReviewId, organizationExpectedUpdatedAt: loaded.item.updatedAt }
      }
      const result = await createH2AOrganizationThenContact(auth, company, { reviewId: item.id, expectedUpdatedAt: item.updatedAt, clientRequestId,
        referralSourceId, ...organization })
      if (!same(startedFor)) return
      // The organization can succeed while the contact step fails: report that on the record, never as success.
      if (result?.contact?.error || !result?.contact) {
        const reason = result?.contact?.error ? ` The contact was not created: ${result.contact.error}` : ' The contact was not created yet. Recheck this record, then create the contact.'
        setRecordErrors(current => ({ ...current, [item.id]: `The organization was created.${reason}` }))
        await refreshRecord(item.id, startedFor)
        return
      }
      const fresh = await afterWrite(item.id, startedFor, auth, company)
      if (result?.contact?.resolution?.status === 'ready_to_recheck' || result?.resolution?.status === 'ready_to_recheck') {
        autoRecheck(item.id, fresh?.updatedAt ?? item.updatedAt, startedFor, auth, company)
      }
    }
  }

  // Low-risk actions wait 5 seconds with Undo / Send now. A refused enqueue (already pending) does nothing.
  function enqueueAction(item, label, run) {
    const queue = queueRef.current
    if (!queue || !item?.id) return false
    const startedFor = tenantKey
    const reviewId = item.id
    if (!queue.enqueue({ id: reviewId, label, run, onError: error => handleSendError(reviewId, error, startedFor) })) return false
    setRecordErrors(current => without(current, reviewId)); setActionError(''); setNotice('')
    advanceFrom(reviewId, new Set([...pendingIds(), reviewId]))
    return true
  }
  // Risky actions were confirmed in a dialog and are sent at once.
  async function runNow(item, run) {
    if (!item?.id || busyId || recheckLock.current) return
    const startedFor = tenantKey
    setBusyId(item.id); setActionError(''); setNotice('')
    try {
      await run()
      if (same(startedFor)) { setRecordErrors(current => without(current, item.id)); advanceFrom(item.id, pendingIds()) }
    } catch (error) { handleSendError(item.id, error, startedFor) } finally { if (same(startedFor)) setBusyId(null) }
  }
  function openDialog(next) { setDialog(next) }
  function closeDialog() { setDialog(null) }
  function confirmDialog() { const current = dialog; setDialog(null); current?.onConfirm() }

  function doUndo(id) {
    const result = queueRef.current?.undo(id)
    if (!result) return
    if (result.sending) { setNotice(`${result.label}: already being sent, so it can’t be undone.`); return }
    setSelectedId(result.id); setActionError('')
    setNotice(`Undone: ${result.label}. Nothing was written.`)
  }
  function sendNow(id) { queueRef.current?.sendNow(id)?.catch?.(() => {}) }

  const linkLabel = (item, candidate, emailMatch) => `Linking ${nameOf(item)} → Albi ${text(candidate?.name) || candidate?.id}${emailMatch ? ' (emails match)' : ''}`
  const linkDecision = (candidate, approveManyToOne, emailMatch) => ({ action: 'link_existing', candidateId: candidate.id, approveManyToOne,
    ...(emailMatch ? { ignoreContactDifferences: true } : {}) })
  const confirmationOf = (item, decision) => { try { return buildResolutionConfirmation({ review: presentSampleReviewItem(item), decision }) } catch { return null } }
  const referralLabel = (item, id) => [item?.createReadiness, item?.forceCreateReadiness, item?.orgFirstCreate]
    .flatMap(source => list(source?.referralSources)).find(source => source?.id === id)?.label ?? id

  const recordHandlers = item => ({
    onAccept: (candidate, { emailMatch = false } = {}) => enqueueAction(item, linkLabel(item, candidate, emailMatch), resolveRun(item, linkDecision(candidate, false, emailMatch))),
    onLink: (candidate, { approveManyToOne = false, emailMatch = false } = {}) => approveManyToOne
      ? runNow(item, resolveRun(item, linkDecision(candidate, true, emailMatch)))
      : enqueueAction(item, linkLabel(item, candidate, emailMatch), resolveRun(item, linkDecision(candidate, false, emailMatch))),
    onCreate: ({ referralSourceId }) => enqueueAction(item, `Creating ${nameOf(item)} in Albi (${referralLabel(item, referralSourceId)})`,
      resolveRun(item, { action: 'create_albi', referralSourceId })),
    onCreateWithOrganization: ({ referralSourceId }) => enqueueAction(item,
      `Creating organization ${text(item.orgFirstCreate?.organizationName) || 'from HubSpot'}, then ${nameOf(item)}`, orgFirstRun(item, referralSourceId)),
    onForceCreate: ({ referralSourceId, ignoredCandidateIds }) => {
      const count = list(ignoredCandidateIds).length
      openDialog({ title: 'Create a separate Albi record?', danger: true, confirmLabel: 'Create separate record',
        lines: [`${plural(count, 'possible match', 'possible matches')} will be ignored. Albi records can’t be deleted from here, so this may create a duplicate.`,
          `Referral source: ${referralLabel(item, referralSourceId)}`],
        onConfirm: () => runNow(item, resolveRun(item, { action: 'force_create_albi', referralSourceId, ignoredCandidateIds })) })
    },
    // Link and keep both systems as they are: the listed differences are recorded as accepted, nothing is written.
    onIgnoreAndLink: (candidate, fields) => {
      const ignoredFields = [...new Set(list(fields))].sort()
      if (!candidate?.id || !ignoredFields.length) return
      openDialog({ title: 'Link and ignore these differences?', confirmLabel: 'Link and ignore',
        lines: [`Links to Albi record ${candidate.id}. Nothing changes in HubSpot or Albi.`, `Ignored: ${ignoredFields.map(fieldLabel).join(', ')}`],
        onConfirm: () => runNow(item, resolveRun(item, { action: 'link_existing', candidateId: candidate.id,
          approveManyToOne: Number(candidate.linkedElsewhere ?? 0) > 0, ignoredFields })) })
    },
    onApplyFields: fieldChoices => {
      const decision = { action: 'resolve_fields', fieldChoices }
      const confirmation = confirmationOf(item, decision)
      const writes = confirmation ? confirmation.hubspotWrites : Object.entries(fieldChoices ?? {}).filter(([, winner]) => winner === 'albi').map(([field]) => ({ field, value: null }))
      const tasks = confirmation?.albiTasks ?? []
      if (!writes.length) return enqueueAction(item, `Saving field choices for ${nameOf(item)}${tasks.length ? ` (adds ${plural(tasks.length, 'Albi to-do')})` : ''}`, resolveRun(item, decision))
      openDialog({ title: 'Update HubSpot now?', confirmLabel: 'Update HubSpot',
        lines: [...writes.map(write => `HubSpot ${write.field} → ${write.value ?? 'Blank'}`), ...tasks.map(task => `Albi to-do: set ${task.field} to ${task.value ?? 'Blank'}`)],
        onConfirm: () => runNow(item, resolveRun(item, decision)) })
    },
    onChooseOrganization: ({ organizationSourceId, addHubSpotAssociation }) => {
      const decision = { action: 'choose_organization', organizationSourceId, addHubSpotAssociation }
      if (!addHubSpotAssociation) return enqueueAction(item, `Choosing organization ${organizationSourceId} for ${nameOf(item)}`, resolveRun(item, decision))
      openDialog({ title: 'Add a HubSpot association?', confirmLabel: 'Add association',
        lines: [`Adds HubSpot organization ${organizationSourceId} as an association of ${nameOf(item)}.`, 'Existing HubSpot associations will not be removed.'],
        onConfirm: () => runNow(item, resolveRun(item, decision)) })
    },
    onSkip: () => kind === 'live' && enqueueAction(item, `Skipping ${nameOf(item)}`, skipRun(item)),
  })

  async function loadMore() {
    if (!nextCursor || loadingMore || recheckLock.current) return
    const controller = new AbortController()
    controllers.current.add(controller)
    const request = requestRevision.current
    const startedFor = tenantKey
    const current = () => !controller.signal.aborted && requestRevision.current === request && tenantKeyRef.current === startedFor
    setLoadingMore(true); setActionError('')
    try {
      const result = await getH2AReviews(session, companyId, { ...filters, kind, bucket: view, cursor: nextCursor, limit: 100, signal: controller.signal })
      if (!current()) return
      if (result?.sample?.id !== metaRef.current.sample?.id) {
        // A cursor belongs to the old sample. Discard this page and reload the current first page before publishing any replacement evidence.
        ++requestRevision.current; ++detailRevision.current
        for (const pendingController of controllers.current) pendingController.abort()
        controllers.current.clear(); prefetching.current.clear(); recheckLock.current = null; selectedIdRef.current = null
        setItems([]); setMeta({ sample: null, progress: null }); setNextCursor(null); setSelectedId(null); setDetails({})
        setLoading(true); setLoadingMore(false); setDetailLoading(false); setBusyId(null)
        setLoadError(''); setDetailError(''); setActionError(''); setNotice('')
        setRetryToken(value => value + 1)
        return
      }
      setItems(existing => {
        const unique = new Map(existing.map(item => [item.id, item]))
        for (const item of list(result?.items)) if (!unique.has(item.id)) unique.set(item.id, item)
        return [...unique.values()]
      })
      setMeta({ sample: result?.sample ?? null, progress: result?.progress ?? null })
      if (result?.bucketCounts) setBucketCounts(result.bucketCounts)
      setNextCursor(result?.nextCursor ?? null)
    } catch (cause) {
      if (current() && cause?.name !== 'AbortError') setActionError(cause.message)
    } finally {
      controllers.current.delete(controller)
      if (current()) setLoadingMore(false)
    }
  }

  async function handleRecheck() {
    if (readOnly) return
    if (!detail?.updatedAt || detail.id !== selectedId || recheckLock.current) return
    // Recheck owns a new generation so prior pages cannot restore stale progress. Keep the queue and cursor for a later pagination retry.
    const request = ++requestRevision.current
    ++detailRevision.current
    for (const pendingController of controllers.current) pendingController.abort()
    controllers.current.clear(); prefetching.current.clear()
    setLoadingMore(false); setDetailLoading(false)
    const controller = new AbortController()
    controllers.current.add(controller)
    recheckLock.current = controller
    const startedFor = tenantKey
    const reviewId = detail.id
    const prior = detail
    const current = () => !controller.signal.aborted && requestRevision.current === request && tenantKeyRef.current === startedFor
    const progressFrom = result => setMeta(previous => ({ ...previous, progress: result && Object.hasOwn(result, 'progress') ? result.progress ?? null : previous.progress }))
    setBusyId(reviewId); setActionError(''); setNotice('')
    try {
      const result = await recheckH2ADryRunReview(session, companyId, { reviewId, expectedUpdatedAt: prior.updatedAt }, { signal: controller.signal })
      if (!current()) return
      replaceItem(result?.item); writeDetail(result?.item, true)
      progressFrom(result)
      setRecordErrors(errors => without(errors, reviewId))
      setNotice('Recheck complete. The record and review progress are up to date.')
    } catch (cause) {
      if (!current() || cause?.name === 'AbortError') return
      if (cause?.status === 409) {
        try {
          const result = await getH2ADryRunReview(session, companyId, reviewId, { signal: controller.signal })
          if (!current()) return
          replaceItem(result?.item); writeDetail(result?.item, true)
          setNotice('This record changed. Its current detail was refreshed; review it before rechecking again.')
        } catch (refreshCause) {
          if (!current() || refreshCause?.name === 'AbortError') return
          if (selectedIdRef.current === reviewId) { setDetails(all => without(all, reviewId)); setDetailError('This record changed and could not be refreshed. Retry loading the record or reload the current queue.') }
          setActionError('The queue may have changed. Reload the queue to review the latest records.')
        }
      } else {
        // A gateway may lose the response after the server has already committed the atomic recheck. Reload before
        // reporting a failure; when the gateway timed out (the server is likely still working), keep reloading for a while.
        try {
          const priorRecheck = prior.lastRecheckedAt ? Date.parse(prior.lastRecheckedAt) : NaN
          const isDone = item => {
            const currentRecheck = item?.lastRecheckedAt ? Date.parse(item.lastRecheckedAt) : NaN
            return Boolean(item?.updatedAt && item.updatedAt !== prior.updatedAt && Number.isFinite(currentRecheck) &&
              (!Number.isFinite(priorRecheck) || currentRecheck > priorRecheck))
          }
          let item = null, completed = false
          const attempts = cause?.timedOut ? 6 : 1
          if (cause?.timedOut) setNotice('Recheck is still finishing on the server. This record reloads by itself when it’s done.')
          for (let attempt = 0; attempt < attempts && !completed; attempt++) {
            if (attempt > 0) await new Promise(resolve => setTimeout(resolve, recheckReloadMs))
            if (!current()) return
            const fresh = await getH2ADryRunReview(session, companyId, reviewId, { signal: controller.signal })
            if (!current()) return
            item = fresh?.item
            completed = isDone(item)
          }
          if (cause?.timedOut) setNotice('')
          if (completed) {
            replaceItem(item); writeDetail(item, true)
            setMeta(previous => {
              const progress = previous.progress
              if (!progress || prior.status === item.status) return previous
              const keys = { needs_review: 'needsReview', cleared: 'cleared', no_longer_in_scope: 'noLongerInScope' }
              const from = keys[prior.status], to = keys[item.status]
              if (!from || !to) return previous
              return { ...previous, progress: { ...progress, [from]: Math.max(0, Number(progress[from] ?? 0) - 1), [to]: Number(progress[to] ?? 0) + 1 } }
            })
            setNotice('Recheck complete. The record and review progress are up to date.')
          } else setActionError(cause?.timedOut ? 'Recheck didn’t finish in time. Reload the record in a minute; if it still hasn’t changed, Recheck it again.'
            : `Recheck failed. ${cause.message} Your previous evidence is unchanged. Try Recheck again.`)
        } catch (refreshCause) {
          if (current() && refreshCause?.name !== 'AbortError') setActionError(`Recheck failed. ${cause.message} Your previous evidence is unchanged. Try Recheck again.`)
        }
      }
    } finally {
      controllers.current.delete(controller)
      if (recheckLock.current === controller) recheckLock.current = null
      if (current()) setBusyId(null)
    }
  }

  // Opens a related review (an organization to sync first, or the survivor of a HubSpot merge), capturing it when needed.
  async function openRelatedReview(target, prepare, pick) {
    if (!detail?.updatedAt || detail.id !== selectedId || recheckLock.current) return
    const contactId = detail.id
    let reviewId = typeof target?.reviewId === 'string' && target.reviewId ? target.reviewId : null
    if (!reviewId) {
      // Preparing a related review is an admin write; members can only open one that already exists.
      if (readOnly) { setActionError('Only an admin can prepare this related record for review.'); return }
      const controller = new AbortController()
      controllers.current.add(controller)
      recheckLock.current = controller
      setBusyId(contactId); setActionError(''); setNotice('')
      try {
        const result = await prepare(session, companyId, { reviewId: contactId, expectedUpdatedAt: detail.updatedAt }, { signal: controller.signal })
        reviewId = pick(result) ?? null
        if (!reviewId) setActionError('The related record could not be opened. Recheck this record and try again.')
      } catch (cause) {
        if (cause?.name !== 'AbortError') setActionError(cause?.message || 'The related review could not be prepared.')
      } finally {
        controllers.current.delete(controller)
        if (recheckLock.current === controller) recheckLock.current = null
        setBusyId(null)
      }
      if (!reviewId) return
    }
    setReturnToId(contactId); setSelectedId(reviewId)
  }

  // Bulk link: only Quick wins rows whose one exact match the server suggests. Never creates, never writes fields,
  // and the server skips (never forces) any row that changed or became linked elsewhere.
  const bulkEligible = view === 'quick' ? items.filter(item => item.triageBucket === 'quick' && item.triageDetails?.quickKind === 'link' && !pendingSet.has(item.id)) : []
  const bulkTargets = checked.size ? bulkEligible.filter(item => checked.has(item.id)) : bulkEligible
  function openBulkLink() {
    if (!bulkTargets.length || bulk) return
    const targets = [...bulkTargets], count = targets.length
    openDialog({ title: `Link ${plural(count, 'exact match', 'exact matches')}?`, confirmLabel: `Link ${count}`,
      lines: [...targets.slice(0, 6).map(nameOf), ...(count > 6 ? [`…and ${count - 6} more`] : []),
        'Each record is rechecked on the server first. Any that changed are skipped, never forced.'],
      onConfirm: () => runBulkLink(targets) })
  }
  async function runBulkLink(targets) {
    const startedFor = tenantKey, auth = session, company = companyId
    const controller = new AbortController()
    controllers.current.add(controller)
    const alive = () => !controller.signal.aborted && same(startedFor)
    const summary = { done: 0, skipped: [], failed: 0 }
    setBulk({ done: 0, total: targets.length }); setBulkSummary(''); setActionError(''); setNotice('')
    try {
      for (let start = 0; start < targets.length; start += BULK_CHUNK) {
        const chunk = targets.slice(start, start + BULK_CHUNK)
        const prepared = await mapLimit(chunk, BULK_DETAIL_CONCURRENCY, async row => {
          let item = detailsRef.current[row.id] ?? null
          if (!item) {
            try { item = (await getH2ADryRunReview(auth, company, row.id, { signal: controller.signal }))?.item ?? null } catch (cause) {
              if (cause?.name === 'AbortError') throw cause
              return { row, item: null, loadFailed: true }
            }
          }
          return { row, item }
        })
        if (!alive()) return
        const sendable = []
        for (const { row, item, loadFailed } of prepared) {
          if (loadFailed) summary.failed += 1
          else if (item?.suggestedCandidateId && item.updatedAt) sendable.push({ row, request: { reviewId: row.id, candidateId: item.suggestedCandidateId,
            expectedUpdatedAt: item.updatedAt, clientRequestId: crypto.randomUUID() } })
          else summary.skipped.push({ name: nameOf(row), reason: 'not_eligible' })
        }
        if (sendable.length) {
          try {
            const result = await bulkLinkH2AReviews(auth, company, sendable.map(entry => entry.request), { signal: controller.signal })
            const outcomes = new Map(list(result?.results).map(entry => [entry?.reviewId, entry]))
            for (const { row } of sendable) {
              const outcome = outcomes.get(row.id)
              if (outcome?.status === 'done') summary.done += 1
              else if (outcome?.status === 'skipped') summary.skipped.push({ name: nameOf(row), reason: outcome.reason })
              else summary.failed += 1
            }
          } catch (cause) {
            if (cause?.name === 'AbortError') throw cause
            summary.failed += sendable.length
          }
        }
        if (!alive()) return
        setBulk({ done: Math.min(targets.length, start + chunk.length), total: targets.length })
      }
      const skipped = summary.skipped.length
        ? ` (${summary.skipped.slice(0, 10).map(entry => `${entry.name}: ${SKIP_REASONS[entry.reason] ?? 'skipped'}`).join('; ')}${summary.skipped.length > 10 ? '; …' : ''})` : ''
      setBulkSummary(`Bulk link finished: ${summary.done} linked, ${summary.skipped.length} skipped${skipped}, ${summary.failed} failed.`)
      setRetryToken(value => value + 1)
    } catch (cause) {
      if (alive() && cause?.name !== 'AbortError') setActionError(cause.message)
    } finally {
      controllers.current.delete(controller)
      if (same(startedFor)) setBulk(null)
    }
  }
  // Create selected: ticked Quick-wins rows that are plain creates (no Albi match). One referral source for all;
  // a background batch reads Albi once and runs the normal checked create for each.
  const createEligible = view === 'quick' ? items.filter(item => item.triageBucket === 'quick' && item.triageDetails?.quickKind === 'create' && !pendingSet.has(item.id)) : []
  // Like bulk link: the ticked no-match rows, or every one in Quick wins when none are ticked.
  const createTargets = (checked.size ? createEligible.filter(item => checked.has(item.id)) : createEligible).slice(0, 50)
  async function openCreateSelected() {
    if (!createTargets.length || bulk || createProgress) return
    const startedFor = tenantKey, targets = [...createTargets]
    setActionError(''); setNotice('')
    try {
      const loaded = await getH2ACreateBatch(session, companyId, kind)
      if (!same(startedFor)) return
      const sources = list(loaded?.referralSources).filter(source => typeof source?.id === 'string' && typeof source?.label === 'string')
      if (!sources.length) { setActionError('Albi’s referral sources could not be loaded. Try again.'); return }
      setCreateDialog({ targets, sources, referralSourceId: '' })
    } catch (cause) { if (same(startedFor)) setActionError(cause.message) }
  }
  async function pollCreateBatch(startedFor, names = new Map()) {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, createBatchPollMs))
      if (!same(startedFor)) return
      let batch = null
      try { batch = (await getH2ACreateBatch(session, companyId, kind))?.batch ?? null } catch { continue }
      if (!same(startedFor)) return
      if (batch) setCreateProgress(batch)
      if (batch && ['completed', 'failed'].includes(batch.status)) {
        setCreateProgress(null)
        const summary = batch.status === 'completed'
          ? `Create selected finished: ${batch.created} created, ${batch.skipped} skipped, ${batch.failed} failed.${batch.created ? ' Recheck them to clear them.' : ''}`
          : `Create selected stopped early: ${batch.created} created, ${batch.skipped} skipped, ${batch.failed} failed.`
        setBulkSummary(summary)
        setCreateSkips({ summary, rows: list(batch.results).filter(result => result?.outcome !== 'created')
          .map(result => ({ id: result.reviewId, name: names.get(result.reviewId) ?? 'A selected record', outcome: result.outcome, reason: createSkipCopy(result.reason) })) })
        setRetryToken(value => value + 1)
        return
      }
    }
  }
  async function runCreateSelected() {
    const current = createDialog
    if (!current?.referralSourceId) return
    setCreateDialog(null)
    const startedFor = tenantKey
    try {
      const result = await startH2ACreateBatch(session, companyId, { kind, referralSourceId: current.referralSourceId,
        items: current.targets.map(item => ({ reviewId: item.id, expectedUpdatedAt: item.updatedAt })) })
      if (!same(startedFor)) return
      setChecked(new Set())
      setCreateProgress(result?.batch ?? { status: 'queued', total: current.targets.length, done: 0 })
      if (result?.status === 'already_running') setNotice('A create batch is already running. Its progress is shown here.')
      pollCreateBatch(startedFor, new Map(current.targets.map(item => [item.id, nameOf(item)])))
    } catch (cause) { if (same(startedFor)) setActionError(cause.message) }
  }
  function openRecheckSelected() {
    const ids = [...checked]
    if (!ids.length || bulk) return
    openDialog({ title: `Recheck ${plural(ids.length, 'record')}?`, confirmLabel: `Recheck ${Math.min(ids.length, RECHECK_IDS_MAX)}`,
      lines: ['Albi is read once for the whole batch. Nothing is written to Albi or HubSpot.',
        ...(ids.length > RECHECK_IDS_MAX ? [`Only the first ${RECHECK_IDS_MAX} are rechecked in this batch.`] : [])],
      onConfirm: () => runRecheckSelected(ids.slice(0, RECHECK_IDS_MAX)) })
  }
  async function runRecheckSelected(ids) {
    const startedFor = tenantKey
    setActionError(''); setNotice('')
    try {
      const result = await startH2ARecheckAll(session, companyId, { kind, reviewIds: ids })
      if (!same(startedFor)) return
      setChecked(new Set())
      setNotice(`Recheck queued for ${plural(ids.length, 'record')}.${onBatchStarted ? ' The queue reloads when it finishes.' : ' Reload the queue when it finishes to see the results.'}`)
      onBatchStarted?.(result?.batch ?? null)
    } catch (cause) {
      if (same(startedFor)) setActionError(cause.message)
    }
  }
  function toggle(id) {
    if (!id || pendingSet.has(id)) return
    setChecked(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function selectAll() {
    const selectable = items.filter(item => !pendingSet.has(item.id)).map(item => item.id)
    setChecked(current => selectable.length && selectable.every(id => current.has(id)) ? new Set() : new Set(selectable))
  }

  // One key handler that always reads the latest render. Keys reuse the record's own buttons so they follow the same rules.
  keyHandler.current = event => {
    if (event.defaultPrevented) return
    // Another modal (the record's many-to-one approval) owns the keyboard while it is open.
    if (!dialog && !help && (inside(event.target, '[role="dialog"]') || document.querySelector?.('[role="dialog"][aria-modal="true"]'))) return
    const action = shortcutFor(event, { kind, dialogOpen: Boolean(dialog) })
    if (!action) return
    if (action === 'dialogConfirm') { event.preventDefault(); confirmDialog(); return }
    if (action === 'dialogCancel') { event.preventDefault(); closeDialog(); return }
    if (action === 'help') { setHelp(value => !value); return }
    if (help) { if (action === 'escape') setHelp(false); return }
    if (action === 'escape') return
    if (action === 'todo') { selectView('todo'); return }
    if (action === 'undo') { doUndo(); return }
    if (readOnly && WRITE_KEYS.has(action)) return
    if (view === 'todo' || !detail) return
    if (action === 'next' || action === 'prev') {
      event.preventDefault()
      const order = itemsRef.current.map(item => item.id)
      const excluded = new Set([...pendingSet].filter(id => id !== selectedId))
      const next = nextRecordId(action === 'prev' ? [...order].reverse() : order, selectedId, excluded)
      if (next) selectRecord(next)
      return
    }
    if (typeof action === 'object' && action?.pick) {
      const total = list(detail.rankedCandidates).length || presentSampleReviewItem(detail).candidates.length
      if (action.pick <= total) setCandidateIndex(action.pick - 1)
      return
    }
    if (action === 'recheck') { handleRecheck(); return }
    if (action === 'toggle') { if (view === 'quick') toggle(selectedId); return }
    if (action === 'create' && referralRef.current && !referralRef.current.value) { event.preventDefault(); referralRef.current.focus(); return }
    const button = rootRef.current?.querySelector?.(`[data-shortcut="${action}"]`)
    if (button && !button.disabled) { event.preventDefault(); button.click() }
  }

  const slotMeta = { sample: visible ? meta.sample : null, progress: visible ? meta.progress : null, loading: loading || !visible,
    busy: Boolean(busyId) || Boolean(bulk), visible, bucketCounts: visible ? bucketCounts : null }
  const gate = !loading && visible && !loadError ? renderGate?.(slotMeta) ?? null : null
  const setFilter = (key, value) => setFilters(current => ({ ...current, [key]: value }))
  const activeFilters = Object.values(filters).filter(Boolean).length
  const prefix = kind === 'live' ? 'live' : 'sample'
  const handlers = detail && !readOnly ? recordHandlers(detail) : null

  return <div ref={rootRef} className="space-y-4">
    {renderHeader?.(slotMeta)}
    {gate ?? <>
      <nav className="flex flex-wrap gap-2" aria-label="Review buckets">
        {BUCKETS.map(([value, label]) => {
          const count = slotMeta.bucketCounts ? Number(slotMeta.bucketCounts[value] ?? 0) : null
          return <button key={value} type="button" aria-pressed={view === value} onClick={() => selectView(value)}
            className={`min-w-[7rem] rounded-lg border px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${view === value ? 'border-brand-500 bg-brand-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
            <span className="block text-xs font-medium text-gray-600">{label}{value === 'todo' && <Kbd>t</Kbd>}</span>
            <span className={`block text-xl font-semibold tabular-nums ${value === 'quick' && count ? 'text-green-700' : value === 'todo' && count ? 'text-amber-700' : 'text-gray-900'}`}>{count === null ? '—' : count}</span>
          </button>
        })}
        <button type="button" className={`${btn} ml-auto self-center`} onClick={() => setHelp(true)}>Shortcuts<Kbd>?</Kbd></button>
      </nav>

      {view !== 'todo' && <details className="rounded-xl border border-gray-200 bg-white">
        <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-gray-800"><span>Filters</span>{activeFilters > 0 && <span className="ml-2 font-normal text-brand-700">{`${activeFilters} active`}</span>}</summary>
        <div className="grid gap-3 border-t border-gray-100 p-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end" role="group" aria-label="Filter reviews">
          <label htmlFor={`${prefix}-review-status`} className="text-xs font-medium text-gray-700">Status<select id={`${prefix}-review-status`} value={filters.status} onChange={event => setFilter('status', event.target.value)} className={selectClass}><option value="">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label htmlFor={`${prefix}-review-object`} className="text-xs font-medium text-gray-700">Object type<select id={`${prefix}-review-object`} value={filters.objectType} onChange={event => setFilter('objectType', event.target.value)} className={selectClass}><option value="">All records</option><option value="contacts">Contacts</option><option value="companies">Organizations</option></select></label>
          <label htmlFor={`${prefix}-review-reason`} className="text-xs font-medium text-gray-700">Reason<select id={`${prefix}-review-reason`} value={filters.reason} onChange={event => setFilter('reason', event.target.value)} className={selectClass}><option value="">All reasons</option>{SAMPLE_REVIEW_REASON_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <button type="button" className={btn} onClick={() => setFilters({ ...blankFilters })}>Clear filters</button>
        </div>
      </details>}

      {renderBeforeQueue?.(slotMeta)}

      <div className="space-y-2 text-sm" aria-live="polite">
        {visible && notice && <p className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-brand-800" role="status">{notice}</p>}
        {visible && bulk && <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-brand-800" role="status">
          <p>{`Linking exact matches… ${bulk.done} / ${bulk.total}`}</p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white" role="progressbar" aria-label="Bulk link progress" aria-valuemin={0} aria-valuemax={bulk.total} aria-valuenow={bulk.done}>
            <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${bulk.total ? Math.round(bulk.done / bulk.total * 100) : 0}%` }} /></div></div>}
        {visible && createProgress && <p className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-brand-800" role="status">
          {`Creating in Albi: ${createProgress.done ?? 0} of ${createProgress.total ?? 0} done${createProgress.created ? ` (${createProgress.created} created)` : ''}. Albi is read once; each record is still checked before it is created.`}</p>}
        {visible && bulkSummary && <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-gray-800" role="status">
          <p>{bulkSummary}</p>
          {createSkips.summary === bulkSummary && createSkips.rows.length > 0 && <ul className="mt-2 space-y-1 text-sm">
            {createSkips.rows.map(row => <li key={row.id}>
              <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => selectRecord(row.id)}>{row.name}</button>
              <span className="text-gray-600"> — {row.outcome === 'failed' ? 'Not created' : 'Skipped'}: {row.reason}</span>
            </li>)}
          </ul>}
        </div>}
        {visible && actionError && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800" role="alert"><p>{actionError}</p>
          <button type="button" onClick={() => setRetryToken(value => value + 1)} className={`${btn} mt-3`}>Reload queue</button></div>}
      </div>

      {view === 'todo' ? <AlbiTodo session={session} companyId={companyId} tenantKey={tenantKey} readOnly={readOnly} />
        : loading || !visible ? <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600" role="status">Loading reviews…</section>
          : loadError ? <section className="rounded-xl border border-red-200 bg-red-50 px-5 py-6" role="alert">
            <h3 className="font-semibold text-red-900">Reviews could not be loaded</h3><p className="mt-1 text-sm text-red-800">{loadError}</p>
            <button type="button" className={`${btn} mt-4`} onClick={() => setRetryToken(value => value + 1)}>Try again</button></section>
            : <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
              <ReviewQueue items={items} bucket={view} selectedId={selectedId} pendingIds={pendingSet} sendingIds={sendingSet} errors={recordErrors} checked={checked}
                bulkEnabled={!readOnly} onSelect={selectRecord} onToggle={toggle} onSelectAll={selectAll} bulkLinkCount={bulkTargets.length}
                onBulkLink={openBulkLink} onRecheckSelected={openRecheckSelected} busy={Boolean(bulk) || Boolean(createProgress)}
                createSelectedCount={createTargets.length} onCreateSelected={readOnly ? undefined : openCreateSelected}
                nextCursor={nextCursor} loadingMore={loadingMore} loadMoreDisabled={Boolean(busyId) || Boolean(bulk)} onLoadMore={loadMore} />
              <div className="min-w-0 space-y-3">
                {returnToId && returnToId !== selectedId && <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-800">
                  <button type="button" onClick={() => { const back = returnToId; setReturnToId(null); selectRecord(back) }} className={btn}>Back to contact review</button>
                  <span className="ml-3 text-xs text-gray-600">Create the organization here, then return to create the contact.</span></div>}
                {selectedId && recordErrors[selectedId] && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{recordErrors[selectedId]}</p>}
                {detail ? <ReviewRecord item={detail} kind={kind} candidateIndex={candidateIndex} onPickCandidate={setCandidateIndex}
                  referralSourceId={referrals[detail.id] ?? ''} onReferral={value => setReferrals(current => ({ ...current, [detail.id]: value }))} referralRef={referralRef}
                  readOnly={readOnly} pending={pendingSet.has(detail.id)} busy={busyId === detail.id || Boolean(bulk)} {...handlers}
                  onRecheck={handleRecheck}
                  onOpenOrganization={target => openRelatedReview(target, prepareH2AOrganizationReview, result => result?.organization?.reviewId)}
                  onOpenMergedSurvivor={target => openRelatedReview(target, prepareH2AMergedSurvivorReview, result => result?.survivor?.reviewId)} />
                  : detailLoading ? <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600" role="status">Loading selected record…</section>
                    : detailError ? <section className="rounded-xl border border-red-200 bg-red-50 px-5 py-6" role="alert">
                      <h3 className="font-semibold text-red-900">Record could not be loaded</h3><p className="mt-1 text-sm text-red-800">{detailError}</p>
                      <button type="button" className={`${btn} mt-3`} onClick={() => { setDetails(all => without(all, selectedId)); setDetailRetry(value => value + 1) }}>Retry loading record</button></section>
                      : <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600">{items.length ? 'Select a record to review it.' : 'This bucket is empty.'}</section>}
              </div>
            </div>}
      {renderFooter?.(slotMeta)}
    </>}

    <UndoToasts entries={pending} onUndo={doUndo} onSendNow={sendNow} />
    <style>{'@keyframes h2a-undo { from { width: 100% } to { width: 0% } }'}</style>
    {createDialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 px-4" role="dialog" aria-modal="true" aria-label="Create selected in Albi">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900">{`Create ${plural(createDialog.targets.length, 'new record')} in Albi?`}</h3>
        <ul className="mt-3 space-y-1 text-sm text-gray-700">{createDialog.targets.slice(0, 8).map(item => <li key={item.id}>{nameOf(item)}</li>)}
          {createDialog.targets.length > 8 && <li>{`…and ${createDialog.targets.length - 8} more`}</li>}</ul>
        <label className="mt-4 block text-xs font-medium text-gray-700">Referral source for all of them
          <select aria-label="Referral source" value={createDialog.referralSourceId} onChange={event => { const value = event.target.value; setCreateDialog(current => current ? { ...current, referralSourceId: value } : current) }}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900">
            <option value="">Referral source…</option>
            {createDialog.sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}</select></label>
        <p className="mt-3 text-xs text-gray-600">Each record is checked against Albi first; any that now match an Albi record, or changed, are skipped. New records are Type Referrer and Status Active, with the owner’s salesperson.</p>
        <div className="mt-5 flex flex-row-reverse gap-2">
          <button type="button" className={primary} disabled={!createDialog.referralSourceId} onClick={runCreateSelected}>{`Create ${createDialog.targets.length} in Albi`}</button>
          <button type="button" className={btn} onClick={() => setCreateDialog(null)}>Cancel</button></div>
      </div></div>}
    {dialog && <ConfirmDialog dialog={dialog} panelRef={dialogPanelRef} confirmRef={dialogConfirmRef} onConfirm={confirmDialog} onCancel={closeDialog} />}
    <ShortcutHelp open={help} kind={kind} onClose={() => setHelp(false)} />
  </div>
}
