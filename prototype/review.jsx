// THROWAWAY PROTOTYPE. Mock data only; nothing is sent to HubSpot, Albi or Supabase.
// Spec: docs/superpowers/specs/2026-10-17-h2a-fast-review-and-conflicts-parity-design.md
import { Fragment, StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

const REFERRALS = ['Google', 'Insurance Agent', 'Plumber', 'Property Manager', 'Repeat Customer']
const COMPANY_DEFAULT_REFERRAL = 'Property Manager'
const UNDO_MS = 5000

const c = (id, name, fields, reasons, extra = {}) => ({ id, name, ...fields, reasons, warnings: [], linkedElsewhere: 0, ...extra })
const MOCK = [
  { id: 'r1', objectType: 'contacts', name: 'Jane Doe', org: 'Lakeside Property Group', hubspotId: '50112', reason: 'Possible duplicate in Albi',
    source: { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@lakeside.com', phone: '(612) 555-0101', address1: '12 Lake St', city: 'Minneapolis', state: 'MN', zip: '55401', organization: 'Lakeside Property Group' },
    candidates: [c('48213', 'Jane Doe', { firstName: 'Jane', lastName: 'Doe', email: 'Jane.Doe@lakeside.com ', phone: '612-555-0199', address1: '12 Lake Street', city: 'Minneapolis', state: 'MN', zip: '55401', organization: 'Lakeside Property Group' }, ['same_email', 'same_name', 'same_organization'])] },
  { id: 'r2', objectType: 'contacts', name: 'Marcus Lee', org: 'Northstar Insurance', hubspotId: '50177', reason: 'Possible duplicate in Albi',
    source: { firstName: 'Marcus', lastName: 'Lee', email: 'mlee@northstar-ins.com', phone: '(651) 555-0144', city: 'St Paul', state: 'MN', organization: 'Northstar Insurance' },
    candidates: [c('48300', 'Marcus Lee', { firstName: 'Marcus', lastName: 'Lee', email: 'mlee@northstar-ins.com', phone: '(651) 555-0144', city: 'Saint Paul', state: 'MN', organization: 'Northstar Insurance' }, ['same_email', 'same_phone', 'same_name', 'same_organization'])] },
  { id: 'r3', objectType: 'contacts', name: 'Priya Shah', org: 'Shah Plumbing', hubspotId: '50190', reason: 'Possible duplicate in Albi', staleOnBulk: true,
    source: { firstName: 'Priya', lastName: 'Shah', email: 'priya@shahplumbing.com', phone: '(763) 555-0123', organization: 'Shah Plumbing' },
    candidates: [c('48410', 'Priya Shah', { firstName: 'Priya', lastName: 'Shah', email: 'priya@shahplumbing.com', phone: '', organization: 'Shah Plumbing' }, ['same_email', 'same_name'])] },
  { id: 'r4', objectType: 'contacts', name: 'Tom Becker', org: '', hubspotId: '50205', reason: 'New contact, not in Albi yet',
    source: { firstName: 'Tom', lastName: 'Becker', email: 'tbecker@gmail.com', phone: '(952) 555-0188', city: 'Edina', state: 'MN' }, candidates: [], createReady: true },
  { id: 'r5', objectType: 'contacts', name: 'Alicia Gomez', org: 'Ridgeview HOA', hubspotId: '50231', reason: 'Several possible matches in Albi',
    source: { firstName: 'Alicia', lastName: 'Gomez', email: 'alicia.gomez@ridgeviewhoa.org', phone: '(612) 555-0170', mobile: '(612) 555-0171', organization: 'Ridgeview HOA' },
    candidates: [
      c('48501', 'Alicia Gomez', { firstName: 'Alicia', lastName: 'Gomez', email: 'agomez@yahoo.com', phone: '612.555.0171', organization: 'Ridgeview HOA' }, ['phone_matches_mobile', 'same_name', 'same_organization'], { warnings: ['different_email'] }),
      c('48502', 'Alicia Gomez-Ruiz', { firstName: 'Alicia', lastName: 'Gomez-Ruiz', email: '', phone: '', organization: '' }, ['same_first_name']),
    ] },
  { id: 'r6', objectType: 'contacts', name: 'Dan Whitfield', org: 'Whitfield Realty', hubspotId: '50250', reason: 'Organization not in Albi yet',
    source: { firstName: 'Dan', lastName: 'Whitfield', email: 'dan@whitfieldrealty.com', phone: '(651) 555-0102', organization: 'Whitfield Realty' }, candidates: [], createReady: true,
    orgFirst: { name: 'Whitfield Realty', ready: true } },
  { id: 'r7', objectType: 'contacts', name: 'Kara Olson', org: 'Olson & Sons Restoration', hubspotId: '50262', reason: 'Field values differ',
    source: { firstName: 'Kara', lastName: 'Olson', email: 'kara@olsonsons.com', phone: '(612) 555-0133', jobTitle: 'Office Manager', organization: 'Olson & Sons Restoration' },
    candidates: [c('48620', 'Kara Olsen', { firstName: 'Kara', lastName: 'Olsen', email: 'kara@olsonsons.com', phone: '(612) 555-0133', jobTitle: 'Office Mgr', organization: 'Olson & Sons Restoration' }, ['same_email', 'same_phone'], { mapped: true })],
    fieldMode: true },
  { id: 'r8', objectType: 'contacts', name: 'Sam Rivera', org: 'Cityline Management', hubspotId: '50288', reason: 'Albi record already linked to another HubSpot contact',
    source: { firstName: 'Sam', lastName: 'Rivera', email: 'sam.rivera@cityline.com', phone: '(763) 555-0155', organization: 'Cityline Management' },
    candidates: [c('48700', 'Sam Rivera', { firstName: 'Sam', lastName: 'Rivera', email: 'sam.rivera@cityline.com', phone: '(763) 555-0155', organization: 'Cityline Management' }, ['same_email', 'same_phone', 'same_name'], { warnings: ['already_linked_elsewhere'], linkedElsewhere: 1 })] },
  { id: 'r9', objectType: 'contacts', name: 'Beth Nguyen', org: 'Metro Adjusters', hubspotId: '50301', reason: 'Merged in HubSpot', mergedInto: '50999',
    source: { firstName: 'Beth', lastName: 'Nguyen', email: 'beth@metroadjusters.com', organization: 'Metro Adjusters' }, candidates: [] },
  { id: 'r10', objectType: 'contacts', name: 'Greg Holm', org: '', hubspotId: '50320', reason: 'Owner has no matching Albi salesperson', blocked: 'salesperson_not_found',
    source: { firstName: 'Greg', lastName: 'Holm', email: 'greg.holm@outlook.com' }, candidates: [] },
  { id: 'r11', objectType: 'companies', name: 'Lakeside Property Group', org: '', hubspotId: '9001', reason: 'Possible duplicate in Albi',
    source: { name: 'Lakeside Property Group', domain: 'lakeside.com', phone: '(612) 555-0100', city: 'Minneapolis' },
    candidates: [c('7100', 'Lakeside Property Group LLC', { name: 'Lakeside Property Group LLC', domain: 'lakeside.com', phone: '(612) 555-0100', city: 'Minneapolis' }, ['same_domain', 'same_phone'])] },
  { id: 'r12', objectType: 'contacts', name: 'Owen Park', org: 'Park Dental', hubspotId: '50340', reason: 'Field values differ', status: 'waiting',
    source: { firstName: 'Owen', lastName: 'Park', email: 'owen@parkdental.com', phone: '(952) 555-0111' },
    candidates: [c('48800', 'Owen Park', { firstName: 'Owen', lastName: 'Park', email: 'owen@parkdental.com', phone: '(952) 555-0119' }, ['same_email', 'same_name'], { mapped: true })],
    albiTasks: [{ field: 'Phone', value: '(952) 555-0111' }] },
  { id: 'r13', objectType: 'contacts', name: 'Rita Kowalski', org: 'Kowalski Law', hubspotId: '50355', reason: 'Field values differ', status: 'waiting', stillDiffers: true,
    source: { firstName: 'Rita', lastName: 'Kowalski', email: 'rita@kowalskilaw.com', address1: '400 Main Ave', city: 'Bloomington' },
    candidates: [c('48810', 'Rita Kowalski', { firstName: 'Rita', lastName: 'Kowalski', email: 'rita@kowalskilaw.com', address1: '40 Main Ave', city: 'Bloomington' }, ['same_email', 'same_name'], { mapped: true })],
    albiTasks: [{ field: 'Address', value: '400 Main Ave' }] },
  { id: 'r14', objectType: 'contacts', name: 'Lena Fischer', org: 'Fischer Homes', hubspotId: '50371', reason: 'Possible duplicate in Albi',
    source: { firstName: 'Lena', lastName: 'Fischer', email: ' lena@fischerhomes.com', phone: '(612) 555-0177', organization: 'Fischer Homes' },
    candidates: [c('48900', 'Lena Fischer', { firstName: 'Lena', lastName: 'Fischer', email: 'LENA@fischerhomes.com', phone: '(612) 555-0177', organization: 'Fischer Homes' }, ['same_email', 'same_phone', 'same_name'])] },
]

const FIELDS = [['firstName', 'First name'], ['lastName', 'Last name'], ['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['mobile', 'Mobile'],
  ['jobTitle', 'Job title'], ['organization', 'Organization'], ['domain', 'Domain'], ['address1', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Postal code']]
const REASON_LABEL = { same_email: 'Same email', same_other_email: 'Same other email', same_phone: 'Same phone', phone_matches_mobile: 'Phone matches mobile',
  same_name: 'Same name', same_first_name: 'Same first name only', same_organization: 'Same organization', same_domain: 'Same domain', same_address: 'Same address' }
const WARNING_LABEL = { different_email: 'Different email', already_linked_elsewhere: 'Already linked to another HubSpot record' }
const BLOCKED_COPY = { salesperson_not_found: 'The HubSpot owner’s name does not match one Albi salesperson. Fix the name in Albi or HubSpot, then recheck.' }
const BUCKETS = [['quick', 'Quick wins'], ['decision', 'Needs decision'], ['blocked', 'Blocked'], ['done', 'Done']]

const norm = (key, value) => {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (key === 'phone' || key === 'mobile') return text.replace(/\D/g, '').slice(-10)
  if (key === 'email' || key === 'domain') return text.toLowerCase()
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/\bstreet\b/g, 'st').replace(/\bsaint\b/g, 'st')
}
function strength(candidate) {
  if ((candidate.reasons.includes('same_email') || candidate.reasons.includes('same_other_email') || candidate.reasons.includes('same_domain')) && !candidate.warnings.includes('different_email')) return 'Strong'
  if (candidate.reasons.some(reason => ['same_phone', 'phone_matches_mobile'].includes(reason)) || candidate.reasons.includes('same_name') && candidate.reasons.includes('same_organization')) return 'Likely'
  return 'Weak'
}
const rank = { Strong: 0, Likely: 1, Weak: 2 }
const ranked = record => [...record.candidates].sort((a, b) => rank[strength(a)] - rank[strength(b)] || b.reasons.length - a.reasons.length)
function suggestion(record) {
  const strong = ranked(record).filter(candidate => strength(candidate) === 'Strong')
  return strong.length === 1 ? strong[0] : null
}
function bucketOf(record) {
  if (record.status === 'done') return 'done'
  if (record.status === 'waiting') return 'todo'
  if (record.blocked || record.mergedInto) return 'blocked'
  if (record.fieldMode) return 'decision'
  if (record.candidates.length === 0 && record.createReady && !record.orgFirst) return 'quick'
  const top = suggestion(record)
  if (top && record.candidates.length === 1 && top.linkedElsewhere === 0) return 'quick'
  return 'decision'
}
const storage = {
  get(key, fallback) { try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value) } catch { return fallback } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* convenience only */ } },
}
const copy = value => { try { navigator.clipboard?.writeText(String(value)) } catch { /* convenience only */ } }

const btn = 'rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed'
const primary = 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed'
const Kbd = ({ children }) => <kbd className="ml-1.5 rounded border border-current/30 px-1 font-mono text-[0.65rem] opacity-70">{children}</kbd>

function App() {
  const [kind, setKind] = useState('sample')
  const [records, setRecords] = useState(() => MOCK.map(record => ({ status: 'open', ...record })))
  const [view, setView] = useState('quick')
  const [selectedId, setSelectedId] = useState(null)
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [referral, setReferral] = useState(() => storage.get('proto.referral', COMPANY_DEFAULT_REFERRAL))
  const [pending, setPending] = useState([])
  const [dialog, setDialog] = useState(null)
  const [checked, setChecked] = useState(() => new Set())
  const [todoDone, setTodoDone] = useState(() => new Set(storage.get('proto.todoDone', [])))
  const [busy, setBusy] = useState('')
  const [log, setLog] = useState([])
  const [help, setHelp] = useState(false)
  const [showMatching, setShowMatching] = useState(false)
  const [fieldChoices, setFieldChoices] = useState({})
  const timers = useRef(new Map())
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const pendingIds = new Set(pending.map(item => item.recordId))
  const buckets = useMemo(() => {
    const groups = { quick: [], decision: [], blocked: [], done: [], todo: [] }
    for (const record of records) groups[bucketOf(record)].push(record)
    return groups
  }, [records])
  const list = view === 'todo' ? [] : buckets[view]
  const selected = records.find(record => record.id === selectedId) ?? null
  const candidates = selected ? ranked(selected) : []
  const candidate = candidates[candidateIndex] ?? null
  const top = selected ? suggestion(selected) : null

  useEffect(() => { if (view !== 'todo' && !list.some(record => record.id === selectedId)) setSelectedId(list.find(record => !pendingIds.has(record.id))?.id ?? list[0]?.id ?? null) }, [view, list]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCandidateIndex(0); setShowMatching(false); setFieldChoices({}) }, [selectedId])
  useEffect(() => { storage.set('proto.referral', referral) }, [referral])
  useEffect(() => { storage.set('proto.todoDone', [...todoDone]) }, [todoDone])

  const note = text => setLog(current => [{ id: crypto.randomUUID(), text, at: new Date() }, ...current].slice(0, 30))
  const patch = (id, values) => setRecords(current => current.map(record => record.id === id ? { ...record, ...values } : record))

  function advanceFrom(id) {
    const order = list.map(record => record.id)
    const start = order.indexOf(id)
    const next = [...order.slice(start + 1), ...order.slice(0, Math.max(0, start))].find(other => other !== id && !pendingIds.has(other))
    setSelectedId(next ?? null)
  }

  // Deferred commit: nothing is "sent" until the undo window expires.
  function queue(record, label, apply) {
    const item = { id: crypto.randomUUID(), recordId: record.id, label, apply }
    setPending(current => [...current, item])
    timers.current.set(item.id, setTimeout(() => commit(item.id), UNDO_MS))
    advanceFrom(record.id)
  }
  function commit(itemId) {
    clearTimeout(timers.current.get(itemId)); timers.current.delete(itemId)
    const item = pendingRef.current.find(value => value.id === itemId)
    pendingRef.current = pendingRef.current.filter(value => value.id !== itemId)
    setPending(current => current.filter(value => value.id !== itemId))
    if (item) { item.apply(); note(`Sent: ${item.label}`) }
  }
  function undo(itemId) {
    const target = itemId ?? pending.at(-1)?.id
    if (!target) return
    clearTimeout(timers.current.get(target)); timers.current.delete(target)
    const item = pending.find(value => value.id === target)
    setPending(current => current.filter(value => value.id !== target))
    if (item) { setSelectedId(item.recordId); note(`Undone: ${item.label} (nothing was written)`) }
  }
  useEffect(() => {
    const guard = event => { if (pending.length) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [pending.length])

  function link(record, target, { emailMatch = false } = {}) {
    if (!target) return
    const label = `Link ${record.name} → Albi ${target.name} (${target.id})${emailMatch ? ', emails match' : ''}`
    if (target.linkedElsewhere > 0) {
      setDialog({ title: 'Approve a many-to-one link?', body: [`Albi ${target.name} (${target.id}) is already linked to ${target.linkedElsewhere} other HubSpot record.`, 'Linking makes both HubSpot records point at this one Albi record.'],
        confirm: 'Approve and link', onConfirm: () => { setDialog(null); patch(record.id, { status: 'done', outcome: 'Linked (many-to-one approved)' }); note(`Sent: ${label} (many-to-one approved)`); advanceFrom(record.id) } })
      return
    }
    queue(record, label, () => patch(record.id, { status: 'done', outcome: `Linked to Albi ${target.id}` }))
  }
  function create(record) {
    if (!referral) return
    if (record.candidates.length > 0) {
      setDialog({ title: 'Create a separate Albi record?', danger: true, body: [`${record.candidates.length} possible match${record.candidates.length === 1 ? '' : 'es'} will be ignored. Albi records can’t be deleted from here, so this may create a duplicate.`, `Referral source: ${referral}`],
        confirm: 'Create separate record', onConfirm: () => { setDialog(null); patch(record.id, { status: 'done', outcome: 'Created (separate record)' }); note(`Sent: Create ${record.name} in Albi despite candidates`); advanceFrom(record.id) } })
      return
    }
    if (record.orgFirst) {
      queue(record, `Create organization ${record.orgFirst.name}, then contact ${record.name} (${referral})`, () => patch(record.id, { status: 'done', outcome: `Organization and contact created (${referral})` }))
      return
    }
    queue(record, `Create ${record.name} in Albi (${referral})`, () => patch(record.id, { status: 'done', outcome: `Created in Albi (${referral})` }))
  }
  function skip(record) {
    if (kind !== 'live') return
    queue(record, `Skip ${record.name}`, () => patch(record.id, { status: 'done', outcome: 'Skipped' }))
  }
  function recheck(record) {
    setBusy(`Rechecking ${record.name}: reading all of Albi (20–40s in real life, 2s here)…`)
    setTimeout(() => { setBusy(''); note(`Rechecked ${record.name}: still needs review`) }, 2000)
  }
  function applyFields(record) {
    const rows = diffRows(record, candidates[candidateIndex]).filter(row => row.kind === 'differs')
    if (rows.some(row => !fieldChoices[row.key])) return
    const hubspotWrites = rows.filter(row => fieldChoices[row.key] === 'albi')
    const albiTasks = rows.filter(row => fieldChoices[row.key] === 'hubspot').map(row => ({ field: row.label, value: row.hubspot }))
    const apply = () => patch(record.id, albiTasks.length ? { status: 'waiting', albiTasks } : { status: 'done', outcome: 'HubSpot updated' })
    if (hubspotWrites.length) {
      setDialog({ title: 'Update HubSpot now?', body: [...hubspotWrites.map(row => `HubSpot ${row.label} → ${row.albi}`), ...albiTasks.map(task => `Albi to-do: set ${task.field} to ${task.value}`)],
        confirm: 'Update HubSpot', onConfirm: () => { setDialog(null); apply(); note(`Sent: field decisions for ${record.name}`); advanceFrom(record.id) } })
      return
    }
    queue(record, `Field decisions for ${record.name} (adds ${albiTasks.length} Albi to-do)`, apply)
  }

  const bulkLinkable = buckets.quick.filter(record => record.candidates.length === 1 && !pendingIds.has(record.id))
  const bulkCreatable = buckets.quick.filter(record => record.candidates.length === 0 && !pendingIds.has(record.id))
  function bulk(kindOf) {
    const chosen = (kindOf === 'link' ? bulkLinkable : bulkCreatable).filter(record => checked.size === 0 || checked.has(record.id))
    if (!chosen.length) return
    setDialog({
      title: kindOf === 'link' ? `Link ${chosen.length} exact matches?` : `Create ${chosen.length} records in Albi?`,
      body: [...chosen.slice(0, 6).map(record => kindOf === 'link' ? `${record.name} → Albi ${record.candidates[0].name} (${record.candidates[0].id})` : `${record.name} · referral ${referral}`),
        ...(chosen.length > 6 ? [`…and ${chosen.length - 6} more`] : []), 'Each record is rechecked on the server first. Any that changed are skipped, never forced.'],
      confirm: kindOf === 'link' ? `Link ${chosen.length}` : `Create ${chosen.length}`,
      onConfirm: () => {
        setDialog(null)
        let index = 0; const skipped = []
        setBusy(`Working… 0 / ${chosen.length}`)
        const step = () => {
          const record = chosen[index]
          if (record.staleOnBulk) skipped.push(record.name)
          else patch(record.id, { status: 'done', outcome: kindOf === 'link' ? `Linked to Albi ${record.candidates[0].id} (bulk)` : `Created in Albi (${referral}, bulk)` })
          index += 1
          setBusy(`Working… ${index} / ${chosen.length}`)
          if (index < chosen.length) setTimeout(step, 350)
          else { setBusy(''); setChecked(new Set()); note(`Bulk ${kindOf}: ${chosen.length - skipped.length} done${skipped.length ? `, ${skipped.length} skipped (changed since you looked: ${skipped.join(', ')})` : ''}`) }
        }
        setTimeout(step, 350)
      },
    })
  }
  function recheckTodo() {
    const ids = buckets.todo.filter(record => todoDone.has(record.id)).map(record => record.id)
    if (!ids.length) return
    setBusy(`Rechecking ${ids.length} records with one Albi walk (20–40s in real life, 3s here)…`)
    setTimeout(() => {
      const still = []
      setRecords(current => current.map(record => {
        if (!ids.includes(record.id)) return record
        if (record.stillDiffers) { still.push(record.name); return { ...record, stillDiffers: false } }
        return { ...record, status: 'done', outcome: 'Cleared after Albi edit' }
      }))
      setTodoDone(current => new Set([...current].filter(id => !ids.includes(id) || false)))
      setBusy(''); note(`Recheck done: ${ids.length - still.length} cleared${still.length ? `; still differs in Albi: ${still.join(', ')}` : ''}`)
    }, 3000)
  }

  // One key handler, always reading the latest render.
  const keys = useRef(null)
  keys.current = event => {
    if (event.target.closest('input, select, textarea') || event.metaKey || event.ctrlKey || event.altKey) return
    // A focused button already handles Enter/Space as a click; don't fire the shortcut too.
    if (event.target.closest('button, a') && (event.key === 'Enter' || event.key === ' ')) return
    if (event.repeat) return
    if (dialog) { if (event.key === 'Escape') setDialog(null); if (event.key === 'Enter') dialog.onConfirm(); return }
    const key = event.key
    if (key === '?') { setHelp(value => !value); return }
    if (key === 'Escape') { setHelp(false); return }
    if (key === 't') { setView('todo'); return }
    if (key === 'u') { undo(); return }
    if (view === 'todo' || !selected) return
    const order = list.filter(record => !pendingIds.has(record.id) || record.id === selectedId).map(record => record.id)
    const at = order.indexOf(selectedId)
    if (key === 'j' || key === 'ArrowDown') { event.preventDefault(); setSelectedId(order[Math.min(order.length - 1, at + 1)] ?? selectedId) }
    else if (key === 'k' || key === 'ArrowUp') { event.preventDefault(); setSelectedId(order[Math.max(0, at - 1)] ?? selectedId) }
    else if ((key === 'Enter' || key === 'a') && top && !pendingIds.has(selected.id)) link(selected, top, { emailMatch: top.reasons.includes('same_email') })
    else if (/^[1-9]$/.test(key) && candidates[Number(key) - 1]) setCandidateIndex(Number(key) - 1)
    else if (key === 'l' && candidate && !pendingIds.has(selected.id)) link(selected, candidate)
    else if (key === 'n' && !pendingIds.has(selected.id) && !selected.blocked && !selected.mergedInto) create(selected)
    else if (key === 's') skip(selected)
    else if (key === 'r') recheck(selected)
    else if (key === 'x') setChecked(current => { const next = new Set(current); next.has(selected.id) ? next.delete(selected.id) : next.add(selected.id); return next })
  }
  useEffect(() => { const handler = event => keys.current(event); window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler) }, [])

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 text-gray-900">
      <div className="mb-3 rounded-lg border-2 border-dashed border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <strong>Prototype.</strong> Mock data; nothing is sent to HubSpot, Albi or Supabase. Press <Kbd>?</Kbd> for shortcuts.
      </div>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">Allied Restoration</p>
          <h1 className="text-xl font-semibold tracking-tight">{kind === 'sample' ? 'Sample review' : 'Conflicts (live sync)'}</h1>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs text-gray-600">Same workspace, two queues:</span>
          {[['sample', 'Sample review'], ['live', 'Conflicts']].map(([value, text]) => <button key={value} type="button" onClick={() => setKind(value)} className={kind === value ? primary : btn}>{text}</button>)}
        </div>
      </header>

      <nav className="mt-4 flex flex-wrap gap-2" aria-label="Buckets">
        {[...BUCKETS.slice(0, 3), ['todo', 'Albi to-do'], BUCKETS[3]].map(([value, text]) => (
          <button key={value} type="button" onClick={() => setView(value)}
            className={`rounded-lg border px-3 py-2 text-left ${view === value ? 'border-brand-500 bg-brand-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
            <span className="block text-xs font-medium text-gray-600">{text}{value === 'todo' && <Kbd>t</Kbd>}</span>
            <span className={`block text-xl font-semibold tabular-nums ${value === 'quick' ? 'text-green-700' : value === 'todo' && buckets.todo.length ? 'text-amber-700' : ''}`}>{buckets[value].length}</span>
          </button>))}
        <div className="ml-auto flex items-center gap-3 self-center text-xs text-gray-600">
          <label className="flex items-center gap-2">Referral source
            <select value={referral} onChange={event => setReferral(event.target.value)} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm">
              {REFERRALS.map(value => <option key={value}>{value}</option>)}</select></label>
          <span title="Falls back to the company's confirmed auto-create source">remembered · default {COMPANY_DEFAULT_REFERRAL}</span>
        </div>
      </nav>

      {busy && <p className="mt-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800" role="status">{busy}</p>}

      {view === 'todo' ? <AlbiTodo records={buckets.todo} done={todoDone} setDone={setTodoDone} onRecheck={recheckTodo} busy={Boolean(busy)} /> : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <aside className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            {view === 'quick' && <div className="space-y-2 border-b border-gray-200 p-3">
              <p className="text-xs text-gray-600">{checked.size ? `${checked.size} selected` : 'Bulk actions apply to all, or to the rows you tick (x).'}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btn} disabled={!bulkLinkable.length || Boolean(busy)} onClick={() => bulk('link')}>Link all exact matches ({bulkLinkable.filter(r => !checked.size || checked.has(r.id)).length})</button>
                <button type="button" className={btn} disabled={!bulkCreatable.length || Boolean(busy)} onClick={() => bulk('create')}>Create all ready ({bulkCreatable.filter(r => !checked.size || checked.has(r.id)).length})</button>
              </div></div>}
            <ol className="max-h-[38rem] divide-y divide-gray-100 overflow-y-auto">
              {list.length === 0 && <li className="px-4 py-8 text-sm text-gray-600">Nothing here.</li>}
              {list.map(record => {
                const isPending = pendingIds.has(record.id)
                return <li key={record.id} className={`flex gap-2 px-3 py-2.5 ${selectedId === record.id ? 'bg-brand-50' : 'hover:bg-gray-50'} ${isPending ? 'opacity-50' : ''}`}>
                  {view === 'quick' && <input type="checkbox" checked={checked.has(record.id)} aria-label={`Select ${record.name}`} className="mt-1"
                    onChange={() => setChecked(current => { const next = new Set(current); next.has(record.id) ? next.delete(record.id) : next.add(record.id); return next })} />}
                  <button type="button" onClick={() => setSelectedId(record.id)} className="min-w-0 flex-1 text-left">
                    <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{record.name}</span>
                      <span className="shrink-0 text-[0.68rem] font-medium text-gray-500">{record.objectType === 'companies' ? 'Org' : 'Contact'}</span></span>
                    <span className="block truncate text-xs text-gray-600">{record.org || record.source.email || '—'}</span>
                    <span className={`mt-0.5 block truncate text-xs ${record.blocked || record.mergedInto ? 'text-red-700' : 'text-gray-500'}`}>{isPending ? 'Sending in a few seconds… (u to undo)' : record.outcome ?? record.reason}</span>
                  </button></li>
              })}
            </ol>
          </aside>

          {selected ? <Record record={selected} kind={kind} candidates={candidates} candidateIndex={candidateIndex} setCandidateIndex={setCandidateIndex} top={top}
            pending={pendingIds.has(selected.id)} referral={referral} showMatching={showMatching} setShowMatching={setShowMatching}
            fieldChoices={fieldChoices} setFieldChoices={setFieldChoices}
            onLink={(target, options) => link(selected, target, options)} onCreate={() => create(selected)} onSkip={() => skip(selected)} onRecheck={() => recheck(selected)} onApplyFields={() => applyFields(selected)} />
            : <section className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-600">{list.length ? 'Select a record.' : 'This bucket is empty. Nice.'}</section>}
        </div>)}

      {log.length > 0 && <section className="mt-4 rounded-xl border border-gray-200 bg-white p-3"><h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">What would have been sent (mock)</h2>
        <ul className="mt-2 space-y-1 text-xs text-gray-700">{log.map(entry => <li key={entry.id}><span className="tabular-nums text-gray-500">{entry.at.toLocaleTimeString()}</span> · {entry.text}</li>)}</ul></section>}

      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2">
        {pending.map(item => <div key={item.id} className="pointer-events-auto flex items-center justify-between gap-3 rounded-lg bg-gray-900 px-4 py-3 text-sm text-white shadow-lg">
          <span className="min-w-0"><span className="block truncate">{item.label}</span><span className="mt-1 block h-1 overflow-hidden rounded bg-white/20"><span className="block h-full animate-[shrink_5s_linear_forwards] bg-white" /></span></span>
          <span className="flex shrink-0 gap-2"><button type="button" className="font-semibold text-brand-200 hover:text-white" onClick={() => undo(item.id)}>Undo<Kbd>u</Kbd></button>
            <button type="button" className="text-white/70 hover:text-white" onClick={() => commit(item.id)}>Send now</button></span></div>)}
      </div>
      <style>{'@keyframes shrink { from { width: 100% } to { width: 0% } }'}</style>

      {dialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 px-4" role="dialog" aria-modal="true">
        <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
          <h2 className="text-lg font-semibold">{dialog.title}</h2>
          <ul className="mt-3 space-y-1 text-sm text-gray-700">{dialog.body.map((line, index) => <li key={index}>{line}</li>)}</ul>
          <div className="mt-5 flex flex-row-reverse gap-2"><button type="button" className={dialog.danger ? 'rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700' : primary} onClick={dialog.onConfirm}>{dialog.confirm}<Kbd>Enter</Kbd></button>
            <button type="button" className={btn} onClick={() => setDialog(null)}>Cancel<Kbd>Esc</Kbd></button></div></div></div>}

      {help && <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 px-4" onClick={() => setHelp(false)}>
        <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={event => event.stopPropagation()}>
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-y-1.5 text-sm">{[['j / k', 'Next / previous record'], ['Enter, a', 'Accept suggestion'], ['1–9', 'Pick candidate'], ['l', 'Link picked candidate'], ['n', 'Create new in Albi'],
            ['s', 'Skip (Conflicts only)'], ['r', 'Recheck record'], ['x', 'Tick for bulk'], ['t', 'Albi to-do'], ['u', 'Undo last action'], ['?', 'This help']].map(([key, text]) => <Fragment key={key}><dt className="font-mono text-gray-700">{key}</dt><dd className="text-gray-700">{text}</dd></Fragment>)}</dl></div></div>}
    </div>
  )
}

function diffRows(record, candidate) {
  return FIELDS.filter(([key]) => record.objectType === 'companies' ? !['firstName', 'lastName'].includes(key) : key !== 'name').map(([key, label]) => {
    const hubspot = String(record.source[key] ?? '').trim()
    const albi = String(candidate?.[key] ?? '').trim()
    if (!hubspot && !albi) return null
    const kind = !candidate ? 'hubspot_only' : norm(key, hubspot) === norm(key, albi) ? 'same' : !hubspot || !albi ? 'one_side' : 'differs'
    return { key, label, hubspot, albi, kind }
  }).filter(Boolean).sort((a, b) => ['differs', 'one_side', 'hubspot_only', 'same'].indexOf(a.kind) - ['differs', 'one_side', 'hubspot_only', 'same'].indexOf(b.kind))
}

function Record({ record, kind, candidates, candidateIndex, setCandidateIndex, top, pending, referral, showMatching, setShowMatching, fieldChoices, setFieldChoices, onLink, onCreate, onSkip, onRecheck, onApplyFields }) {
  const candidate = candidates[candidateIndex] ?? null
  const rows = diffRows(record, candidate)
  const visible = rows.filter(row => row.kind !== 'same')
  const matching = rows.filter(row => row.kind === 'same')
  const differing = rows.filter(row => row.kind === 'differs')
  const done = record.status === 'done'
  const disabled = pending || done
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-5 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{record.name}</h2>
          <p className="text-sm text-gray-700">{record.reason}{record.org ? <> · <span className="text-gray-500">HubSpot org:</span> {record.org}</> : null}</p>
        </div>
        <div className="text-right text-xs text-gray-500"><a className="font-semibold text-brand-700 underline" href="#hubspot">Open in HubSpot</a>{candidate && <> · <a className="font-semibold text-brand-700 underline" href="#albi">Open in Albi</a></>}
          <p className="mt-1">HubSpot ID {record.hubspotId} · last recheck 2h ago</p></div>
      </header>

      <div className="space-y-4 px-5 py-4">
        {done && <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{record.outcome}</p>}
        {record.mergedInto && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"><p className="font-semibold text-amber-950">Merged in HubSpot into contact {record.mergedInto}</p>
          <p className="mt-1 text-xs text-amber-900">This record is out of date. Review the surviving record instead.</p><button type="button" className={`${btn} mt-2`}>Review the surviving record</button></div>}
        {record.blocked && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"><p className="font-semibold">Can’t create yet: salesperson not found</p><p className="mt-1 text-xs">{BLOCKED_COPY[record.blocked]}</p></div>}
        {record.status === 'waiting' && <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-sm"><p className="font-semibold text-amber-950">Update this contact in Albi</p>
          <ul className="mt-1 text-amber-900">{record.albiTasks.map(task => <li key={task.field}>{task.field}: {task.value}</li>)}</ul><p className="mt-1 text-xs text-amber-900">Also listed in Albi to-do (t).</p></div>}

        {candidates.length > 0 && <section>
          <h3 className="text-sm font-semibold">Albi candidates <span className="font-normal text-gray-500">· ranked</span></h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">{candidates.map((option, index) => {
            const level = strength(option)
            return <button key={option.id} type="button" onClick={() => setCandidateIndex(index)}
              className={`rounded-lg border p-3 text-left ${index === candidateIndex ? 'border-brand-500 ring-2 ring-brand-500/30' : 'border-gray-200 hover:border-brand-300'}`}>
              <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{index + 1}. {option.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[0.68rem] font-semibold ${level === 'Strong' ? 'bg-green-100 text-green-800' : level === 'Likely' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'}`}>{level}{top?.id === option.id ? ' · suggested' : ''}</span></span>
              <span className="mt-1 block truncate text-xs text-gray-600">{[option.email, option.phone, option.organization].filter(Boolean).join(' · ') || 'Few details in Albi'} · Albi {option.id}</span>
              <span className="mt-2 flex flex-wrap gap-1">{option.reasons.map(reason => <span key={reason} className="rounded bg-gray-100 px-1.5 py-0.5 text-[0.68rem] font-medium text-gray-700">{REASON_LABEL[reason]}</span>)}
                {option.warnings.map(warning => <span key={warning} className="rounded bg-red-50 px-1.5 py-0.5 text-[0.68rem] font-medium text-red-700">{WARNING_LABEL[warning]}</span>)}</span>
            </button>
          })}</div></section>}

        <section>
          <h3 className="text-sm font-semibold">{candidate ? `What differs from Albi ${candidate.id}` : 'HubSpot values (no Albi match)'}</h3>
          {visible.length === 0 && <p className="mt-1 text-sm text-gray-600">Nothing differs. Every shared field matches.</p>}
          {visible.length > 0 && <table className="mt-2 w-full table-fixed text-sm"><thead><tr className="text-left text-xs text-gray-500"><th className="w-28 pb-1 font-medium">Field</th><th className="pb-1 font-medium">HubSpot</th>{candidate && <th className="pb-1 font-medium">Albi</th>}{record.fieldMode && <th className="w-44 pb-1 font-medium">Keep</th>}</tr></thead>
            <tbody>{visible.map(row => <tr key={row.key} className={`border-t border-gray-100 ${row.kind === 'differs' ? 'bg-amber-50/60' : ''}`}>
              <td className="py-1.5 pr-2 text-xs font-medium text-gray-600">{row.label}</td><td className="break-words py-1.5 pr-2">{row.hubspot || <span className="text-gray-400">Blank</span>}</td>
              {candidate && <td className="break-words py-1.5 pr-2">{row.albi || <span className="text-gray-400">Blank</span>}</td>}
              {record.fieldMode && <td className="py-1.5">{row.kind === 'differs' && <span className="flex gap-1">{[['hubspot', 'HubSpot'], ['albi', 'Albi']].map(([value, text]) =>
                <button key={value} type="button" disabled={disabled} onClick={() => setFieldChoices(current => ({ ...current, [row.key]: value }))}
                  className={`rounded border px-2 py-0.5 text-xs font-semibold ${fieldChoices[row.key] === value ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-gray-300 text-gray-700'}`}>{text}</button>)}</span>}</td>}
            </tr>)}</tbody></table>}
          {matching.length > 0 && <button type="button" onClick={() => setShowMatching(value => !value)} className="mt-2 text-xs font-semibold text-brand-700 underline">{showMatching ? 'Hide' : 'Show'} {matching.length} matching field{matching.length === 1 ? '' : 's'}</button>}
          {showMatching && <p className="mt-1 text-xs text-gray-600">{matching.map(row => `${row.label}: ${row.hubspot}`).join(' · ')}</p>}
        </section>
      </div>

      {!done && <footer className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
        {record.fieldMode ? <>
          <button type="button" className={btn} disabled={disabled} onClick={() => setFieldChoices(Object.fromEntries(differing.map(row => [row.key, 'hubspot'])))}>All HubSpot</button>
          <button type="button" className={btn} disabled={disabled} onClick={() => setFieldChoices(Object.fromEntries(differing.map(row => [row.key, 'albi'])))}>All Albi</button>
          <button type="button" className={primary} disabled={disabled || differing.some(row => !fieldChoices[row.key])} onClick={onApplyFields}>Apply field choices</button>
        </> : <>
          {top && <button type="button" className={primary} disabled={disabled || record.blocked} onClick={() => onLink(top, { emailMatch: top.reasons.includes('same_email') })}>Accept suggestion{top.reasons.includes('same_email') ? ' (emails match)' : ''}<Kbd>Enter</Kbd></button>}
          {candidate && (!top || candidate.id !== top.id) && <button type="button" className={top ? btn : primary} disabled={disabled} onClick={() => onLink(candidate)}>Link {candidate.name}<Kbd>l</Kbd></button>}
          {!record.mergedInto && !record.blocked && <button type="button" className={candidates.length || top ? btn : primary} disabled={disabled} onClick={onCreate}>
            {record.orgFirst ? `Create organization + contact (${referral})` : candidates.length ? 'Add new in Albi instead' : `Create in Albi (${referral})`}<Kbd>n</Kbd></button>}
          {kind === 'live' && <button type="button" className={btn} disabled={disabled} onClick={onSkip}>Skip<Kbd>s</Kbd></button>}
        </>}
        <button type="button" className={`${btn} ml-auto`} onClick={onRecheck}>Recheck<Kbd>r</Kbd></button>
      </footer>}
    </section>
  )
}

