import { rankReviewCandidates } from './ranking.js'
import { safeReviewCandidates, safeReviewChanges, safeReviewEvidence, safeReviewSnapshot } from './review.js'
import { carriedMerge, carriedReadiness, computeTriage } from './triage.js'
import { dispatchConflictResumes } from './conflicts.js'
import { REVIEW_CONFLICT_TYPES, REVIEW_REASONS } from './review.js'

const identity = value => typeof value === 'string' && value.trim() !== ''

// Live capture: one open review row per HubSpot source, with every contact/company conflict for it linked.
// Shares the snapshot, candidate, evidence and change builders with sample capture; only the upsert differs.
export async function captureLiveReview(deps, { companyId, runId, portalId, objectType, sourceId, reason, conflictType,
  source, candidates, evidence, proposedChanges, conflictId, mappings = [], createReadiness } = {}) {
  const repository = deps?.repository
  if (typeof repository?.upsertLiveReview !== 'function' || typeof repository?.linkLiveReviewConflict !== 'function') {
    throw new TypeError('A live review repository is required')
  }
  if (!identity(conflictId)) throw new TypeError('A persisted conflict ID is required for live review capture')
  const sourceKnown = source !== undefined && source !== null
  const sourceSnapshot = safeReviewSnapshot(sourceKnown ? source : { id: sourceId }, objectType)
  const candidateSnapshots = safeReviewCandidates(candidates ?? [], objectType)
  const ranking = rankReviewCandidates({ objectType, source: sourceSnapshot, candidates: candidateSnapshots,
    mappings: Array.isArray(mappings) ? mappings : [], portalId, sourceId })
  // createReadiness is computed at capture for zero-candidate new records; undefined means "not known".
  // On refresh, knowledge this capture lacks (a live-only merge, a readiness it could not read) is kept.
  const triageFor = stored => computeTriage({ row: { status: 'needs_review', reason }, ranking,
    createReadiness: carriedReadiness(stored, createReadiness), mergedInto: carriedMerge(stored, undefined) })
  const triage = triageFor(null)
  const review = await repository.upsertLiveReview(companyId, {
    run_id: runId, portal_id: portalId, object_type: objectType, source_id: sourceId,
    reason, conflict_type: conflictType, source_snapshot: sourceSnapshot, candidate_snapshots: candidateSnapshots,
    match_evidence: { evidence: safeReviewEvidence(evidence) }, proposed_changes: safeReviewChanges(proposedChanges, objectType),
    triage_bucket: triage.bucket, triage_details: triage.details, source_known: sourceKnown, triage_for: triageFor,
  })
  if (!identity(review?.id)) throw new Error('Invalid live review capture response')
  // A row closed earlier in this same run stays closed; its close already ran, so a new
  // conflict is not attached to it (the per-run key prevents a second row in this run).
  if (review.closed === true) return { reviewId: review.id, inserted: false, closed: true, linked: false }
  const linked = await repository.linkLiveReviewConflict(companyId, review.id, conflictId)
  return { reviewId: review.id, inserted: review.inserted === true, linked: linked === true }
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function backfillCursor(cursor) {
  if (cursor === undefined || cursor === null) return null
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).length !== 2 ||
    typeof cursor.createdAt !== 'string' || !TIMESTAMP.test(cursor.createdAt) || typeof cursor.id !== 'string' || !UUID.test(cursor.id)) {
    throw new TypeError('Invalid backfill cursor')
  }
  return { createdAt: cursor.createdAt, id: cursor.id }
}

