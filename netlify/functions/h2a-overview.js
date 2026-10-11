import { H2AAuthError, requireH2ARequest } from './_h2a/auth.js'

const RUN_SELECT = 'id,mode,trigger,status,totals,sample_limit_per_type,created_at,started_at,finished_at,error_summary'
const REVIEW_ITEM_SELECT = 'id,run_id,object_type,source_id,albi_target_type,albi_target_id,outcome,sanitized_details,created_at'
const RUN_FIELDS = ['id', 'mode', 'trigger', 'status', 'created_at', 'started_at', 'finished_at']
const TOTAL_FIELDS = new Set([
  'created', 'updated', 'linked', 'delivered', 'reconciled', 'skipped', 'conflict', 'failed', 'dry_run',
  'would_create_organizations', 'would_create_contacts', 'would_link', 'would_deliver_activities', 'requires_review',
])
const ACTIVE_STATUSES = ['queued', 'running', 'paused']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ERROR_CATEGORIES = Object.freeze({
  background_dispatch_failed: 'Background dispatch problem',
  already_running: 'Concurrent run prevented',
  'auth:operation_failed': 'Provider authorization problem',
  'permission:operation_failed': 'Provider permission problem',
  'validation:operation_failed': 'Provider validation problem',
  'permanent:operation_failed': 'Permanent provider problem',
  'transient:operation_failed': 'Temporary provider problem',
  'transient:timeout': 'Temporary provider problem',
  'transient:network': 'Temporary provider problem',
  'rate_limit:operation_failed': 'Provider rate limit',
})
const REVIEW_OBJECT_TYPES = Object.freeze({
  companies: 'organizations',
  company: 'organizations',
  organizations: 'organizations',
  organization: 'organizations',
  contacts: 'contacts',
  contact: 'contacts',
  meetings: 'meetings',
  meeting: 'meetings',
  calls: 'calls',
  call: 'calls',
  emails: 'emails',
  email: 'emails',
  communications: 'communications',
  communication: 'communications',
  notes: 'notes',
  note: 'notes',
})
const ATTENTION_REASONS = new Set([
  'missing_target',
  'multiple_candidates',
  'multiple_associated_organizations',
  'missing_hubspot_contact',
  'missing_hubspot_company',
  'contact_type_confirmation_required',
  'activity_type_confirmation_required',
  'organization_type_confirmation_required',
  'target_already_mapped',
  'duplicate_candidates',
  'email_phone_disagree',
  'unsupported_phone_evidence',
  'name_only_candidate',
  'missing_required_name',
  'contradictory_evidence',
  'albi_organization_update_contract_unverified',
  'nonblank_field_difference',
  'albi_contact_update_contract_unverified',
  'albi_contact_association_contract_unverified',
  'organization_fields_require_review',
  'contact_fields_require_review',
  'association_contract_unverified',
  'invalid_phone_length',
  'unsupported_international_format',
  'extension_not_supported',
])

export class H2AOverviewError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'H2AOverviewError'
    this.statusCode = statusCode
  }
}

function fail(statusCode, message) {
  throw new H2AOverviewError(statusCode, message)
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))) fail(400, 'Invalid overview cursor.')
  return value
}

function validateCursor(cursor) {
  if (cursor == null || cursor === '') return null
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).length !== 2 ||
    !UUID.test(cursor.id ?? '')) fail(400, 'Invalid overview cursor.')
  return { effectiveAt: validTimestamp(cursor.effectiveAt), id: cursor.id }
}

function effectiveAt(run) {
  return run?.started_at ?? run?.created_at ?? null
}

function sanitizeTotals(totals) {
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return {}
  return Object.fromEntries(Object.entries(totals).filter(([key, value]) =>
    TOTAL_FIELDS.has(key) && Number.isSafeInteger(value) && value >= 0))
}

export function sanitizeOverviewRun(run) {
  if (!run || typeof run !== 'object') return null
  const result = Object.fromEntries(RUN_FIELDS.filter(field => run[field] !== undefined).map(field => [field, run[field]]))
  result.totals = sanitizeTotals(run.totals)
  if (run.mode === 'dry_run' && Number.isInteger(run.sample_limit_per_type) &&
    run.sample_limit_per_type >= 1 && run.sample_limit_per_type <= 50) {
    result.sampleLimitPerType = run.sample_limit_per_type
  }
  const errorCategory = typeof run.error_summary === 'string' && Object.hasOwn(ERROR_CATEGORIES, run.error_summary)
    ? ERROR_CATEGORIES[run.error_summary]
    : null
  if (errorCategory) result.errorCategory = errorCategory
  return result
}

