import { randomUUID } from 'node:crypto'
import { HUBSPOT_ACTIVITY_TYPES, SAMPLE_LIMIT_PER_TYPE } from './constants.js'
import { pacificBusinessDate, pacificStartOfDate } from './time.js'
import { advanceCheckpoint, compareBoundary, planBackfillWindows, readStartWithOverlap } from './checkpoints.js'
import { evaluateContactReview, evaluateOrganizationReview, safeReviewSnapshot, safeReviewCandidates,
  selectReviewedOrganizationContext, safeReviewEvidence, safeReviewChanges } from './review.js'
import { resolveActivityTargets, buildAlbiActivity } from './activity.js'
import { resolveActivityType, resolveContactType } from './options.js'
import { reserveDelivery, completeDelivery } from './deliveries.js'
import { captureLiveReview } from './liveReview.js'
import { computeCaptureReadiness } from './createDefaults.js'
import { computeTriage } from './triage.js'
import { rankReviewCandidates } from './ranking.js'
import { followOrganizationMerge } from './organizationMerges.js'

const text = value => value == null ? '' : String(value).trim()
const sourceFields = record => record?.properties ?? record ?? {}
const idOf = record => text(record?.id)
const nowIso = deps => (deps.now?.() ?? new Date()).toISOString()
const clockMs = deps => (deps.clockMs ?? Date.now)()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
class ReviewCaptureError extends Error {
  constructor() { super('H2A sample review capture failed') }
}
const capturesReview = ctx => ctx?.mode === 'dry_run' && ctx.sampleLimitPerType === SAMPLE_LIMIT_PER_TYPE &&
  ctx.reviewCaptureVersion === 1
const ERROR_CATEGORIES = new Set(['auth', 'permission', 'validation', 'permanent', 'transient', 'rate_limit'])
const ERROR_CODES = new Set(['pagination_loop', 'malformed_response', 'application_error', 'unsupported_contract', 'timeout', 'network'])
const WRAPPER_SCOPES = new Set([
  'contacts:list', 'contacts:create', 'organizations:list', 'organizations:create', 'activities:list', 'activities:create',
  'options.relationship-types:list', 'options.referral-sources:list', 'options.relationship-statuses:list', 'options.activity-types:list',
])
const safeScope = error => WRAPPER_SCOPES.has(error?.requiredScope) ? { requiredScope: error.requiredScope } : {}
function safeFailure(error) {
  return { reason: `${ERROR_CATEGORIES.has(error?.category) ? error.category : 'error'}:${ERROR_CODES.has(error?.code) ? error.code : 'operation_failed'}`,
    ...safeScope(error) }
}
const safeError = error => safeFailure(error).reason
function logCleanupFailure(deps, phase, error) {
  const logger = deps.logger ?? console
  try { (logger.warn ?? logger.error)?.call(logger, 'H2A cleanup failed', { phase, reason: safeError(error) }) }
  catch { /* Cleanup logging is best-effort and never replaces run state. */ }
}
const SNAPSHOT_FIELDS = ['id', 'firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone', 'phoneNumber',
  'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country']
function safeSnapshot(record) {
  if (!record) return {}
  const fields = { id: idOf(record), ...sourceFields(record) }
  return Object.fromEntries(SNAPSHOT_FIELDS.filter(key => fields[key] !== undefined && fields[key] !== null)
    .map(key => [key, text(fields[key]).slice(0, 500)]))
}

async function retryRead(deps, operation, deadline) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation() } catch (error) {
      if (!['rate_limit', 'transient'].includes(error?.category) || attempt >= 2) throw error
      if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 5000) throw error
      const delay = Math.max(0, Math.min(5000, error.retryAfterMs ?? 250 * 2 ** attempt))
      if (clockMs(deps) + delay >= deadline) throw error
      await (deps.sleep ?? sleep)(delay)
    }
  }
}

async function listAll(deps, client, method, deadline) {
  const records = [], seen = new Set()
  let cursor = '1'
  for (let count = 0; count < 1000; count += 1) {
    if (seen.has(cursor)) throw new Error(`Albi ${method} repeated a page`)
    seen.add(cursor)
    const page = await retryRead(deps, () => client[method]({ cursor, pageSize: 100 }), deadline)
    if (!Array.isArray(page?.records)) throw new Error(`Albi ${method} returned an invalid page`)
    records.push(...page.records)
    if (page.cursor == null) return records
    if (!/^[1-9]\d*$/.test(String(page.cursor)) || Number(page.cursor) <= Number(cursor)) throw new Error(`Albi ${method} returned an invalid cursor`)
    cursor = String(page.cursor)
  }
  throw new Error(`Albi ${method} page limit exceeded`)
}

function mappingFor(mappings, portalId, sourceId) {
  return mappings.find(row => row.portal_id === portalId && row.hubspot_id === sourceId)
}

function option(mappings, kind) {
  const resolved = resolveContactType({ mappings: mappings.filter(row => row.mapping_kind === kind && row.source_key === 'default')
    .map(row => ({ ...row, mapping_kind: 'default_contact_type' })) })
  return resolved.action === 'resolved' ? resolved.contactTypeId : null
}

function actionTarget(evaluation, candidates, mapping, targetKey) {
  if (evaluation.reason === 'existing_mapping' && mapping?.[targetKey]) return text(mapping[targetKey])
  // Evaluator IDs are diagnostic strings capped at 500 characters. Recover the
  // full action ID from the original index, and fail closed on prefix collisions.
  const matches = candidates.filter(candidate => evaluation.targetId?.length === 500
    ? idOf(candidate).slice(0, 500) === evaluation.targetId : idOf(candidate) === evaluation.targetId)
  if (matches.length !== 1) throw new Error('H2A evaluation target is unavailable')
  return idOf(matches[0])
}

