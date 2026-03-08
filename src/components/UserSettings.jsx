/**
 * UserSettings — per-user sandboxed configuration
 * Mirrors the Config tab in the Google Sheet:
 *   - Pipeline mapping: job suffix → HubSpot pipeline name
 *   - Excluded suffixes: job types to skip on import
 *   - Sales team: name + email pairs for owner validation
 *   - HubSpot Partner/Portal ID
 */
import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Default values for new users — match Google Script reference
const DEFAULT_PIPELINE_MAPPING = {
  WTR: 'Water Mitigation',
  EMS: 'Water Mitigation',
  FIRE: 'Fire Mitigation',
  CON: 'Contents',
  RBL: 'Rebuild',
}
const DEFAULT_EXCLUDED = ['WTY', 'LTR', 'SUB', 'BDUP', 'LUX']

function SectionHeader({ title, description }) {
  return (
    <div className="mb-3">
      <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
      {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
    </div>
  )
}

function TagInput({ tags, onChange, placeholder }) {
  const [input, setInput] = useState('')

  function addTag(raw) {
    const val = raw.trim().toUpperCase()
    if (val && !tags.includes(val)) onChange([...tags, val])
    setInput('')
  }

  function handleKey(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5 border border-gray-300 rounded-lg px-2 py-2 focus-within:ring-2 focus-within:ring-brand-500 bg-white">
      {tags.map(tag => (
        <span key={tag} className="inline-flex items-center gap-1 bg-brand-100 text-brand-700 text-xs font-mono font-semibold rounded px-2 py-0.5">
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter(t => t !== tag))}
            className="text-brand-400 hover:text-brand-700 leading-none"
          >×</button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => input && addTag(input)}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[80px] text-xs outline-none bg-transparent"
      />
    </div>
  )
}

function PipelineMappingEditor({ mapping, onChange }) {
  const [newSuffix, setNewSuffix] = useState('')
  const [newPipeline, setNewPipeline] = useState('')

  function addRow() {
    const s = newSuffix.trim().toUpperCase()
    const p = newPipeline.trim()
    if (!s || !p) return
    onChange({ ...mapping, [s]: p })
    setNewSuffix('')
    setNewPipeline('')
  }

  function removeRow(suffix) {
    const next = { ...mapping }
    delete next[suffix]
    onChange(next)
  }

  function updateValue(suffix, value) {
    onChange({ ...mapping, [suffix]: value })
  }

  const entries = Object.entries(mapping)

  return (
    <div className="space-y-2">
      {entries.map(([suffix, pipeline]) => (
        <div key={suffix} className="flex items-center gap-2">
          <code className="w-20 shrink-0 text-xs font-mono font-semibold bg-gray-100 border border-gray-200 rounded px-2 py-1.5 text-center">
            {suffix}
          </code>
          <span className="text-gray-400 text-sm shrink-0">→</span>
          <input
            type="text"
            value={pipeline}
            onChange={e => updateValue(suffix, e.target.value)}
            className="flex-1 text-xs border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="HubSpot pipeline name"
          />
          <button
            type="button"
            onClick={() => removeRow(suffix)}
            className="text-gray-300 hover:text-red-500 transition-colors text-lg leading-none shrink-0"
          >
            ×
          </button>
        </div>
      ))}

      {/* Add row */}
      <div className="flex items-center gap-2 pt-1">
        <input
          type="text"
          value={newSuffix}
          onChange={e => setNewSuffix(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && addRow()}
          placeholder="Suffix"
          className="w-20 shrink-0 text-xs font-mono border border-dashed border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500 text-center"
        />
        <span className="text-gray-300 text-sm shrink-0">→</span>
        <input
          type="text"
          value={newPipeline}
          onChange={e => setNewPipeline(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addRow()}
          placeholder="HubSpot pipeline name"
          className="flex-1 text-xs border border-dashed border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          type="button"
          onClick={addRow}
          disabled={!newSuffix.trim() || !newPipeline.trim()}
          className="text-brand-600 hover:text-brand-800 disabled:opacity-30 text-sm font-medium shrink-0"
        >
          Add
        </button>
      </div>
    </div>
  )
}

// Same as TagInput but does NOT uppercase values (job names are mixed-case)
function BlacklistInput({ tags, onChange, placeholder }) {
  const [input, setInput] = useState('')

  function addTag(raw) {
    const val = raw.trim()
    if (val && !tags.includes(val)) onChange([...tags, val])
    setInput('')
  }

  function handleKey(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5 border border-gray-300 rounded-lg px-2 py-2 focus-within:ring-2 focus-within:ring-brand-500 bg-white">
      {tags.map(tag => (
        <span key={tag} className="inline-flex items-center gap-1 bg-red-50 text-red-700 text-xs font-mono rounded px-2 py-0.5 border border-red-200">
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter(t => t !== tag))}
            className="text-red-400 hover:text-red-700 leading-none"
          >×</button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => input && addTag(input)}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] text-xs font-mono outline-none bg-transparent"
      />
    </div>
  )
}

function SalesTeamEditor({ team, onChange }) {
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')

  function addMember() {
    const name = newName.trim()
    const email = newEmail.trim().toLowerCase()
    if (!name || !email) return
    onChange([...team, { name, email }])
    setNewName('')
    setNewEmail('')
  }

  function removeMember(idx) {
    onChange(team.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-2">
      {team.map((member, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            type="text"
            value={member.name}
            onChange={e => {
              const next = [...team]
              next[idx] = { ...next[idx], name: e.target.value }
              onChange(next)
            }}
            className="flex-1 text-xs border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Full name"
          />
          <input
            type="email"
            value={member.email}
            onChange={e => {
              const next = [...team]
              next[idx] = { ...next[idx], email: e.target.value }
              onChange(next)
            }}
            className="flex-1 text-xs border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="email@example.com"
          />
          <button
            type="button"
            onClick={() => removeMember(idx)}
            className="text-gray-300 hover:text-red-500 transition-colors text-lg leading-none shrink-0"
          >
            ×
          </button>
        </div>
      ))}

      <div className="flex items-center gap-2 pt-1">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addMember()}
          placeholder="Full name"
          className="flex-1 text-xs border border-dashed border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <input
          type="email"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addMember()}
          placeholder="email@example.com"
          className="flex-1 text-xs border border-dashed border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          type="button"
          onClick={addMember}
          disabled={!newName.trim() || !newEmail.trim()}
          className="text-brand-600 hover:text-brand-800 disabled:opacity-30 text-sm font-medium shrink-0"
        >
          Add
        </button>
      </div>
    </div>
  )
}

export default function UserSettings({ userId, initialConfig, onSaved }) {
  const [pipelineMapping, setPipelineMapping] = useState(
    initialConfig?.pipeline_mapping && Object.keys(initialConfig.pipeline_mapping).length > 0
      ? initialConfig.pipeline_mapping
      : DEFAULT_PIPELINE_MAPPING
  )
  const [excludedSuffixes, setExcludedSuffixes] = useState(
    initialConfig?.excluded_suffixes?.length > 0
      ? initialConfig.excluded_suffixes
      : DEFAULT_EXCLUDED
  )
  const [salesTeam, setSalesTeam] = useState(initialConfig?.sales_team || [])
  const [blacklist, setBlacklist] = useState(initialConfig?.blacklist || [])
  const [partnerID, setPartnerID] = useState(initialConfig?.hubspot_partner_id || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)

    const { error } = await supabase
      .from('hs_user_config')
      .upsert(
        {
          user_id: userId,
          pipeline_mapping: pipelineMapping,
          excluded_suffixes: excludedSuffixes,
          sales_team: salesTeam,
          blacklist,
          hubspot_partner_id: partnerID.trim() || null,
        },
        { onConflict: 'user_id' }
      )

    if (error) {
      setError(error.message)
    } else {
      setSaved(true)
      onSaved?.()
      setTimeout(() => setSaved(false), 3000)
    }
    setSaving(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="font-semibold text-gray-900 mb-1">Import Settings</h3>
      <p className="text-sm text-gray-500 mb-6">
        These settings are private to your account. They control how your Albi export maps to HubSpot.
      </p>

      <form onSubmit={handleSave} className="space-y-8">
        {/* HubSpot Partner ID */}
        <div>
          <SectionHeader
            title="HubSpot Portal ID"
            description="Your HubSpot portal/partner ID (found in the HubSpot URL as the number after /portal/)."
          />
          <input
            type="text"
            value={partnerID}
            onChange={e => setPartnerID(e.target.value)}
            placeholder="e.g. 12345678"
            className="w-48 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {/* Pipeline Mapping */}
        <div>
          <SectionHeader
            title="Job Suffix → Pipeline Mapping"
            description="Maps the type suffix of your Albi job number to a HubSpot pipeline. The suffix is extracted after the second dash (e.g. GPC-24-WTR001 → WTR)."
          />
          <PipelineMappingEditor mapping={pipelineMapping} onChange={setPipelineMapping} />
        </div>

        {/* Excluded Suffixes */}
        <div>
          <SectionHeader
            title="Excluded Job Suffixes"
            description="Jobs with these prefixes will be skipped during import. Type a suffix and press Enter or comma to add."
          />
          <TagInput
            tags={excludedSuffixes}
            onChange={setExcludedSuffixes}
            placeholder="Type suffix and press Enter…"
          />
        </div>

        {/* Sales Team */}
        <div>
          <SectionHeader
            title="Sales Team"
            description="Your team members and their HubSpot email addresses. Used to validate owners during the config check and map deal ownership during import."
          />
          <SalesTeamEditor team={salesTeam} onChange={setSalesTeam} />
        </div>

        {/* Blacklist */}
        <div>
          <SectionHeader
            title="Job Blacklist"
            description="Job names in this list are always skipped during import, regardless of other filters. Type an exact job name (e.g. GPC-24-WTR999) and press Enter to add."
          />
          <BlacklistInput
            tags={blacklist}
            onChange={setBlacklist}
            placeholder="Type job name and press Enter…"
          />
          {blacklist.length > 0 && (
            <p className="text-xs text-gray-400 mt-1.5">{blacklist.length} job{blacklist.length !== 1 ? 's' : ''} blacklisted</p>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          {saved && (
            <span className="text-sm text-green-700 font-medium">Settings saved.</span>
          )}
        </div>
      </form>
    </div>
  )
}
