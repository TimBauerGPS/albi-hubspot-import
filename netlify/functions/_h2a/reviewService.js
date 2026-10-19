import { ApiError, isRecord, malformed } from './http.js'
import { assertReviewClassification, evaluateContactReview, evaluateOrganizationReview,
  selectReviewedOrganizationContext, safeReviewSnapshot, safeReviewCandidates, safeReviewEvidence, safeReviewChanges } from './review.js'
import { resolveContactType } from './options.js'
import { refreshReviewTriage } from './triage.js'
import { H2A_IGNORABLE_CONTACT_FIELDS, sameH2AEmail } from '../../../shared/h2aReviewReasons.js'

export class H2AReviewError extends Error {
  constructor(statusCode, message) { super(message); this.name = 'H2AReviewError'; this.statusCode = statusCode }
}
const fail = (status, message) => { throw new H2AReviewError(status, message) }
const MESSAGES = {
  not_found: 'Sample review item not found.',
  stale: 'This sample review changed. Refresh it before rechecking.',
  superseded: 'This sample review is no longer current. Refresh before rechecking.',
}
const LIVE_MESSAGES = {
  not_found: 'Review item not found.',
  stale: 'This review changed. Refresh it before rechecking.',
  failed: 'Unable to recheck this review.',
}
const CATEGORIES = new Set(['auth', 'permission', 'validation', 'permanent', 'transient', 'rate_limit'])
const CODES = new Set(['pagination_loop', 'malformed_response', 'application_error', 'unsupported_contract', 'timeout', 'network'])
const clock = deps => (deps.clockMs ?? Date.now)()
const iso = deps => (deps.now?.() ?? new Date()).toISOString()
const timeout = () => new ApiError('transient', { code: 'timeout' })
const pagination = () => new ApiError('permanent', { code: 'pagination_loop' })
const fixedFailure = error => ({ category: CATEGORIES.has(error?.category) ? error.category : 'error',
  code: CODES.has(error?.code) ? error.code : 'operation_failed' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Recheck receives only reads and diagnostic writes. Select methods explicitly
// so credential, sync mutation, and delivery getters are never accessed.
export function createReviewRepositoryCapabilities(repository) {
  return Object.freeze({
    getConfig: repository.getConfig.bind(repository),
    getLatestCompletedSampleDryRun: repository.getLatestCompletedSampleDryRun.bind(repository),
    getCurrentReviewSample: repository.getCurrentReviewSample.bind(repository),
    getDryRunReview: repository.getDryRunReview.bind(repository),
    // Kind-aware recheck reads the row by id first; absent on legacy sample-only adapters.
    ...(typeof repository.getReview === 'function' ? { getReview: repository.getReview.bind(repository) } : {}),
    getMappings: repository.getMappings.bind(repository),
    appendDryRunReviewEvent: repository.appendDryRunReviewEvent.bind(repository),
    applyDryRunRecheck: repository.applyDryRunRecheck.bind(repository),
  })
}

async function requireCurrentSample(repository, companyId, sample, after) {
  const latest = await repository.getLatestCompletedSampleDryRun(companyId, after)
  if (latest?.id !== sample.id || latest.review_capture_version !== 1) fail(409, MESSAGES.superseded)
}

export async function resolveReviewSample(repository, companyId) {
  const config = await repository.getConfig(companyId)
  if (!config?.initial_start_locked_at) return { config, latest: null, sample: null }
  const latest = await repository.getLatestCompletedSampleDryRun(companyId, config.initial_start_locked_at)
  const current = await repository.getCurrentReviewSample(companyId, config.initial_start_locked_at)
  return { config, latest, sample: latest?.review_capture_version === 1 && current?.id === latest.id ? current : null }
}

export async function reviewProgress(repository, companyId, sample, after) {
  const empty = { total: 0, needsReview: 0, cleared: 0, noLongerInScope: 0, fullDryRunReady: false }
  if (!sample) return empty
  const values = await Promise.all([null, 'needs_review', 'cleared', 'no_longer_in_scope']
    .map(status => repository.countDryRunReviews(companyId, sample.id, status)))
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid review count')
  const [total, needsReview, cleared, noLongerInScope] = values
  // Revalidate both selectors after counting: pruning or a historical replacement cannot report readiness.
  const latest = total === 0 ? await repository.getLatestCompletedSampleDryRun(companyId, after) : null
  const fullDryRunReady = total === 0 && latest?.id === sample.id && latest.review_capture_version === 1 &&
    await repository.hasCleanReviewSampleDryRun(companyId, after)
  return { total, needsReview, cleared, noLongerInScope, fullDryRunReady: Boolean(fullDryRunReady) }
}

async function bounded(deps, operation, deadline) {
  const remaining = deadline - clock(deps)
  if (remaining <= 0) throw timeout()
  let timer
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeout()), remaining)
    })])
  } finally { clearTimeout(timer) }
}

