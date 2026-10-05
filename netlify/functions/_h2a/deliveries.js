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
  if (row.state === 'failed') {
    const retryAt = Date.parse(row.next_attempt_at)
    if (row.next_attempt_at && Number.isFinite(retryAt) && retryAt > Date.parse(now)) return 'retry_scheduled'
    if (!row.next_attempt_at || !Number.isFinite(retryAt)) return 'failed'
  }
  return 'in_progress'
}

function versionOf(row) {
  const value = Number(row.attempt_count)
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
    if (nativeExternalIdSupported && record.source === 'hubspot' && String(record.sourceId ?? '') === expectedId) return true
    const notes = String(record.notes ?? record.description ?? '')
    return notes.split(/\r?\n/u).some(line => line.trim() === marker)
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
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new TypeError('A valid reservation time is required')
  const staleAfterMs = Number.isInteger(input.staleAfterMs) ? Math.min(60 * 60_000, Math.max(30_000, input.staleAfterMs)) : 5 * 60_000
  const staleBefore = new Date(nowMs - staleAfterMs).toISOString()
  const sourceMarker = makeSourceMarker({ objectType: SINGULAR_TYPES[identity.objectType], activityId: identity.activityId })
  const reservationResult = await input.store.reserve({
    identity,
    key: identity.key,
    source_marker: sourceMarker,
    now,
    staleBefore,
    retryEligibleAt: now,
    // The store atomically inserts or reclaims an eligible row and increments attempt_count.
    // That persisted generation is the fencing token used by conditional transitions.
  })
  if (!reservationResult?.row) throw new TypeError('Delivery store returned no reservation row')
  const row = reservationResult.row
  if (!reservationResult.acquired) {
    return { disposition: dispositionForExisting(row, now), identity, sourceMarker, id: row.id, delivery: row }
  }
  if (typeof reservationResult.isNew !== 'boolean') throw new TypeError('Delivery store must identify new versus reclaimed reservations')
  const previous = reservationResult.previous
  if (!reservationResult.isNew) {
    if (!previous || typeof previous !== 'object') throw new TypeError('Reclaimed reservations must include their prior eligibility state')
    const retryWasDue = previous.state === 'failed' && previous.next_attempt_at &&
      Number.isFinite(Date.parse(previous.next_attempt_at)) && Date.parse(previous.next_attempt_at) <= nowMs
    const reservedWasStale = previous.state === 'reserved' &&
      (previous.last_attempt_at == null || (Number.isFinite(Date.parse(previous.last_attempt_at)) &&
        Date.parse(previous.last_attempt_at) <= Date.parse(staleBefore)))
    if (!retryWasDue && !reservedWasStale) throw new TypeError('Delivery store reclaimed an ineligible attempt')
  }
  const version = versionOf(row)
  const reservation = {
    disposition: 'reserved', identity, sourceMarker, id: row.id, delivery: row,
    attemptToken: String(version), version, attemptCount: version,
    safeToCreate: reservationResult.isNew, reconciledBeforeCreate: false,
    previousState: previous?.state ?? null,
  }
  const requiresReconciliation = !reservationResult.isNew
  if (!requiresReconciliation) return { ...reservation, safeToCreate: true }
  if (!input.albi || typeof input.albi.listActivities !== 'function') {
    throw new TypeError('Reclaimed delivery attempts require Albi reconciliation before create')
  }
  const reconciled = await reconcileDelivery({
    reservation, store: input.store, albi: input.albi,
    nativeExternalIdSupported: input.nativeExternalIdSupported === true,
    query: input.reconcileQuery, now: input.now,
    maxPages: input.maxReconcilePages,
  })
  if (reconciled.disposition !== 'not_found') return reconciled
  return { ...reservation, safeToCreate: true, reconciledBeforeCreate: true }
}

export async function reconcileDelivery(input = {}) {
  const { reservation, store, albi } = input
  if (!reservation || reservation.disposition !== 'reserved' || !store || !albi || typeof albi.listActivities !== 'function') {
    throw new TypeError('An active reservation, store, and Albi activity reader are required')
  }
  const query = input.query ?? {}
  const targetKey = reservation.identity.albiTargetType === 'contact' ? 'contactId' : 'organizationId'
  const maxPages = Number.isInteger(input.maxPages) ? Math.min(50, Math.max(1, input.maxPages)) : 25
  const seen = new Set()
  let page = 1
  let match = null
  for (let count = 0; count < maxPages; count++) {
    if (seen.has(String(page))) throw new Error('Albi reconciliation pagination repeated a page')
    seen.add(String(page))
    const response = await albi.listActivities({ ...query, [targetKey]: reservation.identity.albiTargetId, page })
    if (!response || !Array.isArray(response.records)) throw new Error('Albi reconciliation returned an invalid page')
    match = matchingActivity(response.records, reservation, input.nativeExternalIdSupported === true)
    if (match) break
    if (response.cursor == null) break
    const nextPage = String(response.cursor)
    if (!/^[1-9]\d*$/u.test(nextPage) || Number(nextPage) <= Number(page)) throw new Error('Albi reconciliation returned an invalid cursor')
    if (count === maxPages - 1) throw new Error('Albi reconciliation page limit exceeded')
    page = nextPage
  }
  if (!match) return { disposition: 'not_found', delivery: reservation.delivery }
  const deliveredAt = typeof input.now === 'function' ? input.now() : (input.now ?? new Date().toISOString())
  return conditionalTransition({ reservation, store, state: 'reconciled', patch: {
    albi_activity_id: String(match.id), delivered_at: deliveredAt,
    next_attempt_at: null, last_error_summary: null,
  } })
}

export async function completeDelivery(input = {}) {
  const { reservation, store } = input
  if (!reservation || reservation.disposition !== 'reserved' || !store || typeof store.transition !== 'function') {
    throw new TypeError('An active reservation and delivery store are required')
  }
  if (reservation.safeToCreate !== true) throw new TypeError('Delivery must be reconciled before create or completion')
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
