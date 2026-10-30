import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { getH2ARecheckAll, startH2ARecheckAll } from '../../lib/hubspotToAlbi'
import { presentRecheckAllBatch, presentSampleReviewProgress } from './sampleReview.js'
import { presentSampleReviewQueryFilters } from './preflightPresentation.js'
import ReviewWorkspace from './ReviewWorkspace.jsx'

const secondaryButton = 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'
const RECHECK_ALL_POLL_MS = 3000
const recheckAllTone = { info: 'border-brand-200 bg-brand-50 text-brand-800', success: 'border-green-200 bg-green-50 text-green-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800', error: 'border-red-200 bg-red-50 text-red-800' }

// Sample review: the shared review workspace on dry-run sample rows, plus the sample header,
// the fresh-sample gate messaging and the "Recheck all" batch. A live company has no samples to review.
export default function SampleReviewPage() {
  const { syncLive } = useOutletContext()
  return syncLive ? <Navigate to="/hubspot-to-albi" replace /> : <SampleReview />
}

function SampleReview() {
  const { session, companyId, companyName, isAdmin, tenantRevision, completeTenantTransition } = useOutletContext()
  const location = useLocation()
  const navigate = useNavigate()
  const initialQuery = useRef(presentSampleReviewQueryFilters(location.search))
  const tenantKey = `${companyId ?? 'none'}:${tenantRevision}`
  const tenantKeyRef = useRef(tenantKey)
  tenantKeyRef.current = tenantKey
  const [reloadToken, setReloadToken] = useState(0)
  // "Recheck all" batch polled from the server; `watched` marks a batch this page saw running.
  const [recheckAll, setRecheckAll] = useState(null)
  const [recheckAllPoll, setRecheckAllPoll] = useState(0)
  const [recheckAllStarting, setRecheckAllStarting] = useState(false)
  const [recheckAllError, setRecheckAllError] = useState('')
  const recheckAllWatching = useRef(null)

  useEffect(() => {
    if (initialQuery.current.invalid) navigate(location.pathname, { replace: true })
  }, [location.pathname, navigate])

  useEffect(() => {
    if (!companyId) return undefined
    const controller = new AbortController()
    const startedFor = tenantKey
    let timer = null
    const current = () => !controller.signal.aborted && tenantKeyRef.current === startedFor
    const watching = () => recheckAllWatching.current?.tenant === startedFor ? recheckAllWatching.current.id : null
    getH2ARecheckAll(session, companyId, { kind: 'sample', signal: controller.signal }).then(result => {
      if (!current()) return
      const batch = result?.batch ?? null
      const active = batch?.status === 'queued' || batch?.status === 'running'
      const watched = Boolean(batch?.id) && (active || watching() === batch.id)
      if (active) {
        recheckAllWatching.current = { tenant: startedFor, id: batch.id }
        timer = setTimeout(() => setRecheckAllPoll(value => value + 1), RECHECK_ALL_POLL_MS)
      } else if (watched) {
        // The batch finished while this page watched it: reload the queue and progress counters.
        recheckAllWatching.current = null
        setReloadToken(value => value + 1)
      }
      setRecheckAll({ tenant: startedFor, batch, watched })
      setRecheckAllError('')
    }).catch(cause => {
      if (!current() || cause?.name === 'AbortError') return
      setRecheckAllError(cause.message)
      if (watching()) timer = setTimeout(() => setRecheckAllPoll(value => value + 1), RECHECK_ALL_POLL_MS)
    })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [companyId, session, tenantKey, recheckAllPoll])

  function watchBatch(batch, startedFor) {
    if (batch?.id) {
      recheckAllWatching.current = { tenant: startedFor, id: batch.id }
      setRecheckAll({ tenant: startedFor, batch, watched: true })
    }
    setRecheckAllPoll(value => value + 1)
  }

  async function startRecheckAll() {
    if (!isAdmin || recheckAllStarting || !companyId) return
    const startedFor = tenantKey
    setRecheckAllStarting(true); setRecheckAllError('')
    try {
      const result = await startH2ARecheckAll(session, companyId, { kind: 'sample' })
      if (tenantKeyRef.current === startedFor) watchBatch(result?.batch, startedFor)
    } catch (cause) {
      if (tenantKeyRef.current === startedFor) setRecheckAllError(cause.message)
    } finally {
      if (tenantKeyRef.current === startedFor) setRecheckAllStarting(false)
    }
  }

  const batchState = recheckAll?.tenant === tenantKey ? recheckAll : null
  const batchView = presentRecheckAllBatch(batchState?.batch)
  const batchActive = Boolean(batchView?.active)

  const renderHeader = meta => {
    const counters = presentSampleReviewProgress(meta?.progress ?? null)
    return <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="break-words text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">{companyName || 'Selected company'}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-gray-900">Sample review</h2>
        <p className="mt-1 max-w-xl text-sm leading-6 text-gray-600">Review underlying contacts and organizations, correct them in HubSpot or Albi, then recheck the evidence.</p>
      </div>
      <dl className="grid shrink-0 grid-cols-3 gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3" aria-label="Sample review progress" aria-live="polite" aria-busy={Boolean(meta?.loading)}>
        {counters.map(counter => <div key={counter.key}><dt className="text-xs font-medium text-gray-600">{counter.label}</dt>
          <dd className={`mt-1 text-xl font-semibold tabular-nums ${counter.key === 'needsReview' && counter.value ? 'text-amber-800' : counter.value ? 'text-green-800' : 'text-gray-900'}`}>{meta?.loading ? '—' : counter.value}</dd></div>)}
      </dl>
    </header>
  }

  // The fresh-sample gate: without a current, review-capable sample there is nothing to review here.
  const renderGate = meta => {
    const sample = meta?.sample ?? null, progress = meta?.progress ?? null
    const historical = sample && (sample.historical || sample.reviewCaptureVersion !== 1)
    const clean = sample?.reviewCaptureVersion === 1 && progress?.total === 0 && progress?.fullDryRunReady === true
    if (!historical && sample && !clean) return null
    return <section className="rounded-xl border border-gray-200 bg-white px-5 py-10" role="status">
      <h3 className="font-semibold text-gray-900">{historical ? 'Run a new sample to create detailed review data' : clean ? 'No underlying records need correction' : 'No completed sample is available'}</h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">{historical ? 'This historical sample did not capture detailed evidence. Start a new sample in Settings.' : clean ? 'This fresh sample captured zero underlying review records. The full dry run is now available in Settings.' : 'If a sample is running, wait for it to finish. Go to Settings to check its status or start a sample.'}</p>
      <Link to="/hubspot-to-albi/settings" className="mt-4 inline-block text-sm font-semibold text-brand-700 underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Go to Settings</Link>
    </section>
  }

  const renderBeforeQueue = meta => {
    const sample = meta?.sample ?? null, progress = meta?.progress ?? null
    if (sample?.reviewCaptureVersion !== 1) return null
    const allCleared = progress?.total > 0 && progress?.needsReview === 0
    return <div className="space-y-3">
      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="sample-review-recheck-all">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 id="sample-review-recheck-all" className="text-sm font-semibold text-gray-900">Recheck all open records</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">After correcting records in Albi or HubSpot, recheck every open record at once. Albi is read once for the whole batch, and nothing is written to Albi or HubSpot.</p>
          </div>
          <button type="button" className={`${secondaryButton} shrink-0`} onClick={startRecheckAll}
            disabled={!isAdmin || Boolean(meta?.loading) || recheckAllStarting || batchActive || Boolean(meta?.busy) || !progress?.needsReview}>
            {batchActive ? 'Rechecking…' : recheckAllStarting ? 'Starting…' : 'Recheck all'}
          </button>
        </div>
        {batchView && (batchActive || batchState.watched) && <div className={`mt-3 rounded-lg border px-4 py-3 text-sm ${recheckAllTone[batchView.tone]}`} role="status" aria-live="polite">
          <p>{batchView.message}</p>
          {batchActive && <div className="mt-2 h-2 overflow-hidden rounded-full bg-white" role="progressbar" aria-label="Recheck all progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={batchView.percent}>
            <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${batchView.percent}%` }} />
          </div>}
        </div>}
        {recheckAllError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{recheckAllError}</p>}
      </section>
      {!meta?.loading && allCleared && <p className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800" role="status">Corrections are clear for this sample. Run a fresh sample to verify them; this sample does not unlock the full dry run.</p>}
    </div>
  }

  const renderFooter = meta => meta?.sample?.reviewCaptureVersion === 1 && !meta?.loading
    ? <p className="text-xs leading-5 text-gray-600">Review progress reflects individual rechecks. Original sample run totals remain unchanged.</p> : null

  return <ReviewWorkspace kind="sample" session={session} companyId={companyId} tenantRevision={tenantRevision}
    completeTenantTransition={completeTenantTransition} isAdmin={isAdmin} readOnly={!isAdmin} initialFilters={initialQuery.current.filters} reloadToken={reloadToken}
    renderHeader={renderHeader} renderGate={renderGate} renderBeforeQueue={renderBeforeQueue} renderFooter={renderFooter}
    onBatchStarted={batch => watchBatch(batch, tenantKey)} />
}
