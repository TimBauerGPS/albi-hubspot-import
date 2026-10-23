import { randomUUID } from 'node:crypto'
import { getH2AReviewRowActions } from '../../../shared/h2aReviewReasons.js'
import { executeReviewResolution } from './reviewResolutionService.js'
import { H2AReviewError } from './reviewService.js'

// "Create selected": a background batch that creates many reviewed records in Albi, each with its own default
// referral source (its Albi organization's, else its salesperson's) or with one referral source for all.
// Albi is read once; every record is still checked against that read (which grows with each record created, so
// two HubSpot records for the same person cannot both be created) by the normal audited create.
export const MAX_CREATE_BATCH_ITEMS = 50
const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const clock = deps => (deps.clockMs ?? Date.now)()

export async function listAll(read) {
  const records = [], seen = new Set()
  let cursor = '1'
  for (let page = 0; page < 1000; page++) {
    if (seen.has(cursor)) throw new Error('pagination_loop')
    seen.add(cursor)
    const next = await read({ cursor, pageSize: 100 })
    if (!next || !Array.isArray(next.records)) throw new Error('malformed_response')
    records.push(...next.records)
    if (next.cursor === null) return records
    if (!providerId(next.cursor) || Number(next.cursor) <= Number(cursor)) throw new Error('pagination_loop')
    cursor = next.cursor
  }
  throw new Error('pagination_loop')
}

// Why a selected row is not a plain create any more (no candidates, open or cleared as safe to create,
// unchanged since it was selected), or null when it still is.
function notCreatable(row, expectedUpdatedAt) {
  if (!row) return 'not_found'
  if (row.updated_at !== expectedUpdatedAt) return 'changed'
  if (!Array.isArray(row.candidate_snapshots) || row.candidate_snapshots.length) return 'has_candidates'
  if (!(row.status === 'needs_review' || row.status === 'cleared' && row.recheck_outcome === 'safe_to_create')) return 'not_open'
  return getH2AReviewRowActions(row).includes('create_albi') ? null : 'not_creatable'
}
const creatable = (row, expectedUpdatedAt) => notCreatable(row, expectedUpdatedAt) === null

export async function runReviewCreateBatch(deps, { companyId, batchId }) {
  const { repository, batchRepository } = deps
  const batch = await batchRepository.claimReviewCreateBatch(companyId, batchId)
  if (!batch) return { status: 'not_claimed' }
  const items = Array.isArray(batch.items) ? batch.items.slice(0, MAX_CREATE_BATCH_ITEMS) : []
  const counts = { total: items.length, done: 0, created: 0, skipped: 0, failed: 0 }
  // Per record: what happened and, when not created, the named reason (shown by the page).
  const results = []
  const finish = async (status, errorCode = null) => {
    await batchRepository.finishReviewCreateBatch(companyId, batchId, { status, errorCode, counts: { ...counts }, results: [...results] })
    return { status, errorCode, counts: { ...counts } }
  }
  const deadline = clock(deps) + Math.min(13 * 60000, Math.max(1, deps.batchDeadlineMs ?? 13 * 60000))
  const execute = deps.executeResolution ?? executeReviewResolution
  let rows, clients, snapshot
  try {
    const config = await repository.getConfig(companyId)
    rows = []
    for (const item of items) rows.push({ item, row: await repository.getReview(companyId, item.reviewId) })
    await batchRepository.updateReviewCreateBatch(companyId, batchId, { counts: { ...counts } })
    clients = await deps.getResolutionClients(companyId, config)
    const ready = rows.filter(entry => creatable(entry.row, entry.item.expectedUpdatedAt))
    snapshot = {
      contacts: ready.some(entry => entry.row.object_type === 'contacts') ? await listAll(args => clients.albiRead.listContacts(args)) : [],
      // Contact creates use the reviewed organization mapping, so organizations are read only for organization creates.
      organizations: ready.some(entry => entry.row.object_type === 'companies') ? await listAll(args => clients.albiRead.listOrganizations(args)) : [],
    }
  } catch {
    return finish('failed', 'operation_failed')
  }
  // Organizations first, so a contact whose organization is created in this batch can be created against it.
  const ordered = [...rows.filter(entry => entry.row?.object_type === 'companies'), ...rows.filter(entry => entry.row?.object_type !== 'companies')]
  const rowDeps = { ...deps, albiSnapshot: snapshot, getResolutionClients: async () => clients }
  // Readiness reads HubSpot and our mappings (never the Albi lists), so it sees an organization created earlier in this batch.
  if (!deps.checkReadiness && deps.loadReadiness) deps = { ...deps, checkReadiness: row => deps.loadReadiness(row, clients) }
  for (const { item, row } of ordered) {
    if (clock(deps) >= deadline) return finish('failed', 'timeout')
    const record = (outcome, reason) => { results.push({ reviewId: item.reviewId, outcome, ...(reason ? { reason } : {}) }); counts[outcome]++ }
    const reason = notCreatable(row, item.expectedUpdatedAt)
    if (reason) record('skipped', reason)
    else {
      // The same checks the record shows (organization linked, owner, type, status), so a skip names its reason.
      let readiness = null
      try { readiness = deps.checkReadiness ? await deps.checkReadiness(row) : { ready: true } } catch { readiness = { ready: false, blockedReason: 'evidence_unavailable' } }
      // Each record's default comes from the same readiness the record shows; the batch's source is the fallback.
      const referralSourceId = batch.use_record_defaults === true
        ? (providerId(readiness?.defaultReferralSourceId) ? readiness.defaultReferralSourceId : batch.referral_source_id ?? null)
        : batch.referral_source_id
      if (readiness?.ready !== true) record('skipped', readiness?.blockedReason ?? 'not_ready')
      else if (!providerId(referralSourceId)) record('skipped', 'no_default_referral')
      else {
        try {
          const result = await execute(rowDeps, { companyId, actorId: batch.requested_by, reviewId: item.reviewId,
            expectedUpdatedAt: item.expectedUpdatedAt, clientRequestId: randomUUID(),
            decision: { action: 'create_albi', referralSourceId } })
          const status = result?.resolution?.status
          if (['ready_to_recheck', 'completed', 'waiting_on_albi'].includes(status)) record('created')
          else record('failed', 'create_failed')
        } catch (error) {
          if (error instanceof H2AReviewError && error.statusCode === 409) record('skipped', 'changed')
          else record('failed', 'error')
        }
      }
    }
    counts.done++
    // A false heartbeat means the batch row expired or finished elsewhere.
    if (!await batchRepository.updateReviewCreateBatch(companyId, batchId, { counts: { ...counts }, results: [...results] })) return { status: 'lost', counts: { ...counts } }
  }
  return finish('completed')
}
