import { ApiError, isRecord, malformed } from './http.js'
import { assertReviewClassification, evaluateContactReview, evaluateOrganizationReview,
  selectReviewedOrganizationContext, safeReviewSnapshot, safeReviewCandidates, safeReviewEvidence, safeReviewChanges } from './review.js'
import { resolveContactType } from './options.js'

export class H2AReviewError extends Error {
  constructor(statusCode, message) { super(message); this.name = 'H2AReviewError'; this.statusCode = statusCode }
}
const fail = (status, message) => { throw new H2AReviewError(status, message) }
const MESSAGES = {
  not_found: 'Sample review item not found.',
  stale: 'This sample review changed. Refresh it before rechecking.',
  superseded: 'This sample review is no longer current. Refresh before rechecking.',
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

function exactSource(records, sourceId) {
  if (!Array.isArray(records)) malformed('review')
  if (records.length === 0) return null
  if (records.length !== 1 || !isRecord(records[0]) || records[0].id !== sourceId || !isRecord(records[0].properties)) malformed('review')
  const fields = ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'address', 'address2', 'city', 'state', 'zip', 'country', 'jobtitle', 'name', 'domain']
  if (fields.some(key => records[0].properties[key] != null && typeof records[0].properties[key] !== 'string')) malformed('review')
  return records[0]
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

export async function recheckDryRunReview(deps, { companyId, reviewId, actorId, expectedUpdatedAt }) {
  const repository = deps.repository
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
  const deadline = clock(deps) + Math.min(60000, Math.max(1, deps.deadlineMs ?? 60000))
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), Math.max(1, deadline - clock(deps)))
  let source, evaluation
  try {
    const capabilities = deps.getReadClients ? await bounded(deps, () => deps.getReadClients(companyId, config, { signal: controller.signal }), deadline) : deps
    const hubspot = capabilities.hubspotRead, albi = capabilities.albiRead
    source = await currentSource(deps, hubspot, row.object_type, row.source_id, deadline)
    if (!source) evaluation = { outcome: 'source_missing', evidence: [], candidates: [], proposedChanges: {} }
    else {
      const associatedCompanyIds = row.object_type === 'contacts' ? associations(await read(deps, () => hubspot.getAssociations({
        objectType: 'contacts', objectIds: [row.source_id], toObjectTypes: ['companies'],
      }), deadline), row.source_id) : []
      const resolutionRepository = deps.resolutionRepository ?? repository
      let organizationChoice = null
      if (row.object_type === 'contacts' && typeof resolutionRepository.getContactOrganizationChoice === 'function') {
        organizationChoice = await bounded(deps, () => resolutionRepository.getContactOrganizationChoice(companyId, row.portal_id, row.source_id), deadline)
      }
      const candidates = await listAll(deps, row.object_type === 'contacts' ? args => albi.listContacts(args) : args => albi.listOrganizations(args), deadline)
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
            const organizations = await listAll(deps, args => albi.listOrganizations(args), deadline)
            const result = evaluateOrganizationReview({ source: company, candidates: organizations, portalId: row.portal_id,
              mappings: mappings.organizations, optionMappings: mappings.options })
            organization = organizationContext(result, organizations, mappings.organizations, id, row.portal_id, mappings.options)
          }
        }
        evaluation = evaluateContactReview({ source, candidates, associatedCompanyIds, organization, organizationChoice, availableCompanies,
          companyId, portalId: row.portal_id,
          mappings: mappings.contacts, optionMappings: mappings.options })
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
    try { await repository.appendDryRunReviewEvent(companyId, sample.id, reviewId,
      { eventType: 'recheck_failed', actorId, details: fixedFailure(error), now: iso(deps) }) }
    catch { /* Failed auditing cannot make the unchanged row safe. */ }
    try {
      const { recordResolutionRecheckFailure } = await import('./reviewResolutionService.js')
      await recordResolutionRecheckFailure(deps, { companyId, reviewId, actorId }, error)
    } catch { /* An unchanged durable intent remains available for reconciliation. */ }
    fail(502, 'Unable to recheck this sample review.')
  } finally { clearTimeout(abortTimer) }
  await requireCurrentSample(repository, companyId, sample, config.initial_start_locked_at)
  const terminal = {
    needs_review: { status: 'needs_review', outcome: 'still_needs_review', eventType: 'still_needs_review' },
    safe_to_link: { status: 'cleared', outcome: 'safe_to_link', eventType: 'cleared' },
    safe_to_create: { status: 'cleared', outcome: 'safe_to_create', eventType: 'cleared' },
    source_missing: { status: 'no_longer_in_scope', outcome: 'source_missing', eventType: 'no_longer_in_scope' },
  }[evaluation.outcome]
  if (!terminal) fail(502, 'Unable to recheck this sample review.')
  const result = await repository.applyDryRunRecheck(companyId, { runId: sample.id, reviewId, expectedUpdatedAt, actorId,
    ...terminal, reason: evaluation.outcome === 'needs_review' ? evaluation.reason : row.reason,
    conflictType: evaluation.outcome === 'needs_review' ? evaluation.conflictType : row.conflict_type,
    sourceSnapshot: safeReviewSnapshot(source ?? row.source_snapshot, row.object_type),
    candidateSnapshots: safeReviewCandidates(evaluation.candidates, row.object_type),
    matchEvidence: { evidence: safeReviewEvidence(evaluation.evidence) },
    proposedChanges: safeReviewChanges(evaluation.proposedChanges, row.object_type),
    eventDetails: { outcome: terminal.outcome }, now: iso(deps) })
  if (result?.error) fail(result.error === 'not_found' ? 404 : ['stale', 'superseded'].includes(result.error) ? 409 : 502,
    MESSAGES[result.error] ?? 'Unable to recheck this sample review.')
  if (!isRecord(result?.review)) fail(502, 'Unable to recheck this sample review.')
  const { finalizeRecheckedResolution } = await import('./reviewResolutionService.js')
  await finalizeRecheckedResolution(deps, { companyId, reviewId, actorId }, result.review)
  return { review: result.review, sample, config }
}
