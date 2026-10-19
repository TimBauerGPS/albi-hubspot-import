import { REASON_LABELS, WARNING_LABELS } from './reviewWorkspace.js'

const STRENGTH_STYLE = { Strong: 'bg-green-100 text-green-800', Likely: 'bg-amber-100 text-amber-800', Weak: 'bg-gray-100 text-gray-700' }
const humanize = code => String(code).replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())

// Ranked Albi candidates. Each card shows name and details, a strength label (no numeric score) and why it matched.
export default function CandidateList({ candidates = [], selectedIndex = 0, suggestedId = null, onPick, objectLabel = 'contact' }) {
  if (!candidates.length) return null
  return <section aria-label="Albi candidates">
    <h3 className="text-sm font-semibold text-gray-900">Albi candidates <span className="font-normal text-gray-500">· ranked</span></h3>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">{candidates.map((candidate, index) => {
      const selected = index === selectedIndex
      return <button key={candidate.id} type="button" aria-pressed={selected} onClick={() => onPick?.(index)}
        className={`min-w-0 rounded-lg border p-3 text-left ${selected ? 'border-brand-500 ring-2 ring-brand-500/30' : 'border-gray-200 hover:border-brand-300'}`}>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">{index + 1}. {candidate.name || `Albi ${objectLabel}`}</span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[0.68rem] font-semibold ${STRENGTH_STYLE[candidate.strength] ?? STRENGTH_STYLE.Weak}`}>
            {candidate.strength}{suggestedId && suggestedId === candidate.id ? ' · suggested' : ''}</span>
        </span>
        <span className="mt-1 block truncate text-xs text-gray-600">{candidate.details || 'Few details in Albi'} · Albi {candidate.id}</span>
        <span className="mt-2 flex flex-wrap gap-1">
          {candidate.matchReasons.map(reason => <span key={reason} className="rounded bg-gray-100 px-1.5 py-0.5 text-[0.68rem] font-medium text-gray-700">{REASON_LABELS[reason] ?? humanize(reason)}</span>)}
          {candidate.warnings.map(warning => <span key={warning} className="rounded bg-red-50 px-1.5 py-0.5 text-[0.68rem] font-medium text-red-700">{WARNING_LABELS[warning] ?? humanize(warning)}</span>)}
        </span>
      </button>
    })}</div>
  </section>
}
