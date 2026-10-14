import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ApiError, isRecord, malformed } from './http.js'
import { H2AReviewError, resolveReviewSample } from './reviewService.js'
import { buildReviewResolutionPlan, hashResolutionDecision, normalizeResolutionDecision, safeResolutionEventDetails,
  safeResolutionExecutionContext, resolutionCanonicalField, RESOLUTION_EVENT_LIMIT } from './reviewResolution.js'
import { safeReviewSnapshot } from './review.js'
import { decideContactMatch, decideOrganizationMatch } from './match.js'
import { normalizePhone } from './normalize.js'
import { H2A_REVIEW_ERROR_CATEGORIES, H2A_REVIEW_ERROR_CODES } from '../../../shared/h2aReviewReasons.js'

const fail = (status, message) => { throw new H2AReviewError(status, message) }
const stale = () => fail(409, 'This sample review changed. Refresh and confirm the resolution again.')
const terminal = row => ['completed', 'superseded'].includes(row.status)
const clock = deps => (deps.clockMs ?? Date.now)()

// These are wrappers over the existing tenant-scoped mapping RPC, not new storage paths.
export function createReviewResolutionCapabilities(repository) {
  return Object.freeze({
    createReviewResolution: repository.createReviewResolution.bind(repository),
    claimReviewResolution: repository.claimReviewResolution.bind(repository),
    finishReviewResolution: repository.finishReviewResolution.bind(repository),
    appendReviewResolutionEvent: repository.appendReviewResolutionEvent.bind(repository),
    saveContactMapping: (companyId, row, approveManyToOne = false) => repository.saveMapping(companyId, 'contact', row, { approveManyToOne }),
    saveOrganizationMapping: (companyId, row, approveManyToOne = false) => repository.saveMapping(companyId, 'organization', row, { approveManyToOne }),
    upsertContactOrganizationChoice: repository.upsertContactOrganizationChoice.bind(repository),
  })
}

export function createReviewReconciliationCapabilities(repository) {
  return Object.freeze({
    getCurrentReviewResolution: repository.getCurrentReviewResolution.bind(repository),
    claimReviewResolution: repository.claimReviewResolution.bind(repository),
    finishReviewResolution: repository.finishReviewResolution.bind(repository),
    getContactOrganizationChoice: repository.getContactOrganizationChoice.bind(repository),
  })
}

function rpc(result) {
  if (result?.error) fail(['not_found'].includes(result.error) ? 404 : 409, 'This resolution cannot be applied. Refresh the sample review.')
  if (!isRecord(result?.resolution)) fail(502, 'Unable to save this resolution.')
  return result.resolution
}

function fixedFailure(error) {
  const category = H2A_REVIEW_ERROR_CATEGORIES.includes(error?.category) ? error.category : 'error'
  const code = ['auth', 'permission'].includes(category) ? 'authorization_rejected'
    : H2A_REVIEW_ERROR_CODES.includes(error?.code) ? error.code : 'operation_failed'
  return { category, code }
}

async function bounded(deps, call, deadline) {
  const remaining = deadline - clock(deps)
  if (remaining <= 0) throw new ApiError('transient', { code: 'timeout' })
  let timer
  try {
    return await Promise.race([Promise.resolve().then(call), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ApiError('transient', { code: 'timeout' })), remaining)
    })])
  } finally { clearTimeout(timer) }
}

async function listAll(deps, method, deadline) {
  const rows = [], seen = new Set()
  let cursor = '1'
  for (let count = 0; count < 1000; count++) {
    if (seen.has(cursor)) throw new ApiError('permanent', { code: 'pagination_loop' })
    seen.add(cursor)
    const page = await bounded(deps, () => method({ cursor, pageSize: 100 }), deadline)
    if (!isRecord(page) || !Array.isArray(page.records) || page.records.length > 100 ||
      page.records.some(row => !isRecord(row) || typeof row.id !== 'string' || !/^[1-9]\d*$/.test(row.id))) malformed('resolution')
    rows.push(...page.records)
    if (page.cursor === null) {
      if (new Set(rows.map(row => row.id)).size !== rows.length) malformed('resolution')
      return rows
    }
    if (typeof page.cursor !== 'string' || !/^[1-9]\d{0,15}$/.test(page.cursor) ||
      !Number.isSafeInteger(Number(page.cursor)) || Number(page.cursor) <= Number(cursor)) malformed('resolution')
    cursor = page.cursor
  }
  throw new ApiError('permanent', { code: 'pagination_loop' })
}