async function recordOnce(repo, companyId, runId, row) {
  if (typeof repo.getItemOutcomes === 'function') {
    const prior = await repo.getItemOutcomes(companyId, runId, row.object_type, row.source_id)
    if (prior?.some(item => item.outcome === row.outcome && item.albi_target_type === (row.albi_target_type ?? null) &&
      item.albi_target_id === (row.albi_target_id ?? null))) return
  }
  await repo.recordItem(companyId, { ...row, run_id: runId })
}

async function conflict(deps, ctx, data) {
  const { companyId, runId, portalId, activity } = ctx
  if (capturesReview(ctx) && ['contacts', 'companies'].includes(data.objectType)) {
    const identity = JSON.stringify([portalId, data.objectType, data.sourceId])
    if (!ctx.capturedReviewIdentities.has(identity)) {
      try {
        const sourceSnapshot = safeReviewSnapshot(data.source ?? { id: data.sourceId }, data.objectType)
        const candidateSnapshots = safeReviewCandidates(data.candidates ?? [], data.objectType)
        // Triage at capture, like live capture. Readiness stays unknown: a sample makes no extra provider reads.
        const mappings = data.objectType === 'companies' ? ctx.mappings?.organizations : ctx.mappings?.contacts
        const triage = computeTriage({ row: { status: 'needs_review', reason: data.reason },
          ranking: rankReviewCandidates({ objectType: data.objectType, source: sourceSnapshot, candidates: candidateSnapshots,
            mappings: Array.isArray(mappings) ? mappings : [], portalId, sourceId: data.sourceId }) })
        await deps.repository.recordDryRunReview(companyId, {
          run_id: runId, portal_id: portalId, object_type: data.objectType, source_id: data.sourceId,
          reason: data.reason, conflict_type: data.type,
          source_snapshot: sourceSnapshot, candidate_snapshots: candidateSnapshots,
          match_evidence: { evidence: safeReviewEvidence(data.evidence) },
          proposed_changes: safeReviewChanges(data.proposedChanges, data.objectType),
          triage_bucket: triage.bucket, triage_details: triage.details,
        })
      } catch { throw new ReviewCaptureError() }
      ctx.capturedReviewIdentities.add(identity)
    }
  }
  if (ctx.mode !== 'dry_run') {
    const persisted = await deps.repository.recordConflict(companyId, {
      portal_id: portalId, object_type: data.objectType, source_id: data.sourceId,
      conflict_type: data.type, reason: data.reason,
      match_evidence: { evidence: data.evidence ?? [] },
      source_snapshot: data.source ? safeSnapshot(data.source) : { id: data.sourceId },
      candidate_snapshots: (data.candidates ?? []).slice(0, 10).map(safeSnapshot),
      proposed_changes: data.proposedChanges ?? {}, status: 'open', run_id: runId,
      activity_object_type: activity.objectType, activity_id: activity.id,
    })
    if (persisted?.inserted === true) ctx.newConflictCount = (ctx.newConflictCount ?? 0) + 1
    // Live and backfill runs both write to Albi, so both hold contact/company conflicts in the live review queue.
    if (['contacts', 'companies'].includes(data.objectType)) {
      await captureLiveReview(deps, { companyId, runId, portalId, objectType: data.objectType, sourceId: data.sourceId,
        reason: data.reason, conflictType: data.type, source: data.source, createReadiness: data.createReadiness,
        candidates: data.candidates ?? [], evidence: data.evidence, proposedChanges: data.proposedChanges,
        conflictId: text(persisted?.id),
        mappings: data.objectType === 'companies' ? ctx.mappings?.organizations : ctx.mappings?.contacts })
    }
  }
  await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: data.objectType,
    source_id: data.sourceId, outcome: ctx.mode === 'dry_run' ? 'dry_run' : 'conflict',
    sanitized_details: { reason: data.reason, conflictType: data.type,
      ...(ctx.mode === 'dry_run' ? { proposedAction: 'review_conflict' } : {}) } })
}

// Create readiness for a new record at live capture: the shared helper with this run's cache (ctx).
function captureCreateReadiness(deps, ctx, { objectType, sourceId, organization = null }) {
  return computeCaptureReadiness({ albi: deps.albi, hubspot: deps.hubspot }, ctx, { objectType, sourceId, organization,
    portalId: ctx.portalId, organizationMappings: ctx.mappings?.organizations })
}

