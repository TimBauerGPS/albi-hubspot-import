// In-memory model of h2a_close_live_review plus the conflict resume claim/finish RPCs,
// following supabase/h2a-live-review-workspace.sql: one transaction closes the row, marks every
// linked open conflict, writes one conflict event each and inserts one resume per resolved conflict.
// A replay closes conflicts linked after the first close with the recorded close (closeRecord), not the caller's.
export function liveCloseStore({ reviewId, conflictIds = ['c-1', 'c-2'], review = null } = {}) {
  const state = {
    review: review ?? { id: reviewId, review_kind: 'live', status: 'needs_review' },
    conflicts: conflictIds.map(id => ({ id, status: 'open', resolution_action: null, object_type: 'contacts', source_id: '42' })),
    conflictEvents: [], resumes: [], closeCalls: [], dispatched: [], failClose: 0, closeRecord: null,
  }
  let sequence = 0
  // The single loop of the RPC: every still-open linked conflict closes with one close record.
  const closeOpen = (companyId, id, { actorId, outcome, resolutionAction }, closed, resumeIds) => {
    const skipped = ['skipped', 'source_missing'].includes(outcome)
    const action = outcome === 'resolved_by_sync' ? 'link_existing' : resolutionAction
    for (const conflict of state.conflicts.filter(item => ['open', 'resolving'].includes(item.status))) {
      Object.assign(conflict, { status: skipped ? 'skipped' : 'resolved', resolution_action: action, resolved_by: actorId })
      state.conflictEvents.push({ conflict_id: conflict.id, event_type: skipped ? 'skipped' : 'resolved', resolution_action: action,
        sanitized_details: { closedByReview: id, outcome } })
      closed.push(conflict.id)
      if (!skipped && !state.resumes.some(resume => resume.conflict_id === conflict.id)) {
        const resume = { id: `resume-${++sequence}`, company_id: companyId, conflict_id: conflict.id, resolution_action: action,
          source_object_type: conflict.object_type, source_id: conflict.source_id, status: 'pending' }
        state.resumes.push(resume)
        resumeIds.push(resume.id)
      }
    }
  }
  const methods = {
    async closeLiveReview(companyId, { reviewId: id, actorId, outcome, resolutionAction = null }) {
      state.closeCalls.push({ companyId, reviewId: id, actorId, outcome, resolutionAction })
      if (state.failClose > 0) { state.failClose--; throw Error('close storage unavailable') }
      if (id !== state.review.id || state.review.review_kind !== 'live') return { error: 'not_found' }
      const replay = state.review.status !== 'needs_review'
      const close = replay ? state.closeRecord : { actorId, outcome, resolutionAction }
      const closed = [], resumeIds = []
      if (close) closeOpen(companyId, id, close, closed, resumeIds)
      if (replay) {
        const linked = state.conflicts.map(conflict => conflict.id)
        return { closedConflictIds: linked, resumeIds: state.resumes.filter(resume => linked.includes(resume.conflict_id)).map(resume => resume.id),
          replayed: true, lateClosedConflictIds: closed }
      }
      state.closeRecord = { actorId, outcome, resolutionAction }
      state.review.status = outcome === 'resolved' ? 'cleared' : 'no_longer_in_scope'
      state.review.triage_bucket = 'done'
      if (outcome === 'source_missing') state.review.recheck_outcome = 'source_missing'
      return { closedConflictIds: closed, resumeIds, replayed: false }
    },
    async getLiveReviewClose() { return state.closeRecord ? structuredClone(state.closeRecord) : null },
    async getConflictResume(_companyId, resumeId) { return state.resumes.find(resume => resume.id === resumeId) ?? null },
    async claimConflictResume(_companyId, resumeId, owner) {
      const resume = state.resumes.find(item => item.id === resumeId && item.status === 'pending' && !item.owner)
      if (!resume) return null
      resume.owner = owner
      return structuredClone(resume)
    },
    async finishConflictResume(_companyId, resumeId, owner, accepted) {
      const resume = state.resumes.find(item => item.id === resumeId && item.owner === owner)
      if (!resume) return false
      resume.owner = null
      if (accepted) resume.status = 'dispatched'
      return true
    },
  }
  const dispatchResume = async intent => { state.dispatched.push(intent.id); return true }
  return { state, methods, dispatchResume }
}
