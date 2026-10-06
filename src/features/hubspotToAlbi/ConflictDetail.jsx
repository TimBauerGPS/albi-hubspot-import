import { useEffect, useMemo, useRef, useState } from 'react'
import { buildConflictResolution, proposedConflictFields } from './operations.js'

const buttonPrimary = 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const buttonSecondary = 'rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'
const buttonDanger = 'rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50'
const FIELD_LABELS = {
  firstname: 'First name', firstName: 'First name', lastname: 'Last name', lastName: 'Last name', name: 'Name',
  email: 'Email', phone: 'Phone', phoneNumber: 'Phone', mobilephone: 'Mobile phone', mobileNumber: 'Mobile phone',
  domain: 'Domain', address: 'Address', address1: 'Address', city: 'City', state: 'State', zip: 'Postal code',
  zipcode: 'Postal code', country: 'Country', id: 'Record ID',
}

function label(value) {
  return FIELD_LABELS[value] ?? String(value ?? '').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase())
}

function dateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function scalar(value) {
  if (value === null || value === undefined || value === '') return 'Not provided'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(scalar).join(', ')
  return Object.entries(value).map(([key, item]) => `${label(key)}: ${scalar(item)}`).join(' · ')
}

function SafeDefinitionList({ value, empty = 'No values provided.' }) {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []
  if (entries.length === 0) return <p className="text-sm text-gray-500">{empty}</p>
  return (
    <dl className="divide-y divide-gray-100">
      {entries.map(([key, item]) => (
        <div key={key} className="grid gap-1 py-2 sm:grid-cols-[9rem_1fr] sm:gap-3">
          <dt className="text-xs font-medium text-gray-500">{label(key)}</dt>
          <dd className="break-words text-sm text-gray-900">{scalar(item)}</dd>
        </div>
      ))}
    </dl>
  )
}

function candidateName(candidate, index) {
  const name = candidate?.name || [candidate?.firstName ?? candidate?.firstname, candidate?.lastName ?? candidate?.lastname].filter(Boolean).join(' ')
  return name || candidate?.email || `Albi candidate ${index + 1}`
}

function confirmationCopy(action, fields) {
  if (action === 'create_new') return 'Create a new Albi record from the reviewed HubSpot source values.'
  if (action === 'approve_fields') return `Apply HubSpot values for: ${fields.map(label).join(', ')}.`
  return 'Skip this conflict item. The current item will not be written by this resolution.'
}

