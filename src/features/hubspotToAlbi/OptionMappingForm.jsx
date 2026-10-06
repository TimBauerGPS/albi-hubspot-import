import { useEffect, useMemo, useRef, useState } from 'react'

const REQUIRED_ROWS = [
  { key: 'default_contact_type', mappingKind: 'default_contact_type', sourceKey: 'default', label: 'Default contact type', group: 'contactTypes', aliases: ['contact'] },
  { key: 'default_organization_type', mappingKind: 'default_organization_type', sourceKey: 'default', label: 'Default organization type', group: 'organizationTypes', aliases: ['organization'] },
  { key: 'meetings', mappingKind: 'activity_type', sourceKey: 'meetings', label: 'HubSpot meetings', group: 'activityTypes', aliases: ['meeting'] },
  { key: 'calls', mappingKind: 'activity_type', sourceKey: 'calls', label: 'HubSpot calls', group: 'activityTypes', aliases: ['call'] },
  { key: 'emails', mappingKind: 'activity_type', sourceKey: 'emails', label: 'HubSpot emails', group: 'activityTypes', aliases: ['email'] },
  { key: 'communications', mappingKind: 'activity_type', sourceKey: 'communications', label: 'HubSpot communications', group: 'activityTypes', aliases: ['communication', 'textmessage', 'sms'] },
  { key: 'notes', mappingKind: 'activity_type', sourceKey: 'notes', label: 'HubSpot notes', group: 'activityTypes', aliases: ['note'] },
]

const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '')
const selectClass = 'mt-1.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:bg-gray-50'
const GROUP_LABELS = { contactTypes: 'contact type', organizationTypes: 'organization type', activityTypes: 'activity type' }

function findSuggestion(row, options) {
  const matches = (options?.[row.group] ?? []).filter(option => row.aliases.includes(normalize(option.label)))
  return matches.length === 1 ? matches[0].id : ''
}

function initialState(options, mappings) {
  const draft = {}
  const accepted = {}
  for (const row of REQUIRED_ROWS) {
    const saved = mappings.find(mapping => mapping.mappingKind === row.mappingKind && mapping.sourceKey === row.sourceKey)
    const savedOption = (options?.[row.group] ?? []).find(option => option.id === saved?.albiId)
    draft[row.key] = savedOption?.id ?? findSuggestion(row, options)
    accepted[row.key] = Boolean(savedOption)
  }
  return { draft, accepted }
}

