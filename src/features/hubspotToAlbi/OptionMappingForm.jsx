import { useEffect, useMemo, useState } from 'react'

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

export default function OptionMappingForm({ options = {}, mappings = [], confirmationStatus, isAdmin, busy, onConfirm, disabledReason }) {
  const seeded = useMemo(() => initialState(options, mappings), [mappings, options])
  const [draft, setDraft] = useState(seeded.draft)
  const [accepted, setAccepted] = useState(seeded.accepted)
  const savedInheritance = useMemo(() => mappings.filter(mapping => mapping.mappingKind === 'organization_to_contact_type'), [mappings])
  const [inheritEnabled, setInheritEnabled] = useState(savedInheritance.length > 0)
  const [inheritance, setInheritance] = useState(() => Object.fromEntries(savedInheritance.map(mapping => [mapping.sourceKey, mapping.albiId])))

  useEffect(() => {
    setDraft(seeded.draft)
    setAccepted(seeded.accepted)
    setInheritEnabled(savedInheritance.length > 0)
    setInheritance(Object.fromEntries(savedInheritance.map(mapping => [mapping.sourceKey, mapping.albiId])))
  }, [savedInheritance, seeded])

  const suggestionKeys = REQUIRED_ROWS.filter(row => findSuggestion(row, options) && draft[row.key] === findSuggestion(row, options)).map(row => row.key)
  const allSelected = REQUIRED_ROWS.every(row => draft[row.key])
  const allAccepted = REQUIRED_ROWS.every(row => accepted[row.key])
  const defaultContact = (options.contactTypes ?? []).find(option => option.id === draft.default_contact_type)

  function choose(key, value) {
    setDraft(current => ({ ...current, [key]: value }))
    setAccepted(current => ({ ...current, [key]: Boolean(value) }))
  }

  function confirmSuggestions() {
    setAccepted(current => ({ ...current, ...Object.fromEntries(suggestionKeys.map(key => [key, true])) }))
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

      <div className="mt-4 grid gap-x-6 gap-y-4 md:grid-cols-2">
        {REQUIRED_ROWS.map(row => {
          const suggestion = findSuggestion(row, options)
          const pendingSuggestion = suggestion && draft[row.key] === suggestion && !accepted[row.key]
          return (
            <div key={row.key}>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`h2a-map-${row.key}`} className="text-sm font-medium text-gray-800">{row.label}</label>
                {!draft[row.key]
                  ? <span className="text-xs font-semibold text-amber-700">Selection required</span>
                  : pendingSuggestion && <span className="text-xs font-semibold text-amber-700">Needs confirmation</span>}
              </div>
              <select
                id={`h2a-map-${row.key}`}
                value={draft[row.key] ?? ''}
                onChange={event => choose(row.key, event.target.value)}
                disabled={!isAdmin || busy}
                aria-describedby={`h2a-map-${row.key}-help`}
                className={selectClass}
              >
                <option value="">Select an Albi {row.group === 'activityTypes' ? 'activity' : row.group === 'contactTypes' ? 'contact' : 'organization'} type</option>
                {(options[row.group] ?? []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <p id={`h2a-map-${row.key}-help`} className="mt-1 text-xs text-gray-500">Albi {row.group} ID: {draft[row.key] || 'not selected'}</p>
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
                  <label htmlFor={`inherit-${organization.id}`} className="text-sm font-medium text-gray-800">{organization.label}</label>
                  <p id={`inherit-${organization.id}-help`} className="text-xs text-gray-500">Organization ID: {organization.id}</p>
                </div>
                <span className="hidden text-center text-gray-400 sm:block" aria-hidden="true">→</span>
                <div>
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

        <p className="mt-4 border-l-2 border-green-500 pl-3 text-sm text-gray-700">
          Fallback contact type: <span className="font-semibold text-gray-900">{defaultContact?.label ?? 'Select and confirm a default contact type'}</span>
          {defaultContact && <span className="text-xs text-gray-500"> · Contact type ID: {defaultContact.id}</span>}
        </p>
      </div>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-500">Server status: {confirmationStatus === 'confirmed' ? 'Confirmed' : 'Not confirmed'}</p>
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
