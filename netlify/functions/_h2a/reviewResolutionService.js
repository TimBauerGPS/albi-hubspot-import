import { loadCreateDefaults } from './createDefaults.js'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ApiError, isRecord, malformed } from './http.js'
import { H2AReviewError, resolveReviewSample } from './reviewService.js'
import { buildReviewResolutionPlan, hashResolutionDecision, normalizeResolutionDecision, safeResolutionEventDetails,
  safeResolutionExecutionContext, resolutionCanonicalField, RESOLUTION_EVENT_LIMIT } from './reviewResolution.js'
import { describeResolutionException, isResolutionProviderId } from './reviewResolution.js'
import { safeReviewSnapshot } from './review.js'
import { refreshReviewTriage } from './triage.js'
import { LIVE_CLOSE_FOR_ACTION, closeLiveReview } from './liveReview.js'
import { decideContactMatch, decideOrganizationMatch, selectAllReviewCandidates } from './match.js'
import { normalizePhone } from './normalize.js'
import { loadReviewResolutionOptions } from './reviewResolutionOptions.js'
import { followOrganizationMerge } from './organizationMerges.js'
import { H2A_REVIEW_ERROR_CATEGORIES, H2A_REVIEW_ERROR_CODES } from '../../../shared/h2aReviewReasons.js'

const fail = (status, message) => { throw new H2AReviewError(status, message) }
// Each freshness rejection names its check (and differing field names, never values) for the audit.
const stale = (check = 'other', fields = []) => {
  const error = new H2AReviewError(409, 'This sample review changed. Refresh and confirm the resolution again.')
  error.staleCheck = check
  error.staleFields = fields
  throw error
}
// A live row has no sample: its 409s use kind-neutral copy. The audit (staleCheck/staleFields) is unchanged.
export const LIVE_STALE_MESSAGE = 'This record changed. Refresh and confirm the resolution again.'
function asLiveConflict(error) {
  if (!(error instanceof H2AReviewError)) return error
  error.reviewKind = 'live'
  if (error.statusCode !== 409 || !/sample review|this sample/i.test(error.message)) return error
  return Object.assign(new H2AReviewError(409, LIVE_STALE_MESSAGE), { staleCheck: error.staleCheck, staleFields: error.staleFields, reviewKind: 'live' })
}
const differingFields = (left, right) => [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])]
  .filter(key => !isDeepStrictEqual(left?.[key], right?.[key])).sort()
const terminal = row => ['completed', 'superseded'].includes(row.status)
const clock = deps => (deps.clockMs ?? Date.now)()

// These are wrappers over the existing tenant-scoped mapping RPC, not new storage paths.
export function createReviewResolutionCapabilities(repository) {
  return Object.freeze({
    createReviewResolution: repository.createReviewResolution.bind(repository),
    claimReviewResolution: repository.claimReviewResolution.bind(repository),
    finishReviewResolution: repository.finishReviewResolution.bind(repository),
    appendReviewResolutionEvent: repository.appendReviewResolutionEvent.bind(repository),
    saveContactMapping: (companyId, row, approveManyToOne = false, forceResolutionId = null) => repository.saveMapping(companyId, 'contact', row,
      { approveManyToOne, forceResolutionId }),
    saveOrganizationMapping: (companyId, row, approveManyToOne = false, forceResolutionId = null) => repository.saveMapping(companyId, 'organization', row,
      { approveManyToOne, forceResolutionId }),
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
  const providerStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status : undefined
  const providerReason = typeof error?.providerReason === 'string' && error.providerReason.length <= 200
    ? error.providerReason : undefined
  const providerShape = typeof error?.providerShape === 'string' && error.providerShape.length <= 240
    ? error.providerShape : undefined
  return { category, code, ...(providerStatus ? { providerStatus } : {}), ...(providerReason ? { providerReason } : {}),
    ...(providerShape ? { providerShape } : {}),
    ...(typeof error?.staleCheck === 'string' ? { staleCheck: error.staleCheck, staleFields: error.staleFields ?? [] } : {}),
    // Not a provider error: keep what was thrown so the failure can be diagnosed.
    ...(category === 'error' ? { exception: describeResolutionException(error) } : {}) }
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
  // Recheck captures the snapshot with the single-record read; compare against the same read.
  const direct = type === 'contacts' ? clients.hubspotRead.getContact : clients.hubspotRead.getCompany
  const rows = typeof direct === 'function'
    ? await bounded(deps, async () => { const record = await direct.call(clients.hubspotRead, id); return record === null ? [] : [record] }, deadline)
    : await bounded(deps, () => type === 'contacts' ? clients.hubspotRead.getContacts([id]) : clients.hubspotRead.getCompanies([id]), deadline)
  if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => !isRecord(row) || row.id !== id ||
    row.archived === true || !isRecord(row.properties))) malformed('resolution')
  return rows[0] ?? null
}

// A create that a recheck cleared as safe to create within this window already had all of Albi checked for a
// duplicate; re-reading every Albi contact before writing took ~30s and drew Albi rate limits.
const TRUSTED_RECHECK_MS = 24 * 3600000
// How long after a timed-out create Albi's list is trusted to show it, if it was made.
const UNKNOWN_CREATE_SETTLE_MS = 5 * 60000