export default function ConflictDetail({ conflict, isAdmin, busy, onResolve }) {
  const fields = useMemo(() => proposedConflictFields(conflict), [conflict])
  const candidates = Array.isArray(conflict?.candidate_snapshots) ? conflict.candidate_snapshots : []
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [selectedTarget, setSelectedTarget] = useState('')
  const [selectedFields, setSelectedFields] = useState([])
  const [pendingAction, setPendingAction] = useState('')
  const [formError, setFormError] = useState('')
  const [manyToOneRequired, setManyToOneRequired] = useState(false)
  const [approveManyToOne, setApproveManyToOne] = useState(false)
  const cancelRef = useRef(null)
  const dialogRef = useRef(null)
  const previousFocus = useRef(null)
  const expectedUpdatedAt = conflict?.updated_at

  useEffect(() => {
    setCandidateIndex(0)
    setSelectedTarget('')
    setSelectedFields([])
    setPendingAction('')
    setFormError('')
    setManyToOneRequired(false)
    setApproveManyToOne(false)
  }, [conflict?.id])

  useEffect(() => {
    if (!pendingAction) return undefined
    previousFocus.current = document.activeElement
    cancelRef.current?.focus()
    return () => previousFocus.current?.focus?.()
  }, [pendingAction])

  if (!conflict) return null
  const candidate = candidates[candidateIndex] ?? null
  const open = conflict.status === 'open'

  function toggleField(field) {
    setSelectedFields(current => current.includes(field) ? current.filter(item => item !== field) : [...current, field])
  }

  async function submit(action, confirmed = false) {
    setFormError('')
    if (['create_new', 'approve_fields', 'skip_item'].includes(action) && !confirmed) {
      if (action === 'approve_fields' && selectedFields.length === 0) {
        setFormError('Select at least one proposed field.')
        return
      }
      setPendingAction(action)
      return
    }
    try {
      const options = action === 'link_existing'
        ? { targetId: selectedTarget, approveManyToOne }
        : ['approve_fields', 'retain_albi'].includes(action) ? { fields: selectedFields } : {}
      const result = await onResolve(buildConflictResolution(conflict, action, options))
      if (result?.manyToOneRequired) {
        setManyToOneRequired(true)
        setApproveManyToOne(false)
        setFormError('This Albi record is already linked. Review and explicitly approve the many-to-one mapping to continue.')
      } else if (result?.stale) {
        setPendingAction('')
        setManyToOneRequired(false)
        setApproveManyToOne(false)
      } else if (result?.ok || result?.saved) {
        setPendingAction('')
        setManyToOneRequired(false)
        setApproveManyToOne(false)
      }
    } catch (cause) {
      setFormError(cause.message)
    }
  }

  function closeConfirmation() {
    setPendingAction('')
  }

  function confirmationKeyDown(event) {
    if (event.key === 'Escape') closeConfirmation()
    if (event.key === 'Tab') {
      const controls = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
  }

  return (
    <article className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm" aria-labelledby="conflict-detail-title" data-updated-at={expectedUpdatedAt}>
      <header className="border-b border-gray-200 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold capitalize text-amber-800 ring-1 ring-inset ring-amber-600/20">{String(conflict.status).replaceAll('_', ' ')}</span>
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label(conflict.conflict_type)}</span>
        </div>
        <h2 id="conflict-detail-title" className="mt-2 text-lg font-semibold text-gray-900">Review {label(conflict.object_type)} conflict</h2>
        <p className="mt-1 text-xs text-gray-500">Created {dateTime(conflict.created_at)} · Source kind {label(conflict.object_type)}</p>
      </header>

      <section className="border-b border-amber-200 bg-amber-50 px-5 py-4 sm:px-6" aria-labelledby="why-review-title">
        <h3 id="why-review-title" className="text-xs font-bold uppercase tracking-[0.12em] text-amber-900">Why this needs review</h3>
        <p className="mt-1 text-sm font-medium text-amber-950">{label(conflict.reason)}</p>
        <div className="mt-3">
          <h4 className="text-xs font-semibold text-amber-900">Match evidence</h4>
          <div className="mt-1"><SafeDefinitionList value={conflict.match_evidence} empty="No match evidence was recorded." /></div>
        </div>
      </section>

      <section className="px-5 py-5 sm:px-6" aria-labelledby="comparison-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 id="comparison-title" className="font-semibold text-gray-900">Source and candidate comparison</h3>
            <p className="mt-1 text-xs text-gray-500">HubSpot is the recommended source, but different nonblank Albi values require your decision.</p>
          </div>
          {candidates.length > 1 && (
            <div className="sm:w-64">
              <label className="text-xs font-medium text-gray-700" htmlFor="conflict-candidate-view">Compare Albi candidate</label>
              <select id="conflict-candidate-view" value={candidateIndex} onChange={event => setCandidateIndex(Number(event.target.value))}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20">
                {candidates.map((item, index) => <option key={`${item.id ?? 'candidate'}:${index}`} value={index}>{candidateName(item, index)}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <section className="border-t-4 border-brand-500 bg-brand-50/40 px-4 py-3" aria-labelledby="hubspot-source-title">
            <p className="text-xs font-bold uppercase tracking-wide text-brand-700">HubSpot recommendation</p>
            <h4 id="hubspot-source-title" className="mt-1 font-semibold text-gray-900">HubSpot source</h4>
            <div className="mt-2"><SafeDefinitionList value={conflict.source_snapshot} /></div>
          </section>
          <section className="border-t-4 border-gray-400 bg-gray-50 px-4 py-3" aria-labelledby="albi-candidate-title">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-600">Existing value</p>
            <h4 id="albi-candidate-title" className="mt-1 font-semibold text-gray-900">Albi candidate</h4>
            <div className="mt-2"><SafeDefinitionList value={candidate} empty="No existing Albi candidate is available." /></div>
          </section>
        </div>
      </section>

      <section className="border-t border-gray-100 px-5 py-5 sm:px-6" aria-labelledby="proposed-title">
        <h3 id="proposed-title" className="font-semibold text-gray-900">Proposed changes</h3>
        <div className="mt-2"><SafeDefinitionList value={conflict.proposed_changes} empty="No field-level proposal was recorded." /></div>
      </section>

      {isAdmin && open ? (
        <section className="border-t border-gray-200 bg-gray-50 px-5 py-5 sm:px-6" aria-labelledby="resolution-title">
          <h3 id="resolution-title" className="font-semibold text-gray-900">Resolve this item</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500">Choose one intent. Server authorization and the current conflict version are checked again when submitted.</p>

          {formError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{formError}</p>}

          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-gray-900">Identity decision</legend>
              <label className="block text-xs font-medium text-gray-700" htmlFor="conflict-target">Existing Albi target</label>
              <select id="conflict-target" value={selectedTarget} onChange={event => {
                setSelectedTarget(event.target.value)
                setManyToOneRequired(false)
                setApproveManyToOne(false)
              }} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20">
                <option value="">Select an exact candidate</option>
                {candidates.filter(item => item?.id != null).map((item, index) => <option key={String(item.id)} value={String(item.id)}>{candidateName(item, index)} · ID {item.id}</option>)}
              </select>
              {manyToOneRequired && (
                <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" checked={approveManyToOne} onChange={event => setApproveManyToOne(event.target.checked)} />
                  <span><strong>Approve many-to-one mapping.</strong> I understand multiple HubSpot records will link to this one Albi record.</span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <button className={buttonPrimary} type="button" disabled={busy || !selectedTarget || manyToOneRequired && !approveManyToOne} onClick={() => submit('link_existing')}>Link selected candidate</button>
                <button className={buttonSecondary} type="button" disabled={busy} onClick={() => submit('create_new')}>Create new target</button>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-gray-900">Field decision</legend>
              {fields.length === 0 ? <p className="text-sm text-gray-500">No selectable field differences were included.</p> : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {fields.map(field => (
                    <label key={field} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800">
                      <input type="checkbox" checked={selectedFields.includes(field)} onChange={() => toggleField(field)} className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                      {label(field)}
                    </label>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button className={buttonPrimary} type="button" disabled={busy || selectedFields.length === 0} onClick={() => submit('approve_fields')}>Approve HubSpot fields</button>
                <button className={buttonSecondary} type="button" disabled={busy || selectedFields.length === 0} onClick={() => submit('retain_albi')}>Retain Albi fields</button>
                <button className={buttonDanger} type="button" disabled={busy} onClick={() => submit('skip_item')}>Skip item</button>
              </div>
            </fieldset>
          </div>
        </section>
      ) : (
        <section className="border-t border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600 sm:px-6">
          {!isAdmin ? 'This conflict is read-only for members. A company admin can resolve it.' : `This item is ${String(conflict.status).replaceAll('_', ' ')} and has no available mutation.`}
        </section>
      )}

      <section className="border-t border-gray-200 px-5 py-5 sm:px-6" aria-labelledby="audit-title">
        <h3 id="audit-title" className="font-semibold text-gray-900">Audit trail</h3>
        {Array.isArray(conflict.audit) && conflict.audit.length ? (
          <ol className="mt-3 space-y-3 border-l border-gray-200 pl-4">
            {conflict.audit.map(event => (
              <li key={event.id} className="text-sm">
                <p className="font-medium capitalize text-gray-900">{label(event.resolution_action || event.event_type)}</p>
                <p className="text-xs text-gray-500">{dateTime(event.created_at)}</p>
                {event.sanitized_details && <p className="mt-1 text-xs text-gray-600">{scalar(event.sanitized_details)}</p>}
              </li>
            ))}
          </ol>
        ) : <p className="mt-2 text-sm text-gray-500">No review events yet.</p>}
      </section>

      {pendingAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 px-4" role="dialog" aria-modal="true" aria-labelledby="confirm-resolution-title" onKeyDown={confirmationKeyDown}>
          <div ref={dialogRef} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 id="confirm-resolution-title" className="text-lg font-semibold text-gray-900">Confirm resolution</h3>
            <p className="mt-2 text-sm leading-6 text-gray-600">{confirmationCopy(pendingAction, selectedFields)}</p>
            <p className="mt-2 text-xs text-gray-500">Conflict {conflict.id}. This uses the current reviewed version and will not silently replay if it changed.</p>
            <div className="mt-5 flex flex-row-reverse flex-wrap gap-2">
              <button className={pendingAction === 'skip_item' ? buttonDanger : buttonPrimary} type="button" disabled={busy} onClick={() => submit(pendingAction, true)}>{busy ? 'Saving…' : 'Confirm resolution'}</button>
              <button ref={cancelRef} className={buttonSecondary} type="button" disabled={busy} onClick={closeConfirmation}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </article>
  )
}
