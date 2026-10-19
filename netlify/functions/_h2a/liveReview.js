import { rankReviewCandidates } from './ranking.js'
import { safeReviewCandidates, safeReviewChanges, safeReviewEvidence, safeReviewSnapshot } from './review.js'
import { computeTriage } from './triage.js'

const identity = value => typeof value === 'string' && value.trim() !== ''

// Live capture: one open review row per HubSpot source, with every contact/company conflict for it linked.
// Shares the snapshot, candidate, evidence and change builders with sample capture; only the upsert differs.
export async function captureLiveReview(deps, { companyId, runId, portalId, objectType, sourceId, reason, conflictType,
  source, candidates, evidence, proposedChanges, conflictId, mappings = [] } = {}) {
  const repository = deps?.repository
  if (typeof repository?.upsertLiveReview !== 'function' || typeof repository?.linkLiveReviewConflict !== 'function') {
    throw new TypeError('A live review repository is required')
  }
  if (!identity(conflictId)) throw new TypeError('A persisted conflict ID is required for live review capture')
  const sourceSnapshot = safeReviewSnapshot(source ?? { id: sourceId }, objectType)
  const candidateSnapshots = safeReviewCandidates(candidates ?? [], objectType)
  // Create readiness is not known at capture time; triage refreshes it at recheck and detail load.
  const ranking = rankReviewCandidates({ objectType, source: sourceSnapshot, candidates: candidateSnapshots,
    mappings: Array.isArray(mappings) ? mappings : [], portalId, sourceId })
  const triage = computeTriage({ row: { status: 'needs_review', reason }, ranking, createReadiness: undefined })
  const review = await repository.upsertLiveReview(companyId, {
    run_id: runId, portal_id: portalId, object_type: objectType, source_id: sourceId,
    reason, conflict_type: conflictType, source_snapshot: sourceSnapshot, candidate_snapshots: candidateSnapshots,
    match_evidence: { evidence: safeReviewEvidence(evidence) }, proposed_changes: safeReviewChanges(proposedChanges, objectType),
    triage_bucket: triage.bucket, triage_details: triage.details,
  })
  if (!identity(review?.id)) throw new Error('Invalid live review capture response')
  // A row closed earlier in this same run stays closed; its close already ran, so a new
  // conflict is not attached to it (the per-run key prevents a second row in this run).
  if (review.closed === true) return { reviewId: review.id, inserted: false, closed: true }
  await repository.linkLiveReviewConflict(companyId, review.id, conflictId)
  return { reviewId: review.id, inserted: review.inserted === true }
}