async function evidence(deps, clients, row, decision, deadline, { live = false } = {}) {
  const source = await sourceRead(deps, clients, row.object_type, row.source_id, deadline)
  if (!source) fail(409, 'The HubSpot source is no longer available. Recheck this review.')
  const loaded = await deps.repository.getMappings(row.company_id)
  if (!loaded || !['contacts', 'organizations', 'options'].every(key => Array.isArray(loaded[key]))) malformed('resolution')
  // A company HubSpot merged from a mapped record is read under that record's mapping.
  const mappings = row.object_type === 'companies'
    ? { ...loaded, organizations: followOrganizationMerge(loaded.organizations, source, row.portal_id) } : loaded
  if (decision.referralSourceId !== undefined) {
    const sources = await bounded(deps, () => clients.albiRead.listReferralSources(), deadline)
    if (!Array.isArray(sources) || !sources.some(option => option?.id === decision.referralSourceId)) {
      fail(409, 'The selected referral source is no longer available in Albi. Reload this record and choose again.')
    }
  }
  let createDefaults = null
  if (['create_albi', 'force_create_albi'].includes(decision.action)) {
    createDefaults = await bounded(deps, () => loadCreateDefaults({ hubspotRead: clients.hubspotRead, albiRead: clients.albiRead,
      objectType: row.object_type, sourceId: row.source_id }), deadline)
  }
  let associatedCompanyIds = []
  if (row.object_type === 'contacts') {
    const records = await bounded(deps, () => clients.hubspotRead.getAssociations({ objectType: 'contacts', objectIds: [row.source_id], toObjectTypes: ['companies'] }), deadline)
    if (!Array.isArray(records) || records.length !== 1 || records[0]?.fromId !== row.source_id ||
      records[0]?.toObjectType !== 'companies' || !Array.isArray(records[0]?.toIds) ||
      records[0].toIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))) malformed('resolution')
    associatedCompanyIds = [...new Set(records[0].toIds)]
  }
  const capturedForceCreate = decision.action === 'force_create_albi'
  // A field resolution where HubSpot wins every field writes nothing anywhere: it only produces a manual
  // Albi task. It can use the captured Albi record instead of re-walking the whole (slow, flaky) Albi list;
  // a later recheck verifies the result against live data.
  const capturedManualOnly = decision.action === 'resolve_fields' &&
    Object.values(decision.fieldChoices ?? {}).every(winner => winner === 'hubspot')
  // An email-match link only saves our mapping; it is verified live by the recheck that follows.
  const capturedEmailLink = decision.action === 'link_existing' && (decision.ignoreContactDifferences === true || Array.isArray(decision.ignoredFields))
  const rechecked = Date.parse(row.last_rechecked_at ?? '')
  const recentlyClearedCreate = !live && decision.action === 'create_albi' && row.status === 'cleared' &&
    row.recheck_outcome === 'safe_to_create' && Array.isArray(row.candidate_snapshots) && row.candidate_snapshots.length === 0 &&
    Number.isFinite(rechecked) && clock(deps) - rechecked >= 0 && clock(deps) - rechecked < TRUSTED_RECHECK_MS
  const captured = capturedForceCreate || capturedManualOnly || capturedEmailLink || recentlyClearedCreate
  // A batch passes one shared Albi read (deps.albiSnapshot) so each record is checked without re-walking Albi.
  const shared = kind => deps.albiSnapshot && Array.isArray(deps.albiSnapshot[kind]) ? structuredClone(deps.albiSnapshot[kind]) : null
  const contacts = row.object_type === 'contacts'
    ? captured ? structuredClone(row.candidate_snapshots) : shared('contacts') ?? await listAll(deps, args => clients.albiRead.listContacts(args), deadline)
    : []
  // A contact create uses the reviewed organization mapping (org-first) rather than scanning every Albi organization.
  const mappedOrganizationsOnly = capturedForceCreate || decision.action === 'create_albi' && row.object_type === 'contacts'
  const needsOrganizations = !captured && !mappedOrganizationsOnly &&
    (row.object_type === 'companies' || decision.action === 'choose_organization' || decision.action === 'create_albi')
  const organizations = needsOrganizations
    ? shared('organizations') ?? await listAll(deps, args => clients.albiRead.listOrganizations(args), deadline)
    : captured && row.object_type === 'companies' ? structuredClone(row.candidate_snapshots) : []
  const candidates = row.object_type === 'contacts' ? contacts : organizations
  const organizationEvidence = []
  const organizationSources = [...new Set([...associatedCompanyIds,
    ...(decision.action === 'choose_organization' ? [decision.organizationSourceId] : [])])]
  for (const id of organizationSources) {
    const company = await sourceRead(deps, clients, 'companies', id, deadline)
    if (!company) continue
    const rows = followOrganizationMerge(mappings.organizations, company, row.portal_id)
    if (mappedOrganizationsOnly) {
      const mapped = rows.filter(mapping => mapping.hubspot_id === id && mapping.portal_id === row.portal_id)
      if (mapped.length > 1) stale('mapping')
      if (mapped.length === 1 && isResolutionProviderId(mapped[0].albi_organization_id)) {
        organizationEvidence.push({ source: company, targetId: mapped[0].albi_organization_id, organizationTypeId: null })
      }
      continue
    }
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
    else if (match.action !== 'create') stale('candidates')
  }
  return { source, albi: candidates.find(item => item.id === targetId), candidates, mappings,
    associatedCompanyIds, organizations: organizationEvidence, ...(createDefaults?.ok ? { createDefaults } : {}), createDefaultsReady: createDefaults?.ok === true }
}