// One-off, on-demand capture of open contact/company conflicts that predate live capture
// ("Prepare open conflicts for review"). Pages oldest first; idempotent on the link table's
// (company_id, conflict_id) and the live partial key, so re-running a page writes nothing.
// - A conflict already linked to a review is left alone.
// - A source that already has an open live row only gets the conflict linked: the row's evidence,
//   refreshed by a live run, is never replaced by the conflict's older stored snapshot.
// - Otherwise the row is captured from the conflict's stored snapshots with triage computed like
//   capture. Create readiness is not read here (no provider calls), so it is undefined and a new
//   record lands in Decision until its detail is opened or it is rechecked.
// Conflicts with a classification the review catalog does not know, or without a run, are skipped.
export async function backfillLiveReviews(deps, { companyId, limit = 50, cursor } = {}) {
  const repository = deps?.repository
  for (const name of ['listOpenSourceConflicts', 'findLiveReviewConflictLink', 'findOpenLiveReviewBySource', 'upsertLiveReview', 'linkLiveReviewConflict']) {
    if (typeof repository?.[name] !== 'function') throw new TypeError('A live review backfill repository is required')
  }
  if (!identity(companyId)) throw new TypeError('Company ID is required')
  const after = backfillCursor(cursor)
  const size = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50
  const page = await repository.listOpenSourceConflicts(companyId, { limit: size, after })
  if (!page || !Array.isArray(page.items)) throw new Error('Invalid conflict page')
  const counts = { captured: 0, linked: 0, skipped: 0, failed: 0 }
  let mappings = null
  for (const conflict of page.items) {
    if (!['contacts', 'companies'].includes(conflict?.object_type) || conflict.status !== 'open' || !identity(conflict.id)) { counts.skipped++; continue }
    if (!REVIEW_REASONS.has(conflict.reason) || !REVIEW_CONFLICT_TYPES.has(conflict.conflict_type) ||
      !identity(conflict.run_id) || !identity(conflict.portal_id) || !identity(conflict.source_id)) { counts.skipped++; continue }
    try {
      if (await repository.findLiveReviewConflictLink(companyId, conflict.id)) continue
      const open = await repository.findOpenLiveReviewBySource(companyId, conflict.portal_id, conflict.object_type, conflict.source_id)
      if (open?.id) {
        if (await repository.linkLiveReviewConflict(companyId, open.id, conflict.id)) counts.linked++
        continue
      }
      if (mappings === null) mappings = typeof repository.getMappings === 'function' ? await repository.getMappings(companyId) : {}
      const stored = conflict.source_snapshot && typeof conflict.source_snapshot === 'object' &&
        Object.keys(conflict.source_snapshot).some(key => key !== 'id') ? conflict.source_snapshot : null
      const result = await captureLiveReview(deps, { companyId, runId: conflict.run_id, portalId: conflict.portal_id,
        objectType: conflict.object_type, sourceId: conflict.source_id, reason: conflict.reason, conflictType: conflict.conflict_type,
        source: stored, candidates: Array.isArray(conflict.candidate_snapshots) ? conflict.candidate_snapshots : [],
        evidence: conflict.match_evidence, proposedChanges: conflict.proposed_changes, conflictId: conflict.id,
        mappings: mappings?.[conflict.object_type === 'companies' ? 'organizations' : 'contacts'] ?? [], createReadiness: undefined })
      if (result.inserted) counts.captured++
      if (result.linked) counts.linked++
    } catch { counts.failed++ }
  }
  const last = page.items.at(-1)
  return { ...counts, nextCursor: page.hasMore && last ? { createdAt: last.created_at, id: last.id } : null }
}

// Close capability for callers that otherwise hold only reads (recheck): the close RPC and resume delivery.
export function createLiveCloseCapabilities(repository) {
  const bind = name => typeof repository?.[name] === 'function' ? repository[name].bind(repository) : undefined
  return Object.freeze({ closeLiveReview: bind('closeLiveReview'), getConflictResume: bind('getConflictResume'),
    claimConflictResume: bind('claimConflictResume'), finishConflictResume: bind('finishConflictResume') })
}

// Which close a completed reviewer resolution on a live row stands for.
export const LIVE_CLOSE_FOR_ACTION = Object.freeze({
  link_existing: Object.freeze({ outcome: 'resolved', resolutionAction: 'link_existing' }),
  create_albi: Object.freeze({ outcome: 'resolved', resolutionAction: 'create_new' }),
  force_create_albi: Object.freeze({ outcome: 'resolved', resolutionAction: 'create_new' }),
  skip_live: Object.freeze({ outcome: 'skipped', resolutionAction: 'skip' }),
})

// Closes a live row and all its linked conflicts in one RPC transaction, then delivers each resume
// it returned. Replays are safe: the RPC returns replayed with no new rows, and delivered resumes are
// not sent again. A delivery failure never undoes the close; those resumes stay pending for retry.
export async function closeLiveReview(deps, { companyId, reviewId, actorId, outcome, resolutionAction = null } = {}) {
  const repository = deps?.repository
  if (typeof repository?.closeLiveReview !== 'function') throw new TypeError('A live review close capability is required')
  const result = await repository.closeLiveReview(companyId, { reviewId, actorId, outcome, resolutionAction })
  if (!result || result.error || !Array.isArray(result.closedConflictIds) || !Array.isArray(result.resumeIds)) {
    throw Object.assign(new Error('Unable to close this live review.'), { closeError: result?.error ?? 'invalid_response' })
  }
  let deliveries = []
  try {
    deliveries = result.resumeIds.length ? await dispatchConflictResumes(deps, companyId, result.resumeIds) : []
  } catch {
    deliveries = result.resumeIds.map(resumeId => ({ resumeId, accepted: false, pending: true }))
  }
  return { closedConflictIds: result.closedConflictIds, resumeIds: result.resumeIds, replayed: result.replayed === true,
    dispatched: deliveries.filter(item => item.accepted).length, pending: deliveries.filter(item => item.pending).length }
}