async function resolveOrganization(deps, ctx, source) {
  const sourceId = idOf(source)
  const { companyId, portalId, mappings, indexes, runId } = ctx
  // A company HubSpot merged from a mapped record is read under that record's mapping for the rest of this run.
  mappings.organizations = followOrganizationMerge(mappings.organizations, source, portalId)
  const evaluation = evaluateOrganizationReview({ source, candidates: indexes.organizations, portalId,
    mappings: mappings.organizations, optionMappings: mappings.options })
  if (evaluation.outcome === 'needs_review') {
    await conflict(deps, ctx, { objectType: 'companies', sourceId, type: evaluation.conflictType, source, ...evaluation })
    return { id: sourceId, action: 'conflict', outcome: evaluation.outcome,
      reason: evaluation.conflictType === 'organization_fields' ? 'organization_fields_require_review' : evaluation.reason }
  }
  if (evaluation.outcome === 'safe_to_link') {
    const targetId = actionTarget(evaluation, indexes.organizations,
      mappingFor(mappings.organizations, portalId, sourceId), 'albi_organization_id')
    if (ctx.mode !== 'dry_run' && !mappingFor(mappings.organizations, portalId, sourceId)) {
      const saved = await deps.repository.saveMapping(companyId, 'organization', { portal_id: portalId, hubspot_id: sourceId,
        albi_organization_id: targetId, match_method: 'automatic' })
      mappings.organizations.push(saved)
    }
    await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: 'companies', source_id: sourceId,
      albi_target_type: 'organization', albi_target_id: targetId,
      outcome: ctx.mode === 'dry_run' ? 'dry_run' : 'linked', sanitized_details: { reason: evaluation.reason,
        ...(ctx.mode === 'dry_run' ? { proposedAction: 'link_organization' } : {}) } })
    const candidate = indexes.organizations.find(item => idOf(item) === targetId)
    const types = candidate?.organizationTypeIds ?? []
    return { id: sourceId, action: 'link', outcome: 'safe_to_link', targetId,
      organizationTypeId: types.length === 1 ? String(types[0]) : null }
  }
  const orgTypeId = option(mappings.options, 'default_organization_type')
  if (ctx.mode === 'dry_run') {
    await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: 'companies', source_id: sourceId,
      outcome: 'dry_run', sanitized_details: { proposedAction: 'create_organization', organizationTypeId: String(orgTypeId) } })
    return { id: sourceId, action: 'conflict', outcome: 'safe_to_create', reason: 'dry_run_preview', organizationTypeId: String(orgTypeId) }
  }
  // Live sync never creates Albi records: a new organization waits for a reviewer in the live review queue.
  // outcome stays safe_to_create so a contact behind it is evaluated (and held) the same way as in the dry run.
  await conflict(deps, ctx, { objectType: 'companies', sourceId, type: 'identity', reason: 'new_record_needs_review',
    source, candidates: [], evidence: evaluation.evidence, proposedChanges: evaluation.proposedChanges,
    createReadiness: await captureCreateReadiness(deps, ctx, { objectType: 'companies', sourceId }) })
  return { id: sourceId, action: 'conflict', outcome: 'safe_to_create', reason: 'new_record_needs_review',
    organizationTypeId: String(orgTypeId) }
}

async function resolveContact(deps, ctx, source, organization, associatedCompanyIds = [], organizationChoice = null, availableCompanies = []) {
  const sourceId = idOf(source)
  const { companyId, portalId, mappings, indexes, runId } = ctx
  const evaluation = evaluateContactReview({ source, candidates: indexes.contacts, portalId,
    mappings: mappings.contacts, optionMappings: mappings.options,
    associatedCompanyIds, organization, organizationChoice, availableCompanies, companyId })
  if (evaluation.outcome === 'needs_review') {
    await conflict(deps, ctx, { objectType: 'contacts', sourceId, type: evaluation.conflictType, source, ...evaluation })
    return { id: sourceId, action: 'conflict', reason: evaluation.conflictType === 'contact_fields'
      ? 'contact_fields_require_review' : evaluation.reason === 'albi_contact_association_contract_unverified'
        ? 'association_contract_unverified' : evaluation.reason }
  }
  if (evaluation.outcome === 'safe_to_link') {
    const targetId = actionTarget(evaluation, indexes.contacts,
      mappingFor(mappings.contacts, portalId, sourceId), 'albi_contact_id')
    if (ctx.mode !== 'dry_run' && !mappingFor(mappings.contacts, portalId, sourceId)) {
      const saved = await deps.repository.saveMapping(companyId, 'contact', { portal_id: portalId, hubspot_id: sourceId,
        albi_contact_id: targetId, match_method: 'automatic' })
      mappings.contacts.push(saved)
    }
    await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: 'contacts', source_id: sourceId,
      albi_target_type: 'contact', albi_target_id: targetId,
      outcome: ctx.mode === 'dry_run' ? 'dry_run' : 'linked', sanitized_details: { reason: evaluation.reason,
        ...(ctx.mode === 'dry_run' ? { proposedAction: 'link_contact' } : {}) } })
    return { id: sourceId, action: 'link', targetId }
  }
  const type = resolveContactType({ mappings: mappings.options,
    inheritFromOrganization: true, organizationTypeId: organization?.organizationTypeId })
  if (ctx.mode === 'dry_run') {
    await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: 'contacts', source_id: sourceId,
      outcome: 'dry_run', sanitized_details: { proposedAction: 'create_contact', contactTypeId: type.contactTypeId } })
    return { id: sourceId, action: 'conflict', reason: 'dry_run_preview' }
  }
  // Live sync never creates Albi records: a new contact waits for a reviewer in the live review queue.
  await conflict(deps, ctx, { objectType: 'contacts', sourceId, type: 'identity', reason: 'new_record_needs_review',
    source, candidates: [], evidence: evaluation.evidence, proposedChanges: evaluation.proposedChanges,
    createReadiness: await captureCreateReadiness(deps, ctx, { objectType: 'contacts', sourceId, organization }) })
  return { id: sourceId, action: 'conflict', reason: 'new_record_needs_review' }
}

