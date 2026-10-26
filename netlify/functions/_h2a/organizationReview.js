import { createH2AProviderClients } from './providerClients.js'
import { H2AReviewError, resolveReviewSample } from './reviewService.js'
import { safeReviewSnapshot } from './review.js'
import { followOrganizationMerge } from './organizationMerges.js'
import { ApiError } from './http.js'

const providerId = value => typeof value === 'string' && /^[1-9]\d{0,99}$/.test(value)
const fail = (status, message) => { throw new H2AReviewError(status, message) }

// Captures (or finds) the review for a contact's one unmapped organization so it can be created and
// audited on its own. Reads HubSpot only; the Albi create is a separate resolution on that review.
export async function prepareOrganizationReview({ repository, options, companyId, input }) {
  const { config, sample } = await resolveReviewSample(repository, companyId)
  if (!sample) fail(409, 'Run a new sample to create detailed review data.')
  const row = await repository.getDryRunReview(companyId, sample.id, input.reviewId)
  if (!row) fail(404, 'Sample review item not found.')
  if (row.object_type !== 'contacts' || row.updated_at !== input.expectedUpdatedAt ||
    !(row.status === 'needs_review' || row.status === 'cleared' && row.recheck_outcome === 'safe_to_create')) {
    fail(409, 'This sample review changed. Refresh it before preparing the organization.')
  }
  const clients = options.makeClients ? await options.makeClients(companyId) : await createH2AProviderClients({
    companyId, repository, keyring: options.keyring, env: options.env, fetch: options.fetch })
  if (!options.makeClients && (await clients.hubspot.getAccountInfo()).portalId !== config.portal_id) throw new ApiError('permission')
  const hubspotRead = { getAssociations: args => clients.hubspot.getAssociations(args), getCompanies: ids => clients.hubspot.getCompanies(ids) }
  const associations = await hubspotRead.getAssociations({ objectType: 'contacts', objectIds: [row.source_id], toObjectTypes: ['companies'] })
  const toIds = Array.isArray(associations) && associations.length === 1 && associations[0]?.fromId === row.source_id &&
    associations[0]?.toObjectType === 'companies' && Array.isArray(associations[0].toIds) ? [...new Set(associations[0].toIds)] : null
  if (!toIds || !toIds.length || !providerId(toIds[0])) fail(409, 'This contact has no associated organization.')
  const [sourceId] = toIds
  const mappings = await repository.getMappings(companyId)
  const mapped = (mappings?.organizations ?? []).some(item => item?.portal_id === row.portal_id && item?.hubspot_id === sourceId)
  const existing = await repository.findDryRunReviewBySource(companyId, sample.id, 'companies', sourceId)
  if (mapped || existing) return { sourceId, reviewId: existing?.id ?? null, mapped }
  const companies = await hubspotRead.getCompanies([sourceId])
  if (!Array.isArray(companies) || companies.length !== 1 || companies[0]?.id !== sourceId || companies[0]?.archived === true ||
    !companies[0]?.properties || typeof companies[0].properties !== 'object') fail(409, 'The associated organization is no longer available in HubSpot.')
  // A company HubSpot merged from a mapped record is already mapped through it; there is nothing to create.
  if (followOrganizationMerge(mappings?.organizations ?? [], companies[0], row.portal_id).some(item => item?.hubspot_id === sourceId)) {
    return { sourceId, reviewId: null, mapped: true }
  }
  const created = await repository.recordDryRunReview(companyId, { run_id: sample.id, portal_id: row.portal_id, object_type: 'companies',
    source_id: sourceId, reason: 'no_match', conflict_type: 'organization_match',
    source_snapshot: safeReviewSnapshot(companies[0], 'companies'), candidate_snapshots: [], match_evidence: { evidence: [] }, proposed_changes: {} })
  return { sourceId, reviewId: created.id, mapped: false }
}
