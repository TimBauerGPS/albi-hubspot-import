import { randomUUID } from 'node:crypto'
import { DRY_RUN_PROPOSED_ACTION_TOTALS, DRY_RUN_REVIEW_TOTAL_FIELDS, SAMPLE_LIMIT_PER_TYPE } from './constants.js'

const BASE_RUN_TOTAL_FIELDS = ['created', 'updated', 'linked', 'delivered', 'reconciled', 'skipped', 'conflict', 'failed', 'dry_run']

function checked(result) {
  if (result?.error) throw result.error
  return result?.data
}

function scoped(supabase, table, companyId) {
  if (typeof companyId !== 'string' || !companyId.trim()) throw new TypeError('Company ID is required')
  return supabase.from(table).select('*').eq('company_id', companyId)
}

function boundary(row) {
  return row ? { timestamp: row.cursor_timestamp ?? row.checkpoint_timestamp, objectId: row.cursor_object_id ?? row.checkpoint_object_id } : null
}

async function readAll(supabase, table, companyId, filter = query => query) {
  const rows = []
  for (let start = 0; start < 1000000; start += 1000) {
    const page = checked(await filter(scoped(supabase, table, companyId)).order('id', { ascending: true }).range(start, start + 999))
    if (!Array.isArray(page)) throw new Error(`Invalid ${table} page`)
    rows.push(...page)
    if (page.length < 1000) return rows
  }
  throw new Error(`${table} page limit exceeded`)
}

export function aggregateRunTotals(rows, mode) {
  const totals = Object.fromEntries(BASE_RUN_TOTAL_FIELDS.map(field => [field, 0]))
  if (mode === 'dry_run') {
    for (const field of DRY_RUN_REVIEW_TOTAL_FIELDS) totals[field] = 0
  }
  const latest = new Map()
  for (const row of [...(rows ?? [])].sort((a, b) =>
    Date.parse(a.created_at) - Date.parse(b.created_at) || String(a.id).localeCompare(String(b.id)))) {
    const key = JSON.stringify([row.object_type, row.source_id, row.albi_target_type, row.albi_target_id])
    latest.set(key, row)
  }
  for (const row of latest.values()) {
    if (Object.hasOwn(totals, row.outcome)) totals[row.outcome] += 1
    if (mode !== 'dry_run' || row.outcome !== 'dry_run') continue
    const action = row.sanitized_details?.proposedAction
    const field = typeof action === 'string' && Object.hasOwn(DRY_RUN_PROPOSED_ACTION_TOTALS, action)
      ? DRY_RUN_PROPOSED_ACTION_TOTALS[action]
      : null
    if (field) totals[field] = (totals[field] ?? 0) + 1
  }
  return totals
}