async function processActivity(deps, ctx, activity, deadline) {
  const { companyId, runId, portalId, mappings } = ctx
  const sourceId = idOf(activity)
  if (await deps.repository.isSkippedItem?.(companyId, portalId, activity.objectType, sourceId)) {
    await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: activity.objectType,
      source_id: sourceId, outcome: 'skipped', sanitized_details: { reason: 'reviewer_skipped' } })
    return true
  }
  if (activity.objectType === 'emails' && activity.properties?.hs_email_direction !== 'EMAIL') {
    await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: 'emails', source_id: sourceId,
      outcome: 'skipped', sanitized_details: { reason: 'not_verified_direct_crm_email' } })
    return true
  }
  const associations = await retryRead(deps, () => deps.hubspot.getAssociations({ objectType: activity.objectType,
    objectIds: [sourceId], toObjectTypes: ['contacts', 'companies'] }), deadline)
  const contactIds = associations.find(row => row.toObjectType === 'contacts')?.toIds ?? []
  const companyIds = associations.find(row => row.toObjectType === 'companies')?.toIds ?? []
  const contactCompanyLinks = []
  for (let start = 0; start < contactIds.length; start += 100) {
    contactCompanyLinks.push(...await retryRead(deps, () => deps.hubspot.getAssociations({ objectType: 'contacts',
      objectIds: contactIds.slice(start, start + 100), toObjectTypes: ['companies'] }), deadline))
  }
  const allCompanyIds = [...new Set([...companyIds, ...contactCompanyLinks.flatMap(row => row.toIds ?? [])])]
  const [contacts, companies] = await Promise.all([
    contactIds.length ? retryRead(deps, () => deps.hubspot.getContacts(contactIds), deadline) : [],
    allCompanyIds.length ? retryRead(deps, () => deps.hubspot.getCompanies(allCompanyIds), deadline) : [],
  ])
  // Resolve each associated organization before any contact. A conflicting organization
  // never suppresses independent safe contacts or organizations in the same source item.
  const organizationBySourceId = new Map()
  for (const source of companies) {
    try { organizationBySourceId.set(idOf(source), await resolveOrganization(deps, ctx, source)) }
    catch (error) {
      if (error instanceof ReviewCaptureError) throw error
      await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: 'companies', source_id: idOf(source),
        outcome: 'failed', sanitized_details: safeFailure(error) })
      organizationBySourceId.set(idOf(source), { id: idOf(source), action: 'conflict', reason: safeError(error) })
    }
  }
  if (capturesReview(ctx)) {
    for (const id of allCompanyIds) {
      if (!companies.some(source => idOf(source) === id)) {
        await conflict(deps, ctx, { objectType: 'companies', sourceId: id,
          type: 'missing_source', reason: 'missing_hubspot_company' })
      }
    }
  }
  const organizations = companyIds.map(id => organizationBySourceId.get(id) ?? { id, action: 'conflict', reason: 'missing_hubspot_company' })
  const contactsResolved = []
  for (const id of contactIds) {
    const source = contacts.find(record => idOf(record) === id)
    if (!source) {
      try {
        await conflict(deps, ctx, { objectType: 'contacts', sourceId: id, type: 'missing_source', reason: 'missing_hubspot_contact' })
        contactsResolved.push({ id, action: 'conflict', reason: 'missing_hubspot_contact' })
      } catch (error) {
        // Like the create branches: a capture failure fails this item and holds the activity, not the run.
        if (error instanceof ReviewCaptureError) throw error
        await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: 'contacts', source_id: id,
          outcome: 'failed', sanitized_details: safeFailure(error) })
        contactsResolved.push({ id, action: 'conflict', reason: safeError(error) })
      }
      continue
    }
    try {
      const linkedIds = contactCompanyLinks.find(row => row.fromId === id)?.toIds ?? []
      const associatedIds = linkedIds.length ? linkedIds : companyIds
      const choiceKey = JSON.stringify([portalId, id])
      if (!ctx.organizationChoices.has(choiceKey)) {
        const repository = deps.resolutionRepository ?? deps.repository
        // Cache the read itself so failures also remain fail closed without
        // repeatedly querying the same scoped contact during this run.
        ctx.organizationChoices.set(choiceKey, Promise.resolve().then(() => typeof repository.getContactOrganizationChoice === 'function'
          ? repository.getContactOrganizationChoice(companyId, portalId, id) : null))
      }
      const choice = await ctx.organizationChoices.get(choiceKey)
      // Activity company context is still a fallback, but it cannot establish
      // the direct association required for a saved reviewed choice.
      const organizationChoice = linkedIds.length ? choice : null
      const context = selectReviewedOrganizationContext({ associatedCompanyIds: associatedIds, choice: organizationChoice,
        availableCompanies: companies, companyId, portalId, contactId: id })
      const organization = context.companyId
        ? organizationBySourceId.get(context.companyId) ?? { id: context.companyId, action: 'conflict', reason: 'missing_hubspot_company' }
        : null
      contactsResolved.push(await resolveContact(deps, ctx, source, organization, associatedIds, organizationChoice, companies))
    } catch (error) {
      if (error instanceof ReviewCaptureError) throw error
      await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: 'contacts', source_id: idOf(source),
        outcome: 'failed', sanitized_details: safeFailure(error) })
      contactsResolved.push({ id: idOf(source), action: 'conflict', reason: safeError(error) })
    }
  }
  const resolved = resolveActivityTargets({ contacts: contactsResolved, organizations })
  for (const targetConflict of resolved.conflicts) await conflict(deps, ctx, { objectType: activity.objectType,
    sourceId, type: 'activity_target', reason: targetConflict.reason })
  const activityType = resolveActivityType({ mappings: mappings.options, objectType: activity.objectType })
  if (activityType.action !== 'resolved') {
    await conflict(deps, ctx, { objectType: activity.objectType, sourceId, type: 'configuration', reason: activityType.reason })
    return ctx.mode === 'dry_run'
  }
  if (ctx.mode === 'dry_run') {
    for (const target of resolved.targets) await recordOnce(deps.repository, companyId, runId, { portal_id: portalId,
      object_type: activity.objectType, source_id: sourceId, albi_target_type: target.type, albi_target_id: target.id,
      outcome: 'dry_run', sanitized_details: { proposedAction: 'deliver_activity', occurredAt: activity.occurredAt } })
    return true
  }
  let allResolved = resolved.conflicts.length === 0 &&
    [...organizationBySourceId.values()].every(organization => organization.action === 'link')
  for (const target of resolved.targets) {
    try {
      const store = deps.repository.deliveryStore(companyId)
      const identity = { companyId, portalId, objectType: activity.objectType, activityId: sourceId,
        albiTargetType: target.type, albiTargetId: target.id }
      const reservation = await reserveDelivery({ identity, store, albi: deps.albi, now: nowIso(deps) })
      if (reservation.disposition === 'delivered' || reservation.disposition === 'reconciled') {
        await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: activity.objectType,
          source_id: sourceId, albi_target_type: target.type, albi_target_id: target.id,
          outcome: reservation.disposition === 'reconciled' ? 'reconciled' : 'skipped',
          sanitized_details: { reason: reservation.disposition === 'reconciled' ? 'delivery_reconciled' : 'already_delivered' } })
        continue
      }
      if (reservation.disposition !== 'reserved' || reservation.safeToCreate !== true) { allResolved = false; continue }
      const props = sourceFields(activity)
      const owner = ctx.owners.get(text(props.hubspot_owner_id))
      const payload = buildAlbiActivity({ objectType: activity.objectType, activityId: sourceId,
        occurredAt: activity.occurredAt, activityTypeId: activityType.activityTypeId, target,
        ownerName: owner ? [owner.firstName, owner.lastName].filter(Boolean).join(' ') : null,
        subject: props.hs_meeting_title ?? props.hs_call_title ?? props.hs_email_subject,
        body: props.hs_meeting_body ?? props.hs_call_body ?? props.hs_email_text ?? props.hs_communication_body ?? props.hs_note_body,
        outcome: props.hs_meeting_outcome ?? props.hs_call_disposition,
        ...(activity.objectType === 'emails' ? { emailEvidence: { source: 'hubspot_crm_engagement', objectType: 'emails', direction: 'EMAIL' } } : {}) })
      let result, error
      try { result = await deps.albi.createActivity(payload) } catch (caught) { error = caught }
      const completed = await completeDelivery({ reservation, store, albi: deps.albi, result, error, now: nowIso(deps) })
      if (!['delivered', 'reconciled'].includes(completed.disposition)) allResolved = false
      await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: activity.objectType,
        source_id: sourceId, albi_target_type: target.type, albi_target_id: target.id,
        activity_delivery_id: completed.delivery?.id ?? null,
        outcome: completed.disposition === 'reconciled' ? 'reconciled' : completed.disposition === 'delivered' ? 'delivered' : 'failed',
        sanitized_details: { reason: completed.disposition,
          ...(error && !['delivered', 'reconciled'].includes(completed.disposition) ? safeScope(error) : {}) } })
    } catch (error) {
      allResolved = false
      await recordOnce(deps.repository, companyId, runId, { portal_id: portalId, object_type: activity.objectType,
        source_id: sourceId, albi_target_type: target.type, albi_target_id: target.id,
        outcome: 'failed', sanitized_details: safeFailure(error) })
    }
  }
  const delivered = allResolved && resolved.targets.length > 0
  // Delivered: the activity's own held rows are settled. Best effort, so it never fails the delivery.
  if (delivered && typeof deps.repository.resolveActivityConflicts === 'function') {
    await deps.repository.resolveActivityConflicts(companyId, { portalId, objectType: activity.objectType, activityId: sourceId, runId })
      .catch(() => {})
  }
  return delivered
}