function planEvidence(row, decision, current, hubspot, albi) {
  return { review: { objectType: row.object_type, sourceId: row.source_id, portalId: row.portal_id,
    reason: row.reason, status: row.status, recheckOutcome: row.recheck_outcome ?? null, candidateSnapshots: row.candidate_snapshots, proposedChanges: row.proposed_changes },
  hubspot, ...(albi ? { albi } : {}), decision,
  mappings: row.object_type === 'contacts' ? current.mappings.contacts : current.mappings.organizations,
  optionMappings: current.mappings.options, associatedCompanyIds: current.associatedCompanyIds,
  organizations: current.organizations, portalId: row.portal_id, ...(current.createDefaults ? { createDefaults: current.createDefaults } : {}) }
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

function assertComparison(row, current, plan, replay, verifiedCreateTargetId = null) {
  const source = structuredClone(current.source)
  if (replay && plan.verification.properties) {
    // Allow only the exact intended write result to differ from the captured source.
    const expectedSource = row.source_snapshot
    for (const [key, value] of Object.entries(plan.verification.properties)) {
      if (!Object.hasOwn(source.properties, key)) stale('source', [key])
      if ((source.properties[key] === null ? '' : source.properties[key]) !== value) continue
      const field = resolutionCanonicalField(row.object_type, key)
      if (field) source.properties[key] = expectedSource[field] ?? ''
    }
  }
  const liveSource = safeReviewSnapshot(source, row.object_type)
  if (!isDeepStrictEqual(liveSource, row.source_snapshot)) stale('source', differingFields(liveSource, row.source_snapshot))
  if (current.albi && ['resolve_fields', 'link_existing'].includes(plan.action)) {
    const before = row.candidate_snapshots?.find(item => item.id === current.albi.id)
    if (!before) stale('target')
    // A link writes no fields (only the mapping), so Albi edits since review never make it stale.
    // A field resolution writes from the reviewed values, so any target change does.
    const liveTarget = safeReviewSnapshot(current.albi, row.object_type)
    if (plan.action === 'resolve_fields' && !isDeepStrictEqual(liveTarget, safeReviewSnapshot(before, row.object_type))) {
      stale('target', differingFields(liveTarget, safeReviewSnapshot(before, row.object_type)))
    }
  }
  if (['resolve_fields', 'link_existing'].includes(plan.action) && !current.albi) stale('target_missing')
  if (plan.action === 'force_create_albi') {
    const matchInput = { source: current.source, sourceId: row.source_id, candidates: current.candidates,
      mappings: row.object_type === 'contacts' ? current.mappings.contacts : current.mappings.organizations, portalId: row.portal_id }
    const decision = (row.object_type === 'contacts' ? decideContactMatch : decideOrganizationMatch)(matchInput)
    const selected = selectAllReviewCandidates(matchInput, decision, row.object_type === 'contacts' ? 'contact' : 'organization')
      .map(item => item.id).filter(id => id !== verifiedCreateTargetId)
      .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
    if (!isDeepStrictEqual(selected, plan.ignoredCandidateIds)) stale('candidates')
    for (const candidateId of plan.ignoredCandidateIds) {
      const before = row.candidate_snapshots?.find(item => item.id === candidateId)
      const after = current.candidates.filter(item => item.id === candidateId)
      if (!before || after.length !== 1 ||
        !isDeepStrictEqual(safeReviewSnapshot(after[0], row.object_type), safeReviewSnapshot(before, row.object_type))) stale('candidates')
    }
  }
}

function propertiesMatch(source, properties) {
  return !!source && Object.entries(properties).every(([key, value]) => Object.hasOwn(source.properties, key) &&
    (source.properties[key] === null ? '' : source.properties[key]) === value)
}

function exactCreateTarget(row, plan, current, receiptId = null, requireReceipt = false) {
  const verify = plan.verification.create
  const rows = row.object_type === 'contacts' ? current.mappings.contacts : current.mappings.organizations
  let targetId = receiptId
  if (targetId) {
    const key = row.object_type === 'contacts' ? 'albi_contact_id' : 'albi_organization_id'
    if (rows.some(item => item[key] === targetId && (item.portal_id !== row.portal_id || item.hubspot_id !== row.source_id))) return null
  } else {
    if (requireReceipt) return null
    const match = (row.object_type === 'contacts' ? decideContactMatch : decideOrganizationMatch)({ source: { id: row.source_id, ...row.source_snapshot },
      candidates: current.candidates, mappings: rows, portalId: row.portal_id })
    if (match.action !== 'link') return null
    targetId = match.targetId
  }
  const matches = current.candidates.filter(item => item.id === targetId)
  if (matches.length !== 1) return null
  const target = matches[0]
  for (const [field, value] of Object.entries(verify.payload)) {
    // Albi list records do not echo the referral source, so it cannot be reconciled by reading.
    if (['referralSourceId', 'relationshipStatusId', 'salespersonId'].includes(field)) continue
    const actual = target[field === 'zipCode' ? 'zipcode' : field]
    if (field === 'phoneNumber') {
      if (!Object.hasOwn(target, field) || normalizePhone(actual).conflictReason || normalizePhone(actual).writable !== value) return null
    } else if (!isDeepStrictEqual(actual, value)) return null
  }
  if (verify.organizationId === null && target.organizationId != null && target.organizationId !== '') return null
  return target.id
}

// Whether an Albi record is the one a create payload would have made: same name (and email or phone when sent).
function madeFrom(record, payload, kind) {
  if (!payload || !isResolutionProviderId(record?.id)) return false
  const same = (a, b) => String(a ?? '').trim().toLocaleLowerCase('en-US') === String(b ?? '').trim().toLocaleLowerCase('en-US')
  // The type it was created with must be on it; a same-named record of another type is not this create.
  const typeKey = kind === 'contacts' ? 'contactTypeIds' : 'organizationTypeIds'
  if (Array.isArray(payload[typeKey]) && !(Array.isArray(record[typeKey]) && payload[typeKey].every(id => record[typeKey].map(String).includes(String(id))))) return false
  if (kind === 'contacts') {
    if (!same(record.firstName, payload.firstName) || !same(record.lastName, payload.lastName)) return false
    return payload.email ? same(record.email, payload.email) : true
  }
  if (!same(record.name, payload.name)) return false
  return payload.phoneNumber ? normalizePhone(record.phoneNumber ?? '').writable === payload.phoneNumber : true
}

function forcedReceiptTarget(row, current, receiptId) {
  if (!isResolutionProviderId(receiptId)) return null
  const rows = row.object_type === 'contacts' ? current.mappings.contacts : current.mappings.organizations
  const targetKey = row.object_type === 'contacts' ? 'albi_contact_id' : 'albi_organization_id'
  if (rows.some(item => item?.[targetKey] === receiptId &&
    (item.portal_id !== row.portal_id || item.hubspot_id !== row.source_id))) return null
  const sourceRows = rows.filter(item => item?.portal_id === row.portal_id && item?.hubspot_id === row.source_id)
  if (sourceRows.length > 1 || sourceRows.length === 1 && sourceRows[0]?.[targetKey] !== receiptId) return null
  return receiptId
}

async function saveLocal(caps, row, plan, actorId, resolutionId, targetId = plan.mapping?.targetId) {
  if (plan.mapping) {
    if (!targetId) malformed('resolution')
    await caps[row.object_type === 'contacts' ? 'saveContactMapping' : 'saveOrganizationMapping'](row.company_id,
      { portal_id: row.portal_id, hubspot_id: row.source_id,
        [row.object_type === 'contacts' ? 'albi_contact_id' : 'albi_organization_id']: targetId, match_method: 'reviewed', reviewed_by: actorId },
      plan.mapping.approveManyToOne, plan.action === 'force_create_albi' ? resolutionId : null)
  }
  if (plan.organizationChoice) {
    const result = await caps.upsertContactOrganizationChoice(row.company_id, { portalId: row.portal_id, ...plan.organizationChoice, actorId })
    if (result?.error) fail(409, 'Unable to save the organization choice.')
  }
}

// Kind comes from the stored row. Live rows are checked against the configured portal only; their
// open status is enforced by the create RPC (so exact replays still return) and by stillCurrent.
async function currentReview(deps, companyId, reviewId) {
  const stored = typeof deps.repository.getReview === 'function' ? await deps.repository.getReview(companyId, reviewId) : null
  if (stored?.review_kind === 'live') {
    if (!['contacts', 'companies'].includes(stored.object_type)) fail(404, 'Review item not found.')
    const config = await deps.repository.getConfig(companyId)
    if (!config?.portal_id || stored.portal_id !== config.portal_id) {
      try { stale('portal') } catch (error) { throw asLiveConflict(error) }
    }
    return { config, row: { ...stored, company_id: companyId } }
  }
  const resolved = await resolveReviewSample(deps.repository, companyId)
  if (!resolved.sample) fail(409, 'This sample is no longer current. Run a new sample review.')
  const row = await deps.repository.getDryRunReview(companyId, resolved.sample.id, reviewId)
  if (!row || !['contacts', 'companies'].includes(row.object_type)) fail(404, 'Sample review item not found.')
  if (row.portal_id !== resolved.config.portal_id) stale('portal')
  return { ...resolved, row: { ...row, company_id: companyId } }
}

// Sample rows are current while their sample is the latest completed one. Live rows are current while
// open: a newer sample never supersedes them; reread so a close by sync or another reviewer is seen.
async function stillCurrent(deps, row, config) {
  if (row.review_kind === 'live') {
    const fresh = typeof deps.repository.getReview === 'function' ? await deps.repository.getReview(row.company_id, row.id) : row
    return fresh?.review_kind === 'live' && fresh.status === 'needs_review'
  }
  const latest = await deps.repository.getLatestCompletedSampleDryRun(row.company_id, config.initial_start_locked_at)
  return latest?.id === row.run_id && latest.review_capture_version === 1
}

const closeDeps = deps => ({ repository: deps.liveCloseRepository ?? deps.repository, dispatchResume: deps.dispatchResume })

// The resolution is already durable when this runs. A failed close is reported, never thrown: the
// completed resolution on a still-open live row is the marker settleLiveReviewClose retries from.
async function closeSafely(deps, args) {
  try { return await closeLiveReview(closeDeps(deps), args) } catch { return { error: 'close_failed' } }
}

async function reloadReview(deps, companyId, row) {
  return typeof deps.repository.getReview === 'function' ? await deps.repository.getReview(companyId, row.id) ?? row : row
}

// A completed reviewer resolution that should have closed this still-open live row (the close
// failed or was interrupted) is closed now. Idempotent through the close RPC's replay.
export async function settleLiveReviewClose(deps, { companyId, row, actorId }) {
  if (row?.review_kind !== 'live' || row.status !== 'needs_review') return null
  const repository = deps.resolutionRepository ?? deps.repository
  if (typeof repository?.getCurrentReviewResolution !== 'function') return null
  const saved = await repository.getCurrentReviewResolution(companyId, row.id)
  const mapped = saved?.status === 'completed' ? LIVE_CLOSE_FOR_ACTION[saved.action] : null
  if (!mapped) return null
  const close = await closeLiveReview(closeDeps(deps), { companyId, reviewId: row.id, actorId: saved.created_by ?? actorId, ...mapped })
  return { resolution: saved, close, review: await reloadReview(deps, companyId, row) }
}

// After a live recheck wrote its evaluation: an open resolution is finished like a sample clear,
// then the row closes as the reviewer's own link/create when that resolution completed, else as
// resolved_by_sync, or as source_missing. Without a close outcome the row stays open.
export async function finalizeLiveRecheck(deps, ids, review, closeOutcome) {
  if (!closeOutcome) {
    const finalized = await finalizeRecheckedResolution(deps, ids, review)
    return { resolution: finalized?.resolution ?? null, review }
  }
  const repository = deps.resolutionRepository ?? deps.repository
  let saved = typeof repository?.getCurrentReviewResolution === 'function'
    ? await repository.getCurrentReviewResolution(ids.companyId, ids.reviewId) : null
  if (saved && !terminal(saved)) {
    const finished = await finalizeRecheckedResolution(deps, ids,
      { ...review, status: closeOutcome === 'source_missing' ? 'no_longer_in_scope' : 'cleared' })
    if (finished?.resolution) saved = finished.resolution
  }
  const own = closeOutcome === 'resolved_by_sync' && saved?.status === 'completed' ? LIVE_CLOSE_FOR_ACTION[saved.action] : null
  const args = own?.outcome === 'resolved' ? own
    : closeOutcome === 'source_missing' ? { outcome: 'source_missing', resolutionAction: 'skip' } : { outcome: 'resolved_by_sync', resolutionAction: null }
  const close = await closeSafely(deps, { companyId: ids.companyId, reviewId: ids.reviewId, actorId: ids.actorId, ...args })
  return { resolution: saved, close, review: await reloadReview(deps, ids.companyId, review) }
}

// Skip on a live row: no provider work. The audited resolution completes, then the close RPC marks
// every linked conflict skipped and writes the skipped ledger.
async function runLiveSkip(deps, input, saved, context) {
  const caps = createReviewResolutionCapabilities(deps.repository), owner = randomUUID()
  const claimed = rpc(await caps.claimReviewResolution(input.companyId, saved.id, owner, input.actorId, 120))
  if (claimed.execution_phase !== 'applying') fail(409, 'This resolution cannot be applied.')
  if (claimed.lease_owner !== owner || !Number.isFinite(Date.parse(claimed.lease_expires_at)) ||
    Date.parse(claimed.lease_expires_at) <= clock(deps)) fail(409, 'The resolution lease expired. Refresh and try again.')
  const row = context.row
  const finish = async (status, code) => rpc(await caps.finishReviewResolution(input.companyId, claimed.id, owner,
    { actorId: input.actorId, status, eventType: status, providerOutcomeCode: code,
      details: safeResolutionEventDetails({ code, ...(code === 'skipped' ? { outcome: 'skipped' } : {}) }) }))
  if (row.review_kind !== 'live' || !await stillCurrent(deps, row, context.config)) {
    const resolution = await finish('superseded', 'superseded')
    await refreshReviewTriage(deps.triageRepository ?? deps.repository, { companyId: input.companyId, row, resolutionStatus: resolution.status })
    return { resolution }
  }
  const resolution = await finish('completed', 'skipped')
  const close = await closeSafely(deps, { companyId: input.companyId, reviewId: row.id, actorId: input.actorId,
    outcome: 'skipped', resolutionAction: 'skip' })
  return { resolution, close }
}

async function runClaim(deps, input, saved, context) {
  const caps = createReviewResolutionCapabilities(deps.repository), owner = randomUUID()
  const claimed = rpc(await caps.claimReviewResolution(input.companyId, saved.id, owner, input.actorId, 120))
  const phase = claimed.execution_phase
  if (!['applying', 'waiting_on_albi', 'ready_to_recheck'].includes(phase)) fail(409, 'This resolution cannot be applied.')
  if (claimed.lease_owner !== owner || !Number.isFinite(Date.parse(claimed.lease_expires_at)) ||
    Date.parse(claimed.lease_expires_at) <= clock(deps)) fail(409, 'The resolution lease expired. Refresh and try again.')
  const row = context.row
  const finish = async (status, eventType, code = eventType, details = {}) => {
    const finished = { resolution: rpc(await caps.finishReviewResolution(
      input.companyId, claimed.id, owner, { actorId: input.actorId, status, eventType, providerOutcomeCode: code,
        details: safeResolutionEventDetails({ ...details, code }) })) }
    await refreshReviewTriage(deps.triageRepository ?? deps.repository, { companyId: input.companyId, row,
      resolutionStatus: finished.resolution.status ?? status })
    return finished
  }
  const live = row.review_kind === 'live'
  // A live row closed while this waited (e.g. by sync) completes the wait rather than superseding it.
  if (live && phase !== 'applying' && ['cleared', 'no_longer_in_scope'].includes(row.status)) return finish('completed', 'completed')
  if (!await stillCurrent(deps, row, context.config) || saved.run_id !== row.run_id) return finish('superseded', 'superseded')
  if (phase !== 'applying' && ['cleared', 'no_longer_in_scope'].includes(row.status)) return finish('completed', 'completed')
  const deadline = Math.min(Date.parse(claimed.lease_expires_at) - 1000,
    clock(deps) + Math.min(60000, Math.max(1, deps.deadlineMs ?? 60000)))
  let clients, current, plan, reconciled = false
  try {
    const events = await bounded(deps, () => deps.repository.listReviewResolutionEvents(input.companyId, saved.id), deadline)
    if (!Array.isArray(events)) malformed('resolution')
    let persistedIndex = -1
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].event_type === 'claimed' && events[index].sanitized_details?.executionContext) {
        persistedIndex = index
        break
      }
    }
    const persisted = persistedIndex >= 0 ? events[persistedIndex] : null
    const receipts = [...new Set(events.map(event => event.sanitized_details?.createReceiptId).filter(Boolean))]
    if (receipts.length > 1) malformed('resolution')
    let createReceiptId = receipts[0] ?? null
    if (!persisted && events.length >= RESOLUTION_EVENT_LIMIT) throw new ApiError('permanent', { code: 'operation_failed' })
    // A provider validation response is definitive: Albi rejected the request and
    // did not return a create receipt. Rebuild the plan so a corrected deployment
    // can safely retry the same audited decision. Ambiguous failures still keep
    // their immutable context and are never blindly repeated.
    // The same holds for a failure that happened before any write (a stale check, e.g. a possible duplicate
    // appeared) and for Albi's rate limit (a 429 is a refusal, not a partial write): with no receipt, plan again.
    const rebuildAfterValidation = !createReceiptId && ['create_albi', 'force_create_albi'].includes(saved.action) &&
      events.slice(persistedIndex + 1).some(event => event.event_type === 'failed' &&
        (['validation', 'rate_limit'].includes(event.sanitized_details?.category) || typeof event.sanitized_details?.staleCheck === 'string'))
    let contextPlan = persisted && !rebuildAfterValidation
      ? safeResolutionExecutionContext(persisted.sanitized_details.executionContext) : null
    if (persisted && !rebuildAfterValidation && !contextPlan || contextPlan && (contextPlan.decisionHash !== hashResolutionDecision(saved.decision) ||
      contextPlan.action !== saved.action || contextPlan.providerOperation?.id && contextPlan.providerOperation.id !== saved.source_id ||
      contextPlan.mapping && contextPlan.mapping.sourceId !== saved.source_id ||
      contextPlan.verification.create && (contextPlan.verification.create.sourceId !== saved.source_id ||
        contextPlan.verification.create.portalId !== saved.portal_id))) malformed('resolution')
    clients = deps.getResolutionClients ? await bounded(deps, () => deps.getResolutionClients(input.companyId, context.config), deadline) : deps
    // A create that timed out (or lost its connection) with no receipt may or may not have been made. Look for it in
    // Albi: one exact new record is that create (link it); none means it was not made (plan it again).
    const timedOut = contextPlan && !createReceiptId && ['create_albi', 'force_create_albi'].includes(saved.action) &&
      events.slice(persistedIndex + 1).some(event => event.event_type === 'failed' && event.sanitized_details?.category === 'transient')
    if (timedOut) {
      const kind = row.object_type === 'contacts' ? 'contacts' : 'organizations'
      const live = await listAll(deps, args => kind === 'contacts' ? clients.albiRead.listContacts(args) : clients.albiRead.listOrganizations(args), deadline)
      const ignored = new Set(contextPlan.ignoredCandidateIds ?? [])
      const found = live.filter(record => record && !ignored.has(record.id) && madeFrom(record, contextPlan.providerOperation?.payload, kind))
      if (found.length > 1) throw new ApiError('permanent', { code: 'operation_failed' })
      if (found.length === 1) {
        createReceiptId = found[0].id
        await caps.appendReviewResolutionEvent(input.companyId, saved.id, { actorId: input.actorId, eventType: 'claimed', details: { createReceiptId } })
      } else {
        // Albi's list can lag a fresh create, so "not found" only counts once the attempt is a few minutes old.
        const failedAt = Math.max(...events.slice(persistedIndex + 1).filter(event => event.event_type === 'failed')
          .map(event => Date.parse(event.created_at ?? '')).filter(Number.isFinite), -Infinity)
        if (Number.isFinite(failedAt) && clock(deps) - failedAt >= UNKNOWN_CREATE_SETTLE_MS) contextPlan = null
      }
    }
    current = await evidence(deps, clients, row, saved.decision, deadline)
    if (phase !== 'applying') return finish(phase, phase === 'waiting_on_albi' ? 'waiting_on_albi' : 'recheck_requested')
    if (row.updated_at !== saved.expected_review_updated_at) stale('review')
    if (contextPlan) {
      plan = contextPlan
      if (saved.action === 'resolve_fields') {
        const original = { ...row.source_snapshot }
        for (const [field, change] of Object.entries(row.proposed_changes?.conflicts ?? {})) {
          if (Object.hasOwn(change, 'proposed')) original[field] = change.proposed ?? ''
        }
        const proof = safeResolutionExecutionContext(buildReviewResolutionPlan(planEvidence(row, saved.decision, current, original, current.albi)))
        if (!isDeepStrictEqual(proof, contextPlan)) stale('plan')
      }
      if (saved.action === 'link_existing') {
        // The approval is durable; ownership can still change between attempts.
        buildReviewResolutionPlan(planEvidence(row, saved.decision, current, current.source, current.albi))
      }
    } else {
      // A reconciling retry keeps its persisted proof; only a fresh plan needs current defaults.
      if (['create_albi', 'force_create_albi'].includes(saved.action) && !current.createDefaultsReady) {
        fail(409, 'Required Albi create defaults are unavailable. Reload this record to see what is missing.')
      }
      // Validate raw live evidence before using captured projections. Missing and
      // overlength fields cannot become empty/truncated writes.
      const livePlan = safeResolutionExecutionContext(buildReviewResolutionPlan(planEvidence(row, saved.decision, current, current.source, current.albi)))
      plan = safeResolutionExecutionContext(capturedPlan(row, saved.decision, current))
      if (!plan) malformed('resolution')
      if (!isDeepStrictEqual(livePlan, plan)) {
        const planFields = value => ({ ...Object.fromEntries((value?.manualTasks ?? []).flatMap(task => task.fields.map(item => [item.field, item.value]))),
          ...(value?.providerOperation?.properties ?? {}) })
        stale('plan', differingFields(planFields(livePlan), planFields(plan)))
      }
    }
    const verifiedReceiptTarget = plan.action === 'force_create_albi' && createReceiptId
      ? forcedReceiptTarget(row, current, createReceiptId) : null
    if (plan.action === 'force_create_albi' && createReceiptId && !verifiedReceiptTarget) {
      throw new ApiError('permanent', { code: 'operation_failed' })
    }
    assertComparison(row, current, plan, !!contextPlan, verifiedReceiptTarget)
    if (!await stillCurrent(deps, row, context.config)) return finish('superseded', 'superseded')
    // Revalidate the review after HTTP reads and before obtaining a mutation method.
    const newest = await deps.repository.getDryRunReview(input.companyId, row.run_id, row.id)
    if (!newest || newest.updated_at !== row.updated_at) stale('review')
    if (!contextPlan) await caps.appendReviewResolutionEvent(input.companyId, saved.id,
      { actorId: input.actorId, eventType: 'claimed', details: { executionContext: plan } })
    const operation = plan.providerOperation
    if (operation) {
      // Albi pagination can be slow. Refresh the source comparison at the write
      // boundary so intervening source edits require a new confirmation.
      current.source = await sourceRead(deps, clients, row.object_type, row.source_id, deadline)
      if (!current.source) stale('source')
      assertComparison(row, current, plan, true, verifiedReceiptTarget)
      if (plan.action === 'force_create_albi') {
        const mappings = await bounded(deps, () => deps.repository.getMappings(row.company_id), deadline)
        if (!mappings || !['contacts', 'organizations', 'options'].every(key => Array.isArray(mappings[key]))) malformed('resolution')
        current.mappings = mappings
        const rows = row.object_type === 'contacts' ? mappings.contacts : mappings.organizations
        const mapped = rows.filter(item => item.portal_id === row.portal_id && item.hubspot_id === row.source_id)
        const key = row.object_type === 'contacts' ? 'albi_contact_id' : 'albi_organization_id'
        if (mapped.length > 1 || mapped.length === 1 && mapped[0][key] !== verifiedReceiptTarget) stale('mapping')
      }
    }
    let createTarget = null
    if (operation?.provider === 'albi') {
      // A receipt Albi returned is that record, whether or not Albi's list shows it (or shows it exactly).
      createTarget = plan.action === 'force_create_albi' || createReceiptId
        ? forcedReceiptTarget(row, current, createReceiptId)
        : exactCreateTarget(row, plan, current, createReceiptId, false)
      // An earlier attempt on this record that Albi already answered with a receipt (but that ended failed, for
      // example before receipts were trusted) is that record: link it rather than create a second one.
      if (!createTarget && !contextPlan && !createReceiptId && typeof deps.repository.listPriorCreateReceipts === 'function') {
        const prior = await bounded(deps, () => deps.repository.listPriorCreateReceipts(input.companyId, row.id), deadline)
        if (!Array.isArray(prior)) malformed('resolution')
        const receipts = [...new Set(prior.filter(isResolutionProviderId))]
        if (receipts.length > 1) throw new ApiError('permanent', { code: 'operation_failed' })
        if (receipts.length === 1) {
          createTarget = forcedReceiptTarget(row, current, receipts[0])
          if (!createTarget) throw new ApiError('permanent', { code: 'operation_failed' })
          createReceiptId = receipts[0]
          await caps.appendReviewResolutionEvent(input.companyId, saved.id,
            { actorId: input.actorId, eventType: 'claimed', details: { createReceiptId } })
        }
      }
      if (createTarget) reconciled = true
      else if (contextPlan) throw new ApiError('permanent', { code: 'operation_failed' })
      else if (plan.action !== 'force_create_albi') {
        // A new create cannot override newly appeared or contradictory identity evidence.
        const matched = (row.object_type === 'contacts' ? decideContactMatch : decideOrganizationMatch)({ source: current.source,
          candidates: current.candidates, mappings: row.object_type === 'contacts' ? current.mappings.contacts : current.mappings.organizations, portalId: row.portal_id })
        if (matched.action !== 'create') stale('candidates')
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
        else {
          const receipt = await bounded(deps, () => clients.albiWrite[operation.operation](operation.payload), deadline)
          if (!isResolutionProviderId(receipt?.id)) malformed('resolution')
          createReceiptId = receipt.id
          // This event is durable before any verification read. A retry can
          // identify the exact new record even when names are not unique keys.
          await caps.appendReviewResolutionEvent(input.companyId, saved.id,
            { actorId: input.actorId, eventType: 'claimed', details: { createReceiptId } })
          // With a shared batch read, add the created record (receipt id + the exact payload Albi accepted) to it, so
          // this record verifies and later records in the batch see it as a possible duplicate.
          if (deps.albiSnapshot) {
            const kind = row.object_type === 'contacts' ? 'contacts' : 'organizations'
            const created = { id: receipt.id }
            for (const [key, value] of Object.entries(operation.payload)) created[key === 'zipCode' ? 'zipcode' : key] = structuredClone(value)
            if (!Array.isArray(deps.albiSnapshot[kind])) deps.albiSnapshot[kind] = []
            deps.albiSnapshot[kind].push(created)
          }
        }
      } catch (error) {
        // All ambiguous responses are verified by reads (always live). Permission/validation
        // failures still retain the intent and return a fixed, sanitized outcome.
        const after = await evidence(deps, clients, row, saved.decision, deadline, { live: true })
        createTarget = plan.verification.create ? plan.action === 'force_create_albi'
          ? forcedReceiptTarget(row, after, createReceiptId)
          : exactCreateTarget(row, plan, after, createReceiptId, false) : null
        const verified = plan.verification.properties ? propertiesMatch(after.source, plan.verification.properties)
          : plan.verification.association ? after.associatedCompanyIds.includes(plan.verification.association.companyId) : !!createTarget
        if (!verified) throw error
        reconciled = true
      }
      if (!reconciled && plan.verification.create && createReceiptId) {
        // Albi answered the create with the new record's id: that is the record. Albi's list can lag behind or
        // store a value slightly differently, so requiring the list to echo every field marked real creates as
        // failed (and left them unlinked). Only check that no other HubSpot record is linked to this id; the
        // recheck that follows compares fields as usual.
        const mappings = await deps.repository.getMappings(row.company_id)
        if (!mappings || !['contacts', 'organizations'].every(key => Array.isArray(mappings[key]))) malformed('resolution')
        createTarget = forcedReceiptTarget(row, { mappings }, createReceiptId)
        if (!createTarget) malformed('resolution')
      } else if (!reconciled) {
        const after = await evidence(deps, clients, row, saved.decision, deadline)
        createTarget = plan.verification.create ? plan.action === 'force_create_albi'
          ? forcedReceiptTarget(row, after, createReceiptId)
          : exactCreateTarget(row, plan, after, createReceiptId, false) : null
        const verified = plan.verification.properties ? propertiesMatch(after.source, plan.verification.properties)
          : plan.verification.association ? after.associatedCompanyIds.includes(plan.verification.association.companyId) : !!createTarget
        if (!verified) malformed('resolution')
      }
    }
    if (!await stillCurrent(deps, row, context.config)) return finish('superseded', 'superseded')
    await saveLocal(caps, row, plan, input.actorId, saved.id, createTarget ?? plan.mapping?.targetId)
  } catch (error) {
    const details = fixedFailure(error)
    const result = await finish(phase === 'applying' ? 'failed' : phase, 'failed', details.code, details)
    if (error instanceof H2AReviewError && error.statusCode === 409) throw error
    return result
  }
  // Keep storage failures outside the provider-error catch: a failed finalization
  // leaves a live/expired lease for reconciliation instead of pretending success.
  const forced = plan.action === 'force_create_albi'
  // Live link/create completes now and closes the row with every linked conflict (one resume each).
  const liveClose = live && !plan.manualTasks.length ? LIVE_CLOSE_FOR_ACTION[plan.action] : null
  if (liveClose) {
    const finished = await finish('completed', 'completed', forced ? 'forced_created' : plan.action === 'link_existing' ? 'linked' : 'created',
      forced ? { outcome: 'forced_created' } : {})
    return { ...finished, close: await closeSafely(deps, { companyId: input.companyId, reviewId: row.id, actorId: input.actorId, ...liveClose }) }
  }
  return finish(plan.verification.successStatus, plan.providerOperation ? reconciled ? 'provider_reconciled' : 'provider_applied'
    : plan.manualTasks.length ? 'waiting_on_albi' : 'recheck_requested', forced ? 'forced_created' : undefined,
  { manualTasks: plan.manualTasks, ...(forced ? { outcome: 'forced_created' } : {}) })
}

