import { useEffect, useRef, useState } from 'react'
import { btn, primary } from './ResolutionBar.jsx'

// Approval for linking a candidate that is already linked to other HubSpot records. Opened by the record
// before any request is sent, so the reviewer never meets a 409 discovery. Approval starts checked.
export default function ManyToOneDialog({ candidate = null, objectLabel = 'contact', busy = false, onConfirm, onCancel }) {
  const [approved, setApproved] = useState(true)
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)
  const previousFocus = useRef(null)
  const open = Boolean(candidate)
  const candidateId = candidate?.id

  useEffect(() => { setApproved(true) }, [candidateId])
  useEffect(() => {
    if (!open) return undefined
    previousFocus.current = document.activeElement
    cancelRef.current?.focus()
    return () => { const target = previousFocus.current; if (target?.isConnected) target.focus() }
  }, [open, candidateId])

  if (!open) return null
  const count = candidate.linkedElsewhere
  function onKeyDown(event) {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel?.(); return }
    if (event.key !== 'Tab') return
    const controls = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); dialogRef.current?.focus() }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current || !controls.includes(document.activeElement))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current || !controls.includes(document.activeElement))) { event.preventDefault(); first.focus() }
  }
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-950/45 px-4 py-4 sm:items-center"
    role="dialog" aria-modal="true" aria-labelledby="many-to-one-title" onKeyDown={onKeyDown}>
    <div ref={dialogRef} tabIndex={-1} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl outline-none">
      <h3 id="many-to-one-title" className="text-lg font-semibold text-gray-900">Link a record that is already linked</h3>
      <p className="mt-2 text-sm text-gray-700">Albi {candidate.name || objectLabel} ({candidate.id}) is already linked to {count} other HubSpot record{count === 1 ? '' : 's'}. Linking it here makes a many-to-one mapping.</p>
      <label className="mt-3 flex items-start gap-2 text-sm text-gray-800">
        <input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} className="mt-0.5 text-brand-600 focus:ring-brand-500" />
        Approve a many-to-one mapping for this Albi {objectLabel}</label>
      <div className="mt-5 flex flex-row-reverse flex-wrap gap-2">
        <button type="button" className={primary} disabled={busy || !approved} onClick={() => onConfirm?.(candidate)}>Link anyway</button>
        <button ref={cancelRef} type="button" className={btn} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>
}