async function read(deps, operation, deadline) {
  for (let attempt = 0; ; attempt++) {
    try { return await bounded(deps, operation, deadline) } catch (error) {
      if (!['transient', 'rate_limit'].includes(error?.category) || attempt >= 2 || error.retryAfterMs > 5000) throw error
      const delay = Math.max(0, Math.min(5000, Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 250 * 2 ** attempt))
      if (clock(deps) + delay >= deadline) throw timeout()
      await bounded(deps, () => (deps.sleep ?? sleep)(delay), deadline)
    }
  }
}

async function listAll(deps, method, deadline) {
  const records = [], seen = new Set()
  let cursor = '1'
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    if (seen.has(cursor)) throw pagination()
    seen.add(cursor)
    const page = await read(deps, () => method({ cursor, pageSize: 100 }), deadline)
    if (!isRecord(page) || !Array.isArray(page.records) || page.records.length > 100 ||
      page.records.some(record => !isRecord(record) || typeof record.id !== 'string' || !record.id)) malformed('review')
    records.push(...page.records)
    if (page.cursor === null) return records
    if (typeof page.cursor !== 'string' || !/^[1-9]\d{0,15}$/.test(page.cursor) || !Number.isSafeInteger(Number(page.cursor))) malformed('review')
    if (Number(page.cursor) <= Number(cursor)) throw pagination()
    cursor = page.cursor
  }
  throw pagination()
}

// A batch recheck walks Albi once and passes that snapshot to every row; a single recheck reads it live.
function albiRecords(deps, albi, kind, deadline) {
  const snapshot = deps.albiSnapshot?.[kind]
  if (snapshot) return snapshot
  return listAll(deps, kind === 'contacts' ? args => albi.listContacts(args) : args => albi.listOrganizations(args), deadline)
}

function exactSource(records, sourceId) {
  if (!Array.isArray(records)) malformed('review')
  if (records.length === 0) return null
  if (records.length !== 1 || !isRecord(records[0]) || records[0].id !== sourceId || !isRecord(records[0].properties)) malformed('review')
  const fields = ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'address', 'address2', 'city', 'state', 'zip', 'country', 'jobtitle', 'name', 'domain']
  if (fields.some(key => records[0].properties[key] != null && typeof records[0].properties[key] !== 'string')) malformed('review')
  return records[0]
}

// A reviewer's email-match link ("ignore phone/address") clears field reviews whose only differences are
// ignorable, as long as the mapping, the linked Albi record and the exact email match still hold.
async function acceptedEmailMatch(deps, companyId, row, evaluation, source, candidates, contactMappings, deadline) {
  if (evaluation.outcome !== 'needs_review' || evaluation.conflictType !== 'contact_fields') return evaluation
  const repository = deps.resolutionRepository ?? deps.repository
  if (typeof repository.getCurrentReviewResolution !== 'function') return evaluation
  const accepted = await bounded(deps, () => repository.getCurrentReviewResolution(companyId, row.id), deadline)
  const decision = isRecord(accepted?.decision) ? accepted.decision : {}
  if (accepted?.action !== 'link_existing' || decision.action !== 'link_existing' || decision.ignoreContactDifferences !== true ||
    ['failed', 'superseded'].includes(accepted.status)) return evaluation
  const mapped = contactMappings.filter(item => item?.portal_id === row.portal_id && item?.hubspot_id === row.source_id)
  if (mapped.length !== 1 || mapped[0].albi_contact_id !== decision.candidateId) return evaluation
  const target = candidates.find(item => item?.id === decision.candidateId)
  if (!target || !sameH2AEmail(source?.properties?.email, target.email)) return evaluation
  const changes = isRecord(evaluation.proposedChanges) ? evaluation.proposedChanges : {}
  const differing = [...Object.keys(isRecord(changes.updates) ? changes.updates : {}), ...Object.keys(isRecord(changes.conflicts) ? changes.conflicts : {})]
  if (!differing.every(field => H2A_IGNORABLE_CONTACT_FIELDS.includes(field))) return evaluation
  return { ...evaluation, outcome: 'safe_to_link', targetId: decision.candidateId }
}