export default function OptionMappingForm({ options = {}, mappings = [], confirmationStatus, resetKey, isAdmin, busy, onConfirm, disabledReason }) {
  const seeded = useMemo(() => initialState(options, mappings), [mappings, options])
  const [draft, setDraft] = useState(seeded.draft)
  const [accepted, setAccepted] = useState(seeded.accepted)
  const [confirmationAnnouncement, setConfirmationAnnouncement] = useState('')
  const savedInheritance = useMemo(() => mappings.filter(mapping => mapping.mappingKind === 'organization_to_contact_type'), [mappings])
  const seededRef = useRef(seeded)
  const savedInheritanceRef = useRef(savedInheritance)
  seededRef.current = seeded
  savedInheritanceRef.current = savedInheritance
  const [inheritEnabled, setInheritEnabled] = useState(savedInheritance.length > 0)
  const [inheritance, setInheritance] = useState(() => Object.fromEntries(savedInheritance.map(mapping => [mapping.sourceKey, mapping.albiId])))

  useEffect(() => {
    const nextSeed = seededRef.current
    const nextInheritance = savedInheritanceRef.current
    setDraft(nextSeed.draft)
    setAccepted(nextSeed.accepted)
    setInheritEnabled(nextInheritance.length > 0)
    setInheritance(Object.fromEntries(nextInheritance.map(mapping => [mapping.sourceKey, mapping.albiId])))
    setConfirmationAnnouncement('')
    // resetKey changes only for tenant/preflight/credential changes or a successful mapping save.
  }, [resetKey])

  const suggestionKeys = REQUIRED_ROWS.filter(row => findSuggestion(row, options) && draft[row.key] === findSuggestion(row, options)).map(row => row.key)
  const allSelected = REQUIRED_ROWS.every(row => draft[row.key])
  const allAccepted = REQUIRED_ROWS.every(row => accepted[row.key])
  const persistedDefaultMapping = confirmationStatus === 'confirmed'
    ? mappings.find(mapping => mapping.mappingKind === 'default_contact_type' && mapping.sourceKey === 'default')
    : null
  const confirmedDefaultContact = (options.contactTypes ?? []).find(option => option.id === persistedDefaultMapping?.albiId)
  const proposedDefaultContact = (options.contactTypes ?? []).find(option => option.id === draft.default_contact_type)
  const proposedFallbackChanged = Boolean(proposedDefaultContact && proposedDefaultContact.id !== confirmedDefaultContact?.id)
  const persistedRequired = new Map(mappings.map(mapping => [`${mapping.mappingKind}:${mapping.sourceKey}`, mapping.albiId]))
  const requiredChanged = REQUIRED_ROWS.some(row => draft[row.key] !== persistedRequired.get(`${row.mappingKind}:${row.sourceKey}`))
  const persistedInheritance = Object.fromEntries(savedInheritance.map(mapping => [mapping.sourceKey, mapping.albiId]))
  const currentInheritance = inheritEnabled ? Object.fromEntries(Object.entries(inheritance).filter(([, value]) => value)) : {}
  const inheritanceChanged = JSON.stringify(Object.entries(currentInheritance).sort()) !== JSON.stringify(Object.entries(persistedInheritance).sort())
  const hasUnsavedChanges = requiredChanged || inheritanceChanged

  function choose(key, value) {
    setDraft(current => ({ ...current, [key]: value }))
    setAccepted(current => ({ ...current, [key]: Boolean(value) }))
  }

  function confirmSuggestions() {
    const newlyAccepted = suggestionKeys.filter(key => !accepted[key])
    const nextAccepted = { ...accepted, ...Object.fromEntries(suggestionKeys.map(key => [key, true])) }
    const remaining = REQUIRED_ROWS.filter(row => !draft[row.key] || !nextAccepted[row.key]).length
    setAccepted(nextAccepted)
    setConfirmationAnnouncement(`${newlyAccepted.length} suggestions confirmed. ${remaining} required mappings remaining.`)
  }

  async function saveMappings() {
    if (!allSelected || !allAccepted) return
    const required = REQUIRED_ROWS.map(row => {
      const option = (options[row.group] ?? []).find(item => item.id === draft[row.key])
      return { mappingKind: row.mappingKind, sourceKey: row.sourceKey, albiId: option.id, label: option.label }
    })
    const optional = inheritEnabled ? (options.organizationTypes ?? []).flatMap(organization => {
      const contact = (options.contactTypes ?? []).find(option => option.id === inheritance[organization.id])
      return contact ? [{ mappingKind: 'organization_to_contact_type', sourceKey: organization.id, albiId: contact.id, label: `${organization.label} → ${contact.label}` }] : []
    }) : []
    await onConfirm([...required, ...optional])
  }

  return (
    <div className="mt-5">
      <div className="flex flex-col gap-3 border-b border-gray-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-gray-900">7 required mappings</p>
          <p className="mt-0.5 text-xs text-gray-500">Suggestions use exact, unambiguous names and do not count as confirmed until you accept them.</p>
        </div>
        <button
          type="button"
          onClick={confirmSuggestions}
          disabled={!isAdmin || busy || suggestionKeys.every(key => accepted[key])}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >Confirm suggested mappings</button>
      </div>
      <p className="min-h-5 pt-2 text-xs text-gray-600" role="status" aria-live="polite">{confirmationAnnouncement}</p>

      {hasUnsavedChanges && (
        <p className="border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">Unsaved mapping changes are shown below. The confirmed server configuration remains active until you save.</p>
      )}

      <div className="mt-4 grid gap-x-6 gap-y-4 md:grid-cols-2">
        {REQUIRED_ROWS.map(row => {
          const suggestion = findSuggestion(row, options)
          const pendingSuggestion = suggestion && draft[row.key] === suggestion && !accepted[row.key]
          const persisted = confirmationStatus === 'confirmed' && persistedRequired.get(`${row.mappingKind}:${row.sourceKey}`) === draft[row.key]
          const status = !draft[row.key] ? 'Selection required' : pendingSuggestion ? 'Needs confirmation' : persisted ? 'Confirmed' : 'Ready to save'
          return (
            <div key={row.key}>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`h2a-map-${row.key}`} className="text-sm font-medium text-gray-800">{row.label}</label>
                <span id={`h2a-map-${row.key}-status`} className={`text-xs font-semibold ${persisted ? 'text-green-700' : accepted[row.key] && draft[row.key] ? 'text-brand-700' : 'text-amber-700'}`}>{status}</span>
              </div>
              <select
                id={`h2a-map-${row.key}`}
                value={draft[row.key] ?? ''}
                onChange={event => choose(row.key, event.target.value)}
                disabled={!isAdmin || busy}
                aria-describedby={`h2a-map-${row.key}-help h2a-map-${row.key}-status`}
                className={selectClass}
              >
                <option value="">Select an Albi {row.group === 'activityTypes' ? 'activity' : row.group === 'contactTypes' ? 'contact' : 'organization'} type</option>
                {(options[row.group] ?? []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <p id={`h2a-map-${row.key}-help`} className="mt-1 text-xs text-gray-500">Albi {GROUP_LABELS[row.group]} ID: {draft[row.key] || 'not selected'}</p>
            </div>
          )
        })}
      </div>

      <div className="mt-6 border-t border-gray-200 pt-5">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={inheritEnabled}
            onChange={event => setInheritEnabled(event.target.checked)}
            disabled={!isAdmin || busy}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          <span>
            <span className="block text-sm font-semibold text-gray-900">Inherit contact type from organization when possible</span>
            <span className="mt-0.5 block text-xs leading-5 text-gray-500">Organization type IDs map only to contact type IDs; labels never cross namespaces automatically.</span>
          </span>
        </label>

        {inheritEnabled && (
          <div className="mt-4 space-y-3 border-l-2 border-brand-100 pl-4">
            {(options.organizationTypes ?? []).map(organization => (
              <div key={organization.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)] sm:items-center">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Organization type</p>
                  <p className="text-sm font-medium text-gray-800">{organization.label}</p>
                  <p id={`inherit-${organization.id}-help`} className="text-xs text-gray-500">Organization type ID: {organization.id}</p>
                </div>
                <span className="hidden text-center text-gray-400 sm:block" aria-hidden="true">→</span>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Contact type</p>
                  <label htmlFor={`inherit-${organization.id}`} className="block text-xs font-medium text-gray-700">Contact type for {organization.label}</label>
                  <select
                    id={`inherit-${organization.id}`}
                    value={inheritance[organization.id] ?? ''}
                    onChange={event => setInheritance(current => ({ ...current, [organization.id]: event.target.value }))}
                    disabled={!isAdmin || busy}
                    aria-describedby={`inherit-${organization.id}-help`}
                    className={selectClass}
                  >
                    <option value="">Use default fallback</option>
                    {(options.contactTypes ?? []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </div>
        )}

        {confirmedDefaultContact ? (
          <p className="mt-4 border-l-2 border-green-500 bg-green-50 px-3 py-2 text-sm text-green-900">
            Confirmed fallback: <span className="font-semibold">{confirmedDefaultContact.label}</span>
            <span className="text-xs text-green-800"> · Contact type ID: {confirmedDefaultContact.id}</span>
          </p>
        ) : (
          <p className="mt-4 border-l-2 border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700">Confirmed fallback: none. Save all seven required mappings before setup is ready.</p>
        )}
        {proposedFallbackChanged && (
          <p className="mt-2 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Proposed fallback (not saved): <span className="font-semibold">{proposedDefaultContact.label}</span>
            <span className="text-xs"> · Contact type ID: {proposedDefaultContact.id}</span>
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className={`text-xs ${confirmationStatus === 'confirmed' && !hasUnsavedChanges ? 'text-green-700' : 'text-gray-600'}`}>
          Server status: {confirmationStatus === 'confirmed' ? hasUnsavedChanges ? 'Confirmed configuration retained; draft not saved' : 'Confirmed' : 'Not confirmed'}
        </p>
        <button
          type="button"
          onClick={saveMappings}
          disabled={!isAdmin || busy || !allSelected || !allAccepted}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >{busy ? 'Saving…' : 'Save confirmed mappings'}</button>
      </div>
      {!isAdmin && <p className="mt-2 text-xs text-gray-500">{disabledReason}</p>}
    </div>
  )
}
