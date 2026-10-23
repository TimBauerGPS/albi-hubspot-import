import { useEffect, useRef, useState } from 'react'
import { getH2AOutbox, retryH2AOutbox, returnH2AOutbox } from '../../lib/hubspotToAlbi'
import { btn, primary } from './ResolutionBar.jsx'
import { blockedReasonCopy } from '../../../shared/h2aBlockedReasons.js'

// The Outbox: actions waiting to be sent to Albi by the background worker, the one being sent, and any that
// failed (with the reason). Failed actions stay here until retried or returned to review.
const ACTION_LABELS = {
  create_albi: 'Create in Albi', force_create_albi: 'Create new in Albi', link_existing: 'Link', resolve_fields: 'Apply field choices',
  choose_organization: 'Set organization', skip_live: 'Skip', create_with_organization: 'Create organization and contact',
}
const REASONS = {
  albi_busy: 'Albi was busy (too many requests) and kept refusing. Retry when it is quieter.',
  changed: 'The record changed after this was queued. Back to review to decide again.',
  record_changed: 'The record changed after this was queued. Back to review to decide again.',
  possible_match: 'A possible match appeared in Albi. Back to review to choose link or create.',
  reply_unreadable: 'Albi’s reply couldn’t be read, so it may have gone through. Retry checks Albi first, so nothing is duplicated.',
  not_allowed: 'This isn’t allowed for the record any more (permissions, or it was already handled).',
  albi_rejected: 'Albi rejected it (a required value is missing or invalid). Back to review to check the record.',
  not_found: 'The record no longer exists.',
  no_default_referral: 'It has no default referral source (none on its organization or salesperson). Back to review to choose one.',
  not_ready: 'Its create checks did not pass. Back to review to see why.',
  error: 'Something went wrong sending it. Retry, or send it back to review.',
}
const time = value => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '' }

function statusText(item) {
  if (item.status === 'sending') return 'Sending…'
  if (item.status === 'failed') return `Failed: ${REASONS[item.errorCode] ?? blockedReasonCopy(item.errorCode) ?? REASONS.error}`
  const at = Date.parse(item.nextAttemptAt ?? '')
  if (item.errorCode === 'albi_busy' && Number.isFinite(at) && at > Date.now()) return `Waiting: Albi was busy, trying again at ${time(item.nextAttemptAt)}`
  return 'Waiting to send'
}

export default function OutboxPanel({ session, companyId, kind = 'live', tenantKey, readOnly = false, pollMs = 4000, onChanged }) {
  const [state, setState] = useState({ items: [], summary: null, error: '' })
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const mine = ++generation.current
    let timer = null
    const load = async () => {
      try {
        const result = await getH2AOutbox(session, companyId, kind)
        if (mine !== generation.current) return
        const items = Array.isArray(result?.items) ? result.items : []
        setState({ items, summary: result?.summary ?? null, error: '' })
        // Keep current while anything is still waiting or sending.
        if (items.some(item => item.status !== 'failed')) timer = setTimeout(load, pollMs)
      } catch (cause) {
        if (mine === generation.current) setState(current => ({ ...current, error: cause?.message || 'The Outbox could not be loaded.' }))
      }
    }
    load()
    return () => { generation.current += 1; if (timer) clearTimeout(timer) }
  }, [session, companyId, kind, tenantKey, pollMs, reload])

  async function act(run, ids) {
    if (!ids.length || busy) return
    setBusy(true)
    try { await run(session, companyId, ids); onChanged?.() } catch (cause) { setState(current => ({ ...current, error: cause?.message || 'The Outbox could not be updated.' })) }
    finally { setBusy(false); setReload(value => value + 1) }
  }

  const failed = state.items.filter(item => item.status === 'failed')
  const waiting = state.items.filter(item => item.status === 'queued').length
  const sending = state.items.filter(item => item.status === 'sending').length

  return <section className="rounded-xl border border-gray-200 bg-white" aria-label="Outbox">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-3">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Outbox</h2>
        <p className="text-sm text-gray-600">Actions are sent to Albi one at a time in the background, slowing down when Albi is busy.
          {state.items.length > 0 && ` ${waiting} waiting · ${sending} sending · ${failed.length} failed`}</p>
      </div>
      {!readOnly && failed.length > 0 && <button type="button" className={primary} disabled={busy} onClick={() => act(retryH2AOutbox, failed.map(item => item.id))}>Retry all failed</button>}
    </header>
    {state.error && <p className="mx-5 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">{state.error}</p>}
    {state.items.length === 0 && !state.error
      ? <p className="px-5 py-6 text-sm text-gray-600">Nothing in the Outbox. Every action has been sent.</p>
      : <ul className="divide-y divide-gray-100">
        {state.items.map(item => <li key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-gray-900">{item.name} <span className="font-normal text-gray-500">· {ACTION_LABELS[item.action] ?? 'Action'}</span></p>
            <p className={`text-xs ${item.status === 'failed' ? 'text-red-800' : 'text-gray-600'}`}>{statusText(item)}</p>
          </div>
          {!readOnly && item.status === 'failed' && <span className="flex gap-2">
            <button type="button" className={btn} disabled={busy} aria-label={`Retry ${item.name}`} onClick={() => act(retryH2AOutbox, [item.id])}>Retry</button>
            <button type="button" className={btn} disabled={busy} aria-label={`Back to review: ${item.name}`} onClick={() => act(returnH2AOutbox, [item.id])}>Back to review</button>
          </span>}
        </li>)}
      </ul>}
  </section>
}