async function sourceRead(deps, clients, type, id, deadline) {
  const rows = await bounded(deps, () => type === 'contacts' ? clients.hubspotRead.getContacts([id]) : clients.hubspotRead.getCompanies([id]), deadline)
  if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => !isRecord(row) || row.id !== id ||
    row.archived === true || !isRecord(row.properties))) malformed('resolution')
  return rows[0] ?? null
}

async function evidence(deps, clients, row, decision, deadline) {
  const source = await sourceRead(deps, clients, row.object_type, row.source_id, deadline)
  if (!source) fail(409, 'The HubSpot source is no longer available. Recheck this review.')
  const mappings = await deps.repository.getMappings(row.company_id)
  if (!mappings || !['contacts', 'organizations', 'options'].every(key => Array.isArray(mappings[key]))) malformed('resolution')
  const contacts = row.object_type === 'contacts' ? await listAll(deps, args => clients.albiRead.listContacts(args), deadline) : []
  const organizations = row.object_type === 'companies' || decision.action === 'choose_organization' || decision.action === 'create_albi'
    ? await listAll(deps, args => clients.albiRead.listOrganizations(args), deadline) : []
  const candidates = row.object_type === 'contacts' ? contacts : organizations
  let associatedCompanyIds = []
  if (row.object_type === 'contacts') {
    const records = await bounded(deps, () => clients.hubspotRead.getAssociations({ objectType: 'contacts', objectIds: [row.source_id], toObjectTypes: ['companies'] }), deadline)
    if (!Array.isArray(records) || records.length !== 1 || records[0]?.fromId !== row.source_id ||
      records[0]?.toObjectType !== 'companies' || !Array.isArray(records[0]?.toIds) ||
      records[0].toIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))) malformed('resolution')
    associatedCompanyIds = [...new Set(records[0].toIds)]
  }
  const organizationEvidence = []
  const organizationSources = [...new Set([...associatedCompanyIds,
    ...(decision.action === 'choose_organization' ? [decision.organizationSourceId] : [])])]
  for (const id of organizationSources) {
    const company = await sourceRead(deps, clients, 'companies', id, deadline)
    if (!company) continue
    const rows = mappings.organizations
    const matched = decideOrganizationMatch({ source: company, candidates: organizations, mappings: rows, portalId: row.portal_id,
      existingMapping: rows.find(mapping => mapping.hubspot_id === id && mapping.portal_id === row.portal_id) })
    if (matched.action !== 'link') continue
    const target = organizations.find(item => item.id === matched.targetId)
    if (!target) continue
    organizationEvidence.push({ source: company, targetId: target.id,
      organizationTypeId: target.organizationTypeIds?.length === 1 ? target.organizationTypeIds[0] : null })
  }
  let targetId = decision.candidateId ?? (row.candidate_snapshots?.length === 1 ? row.candidate_snapshots[0].id : null)
  if (decision.action === 'choose_organization') {
    const rows = mappings.contacts
    const match = decideContactMatch({ source, candidates, mappings: rows, portalId: row.portal_id,
      existingMapping: rows.find(mapping => mapping.portal_id === row.portal_id && mapping.hubspot_id === row.source_id) })
    if (match.action === 'link') targetId = match.targetId
    else if (match.action !== 'create') stale()
  }
  return { source, albi: candidates.find(item => item.id === targetId), candidates, mappings,
    associatedCompanyIds, organizations: organizationEvidence }
}

function planEvidence(row, decision, current, hubspot, albi) {
  return { review: { objectType: row.object_type, sourceId: row.source_id, portalId: row.portal_id,
    reason: row.reason, candidateSnapshots: row.candidate_snapshots, proposedChanges: row.proposed_changes },
  hubspot, ...(albi ? { albi } : {}), decision,
  mappings: row.object_type === 'contacts' ? current.mappings.contacts : current.mappings.organizations,
  optionMappings: current.mappings.options, associatedCompanyIds: current.associatedCompanyIds,
  organizations: current.organizations, portalId: row.portal_id }
}