async function currentSource(deps, hubspot, objectType, sourceId, deadline) {
  const direct = objectType === 'contacts' ? hubspot.getContact : hubspot.getCompany
  if (typeof direct === 'function') {
    const record = await read(deps, () => direct.call(hubspot, sourceId), deadline)
    return exactSource(record === null ? [] : [record], sourceId)
  }
  const records = await read(deps, () => objectType === 'contacts'
    ? hubspot.getContacts([sourceId]) : hubspot.getCompanies([sourceId]), deadline)
  return exactSource(records, sourceId)
}

function associations(records, sourceId) {
  if (!Array.isArray(records) || records.length !== 1) malformed('review')
  const row = records[0]
  if (!isRecord(row) || row.fromId !== sourceId || row.toObjectType !== 'companies' || !Array.isArray(row.toIds) ||
    row.toIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))) malformed('review')
  return [...new Set(row.toIds)]
}

function organizationContext(evaluation, candidates, mappings, sourceId, portalId, options) {
  if (evaluation.outcome === 'safe_to_link') {
    const mapped = mappings.find(row => row.portal_id === portalId && row.hubspot_id === sourceId)
    const matches = candidates.filter(row => evaluation.targetId?.length === 500
      ? row.id.slice(0, 500) === evaluation.targetId : row.id === evaluation.targetId)
    const targetId = evaluation.reason === 'existing_mapping' ? mapped?.albi_organization_id : matches.length === 1 ? matches[0].id : null
    if (!targetId) malformed('review')
    const types = candidates.find(row => row.id === targetId)?.organizationTypeIds ?? []
    return { outcome: 'safe_to_link', targetId, organizationTypeId: types.length === 1 ? types[0] : null }
  }
  const resolved = resolveContactType({ mappings: options.filter(row => row.mapping_kind === 'default_organization_type' && row.source_key === 'default')
    .map(row => ({ ...row, mapping_kind: 'default_contact_type' })) })
  return { outcome: evaluation.outcome, targetId: null, organizationTypeId: resolved.action === 'resolved' ? resolved.contactTypeId : null }
}

