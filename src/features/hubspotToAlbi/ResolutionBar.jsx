export const btn = 'rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'
export const primary = 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
export const Kbd = ({ children }) => <kbd className="ml-1.5 rounded border border-current/30 px-1 font-mono text-[0.65rem] opacity-70">{children}</kbd>

// Presentational action bar. ReviewRecord decides what is offered; this only renders it and calls back.
// Nothing here is rendered for a read-only reviewer (canAct and showRecheck are both false).
export default function ResolutionBar({
  disabled = false, fieldMode = false, applyDisabled = false, onAllHubSpot, onAllAlbi, onApplyFields,
  suggestion = null, onAccept, selectedLink = null, onLinkSelected,
  create = null, referralSources = [], referralSourceId = '', onReferral, referralRef, onCreate,
  showSkip = false, onSkip, showRecheck = false, onRecheck,
}) {
  const hasOther = Boolean(suggestion || selectedLink)
  return <footer className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3" aria-label="Resolution actions">
    {fieldMode && <>
      <button type="button" className={btn} disabled={disabled} onClick={onAllHubSpot}>All HubSpot</button>
      <button type="button" className={btn} disabled={disabled} onClick={onAllAlbi}>All Albi</button>
      <button type="button" className={primary} disabled={disabled || applyDisabled} onClick={onApplyFields}>Apply field choices</button>
    </>}
    {suggestion && <button type="button" className={primary} disabled={disabled} onClick={onAccept}>
      Accept suggestion{suggestion.emailMatch ? ' (emails match)' : ''}<Kbd>Enter</Kbd></button>}
    {selectedLink && <button type="button" className={suggestion ? btn : primary} disabled={disabled} onClick={onLinkSelected}>
      Link selected{selectedLink.name ? `: ${selectedLink.name}` : ''}<Kbd>l</Kbd></button>}
    {create && <span className="flex flex-wrap items-center gap-2">
      <select ref={referralRef} value={referralSourceId} disabled={disabled} aria-label="Referral source"
        onChange={event => { onReferral?.(event.target.value); event.target.blur?.() }}
        className={`rounded-lg border bg-white px-2 py-1.5 text-sm ${referralSourceId ? 'border-gray-300' : 'border-amber-400'}`}>
        <option value="">Referral source…</option>
        {referralSources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
      </select>
      <button type="button" className={hasOther || fieldMode ? btn : primary} disabled={disabled || !referralSourceId} onClick={onCreate}>
        {create.label}<Kbd>n</Kbd></button>
    </span>}
    {showSkip && <button type="button" className={btn} disabled={disabled} onClick={onSkip}>Skip<Kbd>s</Kbd></button>}
    {showRecheck && <button type="button" className={`${btn} ml-auto`} onClick={onRecheck}>Recheck<Kbd>r</Kbd></button>}
  </footer>
}
