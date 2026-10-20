import { randomUUID } from 'node:crypto'
import { getH2AReviewActions } from '../../../shared/h2aReviewReasons.js'
import { executeReviewResolution } from './reviewResolutionService.js'
import { H2AReviewError } from './reviewService.js'

// "Create selected": a background batch that creates many reviewed records in Albi with one referral source.
// Albi is read once; every record is still checked against that read (which grows with each record created, so
// two HubSpot records for the same person cannot both be created) by the normal audited create.
export const MAX_CREATE_BATCH_ITEMS = 50
const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const clock = deps => (deps.clockMs ?? Date.now)()

async function listAll(read) {
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

// Still a plain create: no candidates, open (or cleared as safe to create), unchanged since it was selected.
function creatable(row, expectedUpdatedAt) {
  if (!row) return false
  if (row.updated_at !== expectedUpdatedAt) return false
  if (!Array.isArray(row.candidate_snapshots) || row.candidate_snapshots.length) return false
  if (!(row.status === 'needs_review' || row.status === 'cleared' && row.recheck_outcome === 'safe_to_create')) return false
  return getH2AReviewActions(row.reason, row.object_type).includes('create_albi')
}

export async function runReviewCreateBatch(deps, { companyId, batchId }) {
  const { repository, batchRepository } = deps
  const batch = await batchRepository.claimReviewCreateBatch(companyId, batchId)
  if (!batch) return { status: 'not_claimed' }
  const items = Array.isArray(batch.items) ? batch.items.slice(0, MAX_CREATE_BATCH_ITEMS) : []
  const counts = { total: items.length, done: 0, created: 0, skipped: 0, failed: 0 }
  const finish = async (status, errorCode = null) => {
    await batchRepository.finishReviewCreateBatch(companyId, batchId, { status, errorCode, counts: { ...counts } })
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
  for (const { item, row } of ordered) {
    if (clock(deps) >= deadline) return finish('failed', 'timeout')
    if (!creatable(row, item.expectedUpdatedAt)) counts.skipped++
    else {
      try {
        const result = await execute(rowDeps, { companyId, actorId: batch.requested_by, reviewId: item.reviewId,
          expectedUpdatedAt: item.expectedUpdatedAt, clientRequestId: randomUUID(),
          decision: { action: 'create_albi', referralSourceId: batch.referral_source_id } })
        const status = result?.resolution?.status
        if (['ready_to_recheck', 'completed', 'waiting_on_albi'].includes(status)) counts.created++
        else counts.failed++
      } catch (error) {
        if (error instanceof H2AReviewError && error.statusCode === 409) counts.skipped++
        else counts.failed++
      }
    }
    counts.done++
    // A false heartbeat means the batch row expired or finished elsewhere.
    if (!await batchRepository.updateReviewCreateBatch(companyId, batchId, { counts: { ...counts } })) return { status: 'lost', counts: { ...counts } }
  }
  return finish('completed')
}