// Reads the current HubSpot source and Albi candidates and evaluates the row with the production
// evaluators. Shared by sample and live rechecks; only reads and diagnostic events happen here.
async function evaluateReviewRow(deps, { companyId, reviewId, actorId, row, config, runId, failureMessage, live = false }) {
  const repository = deps.repository
  const deadline = clock(deps) + Math.min(60000, Math.max(1, deps.deadlineMs ?? 60000))
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), Math.max(1, deadline - clock(deps)))
  let source, evaluation, mergedInto = null
  try {
    const capabilities = deps.getReadClients ? await bounded(deps, () => deps.getReadClients(companyId, config, { signal: controller.signal }), deadline) : deps
    const hubspot = capabilities.hubspotRead, albi = capabilities.albiRead
    source = await currentSource(deps, hubspot, row.object_type, row.source_id, deadline)
    if (!source) {
      evaluation = { outcome: 'source_missing', evidence: [], candidates: [], proposedChanges: {} }
      // A live row closes as gone only when HubSpot does not list the source as merged into a survivor.
      if (live && typeof hubspot.getMergedInto === 'function') {
        const survivor = await read(deps, () => hubspot.getMergedInto(row.object_type, row.source_id), deadline)
        if (typeof survivor === 'string' && /^[1-9]\d{0,99}$/.test(survivor)) mergedInto = { sourceId: survivor }
      }
    } else {
      const associatedCompanyIds = row.object_type === 'contacts' ? associations(await read(deps, () => hubspot.getAssociations({
        objectType: 'contacts', objectIds: [row.source_id], toObjectTypes: ['companies'],
      }), deadline), row.source_id) : []
      const resolutionRepository = deps.resolutionRepository ?? repository
      let organizationChoice = null
      if (row.object_type === 'contacts' && typeof resolutionRepository.getContactOrganizationChoice === 'function') {
        organizationChoice = await bounded(deps, () => resolutionRepository.getContactOrganizationChoice(companyId, row.portal_id, row.source_id), deadline)
      }
      const candidates = await albiRecords(deps, albi, row.object_type === 'contacts' ? 'contacts' : 'organizations', deadline)
      const mappings = await bounded(deps, () => repository.getMappings(companyId), deadline)
      if (!mappings || !['contacts', 'organizations', 'options'].every(key => Array.isArray(mappings[key]))) malformed('review')
      if (row.object_type === 'companies') evaluation = evaluateOrganizationReview({ source, candidates, portalId: row.portal_id,
        mappings: mappings.organizations, optionMappings: mappings.options })
      else {
        let organization = null
        const availableCompanies = []
        // First choose a possible source to read; only the actual company read
        // below can authorize a reviewed context in the evaluator.
        const context = selectReviewedOrganizationContext({ associatedCompanyIds, choice: organizationChoice,
          availableCompanies: associatedCompanyIds.map(id => ({ id })), companyId, portalId: row.portal_id, contactId: row.source_id })
        if (context.companyId) {
          const id = context.companyId
          const company = await currentSource(deps, hubspot, 'companies', id, deadline)
          if (!company || company.archived === true) organization = { outcome: 'needs_review' }
          else {
            availableCompanies.push(company)
            const organizations = await albiRecords(deps, albi, 'organizations', deadline)
            const result = evaluateOrganizationReview({ source: company, candidates: organizations, portalId: row.portal_id,
              mappings: mappings.organizations, optionMappings: mappings.options })
            organization = organizationContext(result, organizations, mappings.organizations, id, row.portal_id, mappings.options)
          }
        }
        evaluation = evaluateContactReview({ source, candidates, associatedCompanyIds, organization, organizationChoice, availableCompanies,
          companyId, portalId: row.portal_id,
          mappings: mappings.contacts, optionMappings: mappings.options })
        evaluation = await acceptedEmailMatch(deps, companyId, row, evaluation, source, candidates, mappings.contacts, deadline)
        // Samples may have used activity company context when direct associations
        // were empty. That context is intentionally not retained; only a fresh
        // sample can prove it resolved. Refresh safe evidence without clearing it.
        if (!associatedCompanyIds.length && row.conflict_type === 'association') {
          evaluation = { ...evaluation, outcome: 'needs_review', reason: row.reason, conflictType: row.conflict_type }
        }
      }
    }
    if (clock(deps) >= deadline) throw timeout()
  } catch (error) {
    controller.abort()
    try { await repository.appendDryRunReviewEvent(companyId, runId, reviewId,
      { eventType: 'recheck_failed', actorId, details: fixedFailure(error), now: iso(deps) }) }
    catch { /* Failed auditing cannot make the unchanged row safe. */ }
    try {
      const { recordResolutionRecheckFailure } = await import('./reviewResolutionService.js')
      await recordResolutionRecheckFailure(deps, { companyId, reviewId, actorId }, error)
    } catch { /* An unchanged durable intent remains available for reconciliation. */ }
    fail(502, failureMessage)
  } finally { clearTimeout(abortTimer) }
  return { source, evaluation, mergedInto }
}

function recheckPayload(row, source, evaluation) {
  return { reason: evaluation.outcome === 'needs_review' ? evaluation.reason : row.reason,
    conflictType: evaluation.outcome === 'needs_review' ? evaluation.conflictType : row.conflict_type,
    sourceSnapshot: safeReviewSnapshot(source ?? row.source_snapshot, row.object_type),
    candidateSnapshots: safeReviewCandidates(evaluation.candidates, row.object_type),
    matchEvidence: { evidence: safeReviewEvidence(evaluation.evidence) },
    proposedChanges: safeReviewChanges(evaluation.proposedChanges, row.object_type) }
}

const RECHECK_TERMINALS = {
  needs_review: { status: 'needs_review', outcome: 'still_needs_review', eventType: 'still_needs_review' },
  safe_to_link: { status: 'cleared', outcome: 'safe_to_link', eventType: 'cleared' },
  safe_to_create: { status: 'cleared', outcome: 'safe_to_create', eventType: 'cleared' },
  source_missing: { status: 'no_longer_in_scope', outcome: 'source_missing', eventType: 'no_longer_in_scope' },
}

