import { useEffect, useRef, useState } from 'react'
import { presentSampleReviewItem } from './sampleReview.js'
import { buildResolutionConfirmation } from './sampleReviewResolution.js'

const primary = 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const secondary = 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'
const idPattern = /^[1-9]\d{0,99}$/
const display = value => value === null || value === '' ? 'Blank' : value

function TaskLink({ url, children }) {
  return url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex text-sm font-semibold text-brand-700 underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{children}</a>
}

export default function SampleReviewResolution({ item, busy = false, onResolve }) {
  const review = presentSampleReviewItem(item)
  const capability = review.resolutionCapability
  const resolution = review.resolution
  const [choices, setChoices] = useState({})
  const [candidateId, setCandidateId] = useState('')
  const [organizationSourceId, setOrganizationSourceId] = useState('')
  const [approveAssociation, setApproveAssociation] = useState(false)
  const [approveManyToOne, setApproveManyToOne] = useState(false)
  const [confirmation, setConfirmation] = useState(null)
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const requestRef = useRef(null)
  const submitLock = useRef(false)
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)
  const confirmRef = useRef(null)
  const sectionRef = useRef(null)
  const previousFocus = useRef(null)
  const fields = review.resolutionFields
  const eligibleFields = fields.length && review.candidates.length === 1 && idPattern.test(review.candidates[0].id)
  const eligibleCandidates = review.candidates.filter(candidate => idPattern.test(candidate.id))
  const organizationOptions = Array.isArray(item?.organizationOptions) ? item.organizationOptions.filter(option =>
    idPattern.test(option?.sourceId) && idPattern.test(option?.targetId) && typeof option.associated === 'boolean' &&
    idPattern.test(option?.contactTargetId) && idPattern.test(option?.currentOrganizationTargetId ?? option.targetId)) : []
  const canChooseOrganization = organizationOptions.length > 0
  const selectedOrganization = organizationOptions.find(option => option.sourceId === organizationSourceId)
  const canCreate = item?.createReadiness?.ready === true && review.candidates.length === 0
  const canForceCreate = item?.forceCreateReadiness?.ready === true && eligibleCandidates.length > 0 &&
    eligibleCandidates.length === review.candidates.length
  const effectiveBusy = busy || submitting
  const canAct = capability.canResolve && review.actions.length > 0 && (review.status === 'needs_review' ||
    review.status === 'cleared' && item?.recheckOutcome === 'safe_to_create')

  useEffect(() => {
    setChoices({}); setCandidateId(''); setOrganizationSourceId(''); setApproveAssociation(false); setApproveManyToOne(false)
    setConfirmation(null); setMessage(''); requestRef.current = null; submitLock.current = false
  }, [review.id, review.updatedAt])

  useEffect(() => {
    if (!confirmation) return undefined
    previousFocus.current = document.activeElement
    cancelRef.current?.focus()
    return () => {
      const target = previousFocus.current
      if (target?.isConnected) target.focus()
      else sectionRef.current?.focus()
    }
  }, [confirmation])

  useEffect(() => {
    if (!confirmation) return
    if (effectiveBusy) dialogRef.current?.focus()
    else if (message.startsWith('Resolution failed')) confirmRef.current?.focus()
  }, [confirmation, effectiveBusy, message])

  function changed(nextChoices, nextCandidate, nextOrganization, nextApproval) {
    setChoices(nextChoices); setCandidateId(nextCandidate); setOrganizationSourceId(nextOrganization); setApproveAssociation(false); setApproveManyToOne(nextApproval)
    requestRef.current = null; setMessage(''); setConfirmation(null)
  }

  function open(action) {
    if (!canAct || effectiveBusy) return
    let decision
    if (action === 'resolve_fields') {
      if (!eligibleFields || fields.some(field => !['hubspot', 'albi'].includes(choices[field.key]))) {
        setMessage('Choose a source of truth for every differing field before continuing.'); return
      }
      decision = { action, fieldChoices: Object.fromEntries(fields.map(field => [field.key, choices[field.key]])) }
    } else if (action === 'link_existing') {
      if (!eligibleCandidates.some(candidate => candidate.id === candidateId)) { setMessage('Choose a valid Albi candidate.'); return }
      decision = { action, candidateId, approveManyToOne }
    } else if (action === 'create_albi') {
      if (!canCreate) return
      decision = { action }
    } else if (action === 'force_create_albi') {
      if (!canForceCreate) return
      decision = { action, ignoredCandidateIds: eligibleCandidates.map(candidate => candidate.id),
        ...(idPattern.test(item?.forceCreateReadiness?.deferredOrganizationSourceId)
          ? { deferOrganizationAssociation: true } : {}) }
    } else {
      if (!canChooseOrganization || !selectedOrganization || !selectedOrganization.associated && !approveAssociation) {
        setMessage('Choose a current associated organization.'); return
      }
      decision = { action, organizationSourceId, addHubSpotAssociation: !selectedOrganization.associated }
    }
    try {
      const preview = buildResolutionConfirmation({ review, decision })
      if (action === 'choose_organization') {
        const option = organizationOptions.find(value => value.sourceId === organizationSourceId)
        if (!option.associated) preview.hubspotWrites.push({ field: 'Company association', value: option.sourceId })
        if (option.currentOrganizationTargetId !== option.targetId) preview.albiTasks.push({ field: 'Organization',
          value: option.targetId, url: option.contactUrl, organizationUrl: option.organizationUrl })
      }
      setMessage(''); setConfirmation({ decision, preview, expectedUpdatedAt: review.updatedAt })
    } catch { setMessage('Current evidence cannot support that resolution. Recheck this record first.') }
  }

  async function submit() {
    if (!confirmation || effectiveBusy || submitLock.current) return
    const fingerprint = JSON.stringify({ decision: confirmation.decision, expectedUpdatedAt: confirmation.expectedUpdatedAt })
    if (requestRef.current?.fingerprint !== fingerprint) requestRef.current = { fingerprint, id: crypto.randomUUID() }
    submitLock.current = true; setSubmitting(true); setMessage('Applying resolution…')
    try {
      const result = await onResolve(confirmation.decision, requestRef.current.id, confirmation.expectedUpdatedAt)
      const status = result?.resolution?.status
      if (status === 'failed') setMessage('Resolution failed. Your decision is saved here; retry the same confirmation.')
      else if (status === 'waiting_on_albi') { setMessage('Waiting on Albi. Complete the manual tasks, then recheck.'); setConfirmation(null) }
      else if (status === 'ready_to_recheck') { setMessage('Provider change reconciled. Recheck this record to verify it.'); setConfirmation(null) }
      else if (status === 'completed') { setMessage('Resolution completed.'); setConfirmation(null) }
      else setMessage('Resolution is applying. Refresh the record to see its latest status.')
    } catch (cause) {
      if (cause?.name === 'AbortError') return
      if (cause?.status === 409) { setConfirmation(null); requestRef.current = null; setMessage('This sample review changed. Its detail was refreshed. Review and confirm again.') }
      else setMessage(`Resolution failed. ${cause?.message ?? 'Try again.'} Your decision is retained for retry.`)
    } finally { submitLock.current = false; setSubmitting(false) }
  }

  function onDialogKeyDown(event) {
    if (event.key === 'Escape' && !effectiveBusy) { setConfirmation(null); return }
    if (event.key !== 'Tab') return
    const controls = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); dialogRef.current?.focus() }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current || !controls.includes(document.activeElement))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current || !controls.includes(document.activeElement))) { event.preventDefault(); first.focus() }
  }

  const events = resolution?.events ?? []
  const manualTasks = resolution?.status === 'waiting_on_albi'
    ? [...events].reverse().find(event => event.manualTasks?.length)?.manualTasks ?? [] : []
  const feedback = message && <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role={/failed|changed|cannot|Choose/.test(message) ? 'alert' : 'status'}>{message}</p>
  return <section ref={sectionRef} tabIndex={-1} className="border-t border-gray-200 pt-5 outline-none" aria-labelledby="sample-review-resolution-title">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 id="sample-review-resolution-title" className="text-sm font-semibold text-gray-900">Resolve this record</h4>
      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${resolution?.status === 'waiting_on_albi' ? 'bg-amber-50 text-amber-800' : resolution?.status === 'failed' ? 'bg-red-50 text-red-800' : 'bg-gray-100 text-gray-700'}`}>
        {resolution?.statusLabel ?? (capability.canResolve ? 'Ready for decision' : 'Read-only')}
      </span>
    </div>
    <p className="mt-2 text-xs leading-5 text-gray-600">Resolution is {capability.enabled ? capability.canResolve ? 'available for this administrator.' : 'read-only for your role.' : 'unavailable in the current mode.'} {capability.hubspotWrites === 'rejected' ? 'Recent HubSpot write authorization was rejected.' : capability.hubspotWrites === 'verified_when_first_used' ? 'HubSpot write access is verified when first used.' : ''}</p>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
      <TaskLink url={review.hubspotUrl}>Open source in HubSpot</TaskLink>
      {review.candidateLinks.map(link => <TaskLink key={link.id} url={link.url}>Open {review.objectType === 'contacts' ? 'contact' : 'organization'} in Albi</TaskLink>)}
    </div>

    {canAct && review.actions.includes('resolve_fields') && eligibleFields && <div className="mt-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold text-gray-900">Choose each field</h5>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={effectiveBusy} className={secondary} onClick={() => changed(Object.fromEntries(fields.map(field => [field.key, 'hubspot'])), candidateId, organizationSourceId, approveManyToOne)}>Use HubSpot for all</button>
          <button type="button" disabled={effectiveBusy} className={secondary} onClick={() => changed(Object.fromEntries(fields.map(field => [field.key, 'albi'])), candidateId, organizationSourceId, approveManyToOne)}>Use Albi for all</button></div></div>
      {fields.map(field => <fieldset key={field.key} className="min-w-0 rounded-lg border border-gray-200 p-3"><legend className="px-1 text-xs font-semibold text-gray-800">{field.label}</legend>
        <div className="grid gap-2 sm:grid-cols-2">{[['hubspot', 'Use HubSpot', 'You’ll update this in Albi', field.hubspot], ['albi', 'Use Albi', 'Updates HubSpot now', field.albi]].map(([value, label, consequence, fieldValue]) =>
          <label key={value} className={`flex min-w-0 cursor-pointer gap-2 rounded-md border px-3 py-2 text-sm ${choices[field.key] === value ? 'border-brand-500 bg-brand-50' : 'border-gray-200 bg-white'}`}>
            <input type="radio" name={`resolution-${review.id}-${field.key}`} value={value} checked={choices[field.key] === value} disabled={effectiveBusy}
              onChange={() => changed({ ...choices, [field.key]: value }, candidateId, organizationSourceId, approveManyToOne)} className="mt-1 text-brand-600 focus:ring-brand-500" />
            <span className="min-w-0"><span className="block font-semibold text-gray-900">{label}</span><span className="block break-words text-gray-700">{display(fieldValue)}</span><span className="mt-1 block text-xs font-medium text-gray-600">{consequence}</span></span>
          </label>)}</div></fieldset>)}
      <button type="button" className={primary} disabled={effectiveBusy} onClick={() => open('resolve_fields')}>Review resolution</button>
    </div>}

    {canAct && review.actions.includes('link_existing') && eligibleCandidates.length > 0 && <div className="mt-5 space-y-3 rounded-lg border border-gray-200 p-4">
      <h5 className="text-sm font-semibold text-gray-900">Link an existing Albi record</h5>
      <label className="block text-xs font-medium text-gray-700">Albi candidate<select value={candidateId} onChange={event => changed(choices, event.target.value, organizationSourceId, approveManyToOne)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-brand-500"><option value="">Choose candidate</option>{eligibleCandidates.map(candidate => <option key={candidate.id} value={candidate.id}>Albi ID {candidate.id}</option>)}</select></label>
      <label className="flex gap-2 text-xs text-gray-700"><input type="checkbox" checked={approveManyToOne} onChange={event => changed(choices, candidateId, organizationSourceId, event.target.checked)} className="text-brand-600 focus:ring-brand-500" />Approve a many-to-one mapping if this Albi record is already linked elsewhere</label>
      <button type="button" className={primary} disabled={effectiveBusy || !candidateId} onClick={() => open('link_existing')}>Link selected Albi record</button>
    </div>}
    {canAct && review.actions.includes('create_albi') && review.candidates.length === 0 && <div className="mt-5 rounded-lg border border-gray-200 p-4"><h5 className="text-sm font-semibold text-gray-900">Create a new Albi record</h5>
      <p className="mt-1 text-xs leading-5 text-gray-600">The server rechecks identity and type readiness before creating anything.</p>
      {canCreate ? <button type="button" className={`${primary} mt-3`} disabled={effectiveBusy} onClick={() => open('create_albi')}>Create in Albi</button>
        : <p className="mt-2 text-xs text-amber-800">Creation is unavailable until the candidate and type checks are ready. Recheck this record after correcting them.</p>}</div>}
    {canAct && review.actions.includes('force_create_albi') && item?.forceCreateReadiness?.eligible === true && review.candidates.length > 0 && <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4"><h5 className="text-sm font-semibold text-red-950">These records are different</h5>
      <p className="mt-1 text-xs leading-5 text-red-900">Create a new Albi record and deliberately ignore the listed match candidates. This can create a duplicate, so the server rechecks every record before applying it.</p>
      {canForceCreate ? <button type="button" className={`${primary} mt-3`} disabled={effectiveBusy} onClick={() => open('force_create_albi')}>Create a separate Albi record</button>
        : <p className="mt-2 text-xs text-red-900">This option is unavailable until the source, candidate, mapping, and type checks are current. Recheck this record first.</p>}</div>}
    {canAct && review.actions.includes('choose_organization') && <div className="mt-5 rounded-lg border border-gray-200 p-4"><h5 className="text-sm font-semibold text-gray-900">Organization context</h5>
      <p className="mt-1 text-xs leading-5 text-gray-700">Existing HubSpot associations will not be removed. The selected organization becomes the saved context; an Albi relationship may need a manual update.</p>
      {canChooseOrganization ? <><label className="mt-3 block text-xs font-medium text-gray-700">Organization<select value={organizationSourceId} onChange={event => changed(choices, candidateId, event.target.value, approveManyToOne)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-brand-500"><option value="">Choose organization</option>{organizationOptions.map(option => <option key={option.sourceId} value={option.sourceId}>HubSpot {option.sourceId} → Albi {option.targetId}{option.associated ? ' · currently associated' : ' · add association'}</option>)}</select></label>
        {selectedOrganization && !selectedOrganization.associated && <label className="mt-3 flex items-start gap-2 text-xs text-gray-700"><input type="checkbox" checked={approveAssociation} onChange={event => { setApproveAssociation(event.target.checked); requestRef.current = null; setConfirmation(null) }} className="mt-0.5 text-brand-600 focus:ring-brand-500" />Add this organization as a HubSpot association. Existing HubSpot associations will not be removed.</label>}
        <button type="button" className={`${primary} mt-3`} disabled={effectiveBusy || !selectedOrganization || !selectedOrganization.associated && !approveAssociation} onClick={() => open('choose_organization')}>Choose organization</button></>
        : <p className="mt-2 text-xs text-amber-800">Fresh server association evidence is unavailable. Recheck or reload this record before choosing an organization.</p>}</div>}

    {!confirmation && feedback}
    {resolution && <section className="mt-5 border-t border-gray-200 pt-4" aria-label="Resolution progress and audit"><h5 className="text-sm font-semibold text-gray-900">Resolution progress</h5>
      <p className="mt-1 text-sm font-medium text-gray-800" role="status">{resolution.statusLabel}</p>
      {manualTasks.map((task, index) => <div key={`${task.targetId}-${index}`} className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3"><p className="text-sm font-semibold text-amber-900">Manual Albi task</p>
        <ul className="mt-2 space-y-1 text-sm text-gray-800">{task.fields.map(field => <li key={field.field}>{field.label}: {display(field.value)}</li>)}</ul>
        <div className="mt-3 flex flex-wrap gap-3"><TaskLink url={task.url}>Open {task.objectType === 'contacts' ? 'contact' : 'organization'} in Albi</TaskLink><TaskLink url={task.organizationUrl}>Open organization in Albi</TaskLink></div>
        <p className="mt-2 text-xs text-gray-700">Opening Albi does not complete this task. Make the change there, then recheck this record.</p></div>)}
      {events.length > 0 && <ol className="mt-3 divide-y divide-gray-100">{events.map((event, index) => <li key={event.id ?? index} className="py-2 text-xs text-gray-700"><span className="font-medium">{event.label}</span>{event.createdAt && <span className="ml-2">{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.createdAt))}</span>}</li>)}</ol>}
    </section>}

    {confirmation && <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-950/45 px-4 py-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="sample-resolution-confirm-title" onKeyDown={onDialogKeyDown}>
      <div ref={dialogRef} tabIndex={-1} className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl outline-none">
        <h3 id="sample-resolution-confirm-title" className="text-lg font-semibold text-gray-900">Confirm resolution</h3>
        <p className="mt-2 text-sm text-gray-700">Review what will change for HubSpot record {review.sourceId}.</p>
        {feedback}
        <div className="mt-4 grid gap-3 sm:grid-cols-2"><section className="rounded-lg border border-blue-200 bg-blue-50 p-3"><h4 className="text-sm font-semibold text-blue-900">Updates HubSpot now</h4>{confirmation.preview.hubspotWrites.length ? <ul className="mt-2 space-y-1 text-xs text-blue-900">{confirmation.preview.hubspotWrites.map(write => <li key={write.field}>{write.field}: {display(write.value)}</li>)}</ul> : <p className="mt-2 text-xs text-blue-800">None</p>}</section>
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-3"><h4 className="text-sm font-semibold text-amber-900">You’ll update this in Albi</h4>{confirmation.preview.albiTasks.length ? <ul className="mt-2 space-y-1 text-xs text-amber-900">{confirmation.preview.albiTasks.map(task => <li key={task.field}>{task.field}: {display(task.value)}</li>)}</ul> : <p className="mt-2 text-xs text-amber-800">{confirmation.preview.mapping?.createAlbi ? 'New Record created' : 'None'}</p>}</section></div>
        {confirmation.preview.mapping && <p className={`mt-3 rounded-lg p-3 text-sm ${confirmation.preview.mapping.forced ? 'border border-red-200 bg-red-50 text-red-950' : 'bg-gray-50 text-gray-800'}`}>{confirmation.preview.mapping.forced
          ? `Creates a separate Albi record, ignores ${confirmation.preview.mapping.ignoredCandidateIds.length} listed candidate${confirmation.preview.mapping.ignoredCandidateIds.length === 1 ? '' : 's'}, and saves the new mapping. A duplicate may be created.${confirmation.preview.mapping.deferOrganizationAssociation ? ' The Albi organization link will be deferred for later review.' : ''}`
          : confirmation.preview.mapping.createAlbi ? 'Creates an Albi record and saves its mapping.' : `Saves a mapping to Albi record ${confirmation.preview.mapping.targetId}.`}</p>}
        {confirmation.preview.association && <p className="mt-3 rounded-lg bg-gray-50 p-3 text-sm text-gray-800">Saves HubSpot organization {confirmation.preview.association.organizationSourceId} as context. {confirmation.preview.association.addHubSpotAssociation ? 'Adds HubSpot association. ' : ''}Existing HubSpot associations will not be removed.</p>}
        <div className="mt-5 flex flex-row-reverse flex-wrap gap-2" aria-busy={effectiveBusy}><button ref={confirmRef} type="button" className={primary} disabled={effectiveBusy} onClick={submit}>{effectiveBusy ? 'Applying…' : message.startsWith('Resolution failed') ? 'Retry resolution' : 'Confirm resolution'}</button>
          <button ref={cancelRef} type="button" className={secondary} disabled={effectiveBusy} onClick={() => setConfirmation(null)}>Cancel</button></div>
      </div></div>}
  </section>
}