function resultIdentity(row) {
  return JSON.stringify([row.run_id, row.object_type, row.source_id, row.albi_target_type, row.albi_target_id])
}

export function aggregateSafeReviewBreakdowns(rows) {
  const latest = new Map()
  for (const row of [...(rows ?? [])].sort((left, right) =>
    Date.parse(left.created_at) - Date.parse(right.created_at) || String(left.id).localeCompare(String(right.id)))) {
    latest.set(resultIdentity(row), row)
  }

  const grouped = new Map()
  for (const row of latest.values()) {
    if (row?.outcome !== 'dry_run' || row?.sanitized_details?.proposedAction !== 'review_conflict' ||
      typeof row.run_id !== 'string') continue
    const rawReason = row.sanitized_details?.reason
    const reason = rawReason === 'dry_run_preview'
      ? 'planned_record_dependency'
      : ATTENTION_REASONS.has(rawReason) ? rawReason : 'other_review_reason'
    const objectType = typeof row.object_type === 'string' && Object.hasOwn(REVIEW_OBJECT_TYPES, row.object_type)
      ? REVIEW_OBJECT_TYPES[row.object_type]
      : 'other'
    const kind = rawReason === 'dry_run_preview'
      ? 'simulation'
      : objectType === 'contacts' || objectType === 'organizations' ? 'record' : 'activity'
    const key = JSON.stringify([row.run_id, kind, objectType, reason])
    const current = grouped.get(key)
    grouped.set(key, { runId: row.run_id, kind, objectType, reason, count: (current?.count ?? 0) + 1 })
  }

  const byRun = new Map()
  for (const { runId, ...item } of grouped.values()) {
    const items = byRun.get(runId) ?? []
    items.push(item)
    byRun.set(runId, items)
  }
  for (const items of byRun.values()) {
    items.sort((left, right) => left.kind.localeCompare(right.kind) ||
      left.objectType.localeCompare(right.objectType) || left.reason.localeCompare(right.reason))
  }
  return byRun
}

export async function getOverview({ repository, companyId, cursor = null, limit = 25 }) {
  if (typeof companyId !== 'string' || !companyId.trim()) fail(400, 'A valid company is required.')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'Overview page size must be between 1 and 100.')
  const before = validateCursor(cursor)
  const [page, activeRun, recentRun, lastSuccessfulRun, unresolvedConflictCount] = await Promise.all([
    repository.listRuns(companyId, { limit, before }),
    repository.getActiveRun(companyId),
    repository.getRecentRun(companyId),
    repository.getLastCompletedRun(companyId),
    repository.countOpenConflicts(companyId),
  ])
  const rows = Array.isArray(page?.items) ? page.items : []
  const selected = rows.slice(0, limit)
  const sampleRunIds = selected.filter(run => run?.mode === 'dry_run' && Number.isInteger(run?.sample_limit_per_type) &&
    run.sample_limit_per_type >= 1 && run.sample_limit_per_type <= 50 &&
    Number.isSafeInteger(run?.totals?.requires_review) && run.totals.requires_review > 0)
    .map(run => run.id).filter(id => typeof id === 'string')
  const reviewItems = sampleRunIds.length > 0 ? await repository.listSampleReviewItems(companyId, sampleRunIds) : []
  const reviewBreakdowns = aggregateSafeReviewBreakdowns(reviewItems)
  const last = selected.at(-1)
  return {
    summary: {
      activeRun: sanitizeOverviewRun(activeRun),
      recentRun: sanitizeOverviewRun(recentRun),
      lastSuccessfulRun: sanitizeOverviewRun(lastSuccessfulRun),
      unresolvedConflictCount: Number.isSafeInteger(unresolvedConflictCount) && unresolvedConflictCount >= 0
        ? unresolvedConflictCount : 0,
    },
    runs: selected.map(run => {
      const sanitized = sanitizeOverviewRun(run)
      const breakdown = reviewBreakdowns.get(run.id)
      if (breakdown?.length) sanitized.reviewBreakdown = breakdown
      return sanitized
    }),
    nextCursor: (page?.hasMore === true || rows.length > limit) && last
      ? { effectiveAt: effectiveAt(last), id: last.id }
      : null,
  }
}

function checked(result) {
  if (result?.error) throw result.error
  return result?.data
}

function scoped(supabase, companyId) {
  return supabase.from('h2a_sync_runs').select(RUN_SELECT).eq('company_id', companyId)
}

async function maybeOne(query) {
  return checked(await query.limit(1).maybeSingle())
}