function capturedPlan(row, decision, current) {
  const source = { ...row.source_snapshot }, albi = row.candidate_snapshots?.find(item => item.id === current.albi?.id)
  const originalTarget = albi ? { ...albi } : null
  // Review projections omit blanks. A recorded comparison is the only evidence
  // that can restore an explicitly reviewed empty value; absence remains unknown.
  for (const [field, change] of Object.entries(row.proposed_changes?.conflicts ?? {})) {
    if (Object.hasOwn(change, 'proposed')) source[field] = change.proposed ?? ''
    if (originalTarget && Object.hasOwn(change, 'current')) originalTarget[field] = change.current ?? ''
  }
  return buildReviewResolutionPlan(planEvidence(row, decision, current, source,
    originalTarget ?? (decision.action === 'choose_organization' ? current.albi : null)))
}

function assertComparison(row, current, plan, replay) {
  const source = structuredClone(current.source)
  if (replay && plan.verification.properties) {
    // Allow only the exact intended write result to differ from the captured source.
    const expectedSource = row.source_snapshot
    for (const [key, value] of Object.entries(plan.verification.properties)) {
      if (!Object.hasOwn(source.properties, key)) stale()
      if ((source.properties[key] === null ? '' : source.properties[key]) !== value) continue
      const field = resolutionCanonicalField(row.object_type, key)
      if (field) source.properties[key] = expectedSource[field] ?? ''
    }
  }
  if (!isDeepStrictEqual(safeReviewSnapshot(source, row.object_type), row.source_snapshot)) stale()
  if (current.albi && ['resolve_fields', 'link_existing'].includes(plan.action)) {
    const before = row.candidate_snapshots?.find(item => item.id === current.albi.id)
    if (!before || !isDeepStrictEqual(safeReviewSnapshot(current.albi, row.object_type), safeReviewSnapshot(before, row.object_type))) stale()
  }
  if (['resolve_fields', 'link_existing'].includes(plan.action) && !current.albi) stale()
}

function propertiesMatch(source, properties) {
  return !!source && Object.entries(properties).every(([key, value]) => Object.hasOwn(source.properties, key) &&
    (source.properties[key] === null ? '' : source.properties[key]) === value)
}

function exactCreateTarget(row, plan, current) {
  const verify = plan.verification.create
  const rows = row.object_type === 'contacts' ? current.mappings.contacts : current.mappings.organizations
  const match = (row.object_type === 'contacts' ? decideContactMatch : decideOrganizationMatch)({ source: { id: row.source_id, ...row.source_snapshot },
    candidates: current.candidates, mappings: rows, portalId: row.portal_id })
  if (match.action !== 'link') return null
  const matches = current.candidates.filter(item => item.id === match.targetId)
  if (matches.length !== 1) return null
  const target = matches[0]
  for (const [field, value] of Object.entries(verify.payload)) {
    const actual = target[field === 'zipCode' ? 'zipcode' : field]
    if (field === 'phoneNumber') {
      if (!Object.hasOwn(target, field) || normalizePhone(actual).conflictReason || normalizePhone(actual).writable !== value) return null
    } else if (!isDeepStrictEqual(actual, value)) return null
  }
  if (verify.organizationId === null && target.organizationId != null && target.organizationId !== '') return null
  return target.id
}

async function saveLocal(caps, row, plan, actorId, targetId = plan.mapping?.targetId) {
  if (plan.mapping) {
    if (!targetId) malformed('resolution')
    await caps[row.object_type === 'contacts' ? 'saveContactMapping' : 'saveOrganizationMapping'](row.company_id,
      { portal_id: row.portal_id, hubspot_id: row.source_id,
        [row.object_type === 'contacts' ? 'albi_contact_id' : 'albi_organization_id']: targetId, match_method: 'reviewed', reviewed_by: actorId }, plan.mapping.approveManyToOne)
  }
  if (plan.organizationChoice) {
    const result = await caps.upsertContactOrganizationChoice(row.company_id, { portalId: row.portal_id, ...plan.organizationChoice, actorId })
    if (result?.error) fail(409, 'Unable to save the organization choice.')
  }
}

