import { H2A_REVIEW_REASON_CATALOG } from '../../../shared/h2aReviewReasons.js'
import { blockedReasonCopy } from '../../../shared/h2aBlockedReasons.js'
import { rankReviewCandidates } from './ranking.js'
import { safeReviewCandidates, safeReviewSnapshot } from './review.js'

export const TRIAGE_BUCKETS = Object.freeze(['quick', 'todo', 'decision', 'blocked', 'done'])

// Pure bucket decision. createReadiness undefined means "not known yet"; only the link rule can yield quick then.
// mergedInto is optional because merge state is read live from HubSpot, not stored.
export function computeTriage({ row, ranking, createReadiness, resolutionStatus, mergedInto } = {}) {
  const candidates = Array.isArray(ranking?.candidates) ? ranking.candidates : []
  if (row?.status === 'cleared' && resolutionStatus !== 'completed' &&
    ['safe_to_link', 'safe_to_create'].includes(row?.recheck_outcome)) {
    return { bucket: 'quick', details: { quickKind: row.recheck_outcome === 'safe_to_link' ? 'link' : 'create' } }
  }
  if (row?.status !== 'needs_review' || resolutionStatus === 'completed') return { bucket: 'done', details: {} }
  if (resolutionStatus === 'waiting_on_albi') return { bucket: 'todo', details: {} }
  if (mergedInto?.sourceId) return { bucket: 'blocked', details: { merged: true } }
  const blockedReason = createReadiness?.blockedReason
  if (candidates.length === 0 && blockedReasonCopy(blockedReason)) return { bucket: 'blocked', details: { blockedReason } }
  const category = H2A_REVIEW_REASON_CATALOG[row?.reason]?.category
  if (ranking?.suggestedCandidateId && candidates.length === 1 && category !== 'field' && category !== 'association') {
    return { bucket: 'quick', details: { quickKind: 'link' } }
  }
  if (candidates.length === 0 && createReadiness?.ready === true) return { bucket: 'quick', details: { quickKind: 'create' } }
  return { bucket: 'decision', details: {} }
}

// Narrow capability set for the recompute points (recheck, resolution status change).
export function createTriageCapabilities(repository) {
  const bind = name => typeof repository?.[name] === 'function' ? repository[name].bind(repository) : undefined
  return Object.freeze({ setReviewTriage: bind('setReviewTriage'), getMappings: bind('getMappings'),
    getCurrentReviewResolution: bind('getCurrentReviewResolution') })
}

// Merge state is live-only: carry a stored merge block forward unless the caller says (null) it is not merged.
export function carriedMerge(stored, mergedInto) {
  return mergedInto === undefined && stored?.triage_details?.merged ? { sourceId: 'stored' } : mergedInto
}

// Readiness the caller did not read is carried over from the stored triage rather than guessed.
export function carriedReadiness(stored, createReadiness) {
  if (createReadiness !== undefined) return createReadiness
  const details = stored?.triage_details ?? {}
  if (details.blockedReason) return { ready: false, blockedReason: details.blockedReason }
  if (stored?.triage_bucket === 'quick' && details.quickKind === 'create') return { ready: true }
  return undefined
}

const sameTriage = (row, next) => row?.triage_bucket === next.bucket &&
  JSON.stringify(row?.triage_details ?? {}) === JSON.stringify(next.details)

// Recomputes a stored review row's triage and writes it only when it changed. Best effort: triage is
// advisory, so a failure here must never fail the recheck or resolution that triggered it.
// Readiness the caller did not re-read is carried over from the stored details rather than guessed.
export async function refreshReviewTriage(repository, { companyId, row, resolutionStatus, createReadiness, mergedInto } = {}) {
  try {
    if (!row || typeof repository?.setReviewTriage !== 'function') return null
    let status = resolutionStatus
    if (status === undefined && typeof repository.getCurrentReviewResolution === 'function') {
      status = (await repository.getCurrentReviewResolution(companyId, row.id))?.status
    }
    const objectType = row.object_type
    const source = safeReviewSnapshot(row.source_snapshot, objectType)
    const candidates = safeReviewCandidates(row.candidate_snapshots, objectType)
    const all = candidates.length && typeof repository.getMappings === 'function'
      ? await repository.getMappings(companyId).catch(() => null) : null
    const mappings = Array.isArray(all) ? all : all?.[objectType === 'companies' ? 'organizations' : 'contacts'] ?? []
    const ranking = rankReviewCandidates({ objectType, source, candidates, mappings, portalId: row.portal_id, sourceId: row.source_id })
    const next = computeTriage({ row, ranking, createReadiness: carriedReadiness(row, createReadiness),
      resolutionStatus: status, mergedInto: carriedMerge(row, mergedInto) })
    if (sameTriage(row, next)) return next
    await repository.setReviewTriage(companyId, row.id, next)
    return next
  } catch { return null }
}
