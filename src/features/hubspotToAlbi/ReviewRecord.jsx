import { useEffect, useState } from 'react'
import { blockedReasonCopy } from '../../../shared/h2aBlockedReasons.js'
import { presentSampleReviewItem } from './sampleReview.js'
import { fieldDiffRows } from './reviewWorkspace.js'
import CandidateList from './CandidateList.jsx'
import FieldDiff from './FieldDiff.jsx'
import ManyToOneDialog from './ManyToOneDialog.jsx'
import ResolutionBar, { btn } from './ResolutionBar.jsx'

const idPattern = /^[1-9]\d{0,99}$/
const text = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
const display = value => value === null || value === undefined || value === '' ? 'Blank' : value
const when = value => { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) } catch { return '' } }

function Link({ url, children }) {
  return url ? <a href={url} target="_blank" rel="noreferrer" className="font-semibold text-brand-700 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{children}</a> : null
}
function CopyButton({ value }) {
  return <button type="button" onClick={() => { try { navigator.clipboard?.writeText(String(value ?? '')) } catch { /* clipboard unavailable */ } }}
    className="rounded border border-gray-300 px-1.5 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Copy</button>
}

function candidateView(ranked, snapshot) {
  const s = snapshot ?? {}
  const name = text(s.fullName) || [s.firstName, s.lastName].filter(Boolean).join(' ') || text(s.name)
  return { id: ranked.id, snapshot: s, name, details: [s.email, s.phoneNumber ?? s.mobileNumber, s.organizationName ?? s.domain].filter(Boolean).join(' · '),
    matchReasons: Array.isArray(ranked.matchReasons) ? ranked.matchReasons : [], warnings: Array.isArray(ranked.warnings) ? ranked.warnings : [],
    strength: ['Strong', 'Likely', 'Weak'].includes(ranked.strength) ? ranked.strength : 'Weak',
    linkedElsewhere: Number.isSafeInteger(ranked.linkedElsewhere) && ranked.linkedElsewhere > 0 ? ranked.linkedElsewhere : 0 }
}

// The read a failed or timed-out create check stopped at (sanitized server tags only), in plain words.
const EVIDENCE_STEPS = {
  provider_clients: 'connecting to HubSpot and Albi', mappings: 'reading saved links', hubspot_record: 'reading the HubSpot record',
  hubspot_associations: 'reading the HubSpot organization link', hubspot_organization: 'reading the HubSpot organization',
  organization_review: 'finding the organization’s review', albi_contacts: 'reading Albi contacts', albi_organizations: 'reading Albi organizations',
  albi_referral_sources: 'reading Albi’s referral sources', albi_create_options: 'reading Albi’s types, statuses and salespeople',
  hubspot_owner: 'reading the record’s HubSpot owner', hubspot_owners: 'reading HubSpot’s owner list', create_defaults: 'reading the create defaults',
}
const EVIDENCE_TAG = /^[a-z][a-z0-9_:]{0,39}$/i
function withEvidence(copy, evidence) {
  if (!copy || !evidence || !Object.hasOwn(EVIDENCE_STEPS, evidence.step)) return copy
  const code = EVIDENCE_TAG.test(evidence.code ?? '') ? evidence.code : null
  const status = Number.isInteger(evidence.status) && evidence.status >= 100 && evidence.status <= 599 ? `HTTP ${evidence.status}` : null
  const issue = EVIDENCE_TAG.test(evidence.issue ?? '') ? evidence.issue : null
  const extra = [code, issue, status].filter(Boolean).join(', ')
  return `${copy} Stopped at: ${EVIDENCE_STEPS[evidence.step]}${extra ? ` (${extra})` : ''}.`
}