async function currentReview(deps, companyId, reviewId) {
  const resolved = await resolveReviewSample(deps.repository, companyId)
  if (!resolved.sample) fail(409, 'This sample is no longer current. Run a new sample review.')
  const row = await deps.repository.getDryRunReview(companyId, resolved.sample.id, reviewId)
  if (!row || !['contacts', 'companies'].includes(row.object_type)) fail(404, 'Sample review item not found.')
  if (row.portal_id !== resolved.config.portal_id) stale()
  return { ...resolved, row: { ...row, company_id: companyId } }
}

async function stillCurrent(deps, row, config) {
  const latest = await deps.repository.getLatestCompletedSampleDryRun(row.company_id, config.initial_start_locked_at)
  return latest?.id === row.run_id && latest.review_capture_version === 1
}

async function runClaim(deps, input, saved, context) {
  const caps = createReviewResolutionCapabilities(deps.repository), owner = randomUUID()
  const claimed = rpc(await caps.claimReviewResolution(input.companyId, saved.id, owner, input.actorId, 120))
  const phase = claimed.execution_phase
  if (!['applying', 'waiting_on_albi', 'ready_to_recheck'].includes(phase)) fail(409, 'This resolution cannot be applied.')
  if (claimed.lease_owner !== owner || !Number.isFinite(Date.parse(claimed.lease_expires_at)) ||
    Date.parse(claimed.lease_expires_at) <= clock(deps)) fail(409, 'The resolution lease expired. Refresh and try again.')
  const row = context.row
  const finish = async (status, eventType, code = eventType, details = {}) => ({ resolution: rpc(await caps.finishReviewResolution(
    input.companyId, claimed.id, owner, { actorId: input.actorId, status, eventType, providerOutcomeCode: code,
      details: safeResolutionEventDetails({ ...details, code }) })) })
  if (!await stillCurrent(deps, row, context.config) || saved.run_id !== row.run_id) return finish('superseded', 'superseded')
  if (phase !== 'applying' && ['cleared', 'no_longer_in_scope'].includes(row.status)) return finish('completed', 'completed')
  const deadline = Math.min(Date.parse(claimed.lease_expires_at) - 1000,
    clock(deps) + Math.min(60000, Math.max(1, deps.deadlineMs ?? 60000)))
  let clients, current, plan, reconciled = false
  try {
    const events = await bounded(deps, () => deps.repository.listReviewResolutionEvents(input.companyId, saved.id), deadline)
    if (!Array.isArray(events)) malformed('resolution')
    const persisted = events.find(event => event.event_type === 'claimed' && event.sanitized_details?.executionContext)
    if (!persisted && events.length >= RESOLUTION_EVENT_LIMIT) throw new ApiError('permanent', { code: 'operation_failed' })
    const contextPlan = persisted ? safeResolutionExecutionContext(persisted.sanitized_details.executionContext) : null
    if (persisted && !contextPlan || contextPlan && (contextPlan.decisionHash !== hashResolutionDecision(saved.decision) ||
      contextPlan.action !== saved.action || contextPlan.providerOperation?.id && contextPlan.providerOperation.id !== saved.source_id ||
      contextPlan.mapping && contextPlan.mapping.sourceId !== saved.source_id ||
      contextPlan.verification.create && (contextPlan.verification.create.sourceId !== saved.source_id ||
        contextPlan.verification.create.portalId !== saved.portal_id))) malformed('resolution')
    clients = deps.getResolutionClients ? await bounded(deps, () => deps.getResolutionClients(input.companyId, context.config), deadline) : deps
    current = await evidence(deps, clients, row, saved.decision, deadline)
    if (phase !== 'applying') return finish(phase, phase === 'waiting_on_albi' ? 'waiting_on_albi' : 'recheck_requested')
    if (row.updated_at !== saved.expected_review_updated_at) stale()
    if (contextPlan) {
      plan = contextPlan
      if (saved.action === 'resolve_fields') {
        const original = { ...row.source_snapshot }
        for (const [field, change] of Object.entries(row.proposed_changes?.conflicts ?? {})) {
          if (Object.hasOwn(change, 'proposed')) original[field] = change.proposed ?? ''
        }
        const proof = safeResolutionExecutionContext(buildReviewResolutionPlan(planEvidence(row, saved.decision, current, original, current.albi)))
        if (!isDeepStrictEqual(proof, contextPlan)) stale()
      }
      if (saved.action === 'link_existing') {
        // The approval is durable; ownership can still change between attempts.
        buildReviewResolutionPlan(planEvidence(row, saved.decision, current, current.source, current.albi))
      }
    } else {
      // Validate raw live evidence before using captured projections. Missing and
      // overlength fields cannot become empty/truncated writes.
      const livePlan = safeResolutionExecutionContext(buildReviewResolutionPlan(planEvidence(row, saved.decision, current, current.source, current.albi)))
      plan = safeResolutionExecutionContext(capturedPlan(row, saved.decision, current))
      if (!plan) malformed('resolution')
      if (!isDeepStrictEqual(livePlan, plan)) stale()
    }
    assertComparison(row, current, plan, !!contextPlan)
    if (!await stillCurrent(deps, row, context.config)) return finish('superseded', 'superseded')
    // Revalidate the review after HTTP reads and before obtaining a mutation method.
    const newest = await deps.repository.getDryRunReview(input.companyId, row.run_id, row.id)
    if (!newest || newest.updated_at !== row.updated_at) stale()
    if (!contextPlan) await caps.appendReviewResolutionEvent(input.companyId, saved.id,
      { actorId: input.actorId, eventType: 'claimed', details: { executionContext: plan } })
    const operation = plan.providerOperation
    if (operation) {
      // Albi pagination can be slow. Refresh the source comparison at the write
      // boundary so intervening source edits require a new confirmation.
      current.source = await sourceRead(deps, clients, row.object_type, row.source_id, deadline)
      if (!current.source) stale()
      assertComparison(row, current, plan, true)
    }
    let createTarget = null
    if (operation?.provider === 'albi') {
      createTarget = exactCreateTarget(row, plan, current)
      if (createTarget) reconciled = true
      else if (contextPlan) throw new ApiError('permanent', { code: 'operation_failed' })
      else {
        // A new create cannot override newly appeared or contradictory identity evidence.
        const matched = (row.object_type === 'contacts' ? decideContactMatch : decideOrganizationMatch)({ source: current.source,
          candidates: current.candidates, mappings: row.object_type === 'contacts' ? current.mappings.contacts : current.mappings.organizations, portalId: row.portal_id })
        if (matched.action !== 'create') stale()
      }
    } else if (plan.verification.properties) reconciled = propertiesMatch(current.source, plan.verification.properties)
    else if (plan.verification.association) reconciled = current.associatedCompanyIds.includes(plan.verification.association.companyId)
    if (operation && !reconciled) {
      try {
        // One provider mutation per claim. No transaction remains open over HTTP.
        if (operation.provider === 'hubspot' && operation.properties) await bounded(deps,
          () => clients.hubspotWrite[operation.operation](operation.id, operation.properties), deadline)
        else if (operation.provider === 'hubspot') await bounded(deps,
          () => clients.hubspotWrite.addContactCompanyAssociation(operation.contactId, operation.companyId), deadline)
        else await bounded(deps, () => clients.albiWrite[operation.operation](operation.payload), deadline)
      } catch (error) {
        // All ambiguous responses are verified by reads. Permission/validation
        // failures still retain the intent and return a fixed, sanitized outcome.
        const after = await evidence(deps, clients, row, saved.decision, deadline)
        createTarget = plan.verification.create ? exactCreateTarget(row, plan, after) : null
        const verified = plan.verification.properties ? propertiesMatch(after.source, plan.verification.properties)
          : plan.verification.association ? after.associatedCompanyIds.includes(plan.verification.association.companyId) : !!createTarget
        if (!verified) throw error
        reconciled = true
      }
      if (!reconciled) {
        const after = await evidence(deps, clients, row, saved.decision, deadline)
        createTarget = plan.verification.create ? exactCreateTarget(row, plan, after) : null
        const verified = plan.verification.properties ? propertiesMatch(after.source, plan.verification.properties)
          : plan.verification.association ? after.associatedCompanyIds.includes(plan.verification.association.companyId) : !!createTarget
        if (!verified) malformed('resolution')
      }
    }
    if (!await stillCurrent(deps, row, context.config)) return finish('superseded', 'superseded')
    await saveLocal(caps, row, plan, input.actorId, createTarget ?? plan.mapping?.targetId)
  } catch (error) {
    const details = fixedFailure(error)
    const result = await finish(phase === 'applying' ? 'failed' : phase, 'failed', details.code, details)
    if (error instanceof H2AReviewError && error.statusCode === 409) throw error
    return result
  }
  // Keep storage failures outside the provider-error catch: a failed finalization
  // leaves a live/expired lease for reconciliation instead of pretending success.
  return finish(plan.verification.successStatus, plan.providerOperation ? reconciled ? 'provider_reconciled' : 'provider_applied'
    : plan.manualTasks.length ? 'waiting_on_albi' : 'recheck_requested', undefined, { manualTasks: plan.manualTasks })
}