export async function executeReviewResolution(deps, input) {
  const decision = normalizeResolutionDecision(input.decision)
  const context = await currentReview(deps, input.companyId, input.reviewId)
  if (context.row.review_kind !== 'live') return executeOnReview(deps, input, decision, context)
  try { return await executeOnReview(deps, input, decision, context) } catch (error) { throw asLiveConflict(error) }
}

async function executeOnReview(deps, input, decision, context) {
  const live = context.row.review_kind === 'live'
  if (decision.action === 'skip_live' && !live) fail(400, 'Skip is only available for live reviews.')
  if (live) {
    // A completed resolution whose close failed is finished here instead of starting another decision.
    let settled = null
    try { settled = await settleLiveReviewClose(deps, { companyId: input.companyId, row: context.row, actorId: input.actorId }) }
    catch { const saved = await deps.repository.getCurrentReviewResolution(input.companyId, input.reviewId); return { resolution: saved, close: { error: 'close_failed' } } }
    if (settled) return { resolution: settled.resolution, close: settled.close }
  }
  // The atomic RPC checks exact replay before freshness, including older intents.
  // Its stale rejection occurs before provider capability construction.
  const caps = createReviewResolutionCapabilities(deps.repository)
  const created = await caps.createReviewResolution(input.companyId, { runId: context.row.run_id, reviewId: input.reviewId,
    portalId: context.row.portal_id, objectType: context.row.object_type, sourceId: context.row.source_id,
    actorId: input.actorId, expectedUpdatedAt: input.expectedUpdatedAt, clientRequestId: input.clientRequestId, decision })
  const saved = rpc(created)
  if (terminal(saved)) return { resolution: saved }
  if (live && context.row.status !== 'needs_review') stale('review')
  if (!live && context.row.status !== 'needs_review' && !(decision.action === 'create_albi' &&
    context.row.status === 'cleared' && context.row.recheck_outcome === 'safe_to_create') && !(decision.action === 'link_existing' &&
    context.row.status === 'cleared' && context.row.recheck_outcome === 'safe_to_link')) stale('review')
  if (saved.action === 'skip_live') return runLiveSkip(deps, input, saved, context)
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
  if (saved.action === 'skip_live') return runLiveSkip(deps, input, saved, context)
  return runClaim(deps, input, saved, context)
}