function AlbiTodo({ records, done, setDone, onRecheck, busy }) {
  const ticked = records.filter(record => done.has(record.id)).length
  return (
    <section className="mt-4 rounded-xl border border-gray-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-3">
        <div><h2 className="text-lg font-semibold">Albi to-do</h2><p className="text-xs text-gray-600">Albi’s API can’t edit existing records. Make these edits in Albi, tick them, then recheck once.</p></div>
        <button type="button" className={primary} disabled={!ticked || busy} onClick={onRecheck}>Recheck done ({ticked})</button>
      </header>
      {records.length === 0 ? <p className="px-5 py-8 text-sm text-gray-600">No Albi edits waiting.</p> : <ul className="divide-y divide-gray-100">{records.map(record =>
        <li key={record.id} className={`flex gap-3 px-5 py-3 ${done.has(record.id) ? 'bg-green-50/50' : ''}`}>
          <input type="checkbox" className="mt-1" checked={done.has(record.id)} aria-label={`Done in Albi: ${record.name}`}
            onChange={() => setDone(current => { const next = new Set(current); next.has(record.id) ? next.delete(record.id) : next.add(record.id); return next })} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{record.name} <span className="font-normal text-gray-500">· Albi {record.candidates[0]?.id}</span> <a href="#albi" className="ml-2 text-xs font-semibold text-brand-700 underline">Open in Albi</a></p>
            <ul className="mt-1 space-y-1">{record.albiTasks.map(task => <li key={task.field} className="flex flex-wrap items-center gap-2 text-sm"><span className="text-gray-600">Set {task.field} to</span><span className="font-medium">{task.value}</span>
              <button type="button" onClick={() => copy(task.value)} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Copy</button></li>)}</ul>
          </div></li>)}</ul>}
    </section>
  )
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