export async function recheckDryRunReview(deps, { companyId, reviewId, actorId, expectedUpdatedAt }) {
  const repository = deps.repository
  // Kind comes from the stored row: live rows never consult the sample gate.
  const stored = typeof repository.getReview === 'function' ? await repository.getReview(companyId, reviewId) : null
  if (stored?.review_kind === 'live') return recheckLiveReview(deps, { companyId, reviewId, actorId, expectedUpdatedAt }, stored)
  const { config, latest, sample } = await resolveReviewSample(repository, companyId)
  if (!sample) {
    if (latest?.review_capture_version === 1) fail(409, MESSAGES.superseded)
    fail(409, 'Run a new sample to create detailed review data.')
  }
  const row = await repository.getDryRunReview(companyId, sample.id, reviewId)
  if (!row) fail(404, MESSAGES.not_found)
  if (!['contacts', 'companies'].includes(row.object_type)) fail(404, MESSAGES.not_found)
  assertReviewClassification(row.reason, row.conflict_type)
  if (row.updated_at !== expectedUpdatedAt) fail(409, MESSAGES.stale)
  if (!row.source_id || !row.portal_id || config.portal_id !== row.portal_id) fail(409, MESSAGES.superseded)
  await requireCurrentSample(repository, companyId, sample, config.initial_start_locked_at)
  const started = await repository.appendDryRunReviewEvent(companyId, sample.id, reviewId,
    { eventType: 'recheck_started', actorId, details: {}, now: iso(deps) })
  if (!started) fail(404, MESSAGES.not_found)
  const { source, evaluation } = await evaluateReviewRow(deps, { companyId, reviewId, actorId, row, config,
    runId: sample.id, failureMessage: 'Unable to recheck this sample review.' })
  await requireCurrentSample(repository, companyId, sample, config.initial_start_locked_at)
  const terminal = RECHECK_TERMINALS[evaluation.outcome]
  if (!terminal) fail(502, 'Unable to recheck this sample review.')
  const result = await repository.applyDryRunRecheck(companyId, { runId: sample.id, reviewId, expectedUpdatedAt, actorId,
    ...terminal, ...recheckPayload(row, source, evaluation), eventDetails: { outcome: terminal.outcome }, now: iso(deps) })
  if (result?.error) fail(result.error === 'not_found' ? 404 : ['stale', 'superseded'].includes(result.error) ? 409 : 502,
    MESSAGES[result.error] ?? 'Unable to recheck this sample review.')
  if (!isRecord(result?.review)) fail(502, 'Unable to recheck this sample review.')
  const { finalizeRecheckedResolution } = await import('./reviewResolutionService.js')
  const finalized = await finalizeRecheckedResolution(deps, { companyId, reviewId, actorId }, result.review)
  await refreshReviewTriage(deps.triageRepository, { companyId, row: result.review, resolutionStatus: finalized?.resolution?.status })
  return { review: result.review, sample, config }
}

