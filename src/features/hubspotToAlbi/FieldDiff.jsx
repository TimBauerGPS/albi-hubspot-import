import { btn } from './ResolutionBar.jsx'

const HIDDEN_KEYS = new Set(['id', 'organizationId'])

// Trimmed, normalized comparison rows (from reviewWorkspace.fieldDiffRows). Rows blank on both sides are
// already gone; matching rows are collapsed behind "Show N matching fields".
export default function FieldDiff({ rows = [], hasCandidate = false, candidateId = '', showMatching = false, onToggleMatching,
  choices = null, onChoose, disabled = false }) {
  const shown = rows.filter(row => !HIDDEN_KEYS.has(row.key))
  const visible = shown.filter(row => row.kind !== 'same')
  const matching = shown.filter(row => row.kind === 'same')
  const choosing = choices !== null
  return <section aria-label="Field comparison">
    <h3 className="text-sm font-semibold text-gray-900">{hasCandidate ? `What differs from Albi ${candidateId}` : 'HubSpot values (no Albi match)'}</h3>
    {hasCandidate && visible.length === 0 && <p className="mt-1 text-sm text-gray-600">Nothing differs. Every shared field matches.</p>}
    {visible.length > 0 && <table className="mt-2 w-full table-fixed text-sm">
      <thead><tr className="text-left text-xs text-gray-500">
        <th className="w-28 pb-1 font-medium">Field</th><th className="pb-1 font-medium">HubSpot</th>
        {hasCandidate && <th className="pb-1 font-medium">Albi</th>}
        {choosing && <th className="w-44 pb-1 font-medium">Keep</th>}
      </tr></thead>
      <tbody>{visible.map(row => <tr key={row.key} className={`border-t border-gray-100 ${row.kind === 'differs' ? 'bg-amber-50/60' : ''}`}>
        <td className="py-1.5 pr-2 text-xs font-medium text-gray-600">{row.label}</td>
        <td className="break-words py-1.5 pr-2">{row.hubspot || <span className="text-gray-400">Blank</span>}</td>
        {hasCandidate && <td className="break-words py-1.5 pr-2">{row.albi || <span className="text-gray-400">Blank</span>}</td>}
        {choosing && <td className="py-1.5">{row.choosable && <span className="flex gap-1" role="group" aria-label={`Keep which ${row.label}`}>
          {[['hubspot', 'Use HubSpot'], ['albi', 'Use Albi']].map(([value, text]) =>
            <button key={value} type="button" disabled={disabled} aria-pressed={choices[row.key] === value} onClick={() => onChoose?.(row.key, value)}
              className={`rounded border px-2 py-0.5 text-xs font-semibold ${choices[row.key] === value ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-gray-300 text-gray-700'}`}>{text}</button>)}
        </span>}</td>}
      </tr>)}</tbody></table>}
    {choosing && visible.some(row => row.choosable) && <p className="mt-2 text-xs text-gray-600">
      Use HubSpot: You’ll update this in Albi. Use Albi: Updates HubSpot now.</p>}
    {matching.length > 0 && <button type="button" onClick={onToggleMatching} className={`${btn} mt-2 border-transparent bg-transparent px-0 py-0 text-xs text-brand-700 underline`}>
      {showMatching ? 'Hide' : 'Show'} {matching.length} matching field{matching.length === 1 ? '' : 's'}</button>}
    {showMatching && matching.length > 0 && <p className="mt-1 text-xs text-gray-600">{matching.map(row => `${row.label}: ${row.hubspot}`).join(' · ')}</p>}
  </section>
}
