import { SOURCE_FIELDS } from './sampleReview.js'

export const REASON_LABELS = Object.freeze({
  same_email: 'Same email', same_other_email: 'Same other email', same_phone: 'Same phone', phone_matches_mobile: 'Phone matches mobile',
  same_name: 'Same name', same_first_name: 'Same first name only', same_organization: 'Same organization', same_domain: 'Same domain', same_address: 'Same address',
})
export const WARNING_LABELS = Object.freeze({ different_email: 'Different email', already_linked_elsewhere: 'Already linked to another HubSpot record' })
export const BUCKETS = Object.freeze([['quick', 'Quick wins'], ['decision', 'Needs decision'], ['blocked', 'Blocked'], ['todo', 'Albi to-do'], ['outbox', 'Outbox'], ['done', 'Done']])

const PHONE_KEYS = new Set(['phoneNumber', 'mobileNumber'])
const LOWER_KEYS = new Set(['email', 'domain'])
const KIND_ORDER = { differs: 0, one_side: 1, hubspot_only: 2, same: 3 }

function trimmed(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}
function normalize(key, value) {
  const text = trimmed(value)
  if (!text) return ''
  if (PHONE_KEYS.has(key)) return text.replace(/\D/g, '').slice(-10)
  if (LOWER_KEYS.has(key)) return text.toLowerCase()
  return text.toLowerCase().replace(/\s+/g, ' ')
}

export function fieldDiffRows({ objectType, source, candidate }) {
  const hs = source ?? {}
  const albi = candidate ?? {}
  const omitted = objectType === 'organization' ? new Set(['firstName', 'lastName']) : new Set(['name'])
  const out = []
  for (const [key, label] of SOURCE_FIELDS) {
    if (omitted.has(key)) continue
    const hubspot = trimmed(hs[key])
    const albiValue = trimmed(albi[key])
    if (!hubspot && !albiValue) continue
    let kind
    if (candidate == null) kind = 'hubspot_only'
    else if (!hubspot || !albiValue) kind = 'one_side'
    else kind = normalize(key, hubspot) === normalize(key, albiValue) ? 'same' : 'differs'
    out.push({ key, label, hubspot, albi: albiValue, kind })
  }
  return out.map((row, index) => ({ row, index }))
    .sort((a, b) => KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] || a.index - b.index).map(({ row }) => row)
}

export function nextRecordId(order, currentId, excluded) {
  const ids = Array.isArray(order) ? order : []
  const skip = excluded ?? new Set()
  const start = ids.indexOf(currentId)
  for (let step = 1; step <= ids.length; step += 1) {
    const id = ids[(start + step + ids.length) % ids.length]
    if (id !== currentId && !skip.has(id)) return id
  }
  return null
}

export function createDeferredQueue({ delayMs = 5000, send, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const entries = new Map()
  const inflight = new Map()
  const snapshot = () => [...entries.values()].map(entry => entry.item).concat([...inflight.values()].map(entry => ({ ...entry.item, sending: true })))
  const notify = extra => { try { if (onChange) onChange(snapshot(), extra) } catch { /* a faulty listener must not break the queue */ } }

  async function dispatch(entry) {
    try { await send(entry.item) } catch (error) {
      try { if (typeof entry.item.onError === 'function') entry.item.onError(error) } catch { /* a throwing handler must not stop the error being reported through onChange below */ }
      notify({ error, item: entry.item })
    }
  }
  function take(id) {
    const entry = entries.get(id)
    if (!entry) return null
    clearTimer(entry.timer)
    entries.delete(id)
    return entry
  }
  async function sendNow(id) {
    const entry = take(id)
    if (!entry) return inflight.get(id)?.promise
    entry.promise = dispatch(entry).finally(() => { if (inflight.get(id) === entry) inflight.delete(id); notify() })
    inflight.set(id, entry)
    notify()
    return entry.promise
  }
  return {
    enqueue(item) {
      if (entries.has(item.id) || inflight.has(item.id)) return false
      const entry = { item, timer: null }
      entry.timer = setTimer(() => { sendNow(item.id).catch(() => {}) }, delayMs)
      entries.set(item.id, entry)
      notify()
      return true
    },
    // Returns the removed item; null if unknown; `{ ...item, sending: true }` if already in flight (too late to undo; the write is happening).
    undo(id) {
      if (id !== undefined && !entries.has(id) && inflight.has(id)) return { ...inflight.get(id).item, sending: true }
      const target = id ?? [...entries.keys()].at(-1)
      const entry = target === undefined ? null : take(target)
      if (!entry) return null
      notify()
      return entry.item
    },
    sendNow,
    async flushAll() {
      await Promise.all([...entries.keys()].map(sendNow))
      await Promise.all([...inflight.values()].map(entry => entry.promise))
    },
    pending: snapshot,
  }
}

const PICK_KEYS = /^[1-9]$/
const SIMPLE = { j: 'next', ArrowDown: 'next', k: 'prev', ArrowUp: 'prev', Enter: 'accept', a: 'accept', l: 'link', n: 'create',
  s: 'skip', r: 'recheck', x: 'toggle', t: 'todo', u: 'undo', '?': 'help', Escape: 'escape' }

function inside(target, selector) {
  return !!target && typeof target.closest === 'function' && !!target.closest(selector)
}

export function shortcutFor(event, { kind, dialogOpen } = {}) {
  if (!event || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return null
  const { key, target } = event
  if (inside(target, 'input, select, textarea')) return null
  if ((key === 'Enter' || key === ' ') && inside(target, 'button, a')) return null
  if (dialogOpen) return key === 'Enter' ? 'dialogConfirm' : key === 'Escape' ? 'dialogCancel' : null
  if (PICK_KEYS.test(key)) return { pick: Number(key) }
  const action = Object.hasOwn(SIMPLE, key) ? SIMPLE[key] : null
  if (action === 'skip' && kind !== 'live') return null
  return action
}

// Plain labels for field names shown in confirmations.
const FIELD_LABELS = Object.freeze({ firstName: 'First name', lastName: 'Last name', email: 'Email', phoneNumber: 'Phone',
  mobileNumber: 'Mobile', jobTitle: 'Job title', address1: 'Address', address2: 'Address line 2', city: 'City',
  state: 'State / region', zipcode: 'Postal code', country: 'Country', name: 'Name', domain: 'Domain' })
export const fieldLabel = field => Object.hasOwn(FIELD_LABELS, field) ? FIELD_LABELS[field] : field