export async function executeReviewResolution(deps, input) {
  const decision = normalizeResolutionDecision(input.decision)
  const context = await currentReview(deps, input.companyId, input.reviewId)
  // The atomic RPC checks exact replay before freshness, including older intents.
  // Its stale rejection occurs before provider capability construction.
  const caps = createReviewResolutionCapabilities(deps.repository)
  const created = await caps.createReviewResolution(input.companyId, { runId: context.row.run_id, reviewId: input.reviewId,
    portalId: context.row.portal_id, objectType: context.row.object_type, sourceId: context.row.source_id,
    actorId: input.actorId, expectedUpdatedAt: input.expectedUpdatedAt, clientRequestId: input.clientRequestId, decision })
  const saved = rpc(created)
  if (terminal(saved)) return { resolution: saved }
  return runClaim(deps, input, saved, context)
}

export async function reconcileReviewResolution(deps, input) {
  const saved = await deps.repository.getReviewResolution(input.companyId, input.resolutionId)
  if (!saved) fail(404, 'Resolution not found.')
  if (terminal(saved)) return { resolution: saved }
  const config = await deps.repository.getConfig(input.companyId)
  const stored = await deps.repository.getDryRunReview(input.companyId, saved.run_id, saved.review_id)
  if (!stored) fail(404, 'Sample review item not found.')
  const context = { config, row: { ...stored, company_id: input.companyId } }
  return runClaim(deps, input, saved, context)
}

