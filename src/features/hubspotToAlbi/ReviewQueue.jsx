import { useEffect, useRef } from 'react'
import { blockedReasonCopy } from '../../../shared/h2aBlockedReasons.js'
import { presentSampleReviewItem } from './sampleReview.js'
import { btn, Kbd } from './ResolutionBar.jsx'

const resolutionLabels = { pending: 'Needs decision', applying: 'Applying', waiting_on_albi: 'Waiting on Albi',
  ready_to_recheck: 'Ready to recheck', completed: 'Completed', failed: 'Action failed', superseded: 'Superseded' }
const bucketBadge = { quick: ['Quick win', 'bg-green-50 text-green-800 ring-green-600/20'], decision: ['Decision', 'bg-amber-50 text-amber-800 ring-amber-600/20'],
  blocked: ['Blocked', 'bg-red-50 text-red-800 ring-red-600/20'], todo: ['Albi to-do', 'bg-amber-50 text-amber-800 ring-amber-600/20'],
  done: ['Done', 'bg-gray-100 text-gray-700 ring-gray-500/20'] }
const text = value => typeof value === 'string' && value.trim() ? value.trim() : ''

// One line under the name: what is happening to this row now, else why it needs review.
function rowReason(item, review, { pending, sending, error }) {
  if (error) return { line: error, tone: 'text-red-700' }
  if (sending) return { line: 'Sending…', tone: 'text-gray-500' }
  if (pending) return { line: 'Sending in a few seconds… (u to undo)', tone: 'text-gray-500' }
  const details = item?.triageDetails ?? {}
  if (details.merged) return { line: 'Merged in HubSpot. Review the surviving record.', tone: 'text-red-700' }
  const blocked = blockedReasonCopy(details.blockedReason)
  if (blocked) return { line: blocked, tone: 'text-red-700' }
  if (item?.triageBucket === 'quick') return { line: details.quickKind === 'create' ? 'Ready to create in Albi' : 'One exact match in Albi', tone: 'text-green-700' }
  return { line: review.reasonLabel, tone: 'text-gray-500' }
}

// Presentational queue for one bucket. Bulk controls (tick boxes, select all, bulk link, recheck selected)
// exist only on the Quick wins bucket, and there is deliberately no bulk create.
export default function ReviewQueue({
  items = [], bucket = 'quick', selectedId = null, pendingIds = new Set(), sendingIds = new Set(), errors = {}, checked = new Set(),
  bulkEnabled = true, onSelect, onToggle, onSelectAll, bulkLinkCount = 0, onBulkLink, onRecheckSelected, createSelectedCount = 0, onCreateSelected, busy = false,
  nextCursor = null, loadingMore = false, loadMoreDisabled = false, onLoadMore,
}) {
  const sentinel = useRef(null)
  const loadRef = useRef(onLoadMore)
  loadRef.current = loadMoreDisabled || loadingMore ? null : onLoadMore
  useEffect(() => {
    const target = sentinel.current
    if (!nextCursor || !target || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadRef.current?.() })
    observer.observe(target)
    return () => observer.disconnect()
  }, [nextCursor])

  const bulk = bucket === 'quick' && bulkEnabled
  const selectable = items.filter(item => !pendingIds.has(item.id))
  const allChecked = selectable.length > 0 && selectable.every(item => checked.has(item.id))
  return <aside className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white lg:sticky lg:top-4" aria-label="Review queue">
    {bulk && <div className="space-y-2 border-b border-gray-200 p-3">
      <p className="text-xs text-gray-600">{checked.size ? `${checked.size} selected` : 'Bulk link applies to every exact match, or to the rows you tick (x). Tick no-match rows to create them together.'}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={busy || !selectable.length} onClick={onSelectAll}>{allChecked ? 'Clear selection' : 'Select all in bucket'}</button>
        <button type="button" className={btn} disabled={busy || !bulkLinkCount} onClick={onBulkLink}>Link all exact matches ({bulkLinkCount})</button>
        <button type="button" className={btn} disabled={busy || !checked.size} onClick={onRecheckSelected}>Recheck selected ({checked.size})</button>
        {onCreateSelected && <button type="button" className={btn} disabled={busy || !createSelectedCount} onClick={onCreateSelected}
          title="Create the ticked no-match records in Albi with one referral source">Create selected ({createSelectedCount})</button>}
      </div>
    </div>}
    <ol className="max-h-[38rem] divide-y divide-gray-100 overflow-y-auto">
      {items.length === 0 && <li className="px-4 py-8 text-sm text-gray-600">Nothing here.</li>}
      {items.map(item => {
        const review = presentSampleReviewItem(item)
        const name = text(item.displayName) || review.displayName
        const organization = text(item.identity?.organizationName) || text(item.identity?.email) || text(item.identity?.domain)
        const pending = pendingIds.has(item.id), sending = sendingIds.has(item.id)
        const reason = rowReason(item, review, { pending, sending, error: errors[item.id] })
        const [badge, tone] = bucketBadge[item.triageBucket] ?? bucketBadge.decision
        return <li key={item.id} className={`flex gap-2 px-3 py-2.5 ${selectedId === item.id ? 'bg-brand-50' : 'hover:bg-gray-50'} ${pending ? 'opacity-60' : ''}`}>
          {bulk && <input type="checkbox" checked={checked.has(item.id)} disabled={pending || busy} aria-label={`Select ${name}`} className="mt-1 text-brand-600 focus:ring-brand-500"
            onChange={() => onToggle?.(item.id)} />}
          <button type="button" onClick={() => onSelect?.(item.id)} aria-current={selectedId === item.id ? 'true' : undefined}
            className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500">
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0 break-words text-sm font-semibold text-gray-900">{name}</span>
              <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[0.68rem] font-semibold ring-1 ring-inset ${tone}`}>{badge}</span>
            </span>
            <span className="block break-words text-xs text-gray-600">{review.objectType === 'companies' ? 'Organization' : 'Contact'}{organization ? ` · ${organization}` : ''}</span>
            <span className={`mt-0.5 block break-words text-xs ${reason.tone}`}>{reason.line}</span>
            {review.resolutionStatus && <span className="mt-1 inline-flex rounded-md bg-blue-50 px-1.5 py-0.5 text-[0.68rem] font-semibold text-blue-800 ring-1 ring-inset ring-blue-600/20">{resolutionLabels[review.resolutionStatus]}</span>}
          </button>
        </li>
      })}
    </ol>
    {nextCursor && <div ref={sentinel} className="border-t border-gray-100 px-4 py-3">
      <button type="button" onClick={onLoadMore} disabled={loadingMore || loadMoreDisabled} className={`${btn} w-full`}>{loadingMore ? 'Loading…' : 'Load more'}</button>
    </div>}
    {bulk && items.length > 0 && <p className="border-t border-gray-100 px-4 py-2 text-[0.7rem] text-gray-500">Tick a row with<Kbd>x</Kbd></p>}
  </aside>
}
