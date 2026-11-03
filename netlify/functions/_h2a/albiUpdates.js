import { ApiError } from './http.js'
import { normalizePhone } from './normalize.js'

// Turning a resolution's Albi tasks (HubSpot's value wins over Albi's) into Albi partial updates.
// Each field maps from the review's name to Albi's update field. A field with no Albi update field (a contact's
// mobile number, an organization's website) stays a manual task.
const UPDATE_FIELDS = Object.freeze({
  contacts: { firstName: 'firstName', lastName: 'lastName', email: 'email', phoneNumber: 'phoneNumber', jobTitle: 'jobTitle',
    organizationId: 'organizationId', address1: 'address1', address2: 'address2', city: 'city', state: 'state', zipcode: 'zipCode', country: 'country' },
  companies: { name: 'name', phoneNumber: 'phoneNumber', address1: 'address1', address2: 'address2', city: 'city', state: 'state',
    zipcode: 'zipCode', country: 'country' },
})
const OPERATION = Object.freeze({ contacts: 'updateContact', companies: 'updateOrganization' })
const text = value => typeof value === 'string' ? value.trim() : ''

// The value Albi accepts for one field, or null when it cannot be sent (a blank never clears an Albi field, and a
// phone Albi cannot store as a 10-digit number stays a manual task). A phone with an extension sends the main number.
function sendable(field, value) {
  const raw = text(value)
  if (!raw) return null
  if (field !== 'phoneNumber') return raw
  const phone = normalizePhone(raw)
  if (phone.writable) return phone.writable
  if (phone.conflictReason === 'extension_not_supported' && /^\d{10}$/.test(phone.comparable ?? '')) {
    return `${phone.comparable.slice(0, 3)}-${phone.comparable.slice(3, 6)}-${phone.comparable.slice(6)}`
  }
  return null
}

// Splits one task into the Albi update to send and the fields left for a manual edit.
export function planAlbiUpdate(task) {
  const fields = UPDATE_FIELDS[task?.objectType]
  const payload = {}, manual = []
  for (const item of Array.isArray(task?.fields) ? task.fields : []) {
    const albiField = fields?.[item?.field]
    const value = albiField ? sendable(item.field, item.value) : null
    if (value === null) manual.push(item)
    else payload[albiField] = value
  }
  return { operation: OPERATION[task?.objectType] ?? null, payload, manual }
}

// A failure kept for the record: category, code and HTTP status, plus the sanitized reason and missing scope.
function failureOf(error) {
  if (!(error instanceof ApiError)) return { category: 'unexpected', code: 'error' }
  return Object.fromEntries(Object.entries({ category: error.category, code: error.code, status: error.status,
    providerReason: error.providerReason, requiredScope: error.requiredScope }).filter(([, value]) => value !== null && value !== undefined))
}

// Sends each task's update. Returns what was sent, the tasks (or fields) still needing a manual Albi edit, and the
// first failure. A task Albi refused stays whole, so it can be sent again; it never fails the resolution around it.
export async function applyAlbiTasks(albiWrite, tasks, call = run => run()) {
  const applied = [], remaining = []
  let failure = null
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const { operation, payload, manual } = planAlbiUpdate(task)
    const method = operation && albiWrite?.[operation]
    if (!Object.keys(payload).length || typeof method !== 'function') { remaining.push(task); continue }
    try {
      await call(() => method(task.targetId, payload))
      applied.push({ objectType: task.objectType, targetId: task.targetId, fields: task.fields.filter(item => !manual.includes(item)).map(item => item.field) })
      if (manual.length) remaining.push({ ...task, fields: manual })
    } catch (error) {
      failure ??= failureOf(error)
      remaining.push(task)
    }
  }
  return { applied, remaining, failure }
}