// A live recheck refreshes evidence on the open row, then closes it when the record now auto-links
// or is already mapped (resolved_by_sync, or the reviewer's own completed link/create), or when its
// HubSpot source was deleted (source_missing). A merged source stays open with the merge block.
async function recheckLiveReview(deps, { companyId, reviewId, actorId, expectedUpdatedAt }, row) {
  const repository = deps.repository
  if (!['contacts', 'companies'].includes(row.object_type)) fail(404, LIVE_MESSAGES.not_found)
  assertReviewClassification(row.reason, row.conflict_type)
  const config = await repository.getConfig(companyId)
  const service = await import('./reviewResolutionService.js')
  // A completed resolution whose close did not finish is closed now instead of being re-evaluated.
  let settled
  try { settled = await service.settleLiveReviewClose(deps, { companyId, row, actorId }) } catch { fail(502, LIVE_MESSAGES.failed) }
  if (settled) return { review: settled.review, config, close: settled.close }
  if (row.status !== 'needs_review' || row.updated_at !== expectedUpdatedAt) fail(409, LIVE_MESSAGES.stale)
  if (!row.source_id || !row.portal_id || config?.portal_id !== row.portal_id) fail(409, LIVE_MESSAGES.stale)
  const started = await repository.appendDryRunReviewEvent(companyId, row.run_id, reviewId,
    { eventType: 'recheck_started', actorId, details: {}, now: iso(deps) })
  if (!started) fail(404, LIVE_MESSAGES.not_found)
  const { source, evaluation, mergedInto } = await evaluateReviewRow(deps, { companyId, reviewId, actorId, row, config,
    runId: row.run_id, failureMessage: LIVE_MESSAGES.failed, live: true })
  const terminal = RECHECK_TERMINALS[evaluation.outcome]
  if (!terminal) fail(502, LIVE_MESSAGES.failed)
  const result = await repository.applyDryRunRecheck(companyId, { runId: row.run_id, reviewId, expectedUpdatedAt, actorId,
    kind: 'live', status: 'needs_review', outcome: terminal.outcome, eventType: 'still_needs_review',
    ...recheckPayload(row, source, evaluation), eventDetails: { outcome: terminal.outcome }, now: iso(deps) })
  if (result?.error) fail(result.error === 'not_found' ? 404 : ['stale', 'superseded'].includes(result.error) ? 409 : 502,
    result.error === 'not_found' ? LIVE_MESSAGES.not_found : result.error === 'invalid_recheck' ? LIVE_MESSAGES.failed : LIVE_MESSAGES.stale)
  if (!isRecord(result?.review)) fail(502, LIVE_MESSAGES.failed)
  const closeOutcome = evaluation.outcome === 'safe_to_link' ? 'resolved_by_sync'
    : evaluation.outcome === 'source_missing' && !mergedInto ? 'source_missing' : null
  const finalized = await service.finalizeLiveRecheck(deps, { companyId, reviewId, actorId }, result.review, closeOutcome)
  const review = finalized.review ?? result.review
  await refreshReviewTriage(deps.triageRepository, { companyId, row: review, resolutionStatus: finalized.resolution?.status,
    mergedInto: evaluation.outcome === 'source_missing' ? mergedInto : null })
  return { review, config, ...(finalized.close ? { close: finalized.close } : {}) }
}

// Batch rechecks read the open queue and claim, heartbeat and finish their own batch row.
// Live batches also close live rows (close RPC and resume delivery), exactly like a single live recheck.
export function createReviewBatchCapabilities(repository) {
  return Object.freeze({
    repository: Object.freeze({ ...createReviewRepositoryCapabilities(repository),
      listDryRunReviews: repository.listDryRunReviews.bind(repository) }),
    batchRepository: Object.freeze({
      claimReviewRecheckBatch: repository.claimReviewRecheckBatch.bind(repository),
      updateReviewRecheckBatch: repository.updateReviewRecheckBatch.bind(repository),
      finishReviewRecheckBatch: repository.finishReviewRecheckBatch.bind(repository),
    }),
  })
}

// Every open row of one kind: the sample's own rows, or every open live row (no run scope).
async function openReviews(repository, companyId, runId, kind = 'sample') {
  const rows = []
  let before = null
  for (let page = 0; page < 100; page++) {
    const result = await repository.listDryRunReviews(companyId, kind === 'live' ? null : runId,
      { limit: 100, before, status: 'needs_review', objectType: null, reason: null, kind })
    if (!isRecord(result) || !Array.isArray(result.items)) malformed('review')
    rows.push(...result.items.filter(row => ['contacts', 'companies'].includes(row?.object_type)))
    const last = result.items.at(-1)
    if (!result.hasMore || !last) return rows
    before = { createdAt: last.created_at, id: last.id }
  }
  throw pagination()
}

// A targeted live batch also sweeps the other open live rows for a completed resolution whose close did
// not land (the reviewer's link/create/skip is durable, the row is still open) and closes them. That costs
// one resolution read per row and no provider reads. Untargeted batches settle these rows in recheckLiveReview.
async function sweepLiveCloses(deps, companyId, rows, actorId, deadline) {
  const { settleLiveReviewClose } = await import('./reviewResolutionService.js')
  let settled = 0
  for (const row of rows) {
    if (clock(deps) >= deadline) break
    try {
      if (row?.review_kind === 'live' && (await settleLiveReviewClose(deps, { companyId, row, actorId }))?.close) settled++
    } catch { /* The row stays the retry marker for the next detail load, recheck or batch. */ }
  }
  return settled
}

