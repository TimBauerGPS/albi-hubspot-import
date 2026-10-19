import { rankReviewCandidates } from './ranking.js'
import { safeReviewCandidates, safeReviewChanges, safeReviewEvidence, safeReviewSnapshot } from './review.js'
import { carriedMerge, carriedReadiness, computeTriage } from './triage.js'
import { dispatchConflictResumes } from './conflicts.js'

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
  if (review.closed === true) return { reviewId: review.id, inserted: false, closed: true }
  await repository.linkLiveReviewConflict(companyId, review.id, conflictId)
  return { reviewId: review.id, inserted: review.inserted === true }
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
