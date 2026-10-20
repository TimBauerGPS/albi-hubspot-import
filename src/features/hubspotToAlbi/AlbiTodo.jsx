import { useEffect, useRef, useState } from 'react'
import { getH2ADryRunReview, getH2ARecheckAll, getH2AReviews, startH2ARecheckAll } from '../../lib/hubspotToAlbi'
import { presentSampleReviewItem } from './sampleReview.js'
import { btn, primary } from './ResolutionBar.jsx'

const KINDS = ['sample', 'live']
const POLL_MS = 3000
const DETAIL_CONCURRENCY = 4
const display = value => value === null || value === undefined || value === '' ? 'Blank' : String(value)
const storageKey = companyId => `h2a.albiTodo.${companyId ?? 'none'}`

function readTicks(companyId) {
  try { const parsed = JSON.parse(localStorage.getItem(storageKey(companyId)) ?? '[]'); return new Set(Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : []) } catch { return new Set() }
}
function writeTicks(companyId, ticks) {
  try { localStorage.setItem(storageKey(companyId), JSON.stringify([...ticks])) } catch { /* browser storage unavailable: ticks last for this view only */ }
}
// A short stable fingerprint of what the task asks for, so a changed task is never shown as already done.
function fingerprint(task) {
  const source = `${task.objectType}:${task.targetId}:${task.fields.map(field => `${field.field}=${display(field.value)}`).join('|')}`
  let hash = 5381
  for (let index = 0; index < source.length; index += 1) hash = (hash * 33 + source.charCodeAt(index)) >>> 0
  return hash.toString(36)
}
async function mapLimit(values, limit, run) {
  const results = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await run(values[index]) }
  }))
  return results
}
function albiName(item, targetId) {
  const match = (Array.isArray(item?.candidateSnapshots) ? item.candidateSnapshots : []).find(candidate => candidate?.id === targetId)
  const name = match?.fullName ?? ([match?.firstName, match?.lastName].filter(Boolean).join(' ') || match?.name)
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

// Every manual Albi edit waiting across both queues, grouped by the Albi record to change.
function groupTasks(loaded) {
  const groups = new Map()
  for (const { kind, item } of loaded) {
    const review = presentSampleReviewItem(item)
    const resolution = review.resolution
    if (!review.id || resolution?.status !== 'waiting_on_albi') continue
    const tasks = [...(resolution.events ?? [])].reverse().find(event => event.manualTasks?.length)?.manualTasks ?? []
    for (const task of tasks) {
      const key = `${task.objectType}:${task.targetId}`
      if (!groups.has(key)) groups.set(key, { key, objectType: task.objectType, targetId: task.targetId, url: task.url,
        name: albiName(item, task.targetId) ?? review.displayName, entries: [] })
      groups.get(key).entries.push({ tick: `${resolution.id ?? review.id}:${fingerprint(task)}`, reviewId: review.id, kind,
        displayName: review.displayName, fields: task.fields })
    }
  }
  return [...groups.values()]
}

export default function AlbiTodo({ session, companyId, tenantKey, readOnly = false }) {
  const tenantRef = useRef(tenantKey)
  tenantRef.current = tenantKey
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ticks, setTicks] = useState(() => readTicks(companyId))
  const [reload, setReload] = useState(0)
  const [recheck, setRecheck] = useState(null)
  const [poll, setPoll] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const startedFor = tenantKey
    const current = () => !controller.signal.aborted && tenantRef.current === startedFor
    // A different company starts from its own list and its own ticks; nothing from the previous one lingers.
    setLoading(true); setError(''); setGroups([]); setTicks(readTicks(companyId))
    async function load() {
      try {
        const pages = await Promise.all(KINDS.map(kind => getH2AReviews(session, companyId, { kind, bucket: 'todo', limit: 100, signal: controller.signal })
          .then(result => (Array.isArray(result?.items) ? result.items : []).map(row => ({ kind, row })))))
        const rows = pages.flat()
        const loaded = (await mapLimit(rows, DETAIL_CONCURRENCY, async ({ kind, row }) => {
          try { const result = await getH2ADryRunReview(session, companyId, row.id, { signal: controller.signal }); return result?.item ? { kind, item: result.item } : null } catch (cause) {
            if (cause?.name === 'AbortError') throw cause
            return null
          }
        })).filter(Boolean)
        if (!current()) return
        const next = groupTasks(loaded)
        setGroups(next)
        // A tick is only a reminder. Ticks for tasks that are no longer waiting are dropped.
        const live = new Set(next.flatMap(group => group.entries.map(entry => entry.tick)))
        setTicks(previous => { const kept = new Set([...readTicks(companyId), ...previous].filter(tick => live.has(tick))); writeTicks(companyId, kept); return kept })
      } catch (cause) {
        if (current() && cause?.name !== 'AbortError') setError(cause.message)
      } finally {
        if (current()) setLoading(false)
      }
    }
    if (companyId) load(); else { setLoading(false); setError('Select a company to load the Albi to-do.') }
    return () => controller.abort()
  }, [session, companyId, tenantKey, reload])

  useEffect(() => { setRecheck(null) }, [tenantKey])

  // After "Recheck done", poll each started batch and reload the list once all of them have finished.
  useEffect(() => {
    if (!recheck?.kinds?.length) return undefined
    const controller = new AbortController()
    const startedFor = tenantKey
    const timer = setTimeout(async () => {
      try {
        const states = await Promise.all(recheck.kinds.map(kind => getH2ARecheckAll(session, companyId, { kind, signal: controller.signal })))
        if (controller.signal.aborted || tenantRef.current !== startedFor) return
        if (states.some(state => ['queued', 'running'].includes(state?.batch?.status))) { setPoll(value => value + 1); return }
        // Tasks that still differ come back unticked, with the field still listed.
        setTicks(previous => { const kept = new Set([...previous].filter(tick => !recheck.ticks.includes(tick))); writeTicks(companyId, kept); return kept })
        setRecheck(null); setReload(value => value + 1)
      } catch (cause) {
        if (!controller.signal.aborted && cause?.name !== 'AbortError' && tenantRef.current === startedFor) setPoll(value => value + 1)
      }
    }, POLL_MS)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [recheck, poll, session, companyId, tenantKey])

  function toggle(tick, value) {
    setTicks(previous => { const next = new Set(previous); if (value) next.add(tick); else next.delete(tick); writeTicks(companyId, next); return next })
  }
  const tickedEntries = groups.flatMap(group => group.entries).filter(entry => ticks.has(entry.tick))
  const tickedReviews = [...new Map(tickedEntries.map(entry => [entry.reviewId, entry])).values()]

  async function recheckDone() {
    if (readOnly || !tickedReviews.length || recheck) return
    const startedFor = tenantKey
    setError('')
    const kinds = KINDS.filter(kind => tickedReviews.some(entry => entry.kind === kind))
    try {
      // One batch per kind, with exactly the ticked records: one Albi walk each.
      await Promise.all(kinds.map(kind => startH2ARecheckAll(session, companyId, { kind,
        reviewIds: tickedReviews.filter(entry => entry.kind === kind).map(entry => entry.reviewId).slice(0, 200) })))
      if (tenantRef.current === startedFor) setRecheck({ kinds, count: tickedReviews.length, ticks: tickedEntries.map(entry => entry.tick) })
    } catch (cause) {
      if (tenantRef.current === startedFor) setError(cause.message)
    }
  }
  function copy(value) { try { navigator.clipboard?.writeText(String(value ?? '')) } catch { /* clipboard unavailable */ } }

  return <section className="rounded-xl border border-gray-200 bg-white" aria-labelledby="albi-todo-title">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-3">
      <div className="min-w-0">
        <h3 id="albi-todo-title" className="text-lg font-semibold text-gray-900">Albi to-do</h3>
        <p className="text-xs leading-5 text-gray-600">Albi’s API can’t edit existing records. Make these edits in Albi, tick them, then recheck once. A tick is a reminder; the recheck verifies.</p>
      </div>
      <button type="button" className={primary} disabled={readOnly || !tickedReviews.length || Boolean(recheck) || loading} onClick={recheckDone}>
        {recheck ? 'Rechecking…' : `Recheck done (${tickedReviews.length})`}</button>
    </header>
    <div aria-live="polite" className="text-sm">
      {recheck && <p className="border-b border-brand-200 bg-brand-50 px-5 py-2 text-brand-800" role="status">{`Rechecking ${recheck.count} ${recheck.count === 1 ? 'record' : 'records'} with one Albi read. This list refreshes when it finishes.`}</p>}
      {error && <p className="border-b border-red-200 bg-red-50 px-5 py-2 text-red-800" role="alert">{error}</p>}
    </div>
    {loading ? <p className="px-5 py-8 text-sm text-gray-600" role="status">Loading the Albi to-do…</p>
      : groups.length === 0 ? <p className="px-5 py-8 text-sm text-gray-600">No Albi edits waiting.</p>
        : <ul className="divide-y divide-gray-100">{groups.map(group => <li key={group.key} className="px-5 py-3">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-900">
            <span className="break-words">{group.name}</span>
            <span className="font-normal text-gray-500">· Albi {group.objectType === 'companies' ? 'organization' : 'contact'} {group.targetId}</span>
            {group.url && <a href={group.url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-brand-700 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Open in Albi</a>}
          </p>
          <ul className="mt-2 space-y-2">{group.entries.map(entry => <li key={entry.tick} className={`flex gap-3 rounded-lg px-2 py-1.5 ${ticks.has(entry.tick) ? 'bg-green-50' : ''}`}>
            <input type="checkbox" className="mt-1 text-brand-600 focus:ring-brand-500" checked={ticks.has(entry.tick)} aria-label={`Done in Albi: ${entry.displayName}`}
              onChange={event => toggle(entry.tick, event.target.checked)} />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-gray-500">From {entry.kind === 'live' ? 'Conflicts' : 'Sample review'}: {entry.displayName}</p>
              <ul className="mt-1 space-y-1">{entry.fields.map(field => <li key={field.field} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-600">Set {field.label} to</span><span className="break-all font-medium text-gray-900">{display(field.value)}</span>
                <button type="button" className={`${btn} px-1.5 py-0.5 text-xs`} onClick={() => copy(field.value)}>Copy</button></li>)}</ul>
            </div>
          </li>)}</ul>
        </li>)}</ul>}
  </section>
}