// Called only after production evaluation was atomically written to the review.
// It fetches the current durable row instead of trusting client completion flags.
export async function finalizeRecheckedResolution(deps, { companyId, reviewId, actorId }, review) {
  const repository = deps.resolutionRepository ?? deps.repository
  if (typeof repository.getCurrentReviewResolution !== 'function') return null
  const saved = await repository.getCurrentReviewResolution(companyId, reviewId)
  if (!saved || terminal(saved)) return saved ? { resolution: saved } : null
  const owner = randomUUID()
  const claim = await repository.claimReviewResolution(companyId, saved.id, owner, actorId, 120)
  if (claim?.error === 'not_claimable' || claim?.error === 'review_busy') return null
  const claimed = rpc(claim)
  const status = ['cleared', 'no_longer_in_scope'].includes(review.status) ? 'completed'
    : claimed.execution_phase === 'waiting_on_albi' ? 'waiting_on_albi' : 'ready_to_recheck'
  const eventType = status === 'completed' ? 'completed' : status === 'waiting_on_albi' ? 'waiting_on_albi' : 'recheck_requested'
  return { resolution: rpc(await repository.finishReviewResolution(companyId, saved.id, owner,
    { actorId, status, eventType, providerOutcomeCode: eventType, details: { code: eventType } })) }
}

export async function recordResolutionRecheckFailure(deps, { companyId, reviewId, actorId }, error) {
  const repository = deps.resolutionRepository ?? deps.repository
  if (typeof repository.getCurrentReviewResolution !== 'function') return null
  const saved = await repository.getCurrentReviewResolution(companyId, reviewId)
  if (!saved || terminal(saved)) return null
  const owner = randomUUID()
  const claim = await repository.claimReviewResolution(companyId, saved.id, owner, actorId, 120)
  if (claim?.error === 'not_claimable' || claim?.error === 'review_busy') return null
  const claimed = rpc(claim), details = fixedFailure(error)
  const status = claimed.execution_phase === 'applying' ? 'failed' : claimed.execution_phase
  return { resolution: rpc(await repository.finishReviewResolution(companyId, saved.id, owner,
    { actorId, status, eventType: 'failed', providerOutcomeCode: details.code, details })) }
}