export function createH2ARepository(supabase) {
  if (!supabase?.from || !supabase?.rpc) throw new TypeError('A server-side Supabase client is required')
  return {
    async getConflict(companyId, conflictId) {
      return checked(await scoped(supabase, 'h2a_conflicts', companyId).eq('id', conflictId).maybeSingle())
    },
    async listConflicts(companyId, { limit, before = null }) {
      let query = scoped(supabase, 'h2a_conflicts', companyId)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit)
      if (before) query = query.or(`created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`)
      const items = checked(await query)
      if (!Array.isArray(items)) throw new Error('Invalid conflict page')
      return { items, hasMore: false }
    },
    async listConflictEvents(companyId, conflictIds) {
      if (!Array.isArray(conflictIds) || conflictIds.length === 0) return []
      return checked(await supabase.from('h2a_conflict_events').select('*').eq('company_id', companyId)
        .in('conflict_id', conflictIds).order('created_at', { ascending: true }).order('id', { ascending: true }))
    },
    async resolveConflict(companyId, input) {
      return checked(await supabase.rpc('h2a_resolve_conflict', {
        p_company_id: companyId, p_conflict_id: input.conflictId, p_expected_updated_at: input.expectedUpdatedAt,
        p_actor_id: input.actorId, p_api_action: input.action, p_db_action: input.dbAction,
        p_request: { targetId: input.targetId, selectedFields: input.selectedFields,
          approveManyToOne: input.approveManyToOne }, p_now: input.now,
      }))
    },
    async listPendingConflictResumes(companyId, limit = 25) {
      return checked(await scoped(supabase, 'h2a_conflict_resumes', companyId).eq('status', 'pending')
        .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit))
    },
    async claimConflictResume(companyId, resumeId, ownerToken, ttlSeconds = 120) {
      return checked(await supabase.rpc('h2a_claim_conflict_resume', {
        p_company_id: companyId, p_resume_id: resumeId, p_owner_token: ownerToken, p_ttl_seconds: ttlSeconds,
      }))
    },
    async finishConflictResume(companyId, resumeId, ownerToken, accepted, errorCode = null) {
      return checked(await supabase.rpc('h2a_finish_conflict_resume', {
        p_company_id: companyId, p_resume_id: resumeId, p_owner_token: ownerToken,
        p_accepted: accepted, p_error_code: errorCode,
      })) === true
    },
    async getConflictResume(companyId, resumeId) {
      return checked(await scoped(supabase, 'h2a_conflict_resumes', companyId).eq('id', resumeId).maybeSingle())
    },
    async getResumeRun(companyId, resumeId) {
      return checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('resume_id', resumeId).maybeSingle())
    },
    async getRun(companyId, runId) {
      return checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('id', runId).maybeSingle())
    },
    async requeueConflictResume(companyId, resumeId) {
      return checked(await supabase.rpc('h2a_requeue_conflict_resume', { p_company_id: companyId, p_resume_id: resumeId })) === true
    },
    async isSkippedItem(companyId, portalId, objectType, activityId) {
      const source = checked(await scoped(supabase, 'h2a_conflicts', companyId).eq('portal_id', portalId)
        .eq('object_type', objectType).eq('source_id', activityId).is('activity_object_type', null).is('activity_id', null)
        .eq('status', 'skipped').limit(1).maybeSingle())
      if (source) return true
      return Boolean(checked(await scoped(supabase, 'h2a_conflicts', companyId).eq('portal_id', portalId)
        .eq('activity_object_type', objectType).eq('activity_id', activityId).eq('status', 'skipped').limit(1).maybeSingle()))
    },
    async claimLease(companyId, ownerToken = randomUUID(), ttlSeconds = 900) {
      return checked(await supabase.rpc('h2a_claim_lease', { p_company_id: companyId, p_owner_token: ownerToken, p_ttl_seconds: ttlSeconds })) === true
    },
    async heartbeatLease(companyId, ownerToken, ttlSeconds = 900) {
      return checked(await supabase.rpc('h2a_heartbeat_lease', { p_company_id: companyId, p_owner_token: ownerToken, p_ttl_seconds: ttlSeconds })) === true
    },
    async releaseLease(companyId, ownerToken) {
      return checked(await supabase.rpc('h2a_release_lease', { p_company_id: companyId, p_owner_token: ownerToken })) === true
    },
    async getConfig(companyId) { return checked(await scoped(supabase, 'h2a_company_config', companyId).maybeSingle()) },
    async getCredentials(companyId) {
      return checked(await supabase.rpc('h2a_get_credentials', { p_company_id: companyId }))
    },
    async getActiveLease(companyId) {
      const lease = checked(await scoped(supabase, 'h2a_execution_leases', companyId).maybeSingle())
      return lease && Date.parse(lease.expires_at) > Date.now() ? lease : null
    },
    async hasCompletedSampleDryRun(companyId, after) {
      const run = checked(await scoped(supabase, 'h2a_sync_runs', companyId)
        .eq('mode', 'dry_run').eq('status', 'completed').eq('sample_limit_per_type', SAMPLE_LIMIT_PER_TYPE)
        .gt('created_at', after).order('created_at', { ascending: false }).limit(1).maybeSingle())
      return Boolean(run)
    },
    async queueRun(companyId, { mode, trigger, requestedBy = null, runId = null, businessDate = null,
      sampleLimitPerType = null }) {
      if (sampleLimitPerType !== null && (mode !== 'dry_run' || !Number.isInteger(sampleLimitPerType) ||
        sampleLimitPerType < 1 || sampleLimitPerType > 50)) {
        throw new TypeError('Invalid sample limit')
      }
      const payload = { ...(runId ? { id: runId } : {}), company_id: companyId,
        mode: mode === 'backfill' ? 'live' : mode, trigger: mode === 'backfill' ? 'backfill' : trigger,
        requested_by: requestedBy, business_date: businessDate, status: 'queued',
        ...(sampleLimitPerType === null ? {} : { sample_limit_per_type: sampleLimitPerType }) }
      try { return checked(await supabase.from('h2a_sync_runs').insert(payload).select('*').single()) }
      catch (error) {
        if (!runId) throw error
        const existing = checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('id', runId).maybeSingle())
        if (existing?.trigger === 'scheduled' && existing.business_date === businessDate) return existing
        throw error
      }
    },
    async queueScheduledRun(companyId, claimId, businessDate) {
      try {
        return checked(await supabase.from('h2a_sync_runs').insert({ id: claimId, company_id: companyId, mode: 'live', trigger: 'scheduled',
          scheduler_claim_id: claimId, business_date: businessDate, status: 'queued' }).select('*').single())
      } catch (error) {
        const existing = checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('scheduler_claim_id', claimId).maybeSingle())
        if (existing?.business_date === businessDate && existing.trigger === 'scheduled') return existing
        throw error
      }
    },
    async claimDailyRun(companyId, businessDate, ownerToken, ttlSeconds = 180) {
      const result = checked(await supabase.rpc('h2a_claim_daily_run', { p_company_id: companyId,
        p_business_date: businessDate, p_owner_token: ownerToken, p_ttl_seconds: ttlSeconds }))
      if (!result || typeof result !== 'object') throw new Error('Invalid daily claim response')
      return { ...result.claim, acquired: result.acquired === true }
    },
    async finishDailyRun(companyId, claimId, ownerToken, accepted, errorCode = null) {
      return checked(await supabase.rpc('h2a_finish_daily_run', { p_company_id: companyId, p_claim_id: claimId,
        p_owner_token: ownerToken, p_accepted: accepted, p_error_code: errorCode })) === true
    },
    async markQueueFailed(companyId, runId) {
      const now = new Date().toISOString()
      return checked(await supabase.from('h2a_sync_runs').update({ status: 'failed', started_at: now,
        finished_at: now, error_summary: 'background_dispatch_failed', updated_at: now })
        .eq('company_id', companyId).eq('id', runId).eq('status', 'queued').select('*').maybeSingle())
    },
    async markRunCollision(companyId, runId) {
      const now = new Date().toISOString()
      return checked(await supabase.from('h2a_sync_runs').update({ status: 'cancelled', started_at: now,
        finished_at: now, error_summary: 'already_running', updated_at: now })
        .eq('company_id', companyId).eq('id', runId).eq('status', 'queued').select('*').maybeSingle())
    },
    async getMappings(companyId) {
      const [contacts, organizations, options] = await Promise.all([
        readAll(supabase, 'h2a_contact_mappings', companyId),
        readAll(supabase, 'h2a_organization_mappings', companyId),
        readAll(supabase, 'h2a_option_mappings', companyId),
      ])
      return { contacts, organizations, options }
    },
    async startRun(companyId, { runId, mode, trigger, requestedBy = null, schedulerClaimId = null, resumeId = null }) {
      if (resumeId) {
        const existing = await this.getResumeRun(companyId, resumeId)
        if (existing && !['queued', 'running', 'paused', 'partially_failed', 'failed'].includes(existing.status)) return existing
        if (existing) {
          return checked(await supabase.from('h2a_sync_runs').update({ status: 'running', started_at: existing.started_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString() }).eq('company_id', companyId).eq('id', existing.id)
            .in('status', ['queued', 'running', 'paused', 'partially_failed', 'failed']).select('*').single())
        }
        return checked(await supabase.from('h2a_sync_runs').insert({ company_id: companyId, mode: 'live', trigger: 'conflict_resolution',
          status: 'running', resume_id: resumeId, started_at: new Date().toISOString() }).select('*').single())
      }
      if (runId) {
        const run = checked(await scoped(supabase, 'h2a_sync_runs', companyId).eq('id', runId).maybeSingle())
        if (!run || run.mode !== (mode === 'backfill' ? 'live' : mode)) throw new Error('Run is missing or belongs to another mode')
        if (!['queued', 'running', 'paused', 'partially_failed', 'failed'].includes(run.status)) throw new Error('Run is not resumable')
        return checked(await supabase.from('h2a_sync_runs').update({ status: 'running', started_at: run.started_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString() }).eq('company_id', companyId).eq('id', runId)
          .in('status', ['queued', 'running', 'paused', 'partially_failed', 'failed']).select('*').single())
      }
      const storedMode = mode === 'backfill' ? 'live' : mode
      return checked(await supabase.from('h2a_sync_runs').insert({ company_id: companyId, mode: storedMode,
        trigger: mode === 'backfill' ? 'backfill' : trigger, status: 'running', requested_by: requestedBy,
        scheduler_claim_id: schedulerClaimId,
        started_at: new Date().toISOString() }).select('*').single())
    },
    async finishRun(companyId, runId, status, totals, errorSummary = null) {
      return checked(await supabase.from('h2a_sync_runs').update({ status, totals, error_summary: errorSummary,
        finished_at: status === 'paused' ? null : new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('company_id', companyId).eq('id', runId).select('*').single())
    },
    async getCursor(companyId, objectType) {
      return boundary(checked(await scoped(supabase, 'h2a_cursors', companyId).eq('object_type', objectType).maybeSingle()))
    },
    async getRunCheckpoint(companyId, runId, objectType) {
      const row = checked(await scoped(supabase, 'h2a_run_checkpoints', companyId).eq('run_id', runId)
        .eq('object_type', objectType).maybeSingle())
      if (!row) return null
      return { ...(row.cursor_timestamp && row.cursor_object_id
        ? { timestamp: row.cursor_timestamp, objectId: row.cursor_object_id } : {}),
      upperBound: row.upper_bound, pageAfter: row.page_after ?? null,
      processedCount: Number.isInteger(row.processed_count) ? row.processed_count : 0, completed: row.completed === true }
    },
    async saveRunCheckpoint(companyId, runId, objectType, checkpoint) {
      const timestamp = checkpoint?.timestamp ?? null
      const objectId = checkpoint?.objectId ?? null
      return checked(await supabase.from('h2a_run_checkpoints').upsert({ company_id: companyId, run_id: runId,
        object_type: objectType, upper_bound: checkpoint?.upperBound, page_after: checkpoint?.pageAfter ?? null,
        cursor_timestamp: timestamp, cursor_object_id: objectId,
        processed_count: checkpoint?.processedCount ?? 0,
        completed: checkpoint?.completed === true, updated_at: new Date().toISOString() },
      { onConflict: 'company_id,run_id,object_type' }).select('*').single())
    },
    async saveCursor(companyId, objectType, checkpoint) {
      return checked(await supabase.from('h2a_cursors').upsert({ company_id: companyId, object_type: objectType,
        cursor_timestamp: checkpoint.timestamp, cursor_object_id: checkpoint.objectId, updated_at: new Date().toISOString() },
      { onConflict: 'company_id,object_type' }).select('*').single())
    },
    async listBackfillWindows(companyId, objectType) {
      return checked(await scoped(supabase, 'h2a_backfill_windows', companyId).eq('object_type', objectType)
        .in('status', ['pending', 'running']).order('start_at', { ascending: true }))
    },
    async saveBackfillWindow(companyId, windowId, patch) {
      return checked(await supabase.from('h2a_backfill_windows').update(patch).eq('company_id', companyId).eq('id', windowId).select('*').single())
    },
    async getItemOutcomes(companyId, runId, objectType, sourceId) {
      return checked(await scoped(supabase, 'h2a_item_results', companyId).eq('run_id', runId)
        .eq('object_type', objectType).eq('source_id', sourceId))
    },
    async recordItem(companyId, item) {
      const row = { ...item, company_id: companyId }
      return checked(await supabase.from('h2a_item_results').insert(row).select('*').single())
    },
    async totals(companyId, runId, mode) {
      const rows = await readAll(supabase, 'h2a_item_results', companyId, query => query.eq('run_id', runId))
      return aggregateRunTotals(rows, mode)
    },
    async saveMapping(companyId, kind, row) {
      const objectType = kind === 'contact' ? 'contacts' : kind === 'organization' ? 'companies' : null
      if (!objectType) throw new TypeError('Unsupported mapping kind')
      const targetId = kind === 'contact' ? row?.albi_contact_id : row?.albi_organization_id
      const result = checked(await supabase.rpc('h2a_save_mapping', {
        p_company_id: companyId, p_portal_id: row?.portal_id, p_object_type: objectType,
        p_source_id: row?.hubspot_id, p_target_id: targetId, p_match_method: row?.match_method,
        p_reviewed_by: row?.reviewed_by ?? null, p_now: new Date().toISOString(),
      }))
      if (result?.error === 'mapping_conflict') {
        throw Object.assign(new Error('A different Albi target is already mapped for this HubSpot source'), { code: 'mapping_conflict' })
      }
      if (result?.error === 'invalid_mapping') throw new TypeError('Invalid source mapping')
      if (!result || result.error) throw new Error('Invalid source mapping response')
      return result
    },
    async recordConflict(companyId, conflict) {
      let query = scoped(supabase, 'h2a_conflicts', companyId)
        .eq('portal_id', conflict.portal_id).eq('object_type', conflict.object_type)
        .eq('source_id', conflict.source_id).eq('conflict_type', conflict.conflict_type)
        .eq('reason', conflict.reason)
      query = conflict.activity_object_type ? query.eq('activity_object_type', conflict.activity_object_type)
        : query.is('activity_object_type', null)
      query = conflict.activity_id ? query.eq('activity_id', conflict.activity_id) : query.is('activity_id', null)
      const existing = checked(await query.eq('status', 'open').maybeSingle())
      if (existing) return { ...existing, inserted: false }
      return { ...checked(await supabase.from('h2a_conflicts').insert({ ...conflict, company_id: companyId }).select('*').single()), inserted: true }
    },
    deliveryStore(companyId) {
      if (typeof companyId !== 'string' || !companyId.trim()) throw new TypeError('Company ID is required')
      return {
        async reserve({ identity, source_marker, now, staleBefore, retryEligibleAt }) {
          const row = checked(await supabase.rpc('h2a_reserve_delivery', {
            p_company_id: companyId, p_portal_id: identity.portalId, p_object_type: identity.objectType,
            p_activity_id: identity.activityId, p_albi_target_type: identity.albiTargetType,
            p_albi_target_id: identity.albiTargetId, p_source_marker: source_marker,
            p_now: now, p_stale_before: staleBefore, p_retry_eligible_at: retryEligibleAt,
          }))
          if (!row || typeof row !== 'object') throw new Error('Invalid delivery reservation response')
          return { acquired: row.acquired, isNew: row.is_new, previous: row.previous, row: row.delivery }
        },
        async transition({ id, expectedVersion, attemptToken, patch }) {
          if (String(expectedVersion) !== attemptToken) throw new TypeError('Invalid delivery attempt token')
          const row = checked(await supabase.rpc('h2a_transition_delivery', {
            p_company_id: companyId, p_delivery_id: id, p_expected_attempt_count: expectedVersion, p_patch: patch,
          }))
          return { updated: row?.updated === true, row: row?.delivery ?? null }
        },
      }
    },
  }
}