// Called only after production evaluation was atomically written to the review.
// It fetches the current durable row instead of trusting client completion flags.
export async function finalizeRecheckedResolution(deps, { companyId, reviewId, actorId }, review) {
  const repository = deps.resolutionRepository ?? deps.repository
  if (typeof repository.getCurrentReviewResolution !== 'function') return null
  const saved = await repository.getCurrentReviewResolution(companyId, reviewId)
  if (!saved || terminal(saved)) return saved ? { resolution: saved } : null
  const wasFailed = saved.status === 'failed'
  const owner = randomUUID()
  const claim = await repository.claimReviewResolution(companyId, saved.id, owner, actorId, 120)
  if (claim?.error === 'not_claimable' || claim?.error === 'review_busy') return null
  const claimed = rpc(claim)
  // A failed attempt wrote nothing we kept (a receipt it got is still found by the next create), so the recheck
  // closes it instead of relabeling it "ready to recheck", which made unfinished records look saved.
  const status = wasFailed ? 'superseded' : ['cleared', 'no_longer_in_scope'].includes(review.status) ? 'completed'
    : claimed.execution_phase === 'waiting_on_albi' ? 'waiting_on_albi' : 'ready_to_recheck'
  const eventType = status === 'superseded' ? 'superseded' : status === 'completed' ? 'completed' : status === 'waiting_on_albi' ? 'waiting_on_albi' : 'recheck_requested'
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

// Each org-first step has its own request id so each is a separately audited, idempotent resolution.
// The resolution store keys requests by uuid, so the `${clientRequestId}:org|contact` seed is hashed
// into a deterministic uuid rather than stored as the literal suffixed string.
export function orgFirstRequestId(clientRequestId, step) {
  const bytes = createHash('sha1').update(`${clientRequestId}:${step}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const reviewKind = row => row?.review_kind === 'live' ? 'live' : 'sample'
const NOT_ELIGIBLE = 'Creating with the organization is not available for this record.'

// Server-side eligibility: the contact waits only on this organization, the organization has no
// candidates and is itself ready to create, and both rows are the same kind in the same tenant.
async function assertOrgFirstEligible(deps, input) {
  const repository = deps.repository
  const [contact, organization] = await Promise.all([repository.getReview(input.companyId, input.contactReviewId),
    repository.getReview(input.companyId, input.organizationReviewId)])
  const open = row => row?.status === 'needs_review' || row?.status === 'cleared' && row.recheck_outcome === 'safe_to_create'
  if (!contact || !organization || contact.object_type !== 'contacts' || organization.object_type !== 'companies' ||
    reviewKind(contact) !== reviewKind(organization) || contact.portal_id !== organization.portal_id ||
    // Both versions are checked before the org create so a changed contact cannot leave an orphan Albi organization.
    contact.updated_at !== input.contactExpectedUpdatedAt || organization.updated_at !== input.organizationExpectedUpdatedAt ||
    !open(contact) || !open(organization) ||
    !Array.isArray(organization.candidate_snapshots) || organization.candidate_snapshots.length !== 0) fail(409, NOT_ELIGIBLE)
  const config = await repository.getConfig(input.companyId)
  if (!config?.portal_id || config.portal_id !== contact.portal_id) fail(409, NOT_ELIGIBLE)
  const reads = deps.getResolutionClients ? await deps.getResolutionClients(input.companyId, config) : deps
  const load = deps.loadResolutionOptions ?? loadReviewResolutionOptions
  const [contactOptions, organizationOptions] = await Promise.all([
    load({ row: { ...contact, company_id: input.companyId }, repository, reads }),
    load({ row: { ...organization, company_id: input.companyId }, repository, reads })])
  const blocked = contactOptions?.createReadiness
  if (blocked?.blockedReason !== 'organization_not_synced' || blocked.organization?.sourceId !== organization.source_id ||
    organizationOptions?.createReadiness?.ready !== true) fail(409, NOT_ELIGIBLE)
}

async function organizationMapped(deps, companyId, organizationReviewId) {
  const organization = await deps.repository.getReview(companyId, organizationReviewId)
  const mappings = await deps.repository.getMappings(companyId)
  return Boolean(organization && (mappings?.organizations ?? []).some(item =>
    item?.portal_id === organization.portal_id && item?.hubspot_id === organization.source_id))
}

// One reviewer choice, two audited creates: the organization first, then the contact against it.
// The contact step only runs when the organization step ended with its mapping saved: `completed`
// for live rows, `ready_to_recheck` (or `completed`) for sample rows.
export async function executeOrganizationThenContactCreate(deps, input) {
  const run = deps.executeResolution ?? executeReviewResolution
  const organizationRequestId = orgFirstRequestId(input.clientRequestId, 'org')
  const contactRequestId = orgFirstRequestId(input.clientRequestId, 'contact')
  const decision = { action: 'create_albi', referralSourceId: input.referralSourceId }
  // A replay already created the organization, so the contact is no longer waiting on it; the
  // eligibility check applies to the first attempt only and the engine replays by request id.
  const prior = await deps.repository.getCurrentReviewResolution(input.companyId, input.organizationReviewId)
  if (prior?.client_request_id !== organizationRequestId) await assertOrgFirstEligible(deps, input)
  let organization
  try {
    organization = await run(deps, { companyId: input.companyId, actorId: input.actorId, reviewId: input.organizationReviewId,
      expectedUpdatedAt: input.organizationExpectedUpdatedAt, clientRequestId: organizationRequestId, decision })
  } catch (error) { return { organization: { error }, contact: null } }
  const status = organization?.resolution?.status
  if (!['completed', 'ready_to_recheck'].includes(status) ||
    !await organizationMapped(deps, input.companyId, input.organizationReviewId)) return { organization, contact: null }
  try {
    const contact = await run(deps, { companyId: input.companyId, actorId: input.actorId, reviewId: input.contactReviewId,
      expectedUpdatedAt: input.contactExpectedUpdatedAt, clientRequestId: contactRequestId, decision })
    return { organization, contact }
  } catch (error) { return { organization, contact: { error } } }
}
