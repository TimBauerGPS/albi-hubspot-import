import { makeDeliveryKey, makeSourceMarker } from './keys.js'

const SINGULAR_TYPES = Object.freeze({ meetings: 'meeting', calls: 'call', emails: 'email', communications: 'communication', notes: 'note' })
const retryableCategories = new Set(['transient', 'rate_limit'])
const asText = value => typeof value === 'string' ? value.trim() : ''

function normalizeIdentity(identity) {
  // makeDeliveryKey applies the shared six-field validation and canonical order.
  const key = makeDeliveryKey(identity)
  if (!SINGULAR_TYPES[identity.objectType]) throw new TypeError('Unsupported HubSpot activity object type')
  return { key, ...identity }
}

function dispositionForExisting(row, now) {
  if (row.state === 'delivered') return 'delivered'
  if (row.state === 'reconciled') return 'reconciled'
  if (row.state === 'failed' && row.next_attempt_at && Date.parse(row.next_attempt_at) > Date.parse(now)) return 'retry_scheduled'
  return 'in_progress'
}

function versionOf(row) {
  const value = Number(row.version ?? row.attempt_count)
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Delivery reservation is missing a fencing version')
  return value
}

function safeSummary(error) {
  const clean = value => asText(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60)
  const code = clean(error?.code)
  const category = clean(error?.category)
  return [category, code].filter(Boolean).join(':').slice(0, 120) || 'provider_error'
}

function matchingActivity(records, reservation, nativeExternalIdSupported) {
  const expectedId = reservation.identity.activityId
  const marker = reservation.sourceMarker
  return (Array.isArray(records) ? records : []).find(record => {
    if (!record || typeof record !== 'object') return false
    if (nativeExternalIdSupported && String(record.sourceId ?? '') === expectedId) return true
    const notes = String(record.notes ?? record.description ?? '')
    return notes.includes(marker)
  }) ?? null
}

async function conditionalTransition({ reservation, store, state, patch = {} }) {
  const changed = await store.transition({
    id: reservation.id,
    expectedVersion: reservation.version,
    attemptToken: reservation.attemptToken,
    patch: { state, ...patch },
  })
  if (!changed?.updated) return { disposition: 'stale_attempt', delivery: changed?.row ?? null }
  return { disposition: state, delivery: changed.row }
}

export async function reserveDelivery(input = {}) {
  if (!input.store || typeof input.store.reserve !== 'function') throw new TypeError('A delivery store is required')
  const identity = normalizeIdentity(input.identity ?? input)
  const now = typeof input.now === 'function' ? input.now() : (input.now ?? new Date().toISOString())
  const sourceMarker = makeSourceMarker({ objectType: SINGULAR_TYPES[identity.objectType], activityId: identity.activityId })
  const attemptToken = typeof input.createAttemptToken === 'function' ? input.createAttemptToken() : null
  const reservationResult = await input.store.reserve({
    identity,
    key: identity.key,
    source_marker: sourceMarker,
    attemptToken,
    now,
    // Persistence uses attempt_count as a monotonically increasing CAS version;
    // transitions must compare it with state='reserved' after the HTTP call.
  })
  if (!reservationResult?.row) throw new TypeError('Delivery store returned no reservation row')
  const row = reservationResult.row
  if (!reservationResult.acquired) {
    return { disposition: dispositionForExisting(row, now), identity, sourceMarker, id: row.id, delivery: row }
  }
  const reservation = {
    disposition: 'reserved', identity, sourceMarker, id: row.id, delivery: row,
    attemptToken, version: versionOf(row), attemptCount: Number(row.attempt_count ?? row.version),
  }
  return reservation
}

export async function reconcileDelivery(input = {}) {
  const { reservation, store, albi } = input
  if (!reservation || reservation.disposition !== 'reserved' || !store || !albi || typeof albi.listActivities !== 'function') {
    throw new TypeError('An active reservation, store, and Albi activity reader are required')
  }
  const query = input.query ?? {}
  const targetKey = reservation.identity.albiTargetType === 'contact' ? 'contactId' : 'organizationId'
  const response = await albi.listActivities({ ...query, [targetKey]: reservation.identity.albiTargetId })
  const match = matchingActivity(response?.records, reservation, input.nativeExternalIdSupported === true)
  if (!match) return { disposition: 'not_found', delivery: reservation.delivery }
  return conditionalTransition({ reservation, store, state: 'reconciled', patch: {
    albi_activity_id: String(match.id), delivered_at: input.now?.() ?? new Date().toISOString(),
    next_attempt_at: null, last_error_summary: null,
  } })
}

export async function completeDelivery(input = {}) {
  const { reservation, store } = input
  if (!reservation || reservation.disposition !== 'reserved' || !store || typeof store.transition !== 'function') {
    throw new TypeError('An active reservation and delivery store are required')
  }
  const now = typeof input.now === 'function' ? input.now() : (input.now ?? new Date().toISOString())
  if (!input.error) {
    const activityId = input.result?.id === undefined || input.result?.id === null ? '' : String(input.result.id)
    if (!activityId) throw new TypeError('Successful activity creation must return an ID')
    return conditionalTransition({ reservation, store, state: 'delivered', patch: {
      albi_activity_id: activityId, delivered_at: now, next_attempt_at: null, last_error_summary: null,
    } })
  }

  const error = input.error
  if (retryableCategories.has(error.category) && input.albi) {
    try {
      const reconciled = await reconcileDelivery({
        reservation, store, albi: input.albi,
        nativeExternalIdSupported: input.nativeExternalIdSupported === true,
        query: input.reconcileQuery,
        now: input.now,
      })
      if (reconciled.disposition !== 'not_found') return reconciled
    } catch {
      // A failed reconciliation is still uncertain. Preserve the retry path; never issue a create here.
    }
  }

  const retryable = retryableCategories.has(error.category)
  const retryNumber = Math.max(1, Number(reservation.attemptCount) || 1)
  const delayMs = Math.min(30 * 60_000, 30_000 * (2 ** Math.min(6, retryNumber - 1)))
  const nextAttemptAt = retryable
    ? (typeof input.retryAt === 'function' ? input.retryAt(error) : new Date(Date.parse(now) + delayMs).toISOString())
    : null
  const transition = await conditionalTransition({ reservation, store, state: 'failed', patch: {
    last_error_summary: safeSummary(error), next_attempt_at: nextAttemptAt,
  } })
  if (transition.disposition === 'stale_attempt') return transition
  return { ...transition, disposition: retryable ? 'retry_scheduled' : 'failed' }
}