export function createOverviewRepository(supabase) {
  if (!supabase?.from) throw new TypeError('A server-side Supabase client is required')
  return {
    async listRuns(companyId, { limit, before }) {
      const size = limit + 1
      let started = scoped(supabase, companyId).not('started_at', 'is', null)
        .order('started_at', { ascending: false }).order('id', { ascending: false }).limit(size)
      let queued = scoped(supabase, companyId).is('started_at', null)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(size)
      if (before) {
        started = started.or(`started_at.lt.${before.effectiveAt},and(started_at.eq.${before.effectiveAt},id.lt.${before.id})`)
        queued = queued.or(`created_at.lt.${before.effectiveAt},and(created_at.eq.${before.effectiveAt},id.lt.${before.id})`)
      }
      const [startedRows, queuedRows] = await Promise.all([started, queued])
      const items = [...(checked(startedRows) ?? []), ...(checked(queuedRows) ?? [])]
        .sort((left, right) => Date.parse(effectiveAt(right)) - Date.parse(effectiveAt(left)) || String(right.id).localeCompare(String(left.id)))
      return { items: items.slice(0, size), hasMore: items.length > limit }
    },
    async getActiveRun(companyId) {
      return maybeOne(scoped(supabase, companyId).in('status', ACTIVE_STATUSES)
        .order('created_at', { ascending: false }).order('id', { ascending: false }))
    },
    async getRecentRun(companyId) {
      const page = await this.listRuns(companyId, { limit: 1, before: null })
      return page.items[0] ?? null
    },
    async getLastCompletedRun(companyId) {
      return maybeOne(scoped(supabase, companyId).eq('status', 'completed')
        .order('finished_at', { ascending: false }).order('id', { ascending: false }))
    },
    async countOpenConflicts(companyId) {
      const result = await supabase.from('h2a_conflicts').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('status', 'open')
      if (result?.error) throw result.error
      return Number.isSafeInteger(result?.count) ? result.count : 0
    },
    async listSampleReviewItems(companyId, runIds) {
      if (!Array.isArray(runIds) || runIds.length === 0) return []
      const rows = []
      for (let start = 0; start < 100000; start += 1000) {
        const result = await supabase.from('h2a_item_results').select(REVIEW_ITEM_SELECT)
          .eq('company_id', companyId).in('run_id', runIds)
          .order('id', { ascending: true }).range(start, start + 999)
        const page = checked(result)
        if (!Array.isArray(page)) throw new Error('Invalid review result page')
        rows.push(...page)
        if (page.length < 1000) return rows
      }
      throw new Error('Review result page limit exceeded')
    },
  }
}

function decodeCursor(value) {
  if (value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400, 'Invalid overview cursor.')
  try { return validateCursor(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))) }
  catch (error) {
    if (error instanceof H2AOverviewError) throw error
    fail(400, 'Invalid overview cursor.')
  }
}

function encodeCursor(cursor) {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

const response = (statusCode, body) => ({ statusCode, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}, body: JSON.stringify(body) })

export function createOverviewHandler(options = {}) {
  return async event => {
    if (event.httpMethod === 'OPTIONS') return response(200, {})
    if (event.httpMethod !== 'GET') return response(405, { error: 'Method not allowed.' })
    try {
      const query = event.queryStringParameters ?? {}
      if (Object.keys(query).some(key => !['companyId', 'company_id', 'limit', 'cursor'].includes(key))) {
        fail(400, 'Unsupported query parameters.')
      }
      const selectors = [query.companyId, query.company_id].filter(value => value !== undefined)
      if (selectors.some(value => typeof value !== 'string' || !value.trim()) || new Set(selectors).size > 1) {
        fail(400, 'A single company selector is required.')
      }
      const limit = query.limit === undefined ? 25 : Number(query.limit)
      if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[0-9]{1,3}$/.test(query.limit))) {
        fail(400, 'Invalid overview page size.')
      }
      const context = await (options.requireRequest ?? requireH2ARequest)(event, {
        supabase: options.supabase, getSupabase: options.getSupabase, requireAdmin: false,
        requestedCompanyId: selectors[0],
      })
      const repository = options.repository ?? createOverviewRepository(context.supabase)
      const overview = await getOverview({ repository, companyId: context.companyId, limit, cursor: decodeCursor(query.cursor) })
      return response(200, { ...overview, nextCursor: encodeCursor(overview.nextCursor) })
    } catch (error) {
      const known = error instanceof H2AAuthError || error instanceof H2AOverviewError
      return response(known ? error.statusCode : 500, {
        error: known ? error.message : 'Unable to load HubSpot to Albi overview.',
      })
    }
  }
}

export const handler = createOverviewHandler()