// Delivers the activities of pending conflict releases one after another under the caller's lease. A release whose
// activity is delivered (or no longer exists in HubSpot) is done; one still held goes to the back of the line, so it
// never blocks the rest. Each release is settled on its own; a failure never stops the drain.
export const RESUME_DRAIN_MARGIN_MS = 60000
async function drainConflictResumes(deps, ctx, { exclude = null, deadline }) {
  const repo = deps.repository
  if (!['listPendingConflictResumes', 'claimConflictResume', 'finishConflictResume'].every(name => typeof repo[name] === 'function')) return
  const seen = new Set(exclude ? [exclude] : [])
  while (clockMs(deps) < deadline - RESUME_DRAIN_MARGIN_MS) {
    let page
    try { page = await repo.listPendingConflictResumes(ctx.companyId, 50) } catch { return }
    const next = (Array.isArray(page) ? page : []).find(row => row?.id && !seen.has(row.id))
    if (!next) return
    seen.add(next.id)
    const owner = randomUUID()
    let claimed = null
    try { claimed = await repo.claimConflictResume(ctx.companyId, next.id, owner, 600) } catch { continue }
    if (!claimed) continue
    let done = false
    try {
      if (!['link_existing', 'create_new'].includes(claimed.resolution_action)) done = false
      else if (!claimed.activity_object_type || !claimed.activity_id) done = true
      else {
        const activity = await deps.hubspot.getActivity(claimed.activity_object_type, claimed.activity_id)
        if (!activity || String(activity.id) !== claimed.activity_id) done = true
        else { ctx.activity = activity; done = await processActivity(deps, ctx, activity, deadline) }
      }
    } catch { done = false }
    try { await repo.finishConflictResume(ctx.companyId, next.id, owner, done, done ? null : 'dispatch_not_accepted') } catch { /* The lease expires for a retry. */ }
  }
}