export default function ReviewRecord({
  item, kind = 'sample', candidateIndex = 0, onPickCandidate, referralSourceId = '', onReferral, referralRef,
  pending = false, busy = false, readOnly = false,
  onAccept, onLink, onCreate, onForceCreate, onCreateWithOrganization, onApplyFields, onIgnoreAndLink, onChooseOrganization,
  onSkip, onRecheck, onOpenOrganization, onOpenMergedSurvivor,
}) {
  const review = presentSampleReviewItem(item)
  // Members see the evidence only: no mutation controls, whatever the server capability says.
  const capability = readOnly ? { ...review.resolutionCapability, canResolve: false } : review.resolutionCapability
  const resolution = review.resolution
  const [showMatching, setShowMatching] = useState(false)
  const [fieldChoices, setFieldChoices] = useState({})
  const [manyToOne, setManyToOne] = useState(null)
  const [organizationSourceId, setOrganizationSourceId] = useState('')
  const [approveAssociation, setApproveAssociation] = useState(false)
  useEffect(() => {
    setShowMatching(false); setFieldChoices({}); setManyToOne(null); setOrganizationSourceId(''); setApproveAssociation(false)
  }, [review.id, review.updatedAt])

  const objectLabel = review.objectType === 'contacts' ? 'contact' : 'organization'
  const snapshots = new Map(review.candidates.map(candidate => [candidate.id, candidate.snapshot]))
  const rankedInput = Array.isArray(item?.rankedCandidates) ? item.rankedCandidates
    : review.candidates.map(candidate => ({ id: candidate.id, matchReasons: [], warnings: [], strength: 'Weak', linkedElsewhere: 0 }))
  const allIdsValid = rankedInput.every(ranked => idPattern.test(ranked?.id))
  const candidates = rankedInput.filter(ranked => idPattern.test(ranked?.id)).map(ranked => candidateView(ranked, snapshots.get(ranked.id)))
  const selected = candidates[candidateIndex] ?? null
  const suggested = candidates.find(candidate => candidate.id === item?.suggestedCandidateId) ?? null

  // In Done the work is finished (linked, or created and linked): nothing more is offered, so a saved record is never
  // re-created or re-linked. Recheck stays available to confirm it.
  const finished = item?.triageBucket === 'done'
  const canAct = !finished && capability.canResolve && review.actions.length > 0 && (review.status === 'needs_review' ||
    review.status === 'cleared' && ['safe_to_create', 'safe_to_link'].includes(item?.recheckOutcome))
  const disabled = pending || busy
  const merged = idPattern.test(item?.mergedInto?.sourceId) ? item.mergedInto : null
  const orgFirst = item?.orgFirstCreate?.eligible === true && review.objectType === 'contacts' && candidates.length === 0
  const readiness = candidates.length === 0 ? item?.createReadiness : item?.forceCreateReadiness
  // The org-first create is blocked on the contact's own readiness, so its sources may ride on orgFirstCreate.
  const sourceList = orgFirst ? item?.orgFirstCreate?.referralSources ?? readiness?.referralSources : readiness?.referralSources
  const referralSources = (Array.isArray(sourceList) ? sourceList : []).filter(source => idPattern.test(source?.id) && typeof source?.label === 'string' && source.label.trim() !== '').slice(0, 100)
  const blockedCopy = withEvidence(blockedReasonCopy(readiness?.blockedReason), readiness?.evidence)
  const unsyncedOrganization = readiness?.blockedReason === 'organization_not_synced' && idPattern.test(readiness?.organization?.sourceId)
    ? { sourceId: readiness.organization.sourceId, reviewId: typeof readiness.organization.reviewId === 'string' && readiness.organization.reviewId ? readiness.organization.reviewId : null } : null

  const fillable = Array.isArray(review.fillableFields) ? review.fillableFields : []
  const fieldMode = canAct && !merged && review.actions.includes('resolve_fields') && (review.resolutionFields.length > 0 || fillable.length > 0) && candidates.length === 1
  const identityActions = canAct && !merged && !fieldMode
  const canCreateNew = identityActions && (orgFirst ? review.actions.includes('create_albi') && referralSources.length > 0
    : candidates.length === 0 ? review.actions.includes('create_albi') && readiness?.ready === true && referralSources.length > 0
      : review.actions.includes('force_create_albi') && allIdsValid && readiness?.ready === true && referralSources.length > 0)
  const newLabel = `Create new ${objectLabel} in Albi`
  // With candidates listed, creating a new record is always on offer: disabled with its reason when not ready yet.
  const forceUnavailable = !canCreateNew && identityActions && candidates.length > 0 && review.actions.includes('force_create_albi') && allIdsValid
  const create = canCreateNew ? { kind: orgFirst ? 'org' : candidates.length ? 'force' : 'create',
    label: orgFirst ? 'Create organization and contact' : candidates.length ? newLabel : 'Create in Albi' }
    : forceUnavailable ? { kind: 'force', label: newLabel, unavailable: blockedCopy ?? 'A new record can’t be created right now. Reload or Recheck this record to check again.' } : null
  const canLink = identityActions && review.actions.includes('link_existing')
  const suggestion = canLink && suggested ? { candidate: suggested, emailMatch: suggested.matchReasons.includes('same_email') && !suggested.warnings.includes('different_email') } : null
  const selectedLink = canLink && selected && (!suggested || selected.id !== suggested.id) ? selected : null

  const organizationOptions = Array.isArray(item?.organizationOptions) ? item.organizationOptions.filter(option =>
    idPattern.test(option?.sourceId) && idPattern.test(option?.targetId) && typeof option.associated === 'boolean' &&
    idPattern.test(option?.contactTargetId) && idPattern.test(option?.currentOrganizationTargetId ?? option.targetId)) : []
  const showOrganizationChoice = canAct && !merged && review.objectType === 'contacts' && review.actions.includes('choose_organization')
  const organizationGate = organizationOptions.length === 0 && idPattern.test(item?.organizationGate?.sourceId)
    ? { sourceId: item.organizationGate.sourceId, reviewId: typeof item.organizationGate.reviewId === 'string' && item.organizationGate.reviewId ? item.organizationGate.reviewId : null } : null
  const chosenOrganization = organizationOptions.find(option => option.sourceId === organizationSourceId)

  // Diff rows. In field mode every field the resolution can write is choosable, even one the normalized diff hides.
  let rows = fieldDiffRows({ objectType: review.objectType === 'companies' ? 'organization' : 'contact', source: review.source, candidate: selected?.snapshot ?? null })
  if (fieldMode) {
    const keys = new Set(review.resolutionFields.map(field => field.key))
    rows = rows.map(row => keys.has(row.key) ? { ...row, kind: 'differs', choosable: true } : row)
    for (const field of review.resolutionFields) if (!rows.some(row => row.key === field.key))
      rows.push({ key: field.key, label: field.label, hubspot: field.hubspot ?? '', albi: field.albi ?? '', kind: 'differs', choosable: true })
    // HubSpot-blank fields Albi has can only be filled from Albi; they are optional.
    const fills = new Set(fillable.map(field => field.key))
    rows = rows.map(row => fills.has(row.key) ? { ...row, choosable: true, fillOnly: true } : row)
    for (const field of fillable) if (!rows.some(row => row.key === field.key))
      rows.push({ key: field.key, label: field.label, hubspot: '', albi: field.albi, kind: 'one_side', choosable: true, fillOnly: true })
  }
  const filledChoices = fillable.filter(field => fieldChoices[field.key] === 'albi').map(field => field.key)
  const allChosen = fieldMode && review.resolutionFields.every(field => fieldChoices[field.key] === 'hubspot' || fieldChoices[field.key] === 'albi') &&
    (review.resolutionFields.length > 0 || filledChoices.length > 0)
  const setAll = value => setFieldChoices(Object.fromEntries([...review.resolutionFields.map(field => [field.key, value]),
    ...(value === 'albi' ? fillable.map(field => [field.key, 'albi']) : [])]))

  const emailMatchOf = candidate => candidate.matchReasons.includes('same_email') && !candidate.warnings.includes('different_email')
  function requestLink(candidate) {
    if (candidate.linkedElsewhere > 0) setManyToOne({ id: candidate.id, accept: false })
    else onLink?.(candidate, { approveManyToOne: false, ...(emailMatchOf(candidate) ? { emailMatch: true } : {}) })
  }
  function requestAccept(candidate, emailMatch) {
    // A stale suggestion that has since been linked elsewhere still needs explicit many-to-one approval.
    if (candidate.linkedElsewhere > 0) setManyToOne({ id: candidate.id, accept: true, emailMatch })
    else onAccept?.(candidate, { emailMatch })
  }
  function onCreateClick() {
    if (!referralSourceId || create?.unavailable) return
    if (create?.kind === 'org') onCreateWithOrganization?.({ referralSourceId })
    else if (create?.kind === 'force') onForceCreate?.({ referralSourceId, ignoredCandidateIds: candidates.map(candidate => candidate.id) })
    else onCreate?.({ referralSourceId })
  }

  const organizationFirstCard = gate => <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
    <p className="text-sm font-semibold text-amber-950">Create the organization first</p>
    <p className="mt-1 text-xs leading-5 text-amber-900">This contact’s HubSpot organization is not in Albi yet. Create it on its own review, then return here to create the contact linked to it.</p>
    <button type="button" className={`${btn} mt-2`} disabled={disabled || !onOpenOrganization} onClick={() => onOpenOrganization?.(gate)}>
      {gate?.reviewId ? 'Open organization review' : 'Prepare organization review'}</button></div>

  const events = resolution?.events ?? []
  const manualTasks = resolution?.status === 'waiting_on_albi' ? [...events].reverse().find(event => event.manualTasks?.length)?.manualTasks ?? [] : []
  const hubspotOrgs = review.objectType === 'contacts' && item?.hubspotOrganizations !== undefined
    ? Array.isArray(item.hubspotOrganizations)
      ? item.hubspotOrganizations.filter(organization => idPattern.test(organization?.sourceId) && typeof organization?.name === 'string').map(organization => organization.name).join(', ') || 'No organization is associated in HubSpot.'
      : 'The HubSpot association could not be read right now.' : null
  const albiUrl = selected ? review.candidateLinks.find(link => link.id === selected.id)?.url : null
  const orgGate = !orgFirst && unsyncedOrganization && canAct && !merged

  return <section className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white" aria-label={`Review ${review.displayName}`}>
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-5 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold text-gray-900">{review.displayName}</h2>
        <p className="text-sm text-gray-700">{review.reasonLabel}{hubspotOrgs ? <> · <span className="text-gray-500">HubSpot organization:</span> {hubspotOrgs}</> : null}</p>
      </div>
      <div className="text-right text-xs text-gray-500">
        <Link url={review.hubspotUrl}>Open in HubSpot</Link>{albiUrl ? <> · <Link url={albiUrl}>Open in Albi</Link></> : null}
        <p className="mt-1">HubSpot ID {review.sourceId} · {review.lastRecheckedAt ? `last recheck ${when(review.lastRecheckedAt)}` : 'not rechecked yet'}</p>
      </div>
    </header>

    <div className="space-y-4 px-5 py-4">
      {finished && <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900" role="status">
        <p className="font-semibold">Done</p>
        <p className="mt-1 text-xs">{review.status === 'no_longer_in_scope' ? `This ${objectLabel} is no longer in scope. Nothing else to do.`
          : `This ${objectLabel} is linked in Albi. Nothing else to do${item?.triageDetails?.recheckPending ? '; Recheck all confirms it later.' : '.'}`}</p></div>}
      {!capability.canResolve && <p className="text-xs leading-5 text-gray-600" role="status">Resolution is {capability.enabled ? 'read-only for your role.' : 'unavailable in the current mode.'} {capability.hubspotWrites === 'rejected' ? 'Recent HubSpot write authorization was rejected.' : ''}</p>}
      {merged && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
        <p className="font-semibold text-amber-950">Merged in HubSpot into {objectLabel} {merged.sourceId}</p>
        <p className="mt-1 text-xs text-amber-900">This record is out of date. Review the surviving record instead.</p>
        <button type="button" className={`${btn} mt-2`} disabled={disabled || !onOpenMergedSurvivor}
          onClick={() => onOpenMergedSurvivor?.({ sourceId: merged.sourceId, reviewId: typeof merged.reviewId === 'string' && merged.reviewId ? merged.reviewId : null })}>Review the surviving record</button></div>}
      {!merged && blockedCopy && !orgFirst && canAct && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="status">
        <p className="font-semibold">Can’t create yet</p><p className="mt-1 text-xs">{blockedCopy}</p></div>}
      {!merged && canAct && !blockedCopy && !create && !fieldMode && !showOrganizationChoice && !orgGate && !orgFirst && readiness && readiness.ready !== true && (review.actions.includes('create_albi') || review.actions.includes('force_create_albi')) &&
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">Creation couldn’t be checked for this record. Reload it, or Recheck it, to check again.</p>}
      {orgGate && organizationFirstCard(unsyncedOrganization)}
      {create?.kind === 'force' && !create.unavailable && <p className="text-xs text-gray-600">Note: creating a new record ignores the matches listed above. The server checks Albi again before creating, so a true duplicate is still refused.</p>}
      {orgFirst && canAct && <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-gray-800">
        {item.orgFirstCreate.organizationName ? `${item.orgFirstCreate.organizationName} is not in Albi yet. ` : 'This contact’s HubSpot organization is not in Albi yet. '}
        Choose a referral source to create the organization and the contact together.</p>}
      {resolution?.status === 'waiting_on_albi' && <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-sm">
        <p className="font-semibold text-amber-950">Update this {objectLabel} in Albi</p>
        {manualTasks.length === 0 && <p className="mt-1 text-xs text-amber-900">Albi needs a manual change. Make it in Albi, then recheck this record.</p>}
        {manualTasks.map((task, index) => <div key={`${task.targetId}-${index}`} className="mt-2">
          <ul className="space-y-1 text-amber-900">{task.fields.map(field => <li key={field.field} className="flex flex-wrap items-center gap-2">
            <span>{field.label}: {display(field.value)}</span><CopyButton value={field.value} /></li>)}</ul>
          <div className="mt-2 flex flex-wrap gap-3 text-sm"><Link url={task.url}>Open {task.objectType === 'contacts' ? 'contact' : 'organization'} in Albi</Link><Link url={task.organizationUrl}>Open organization in Albi</Link></div></div>)}
        <p className="mt-2 text-xs text-amber-900">Opening Albi does not complete this task. Make the change there, then recheck this record. Also listed in Albi to-do (t).</p></div>}

      <CandidateList candidates={candidates} selectedIndex={candidateIndex} suggestedId={suggested?.id ?? null} onPick={onPickCandidate} objectLabel={objectLabel} />
      <FieldDiff rows={rows} hasCandidate={Boolean(selected)} candidateId={selected?.id ?? ''} showMatching={showMatching}
        onToggleMatching={() => setShowMatching(value => !value)} choices={fieldMode ? fieldChoices : null}
        onChoose={(key, value) => setFieldChoices(current => {
          // A fill-from-Albi choice toggles off when chosen again; every other field keeps its choice.
          if (current[key] === value && fillable.some(field => field.key === key)) { const next = { ...current }; delete next[key]; return next }
          return { ...current, [key]: value }
        })} disabled={disabled} />

      {showOrganizationChoice && <section className="rounded-lg border border-gray-200 p-4" aria-label="Organization context">
        <h3 className="text-sm font-semibold text-gray-900">Organization context</h3>
        <p className="mt-1 text-xs leading-5 text-gray-700">Existing HubSpot associations will not be removed. The selected organization becomes the saved context; an Albi relationship may need a manual update.</p>
        {organizationOptions.length > 0 ? <>
          <label className="mt-3 block text-xs font-medium text-gray-700">Organization
            <select value={organizationSourceId} disabled={disabled} onChange={event => { setOrganizationSourceId(event.target.value); setApproveAssociation(false) }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-brand-500">
              <option value="">Choose organization</option>
              {organizationOptions.map(option => <option key={option.sourceId} value={option.sourceId}>HubSpot {option.sourceId} → Albi {option.targetId}{option.associated ? ' · currently associated' : ' · add association'}</option>)}
            </select></label>
          {chosenOrganization && !chosenOrganization.associated && <label className="mt-3 flex items-start gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={approveAssociation} disabled={disabled} onChange={event => setApproveAssociation(event.target.checked)} className="mt-0.5 text-brand-600 focus:ring-brand-500" />
            Add this organization as a HubSpot association. Existing HubSpot associations will not be removed.</label>}
          <button type="button" className={`${btn} mt-3`} disabled={disabled || !chosenOrganization || !chosenOrganization.associated && !approveAssociation}
            onClick={() => onChooseOrganization?.({ organizationSourceId, addHubSpotAssociation: !chosenOrganization.associated })}>Choose organization</button></>
          : organizationGate ? <div className="mt-3">{organizationFirstCard(organizationGate)}</div>
            : <p className="mt-2 text-xs text-amber-800">Fresh server association evidence is unavailable. Recheck or reload this record before choosing an organization.</p>}
      </section>}

      {events.length > 0 && <details className="text-xs text-gray-700">
        <summary className="cursor-pointer font-semibold text-gray-800">History</summary>
        <p className="mt-1 font-medium text-gray-800">{resolution.statusLabel}</p>
        <ol className="mt-1 divide-y divide-gray-100">{events.map((event, index) => <li key={event.id ?? index} className="py-1.5"><span className="font-medium">{event.label}</span>{event.createdAt && <span className="ml-2">{when(event.createdAt)}</span>}</li>)}</ol>
      </details>}
    </div>

    {capability.canResolve && <ResolutionBar disabled={disabled} fieldMode={fieldMode} applyDisabled={!allChosen}
      onAllHubSpot={() => setAll('hubspot')} onAllAlbi={() => setAll('albi')}
      showIgnoreAndLink={fieldMode && review.actions.includes('link_existing') && Boolean(candidates[0]?.id)}
      onIgnoreAndLink={() => onIgnoreAndLink?.(candidates[0], [...new Set([...review.resolutionFields, ...fillable].map(field => field.key))].sort())}
      onApplyFields={() => onApplyFields?.(Object.fromEntries([...review.resolutionFields.map(field => [field.key, fieldChoices[field.key]]),
        ...filledChoices.map(key => [key, 'albi'])]))}
      suggestion={suggestion} onAccept={() => suggestion && requestAccept(suggestion.candidate, suggestion.emailMatch)}
      selectedLink={selectedLink} onLinkSelected={() => selectedLink && requestLink(selectedLink)}
      create={create} referralSources={referralSources} referralSourceId={referralSourceId} onReferral={onReferral} referralRef={referralRef} onCreate={onCreateClick}
      showSkip={kind === 'live'} onSkip={onSkip} showRecheck onRecheck={onRecheck} />}

    <ManyToOneDialog candidate={candidates.find(candidate => candidate.id === manyToOne?.id) ?? null} objectLabel={objectLabel} busy={disabled}
      onCancel={() => setManyToOne(null)}
      onConfirm={candidate => { setManyToOne(null); onLink?.(candidate, { approveManyToOne: true, ...(emailMatchOf(candidate) ? { emailMatch: true } : {}) }) }} />
  </section>
}
