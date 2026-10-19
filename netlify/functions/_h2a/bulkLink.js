import { rankReviewCandidates } from './ranking.js'
import { safeReviewCandidates, safeReviewSnapshot } from './review.js'
import { executeReviewResolution } from './reviewResolutionService.js'
import { H2AReviewError } from './reviewService.js'

export const MAX_BULK_LINK_ITEMS = 25
const skipped = (reviewId, reason) => ({ reviewId, status: 'skipped', reason })

// Re-ranks from the stored snapshots and a fresh mapping read so linkedElsewhere reflects now.
async function evaluate(deps, companyId, item) {
  const row = await deps.repository.getReview(companyId, item.reviewId)
  if (!row || row.company_id !== undefined && row.company_id !== companyId) return { skip: 'not_eligible' }
  if (row.updated_at !== item.expectedUpdatedAt) return { skip: 'changed' }
  if (row.triage_bucket !== 'quick' || row.triage_details?.quickKind !== 'link') return { skip: 'not_eligible' }
  const objectType = row.object_type
  const all = await deps.repository.getMappings(companyId)
  const mappings = Array.isArray(all) ? all : all?.[objectType === 'companies' ? 'organizations' : 'contacts'] ?? []
  const ranking = rankReviewCandidates({ objectType, source: safeReviewSnapshot(row.source_snapshot, objectType),
    candidates: safeReviewCandidates(row.candidate_snapshots, objectType), mappings, portalId: row.portal_id, sourceId: row.source_id })
  const candidate = ranking.candidates.find(entry => entry.id === item.candidateId)
  if (!candidate) return { skip: 'not_eligible' }
  // A target mapped to another HubSpot record is never suggested, so it is checked before the suggestion.
  if (candidate.linkedElsewhere > 0) return { skip: 'linked_elsewhere' }
  if (ranking.suggestedCandidateId !== item.candidateId) return { skip: 'not_eligible' }
  return { sameEmail: candidate.matchReasons.includes('same_email') }
}

export async function executeBulkLink(deps, { companyId, actorId, items } = {}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BULK_LINK_ITEMS) {
    throw new H2AReviewError(400, 'Invalid resolution request.')
  }
  const run = deps.executeResolution ?? executeReviewResolution
  const results = []
  for (const item of items) {
    try {
      const verdict = await evaluate(deps, companyId, item)
      if (verdict.skip) { results.push(skipped(item.reviewId, verdict.skip)); continue }
      await run(deps, { companyId, actorId, reviewId: item.reviewId, expectedUpdatedAt: item.expectedUpdatedAt,
        clientRequestId: item.clientRequestId,
        decision: { action: 'link_existing', candidateId: item.candidateId, approveManyToOne: false,
          ...(verdict.sameEmail ? { ignoreContactDifferences: true } : {}) } })
      results.push({ reviewId: item.reviewId, status: 'done' })
    } catch (error) {
      results.push(error instanceof H2AReviewError && error.statusCode === 409 ? skipped(item.reviewId, 'changed')
        : { reviewId: item.reviewId, status: 'failed', reason: 'error' })
    }
  }
  return { results }
}
