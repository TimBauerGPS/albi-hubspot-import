import { useEffect, useRef } from 'react'
import { btn, Kbd } from './ResolutionBar.jsx'

const KEYS = [
  ['j / k', 'Next / previous record'], ['Enter or a', 'Accept the suggestion'], ['1–9', 'Pick a candidate'], ['l', 'Link the selected candidate'],
  ['n', 'Create in Albi'], ['s', 'Skip (live records only)'], ['r', 'Recheck'], ['x', 'Tick for a bulk action'],
  ['t', 'Open the Albi to-do'], ['u', 'Undo the last action'], ['?', 'Show this help'],
]

export default function ShortcutHelp({ open = false, kind = 'sample', onClose }) {
  const closeRef = useRef(null)
  const previousFocus = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    previousFocus.current = document.activeElement
    closeRef.current?.focus()
    return () => { const target = previousFocus.current; if (target?.isConnected) target.focus() }
  }, [open])
  if (!open) return null
  const keys = KEYS.filter(([, text]) => kind === 'live' || !text.startsWith('Skip'))
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 px-4 py-4" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title"
    onKeyDown={event => { if (event.key === 'Escape' || event.key === '?') { event.preventDefault(); onClose?.() } }}>
    <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
      <h3 id="shortcut-help-title" className="text-lg font-semibold text-gray-900">Keyboard shortcuts</h3>
      <dl className="mt-3 space-y-1.5 text-sm">{keys.map(([key, text]) => <div key={key} className="flex items-center justify-between gap-3">
        <dt className="text-gray-700">{text}</dt><dd><Kbd>{key}</Kbd></dd></div>)}</dl>
      <p className="mt-3 text-xs text-gray-600">Shortcuts are ignored while typing in a field.</p>
      <div className="mt-4 flex justify-end"><button ref={closeRef} type="button" className={btn} onClick={onClose}>Close</button></div>
    </div>
  </div>
}