export async function runCompanySync(deps, input = {}) {
  const { companyId, mode, trigger, runId = null } = input
  if (typeof companyId !== 'string' || !companyId.trim() || !['dry_run', 'live', 'backfill'].includes(mode) ||
    !['manual', 'scheduled', 'resume', 'conflict_resolution'].includes(trigger)) throw new TypeError('Invalid sync request')
  const repo = deps.repository
  if (!repo) throw new TypeError('A repository is required')
  const ownerToken = deps.ownerToken ?? randomUUID()
  const acquired = await repo.claimLease(companyId, ownerToken, 900)
  if (!acquired) return { status: 'already_running', companyId }
  let run, ctx, primaryError = null, status = 'completed', totals = {}, continuation = false, response, continuationPayload
  const budget = Math.max(1000, Math.min(13 * 60_000, input.timeBudgetMs ?? 13 * 60_000))
  const deadline = clockMs(deps) + budget
  try {
    const config = await repo.getConfig(companyId)
    if (!config?.portal_id || !config?.selected_start_date || config.preflight_status !== 'valid' ||
      (mode === 'dry_run' ? !['dry_run', 'ready', 'live'].includes(config.state) : config.state !== 'live')) {
      throw new Error('H2A company configuration is not ready for this run')
    }
    run = await repo.startRun(companyId, { runId, mode, trigger, requestedBy: input.requestedBy ?? null,
      schedulerClaimId: input.schedulerClaimId ?? null, resumeId: input.resumeId ?? null })
    if (input.resumeId && !['queued', 'running', 'paused', 'partially_failed', 'failed'].includes(run.status)) {
      return { status: 'already_accepted', companyId, runId: run.id, resumeId: input.resumeId }
    }
    if (run.cancel_requested_at) {
      totals = await repo.totals(companyId, run.id, mode)
      status = 'cancelled'
      await repo.finishRun(companyId, run.id, status, totals)
      return { status, companyId, runId: run.id, totals, newConflictCount: 0, continuation: false }
    }
    const storedSampleLimit = run.sample_limit_per_type
    if (storedSampleLimit != null && (mode !== 'dry_run' || !Number.isInteger(storedSampleLimit) ||
      storedSampleLimit < 1 || storedSampleLimit > 50)) throw new Error('Run has an invalid sample boundary')
    const sampleLimitPerType = storedSampleLimit ?? null
    const mappings = await repo.getMappings(companyId)
    const indexes = { contacts: await listAll(deps, deps.albi, 'listContacts', deadline),
      organizations: await listAll(deps, deps.albi, 'listOrganizations', deadline) }
    let owners = []
    try { owners = deps.hubspot.listOwners ? await retryRead(deps, () => deps.hubspot.listOwners(), deadline) : [] }
    catch { /* Owner names are optional metadata; activity sync remains eligible. */ }
    ctx = { companyId, runId: run.id, portalId: config.portal_id, mode, mappings, indexes, sampleLimitPerType,
      reviewCaptureVersion: run.mode === 'dry_run' ? run.review_capture_version : null,
      capturedReviewIdentities: new Set(),
      organizationChoices: new Map(),
      owners: new Map(owners.map(owner => [String(owner.id), owner])), activity: null, newConflictCount: 0 }
    if (input.resumeId) {
      const intent = await repo.getConflictResume(companyId, input.resumeId)
      if (!intent || intent.company_id !== companyId || !['pending', 'dispatched'].includes(intent.status) ||
        !['link_existing', 'create_new'].includes(intent.resolution_action)) throw new Error('Targeted resume intent is unavailable')
      if (intent.activity_object_type && intent.activity_id) {
        const activity = await deps.hubspot.getActivity(intent.activity_object_type, intent.activity_id)
        if (!activity || String(activity.id) !== intent.activity_id) throw new Error('Targeted HubSpot activity is unavailable')
        ctx.activity = activity
        await processActivity(deps, ctx, activity, deadline)
      }
      const targeted = await repo.totals(companyId, run.id, mode)
      if (targeted.failed || targeted.conflict) await repo.requeueConflictResume?.(companyId, input.resumeId)
      // Only one run holds the company, so other releases dispatched alongside this one were refused as already
      // running. Deliver them here, with the Albi read already made, rather than one per hourly attempt.
      await drainConflictResumes(deps, ctx, { exclude: input.resumeId, deadline })
      totals = await repo.totals(companyId, run.id, mode)
      status = totals.failed || totals.conflict ? 'partially_failed' : 'completed'
      await repo.finishRun(companyId, run.id, status, totals)
      return { status, companyId, runId: run.id, resumeId: input.resumeId, totals, newConflictCount: ctx.newConflictCount, continuation: false }
    }
    for (const objectType of HUBSPOT_ACTIVITY_TYPES) {
      if (clockMs(deps) >= deadline - 5000) { continuation = true; break }
      // Dry and live runs both keep a per-run bookmark, so a run resumed after its time limit continues where it
      // stopped. (A live run's durable cursor stops at its first held activity; resuming from it repeated work forever.)
      const runCheckpoint = (mode === 'dry_run' || mode === 'live') && typeof repo.getRunCheckpoint === 'function'
        ? await repo.getRunCheckpoint(companyId, run.id, objectType) : null
      if (runCheckpoint?.completed) continue
      let sampleProcessedCount = sampleLimitPerType === null ? 0 : runCheckpoint?.processedCount ?? 0
      if (sampleLimitPerType !== null && sampleProcessedCount >= sampleLimitPerType) {
        await repo.saveRunCheckpoint(companyId, run.id, objectType, { upperBound: runCheckpoint?.upperBound ??
          new Date((deps.now?.() ?? new Date()).getTime() + 1).toISOString(), pageAfter: null,
        processedCount: sampleProcessedCount, completed: true })
        continue
      }
      const seeds = mode === 'backfill' ? await repo.listBackfillWindows(companyId, objectType) : [null]
      const windows = seeds.flatMap(seed => {
        if (!seed) return [null]
        const days = planBackfillWindows({ startDate: pacificBusinessDate(seed.start_at),
          endDate: pacificBusinessDate(seed.end_at), objectType, maxWindows: 3660 })
          .filter(day => !seed.checkpoint_timestamp || Date.parse(seed.checkpoint_timestamp) < Date.parse(day.endAt))
        return days.map((day, index) => ({ ...seed, start_at: day.startAt, end_at: day.endAt, isLastDay: index === days.length - 1 }))
      })
      const blockedSeeds = new Set()
      for (const window of windows) {
        if (clockMs(deps) >= deadline - 5000) { continuation = true; break }
        const lowerBound = window?.start_at ?? pacificStartOfDate(config.selected_start_date)
        const upperBound = window?.end_at ?? (runCheckpoint?.upperBound
          ? runCheckpoint.upperBound : new Date((deps.now?.() ?? new Date()).getTime() + 1).toISOString())
        let checkpoint = window?.checkpoint_timestamp ? { timestamp: window.checkpoint_timestamp, objectId: window.checkpoint_object_id }
          : mode === 'live' ? await repo.getCursor(companyId, objectType)
            : runCheckpoint?.timestamp && runCheckpoint?.objectId
              ? { timestamp: runCheckpoint.timestamp, objectId: runCheckpoint.objectId } : null
        const liveRun = mode === 'live' && !window
        // How far this live run has already got (every activity handled, held or not).
        let runBoundary = liveRun && runCheckpoint?.timestamp && runCheckpoint?.objectId
          ? { timestamp: runCheckpoint.timestamp, objectId: runCheckpoint.objectId } : null
        let after = mode === 'dry_run' || liveRun ? runCheckpoint?.pageAfter ?? null : null
        // A resumed live run that had passed a held activity keeps its durable cursor where it stopped.
        let blocked = window ? blockedSeeds.has(window.id) : Boolean(runBoundary && !(checkpoint && compareBoundary(checkpoint, runBoundary) >= 0))
        let pendingOutcomes = []
        const seen = new Set()
        for (let pageNo = 0; pageNo < 1000; pageNo += 1) {
          if (clockMs(deps) >= deadline - 5000) { continuation = true; break }
          const sampleRemaining = sampleLimitPerType === null ? null : sampleLimitPerType - sampleProcessedCount
          const page = await retryRead(deps, () => deps.hubspot.listActivities({ objectType,
            occurredAtGte: mode === 'dry_run' ? lowerBound : readStartWithOverlap(checkpoint, lowerBound), occurredAtLt: upperBound,
            ...(after ? { after } : {}), limit: sampleLimitPerType ?? 100 }), deadline)
          if (!Array.isArray(page?.records)) throw new Error('HubSpot returned an invalid activity page')
          const outcomes = []
          const eligibleRecords = sampleLimitPerType !== null && objectType === 'emails'
            ? page.records.filter(activity => activity.properties?.hs_email_direction === 'EMAIL')
            : page.records
          const boundedRecords = sampleLimitPerType === null ? eligibleRecords : eligibleRecords.slice(0, sampleLimitPerType)
          for (const activity of [...boundedRecords].sort((a, b) => {
            const t = Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
            return t || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
          })) {
            if (clockMs(deps) >= deadline - 5000) { continuation = true; break }
            if (!activity.occurredAt || Date.parse(activity.occurredAt) < Date.parse(lowerBound) ||
              Date.parse(activity.occurredAt) >= Date.parse(upperBound)) continue
            const itemBoundary = { timestamp: activity.occurredAt, objectId: String(activity.id) }
            if (runBoundary && compareBoundary(itemBoundary, runBoundary) <= 0) continue
            if (checkpoint && !blocked && (mode === 'dry_run'
              ? compareBoundary(itemBoundary, checkpoint) <= 0
              : Date.parse(activity.occurredAt) <= Date.parse(checkpoint.timestamp) && itemBoundary.objectId === checkpoint.objectId)) continue
            if (sampleRemaining !== null && outcomes.length >= sampleRemaining) break
            ctx.activity = activity
            try {
              const resolved = await processActivity(deps, ctx, activity, deadline)
              outcomes.push({ ...itemBoundary, resolved })
            } catch (error) {
              if (capturesReview(ctx) || error instanceof ReviewCaptureError) throw error
              await recordOnce(repo, companyId, run.id, { portal_id: config.portal_id, object_type: objectType,
                source_id: String(activity.id), outcome: mode === 'dry_run' ? 'dry_run' : 'failed',
                sanitized_details: { reason: safeError(error),
                  ...(mode === 'dry_run' ? { proposedAction: 'review_conflict' } : {}) } })
              outcomes.push({ ...itemBoundary, resolved: mode === 'dry_run' })
            }
          }
          if (mode === 'dry_run') {
            if (sampleLimitPerType !== null) sampleProcessedCount += outcomes.length
            const next = advanceCheckpoint({ current: checkpoint, items: outcomes })
            if (continuation) {
              await repo.saveRunCheckpoint(companyId, run.id, objectType, { upperBound, pageAfter: after,
                processedCount: sampleProcessedCount, ...(next ?? {}), completed: false })
              checkpoint = next
            } else if (page.after && sampleLimitPerType === null) {
              await repo.saveRunCheckpoint(companyId, run.id, objectType, { upperBound, pageAfter: page.after,
                processedCount: sampleProcessedCount, completed: false })
              checkpoint = null
            } else if (page.after && sampleProcessedCount < sampleLimitPerType) {
              await repo.saveRunCheckpoint(companyId, run.id, objectType, { upperBound, pageAfter: page.after,
                processedCount: sampleProcessedCount, completed: false })
              checkpoint = null
            } else {
              await repo.saveRunCheckpoint(companyId, run.id, objectType, { upperBound, pageAfter: null,
                processedCount: sampleProcessedCount, completed: true })
              checkpoint = null
            }
          } else if (!blocked) {
            const combined = [...pendingOutcomes, ...outcomes]
            const maxTimestamp = combined.length ? Math.max(...combined.map(item => Date.parse(item.timestamp))) : null
            const ready = page.after && maxTimestamp !== null
              ? combined.filter(item => Date.parse(item.timestamp) < maxTimestamp) : combined
            pendingOutcomes = page.after && maxTimestamp !== null
              ? combined.filter(item => Date.parse(item.timestamp) === maxTimestamp) : []
            const next = advanceCheckpoint({ current: checkpoint, items: ready })
            if (next && (!checkpoint || next.timestamp !== checkpoint.timestamp || next.objectId !== checkpoint.objectId)) {
              if (window) await repo.saveBackfillWindow(companyId, window.id, { checkpoint_timestamp: next.timestamp,
                checkpoint_object_id: next.objectId, status: 'running', run_id: run.id })
              else await repo.saveCursor(companyId, objectType, next)
              checkpoint = next
            }
            if (ready.some(item => !item.resolved)) blocked = true
          }
          if (liveRun && typeof repo.saveRunCheckpoint === 'function') {
            runBoundary = advanceCheckpoint({ current: runBoundary, items: outcomes.map(item => ({ ...item, resolved: true })) })
            await repo.saveRunCheckpoint(companyId, run.id, objectType, { upperBound, pageAfter: continuation ? after : page.after ?? null,
              processedCount: 0, ...(runBoundary ?? {}), completed: !continuation && !page.after })
          }
          if (!(await repo.heartbeatLease(companyId, ownerToken, 900))) throw new Error('H2A lease was lost')
          if (continuation) break
          if (sampleLimitPerType !== null && sampleProcessedCount >= sampleLimitPerType) break
          if (!page.after) break
          if (seen.has(page.after)) throw new Error('HubSpot pagination repeated a cursor')
          seen.add(page.after)
          after = page.after
          if (pageNo === 999) throw new Error('HubSpot page limit exceeded')
        }
        if (continuation) break
        if (window && blocked) blockedSeeds.add(window.id)
        if (window?.isLastDay && !blockedSeeds.has(window.id)) await repo.saveBackfillWindow(companyId, window.id, { status: 'completed', run_id: run.id })
        if (blocked) status = 'partially_failed'
      }
      if (continuation) break
    }
    totals = await repo.totals(companyId, run.id, mode)
    if (totals.failed || totals.conflict) status = 'partially_failed'
    if (continuation) status = 'paused'
    await repo.finishRun(companyId, run.id, status, totals)
    if (status === 'completed' && capturesReview(ctx)) {
      try {
        const current = config.initial_start_locked_at
          ? await repo.getCurrentReviewSample(companyId, config.initial_start_locked_at) : null
        // An older continuation can finish after a newer sample. Only the
        // current completed set may replace details, while this lease is held.
        if (current?.id === run.id) await repo.pruneSupersededDryRunReviews(companyId, run.id)
      }
      catch (error) { logCleanupFailure(deps, 'dry_run_review_cleanup', error) }
    }
    response = { status, companyId, runId: run.id, totals, newConflictCount: ctx.newConflictCount, continuation }
    if (continuation) continuationPayload = { companyId, mode, trigger: 'resume', runId: run.id }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error('H2A run failed')
    if (run) {
      try {
        totals = await repo.totals(companyId, run.id, mode)
        await repo.finishRun(companyId, run.id, 'failed', totals, safeError(primaryError))
        primaryError.h2aPersistedFailure = { runId: run.id, totals, newConflictCount: ctx?.newConflictCount ?? 0 }
      } catch (persistError) { logCleanupFailure(deps, 'failure_persist', persistError) }
      if (input.resumeId) {
        try { await repo.requeueConflictResume?.(companyId, input.resumeId) }
        catch (cleanupError) { logCleanupFailure(deps, 'resume_requeue', cleanupError) }
      }
    }
    throw primaryError
  } finally {
    try { await repo.releaseLease(companyId, ownerToken) }
    catch (cleanupError) {
      logCleanupFailure(deps, 'lease_release', cleanupError)
      if (!primaryError) throw cleanupError
    }
  }
  // The next worker must not race the lease held by this invocation.
  if (continuationPayload) await deps.dispatchContinuation?.(continuationPayload)
  return response
}