// Rechecks every open review of one kind (the current sample's, or every open live row) against one
// Albi snapshot, or only the batch's review_ids. Each row still goes through recheckDryRunReview, so its
// audit events, stale check, resolution finalization and (for live rows) close are unchanged.
export async function runReviewRecheckBatch(deps, { companyId, batchId }) {
  const { repository, batchRepository } = deps
  const batch = await batchRepository.claimReviewRecheckBatch(companyId, batchId, iso(deps))
  if (!batch) return { status: 'not_claimed' }
  const actorId = batch.requested_by
  const live = batch.review_kind === 'live'
  const targeted = Array.isArray(batch.review_ids) ? [...new Set(batch.review_ids)] : null
  const counts = { total: 0, done: 0, cleared: 0, stillNeedsReview: 0, noLongerInScope: 0, stale: 0, failed: 0 }
  let settled = 0
  const finish = async (status, errorCode = null) => {
    await batchRepository.finishReviewRecheckBatch(companyId, batchId, { status, errorCode, counts: { ...counts } })
    return { status, errorCode, counts: { ...counts }, ...(live ? { settled } : {}) }
  }
  const started = clock(deps)
  const deadline = started + Math.min(13 * 60000, Math.max(1, deps.batchDeadlineMs ?? 13 * 60000))
  let rows, snapshot, missing = 0, stranded = []
  // The sweep runs only after the targeted rechecks, with whatever deadline they left.
  const sweepThenFinish = async () => {
    if (stranded.length) settled = await sweepLiveCloses(deps, companyId, stranded, actorId, deadline)
    return finish('completed')
  }
  try {
    let config
    if (live) config = await repository.getConfig(companyId)
    else {
      const current = await resolveReviewSample(repository, companyId)
      if (!current.sample || current.sample.id !== batch.run_id) return await finish('failed', 'superseded')
      config = current.config
    }
    const open = await openReviews(repository, companyId, batch.run_id, live ? 'live' : 'sample')
    if (targeted) {
      const wanted = new Set(targeted)
      rows = open.filter(row => wanted.has(row.id))
      // A targeted id no longer open in this queue (closed, gone, or another kind) is reported stale.
      missing = targeted.length - rows.length
      if (live) stranded = open.filter(row => !wanted.has(row.id))
    } else rows = open
    counts.total = rows.length + missing
    await batchRepository.updateReviewRecheckBatch(companyId, batchId, { counts: { ...counts } })
    if (missing) {
      counts.stale += missing
      counts.done += missing
      if (!await batchRepository.updateReviewRecheckBatch(companyId, batchId, { counts: { ...counts } })) {
        return { status: 'lost', errorCode: null, counts: { ...counts } }
      }
    }
    if (!rows.length) return await sweepThenFinish()
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), Math.max(1, deadline - clock(deps)))
    try {
      const clients = await bounded(deps, () => deps.getReadClients(companyId, config, { signal: controller.signal }), deadline)
      const albi = clients.albiRead
      snapshot = {
        contacts: rows.some(row => row.object_type === 'contacts')
          ? await listAll(deps, args => albi.listContacts(args), deadline) : [],
        organizations: await listAll(deps, args => albi.listOrganizations(args), deadline),
      }
      snapshot.clients = clients
    } finally { clearTimeout(abortTimer) }
  } catch (error) {
    return finish('failed', error instanceof H2AReviewError ? 'operation_failed' : fixedFailure(error).code)
  }
  const rowDeps = { ...deps, getReadClients: undefined, hubspotRead: snapshot.clients.hubspotRead, albiRead: snapshot.clients.albiRead,
    albiSnapshot: { contacts: snapshot.contacts, organizations: snapshot.organizations } }
  for (const row of rows) {
    if (clock(deps) >= deadline) return finish('failed', 'timeout')
    try {
      const { review } = await recheckDryRunReview(rowDeps, { companyId, reviewId: row.id, actorId, expectedUpdatedAt: row.updated_at })
      if (review.status === 'cleared') counts.cleared++
      else if (review.status === 'no_longer_in_scope') counts.noLongerInScope++
      else counts.stillNeedsReview++
    } catch (error) {
      if (error?.message === MESSAGES.superseded) return finish('failed', 'superseded')
      if ([MESSAGES.stale, MESSAGES.not_found, LIVE_MESSAGES.stale, LIVE_MESSAGES.not_found].includes(error?.message)) counts.stale++
      else counts.failed++
    }
    counts.done++
    // A false heartbeat means the batch row expired or finished elsewhere; another batch may now own the queue.
    if (!await batchRepository.updateReviewRecheckBatch(companyId, batchId, { counts: { ...counts } })) return { status: 'lost', errorCode: null, counts: { ...counts } }
  }
  return sweepThenFinish()
}
