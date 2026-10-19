import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

// Static deployment contract only: this does not replace PostgreSQL role/concurrency tests.
const schemaUrl = new URL('../supabase/h2a-schema.sql', import.meta.url)
const sampleMigrationUrl = new URL('../supabase/h2a-dry-run-samples.sql', import.meta.url)
const reviewMigrationUrl = new URL('../supabase/h2a-dry-run-review-workflow.sql', import.meta.url)
const resolutionMigrationUrl = new URL('../supabase/h2a-review-resolutions.sql', import.meta.url)
const recheckBatchMigrationUrl = new URL('../supabase/h2a-review-recheck-batches.sql', import.meta.url)
const liveReviewMigrationUrl = new URL('../supabase/h2a-live-review-workspace.sql', import.meta.url)
const mappingOwnershipMigrationUrl = new URL('../supabase/h2a-mapping-target-ownership.sql', import.meta.url)
const requiredTables = [
  'h2a_company_config', 'h2a_option_mappings', 'h2a_sync_runs',
  'h2a_cursors', 'h2a_backfill_windows', 'h2a_contact_mappings',
  'h2a_organization_mappings', 'h2a_activity_deliveries',
  'h2a_item_results', 'h2a_conflicts', 'h2a_conflict_events',
  'h2a_conflict_resumes', 'h2a_execution_leases', 'h2a_daily_claims',
  'h2a_run_checkpoints',
  'h2a_dry_run_reviews', 'h2a_dry_run_review_events',
  'h2a_dry_run_review_resolutions', 'h2a_dry_run_review_resolution_events', 'h2a_contact_organization_choices',
  'h2a_review_recheck_batches', 'h2a_live_review_conflicts',
]
const serviceOnlyTables = ['h2a_dry_run_reviews', 'h2a_dry_run_review_events']
const batchTables = ['h2a_review_recheck_batches', 'h2a_live_review_conflicts']
const resolutionTables = ['h2a_dry_run_review_resolutions', 'h2a_dry_run_review_resolution_events', 'h2a_contact_organization_choices']
const readSchema = () => readFileSync(schemaUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
const readSampleMigration = () => readFileSync(sampleMigrationUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
const readReviewMigration = () => readFileSync(reviewMigrationUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
const readResolutionMigration = () => {
  assert.ok(existsSync(resolutionMigrationUrl), 'deployable resolution migration must exist')
  return readFileSync(resolutionMigrationUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
}
const tableBody = (sql, table) => {
  const body = sql.match(new RegExp(`create table (?:if not exists )?${table.replace('.', '\\.')} \\(([\\s\\S]*?)\\n\\);`))?.[1]
  assert.ok(body, `${table} must exist`)
  return body
}
const functionBody = (sql, name) => {
  const body = sql.match(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1]
  assert.ok(body, `${name} must exist`)
  return body
}

test('all tenant tables have UUID keys, ownership, RLS, and authenticated read-only policies', () => {
  const sql = readSchema()
  const tables = [...sql.matchAll(/create table public\.(h2a_\w+)/g)].map((match) => match[1])
  assert.deepEqual([...tables].sort(), [...requiredTables].sort())
  assert.doesNotMatch(sql, /auth\.role\s*\(/)
  for (const table of tables) {
    const body = tableBody(sql, `public.${table}`)
    assert.match(body, /\buuid primary key/)
    assert.match(body, /company_id uuid (?:primary key|not null)/)
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`))
    if ([...serviceOnlyTables, ...resolutionTables, ...batchTables].includes(table)) {
      assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role;`))
      assert.doesNotMatch(sql, new RegExp(`grant [^;]*on (?:table )?public\\.${table} to authenticated;`))
      assert.doesNotMatch(sql, new RegExp(`create policy[^;]+on public\\.${table}`))
      continue
    }
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`))
    if (['h2a_conflict_resumes', 'h2a_execution_leases', 'h2a_daily_claims', 'h2a_run_checkpoints'].includes(table)) {
      assert.doesNotMatch(sql, /grant [^;]*on (?:table )?public\.h2a_conflict_resumes to authenticated;/)
      assert.doesNotMatch(sql, new RegExp(`grant [^;]*on (?:table )?public\\.${table} to authenticated;`))
      assert.doesNotMatch(sql, new RegExp(`create policy[^;]+on public\\.${table}`))
      continue
    }
    if (['h2a_contact_mappings', 'h2a_organization_mappings'].includes(table)) {
      assert.match(sql, new RegExp(`revoke insert, update, delete on table public\\.${table} from service_role;`))
      assert.match(sql, new RegExp(`grant select on table public\\.${table} to authenticated, service_role;`))
      assert.doesNotMatch(sql, new RegExp(`grant [^;]*on table public\\.${table} to service_role;`))
    } else {
      assert.match(sql, new RegExp(`grant select on table public\\.${table} to authenticated;`))
    }
    const policy = sql.match(new RegExp(`create policy ${table}_select on public\\.${table}([\\s\\S]*?);`))?.[1]
    assert.ok(policy, `${table} requires a read policy`)
    assert.match(policy, /for select to authenticated/)
    assert.match(policy, /public\.company_members/)
    assert.match(policy, /public\.super_admins/)
    assert.match(policy, /\(select auth\.uid\(\)\)/)
    assert.match(policy, new RegExp(`company_id = ${table}\\.company_id`))
  }
  assert.doesNotMatch(sql, /create policy[^;]+for (?:all|insert|update|delete)/)
})

// These contracts catch missing tenant keys/grants, expanded state alphabets,
// lost CAS/lease fencing, cross-review execution races, and migration mirror drift.
test('durable resolution tables preserve tenant identity, fixed states, append-only events, and indexed FKs', () => {
  for (const sql of [readSchema(), readResolutionMigration()]) {
    for (const table of resolutionTables) {
      const body = tableBody(sql, `public.${table}`)
      assert.match(body, /id uuid primary key default gen_random_uuid\(\)/)
      assert.match(body, /company_id uuid not null references public\.companies\(id\)/)
      assert.match(body, /unique \(company_id, id\)/)
      assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`))
      assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role;`))
      assert.doesNotMatch(sql, new RegExp(`grant [^;]*public\\.${table} to (?:public|anon|authenticated)`))
      assert.doesNotMatch(sql, new RegExp(`create policy[^;]*public\\.${table}`))
    }
    const resolutions = tableBody(sql, 'public.h2a_dry_run_review_resolutions')
    const events = tableBody(sql, 'public.h2a_dry_run_review_resolution_events')
    const choices = tableBody(sql, 'public.h2a_contact_organization_choices')
    const values = (body, field) => [...body.match(new RegExp(`${field} text[^\\n]*check \\(${field} in \\(([\\s\\S]*?)\\)\\)`))[1].matchAll(/'([^']+)'/g)].map(m => m[1])
    assert.deepEqual(values(resolutions, 'status'), ['pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded'])
    assert.deepEqual(values(resolutions, 'action'), ['resolve_fields', 'link_existing', 'create_albi', 'force_create_albi', 'choose_organization'])
    assert.deepEqual(values(events, 'event_type'), ['planned', 'claimed', 'provider_applied', 'provider_reconciled', 'waiting_on_albi', 'recheck_requested', 'completed', 'failed', 'superseded'])
    assert.match(resolutions, /unique \(company_id, review_id, expected_review_updated_at, decision_hash\)/)
    assert.match(resolutions, /unique \(company_id, client_request_id\)/)
    assert.match(resolutions, /foreign key \(company_id, run_id\) references public\.h2a_sync_runs \(company_id, id\) on delete restrict/)
    assert.match(resolutions, /foreign key \(company_id, run_id, review_id\) references public\.h2a_dry_run_reviews \(company_id, run_id, id\) on delete restrict/)
    assert.match(resolutions, /decision_hash ~ '\^\[a-f0-9\]\{64\}\$'/)
    assert.match(resolutions, /check \(\(lease_owner is null\) = \(lease_expires_at is null\)\)/)
    assert.match(events, /foreign key \(company_id, resolution_id\) references public\.h2a_dry_run_review_resolutions \(company_id, id\) on delete cascade/)
    assert.match(events, /sanitized_details jsonb not null default '\{\}'::jsonb check \(jsonb_typeof\(sanitized_details\) = 'object'\)/)
    assert.match(sql, /grant select, insert on table public\.h2a_dry_run_review_resolution_events to service_role;/)
    assert.doesNotMatch(sql, /grant [^;]*(?:update|delete)[^;]*public\.h2a_dry_run_review_resolution_events/)
    assert.match(choices, /unique \(company_id, portal_id, hubspot_contact_id\)/)
    assert.match(sql, /create index (?:if not exists )?h2a_review_resolutions_active_idx\s+on public\.h2a_dry_run_review_resolutions \(company_id, status, created_at, id\)\s+where status in \('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'failed'\)/)
    for (const [table, columns] of [
      ['h2a_dry_run_review_resolutions', ['run_id', 'review_id', 'created_by']],
      ['h2a_dry_run_review_resolution_events', ['resolution_id', 'actor_id']],
      ['h2a_contact_organization_choices', ['reviewed_by']],
    ]) for (const column of columns) assert.match(sql, new RegExp(`create index (?:if not exists )?\\w+\\s+on public\\.${table} \\(${column}\\)`))
    assert.match(sql, /from pg_catalog\.pg_constraint[\s\S]*conrelid = 'public\.h2a_dry_run_reviews'::pg_catalog\.regclass/)
    assert.match(sql, /conname = 'h2a_dry_run_reviews_company_run_id_key'/)
    assert.match(sql, /add constraint h2a_dry_run_reviews_company_run_id_key unique \(company_id, run_id, id\)/)
    assert.doesNotMatch(sql, /add constraint if not exists/)
  }
})

test('retention RPC supersedes nonleased old intents and keeps their review rows', () => {
  for (const sql of [readSchema(), readResolutionMigration()]) {
    const body = functionBody(sql, 'h2a_retain_review_resolution_runs')
    assert.match(body, /status in \('pending', 'waiting_on_albi', 'ready_to_recheck', 'failed'\)/)
    assert.match(body, /lease_owner is null/)
    assert.match(body, /insert into public\.h2a_dry_run_review_resolution_events/)
    assert.match(body, /event_type[\s\S]*'superseded'/)
    assert.match(body, /select[^;]*run_id[^;]*from public\.h2a_dry_run_review_resolutions/)
    assert.match(sql, /grant execute on function public\.h2a_retain_review_resolution_runs\(uuid, uuid\) to service_role;/)
  }
  assert.match(readResolutionMigration(), /drop constraint %i/)
})

test('forced create reserves the source before provider work and fences every mapping RPC', () => {
  for (const sql of [readSchema(), readResolutionMigration()]) {
    const create = functionBody(sql, 'h2a_create_review_resolution')
    assert.match(create, /pg_advisory_xact_lock[\s\S]*'source'[\s\S]*p_action = 'force_create_albi'/)
    assert.match(create, /public\.h2a_contact_mappings[\s\S]*public\.h2a_organization_mappings/)
    const claim = functionBody(sql, 'h2a_claim_review_resolution')
    assert.match(claim, /v_row\.action = 'force_create_albi' and v_row\.status = 'failed'[\s\S]*pg_advisory_xact_lock[\s\S]*v_mapping_exists[\s\S]*'stale'/)
  }
  for (const sql of [readSchema(), readFileSync(mappingOwnershipMigrationUrl, 'utf8').toLowerCase()]) {
    const mapping = functionBody(sql, 'h2a_save_mapping')
    assert.match(sql, /create (?:or replace )?function public\.h2a_save_mapping\([\s\S]*?p_force_resolution_id uuid default null[\s\S]*?as \$\$/)
    assert.match(mapping, /pg_advisory_xact_lock[\s\S]*to_regclass\('public\.h2a_dry_run_review_resolutions'\)[\s\S]*mapping_reserved/)
    assert.match(mapping, /p_force_resolution_id is distinct from v_force_reservation/)
    assert.doesNotMatch(sql, /create (?:or replace )?function public\.h2a_save_mapping_unfenced/)
    assert.doesNotMatch(sql, /grant execute on function public\.h2a_save_mapping\(uuid,\s*text,\s*text,\s*text,\s*text,\s*text,\s*uuid,\s*timestamptz,\s*boolean\) to service_role/)
    const conflict = functionBody(sql, 'h2a_resolve_conflict')
    assert.match(conflict, /to_regclass\('public\.h2a_dry_run_review_resolutions'\)[\s\S]*force_create_albi[\s\S]*mapping_conflict/)
  }
  assert.match(readResolutionMigration(), /run h2a-mapping-target-ownership\.sql before h2a-review-resolutions\.sql/)
})

test('resolution RPCs fail closed, pin invoker search paths, and expose execution only to service role', () => {
  const required = {
    h2a_create_review_resolution: ['company_id', 'run_id', 'review_id', 'portal_id', 'object_type', 'source_id', 'action', 'expected_review_updated_at', 'decision', 'decision_hash', 'client_request_id', 'actor_id'],
    h2a_claim_review_resolution: ['company_id', 'resolution_id', 'owner_token', 'actor_id', 'ttl_seconds'],
    h2a_finish_review_resolution: ['company_id', 'resolution_id', 'owner_token', 'actor_id', 'status', 'event_type', 'event_details'],
    h2a_upsert_contact_organization_choice: ['company_id', 'portal_id', 'hubspot_contact_id', 'hubspot_company_id', 'actor_id'],
  }
  for (const sql of [readSchema(), readResolutionMigration()]) for (const [name, parameters] of Object.entries(required)) {
    const definition = sql.match(new RegExp(`create (?:or replace )?function public\\.${name}\\(([\\s\\S]*?)as \\$\\$`))?.[1]
    assert.match(definition, /security invoker set search_path = ''/)
    const body = functionBody(sql, name)
    for (const parameter of parameters) assert.match(body, new RegExp(`p_${parameter} is null`))
    assert.match(sql, new RegExp(`revoke execute on function public\\.${name}\\([^;]+\\) from public, anon, authenticated;`))
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]+\\) to service_role;`))
    assert.doesNotMatch(body, /(?:http|net)\.(?:http|post|get)|p_\w*snapshot/)
  }
})

test('resolution RPCs serialize review claims, fence completion, and preserve idempotent creation', () => {
  for (const sql of [readSchema(), readResolutionMigration()]) {
    const create = functionBody(sql, 'h2a_create_review_resolution')
    assert.match(create, /where r\.company_id = p_company_id and r\.id = p_review_id[\s\S]*for update/)
    for (const field of ['run_id', 'portal_id', 'object_type', 'source_id']) assert.match(create, new RegExp(`v_review\\.${field} is distinct from p_${field}`))
    assert.match(create, /v_review\.updated_at is distinct from p_expected_review_updated_at/)
    assert.match(create, /on conflict do nothing/)
    assert.match(create, /'request_conflict'/)
    assert.match(create, /insert into public\.h2a_dry_run_review_resolution_events[\s\S]*'planned'/)
    const claim = functionBody(sql, 'h2a_claim_review_resolution')
    assert.match(claim, /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(p_company_id::text \|\| ':' \|\| v_review_id::text, 0\)\)/)
    assert.match(claim, /status in \('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'failed'\)/)
    assert.match(claim, /lease_owner is null or r\.lease_expires_at <= v_now/)
    assert.match(claim, /r\.id <> p_resolution_id[\s\S]*r\.lease_expires_at > v_now/)
    assert.match(claim, /status = 'applying'/)
    assert.match(claim, /p_ttl_seconds <= 0 or p_ttl_seconds > 3600/)
    assert.match(claim, /'claimed'/)
    const finish = functionBody(sql, 'h2a_finish_review_resolution')
    assert.match(finish, /v_row\.lease_owner is distinct from p_owner_token/)
    assert.match(finish, /v_row\.lease_expires_at <= v_now/)
    assert.match(finish, /v_row\.status <> 'applying'/)
    assert.match(finish, /p_status not in \('pending', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded'\)/)
    assert.match(finish, /p_status in \('pending', 'waiting_on_albi', 'ready_to_recheck'\) and p_event_type in \('provider_applied', 'provider_reconciled'\)/)
    for (const [status, event] of [['waiting_on_albi', 'waiting_on_albi'], ['ready_to_recheck', 'recheck_requested'], ['completed', 'completed'], ['failed', 'failed'], ['superseded', 'superseded']]) {
      assert.match(finish, new RegExp(`p_status = '${status}' and p_event_type = '${event}'`))
    }
    assert.match(finish, /'invalid_transition'/)
    assert.match(finish, /lease_owner = null, lease_expires_at = null/)
    const assignments = finish.match(/update public\.h2a_dry_run_review_resolutions set([\s\S]*?)where/)?.[1]
    assert.ok(assignments)
    assert.doesNotMatch(assignments, /\b(?:company_id|run_id|review_id|portal_id|object_type|source_id)\s*=/)
    const choice = functionBody(sql, 'h2a_upsert_contact_organization_choice')
    assert.match(choice, /pg_catalog\.pg_advisory_xact_lock[\s\S]*p_company_id::text[\s\S]*p_portal_id[\s\S]*p_hubspot_contact_id/)
    assert.match(choice, /on conflict \(company_id, portal_id, hubspot_contact_id\) do update/)
  }
})

test('resolution deployable migration and canonical mirror are semantically identical', () => {
  const schema = readSchema()
  const start = schema.indexOf('create table public.h2a_dry_run_review_resolutions')
  assert.ok(start > 0, 'canonical resolution block exists')
  const canonical = schema.slice(schema.lastIndexOf('do $$', start))
  const migration = readResolutionMigration()
  const normalize = value => value.replace(/\bif not exists\s+/g, '').replace(/create or replace function/g, 'create function').replace(/\s+/g, ' ').trim()
  assert.equal(normalize(canonical), normalize(migration.slice(migration.indexOf('do $$'))))
  for (const table of resolutionTables) assert.match(migration, new RegExp(`create table if not exists public\\.${table}`))
  assert.doesNotMatch(migration, /create (?:unique )?index (?!if not exists)/)
  assert.doesNotMatch(migration, /create function/)
})

test('waiting and recheck claims preserve execution phase across expired recovery and restrict finish edges', () => {
  for (const sql of [readSchema(), readResolutionMigration()]) {
    const table = tableBody(sql, 'public.h2a_dry_run_review_resolutions')
    assert.match(table, /execution_phase text check \(execution_phase in \('applying', 'waiting_on_albi', 'ready_to_recheck'\)\)/)
    assert.match(table, /constraint h2a_review_resolutions_execution_phase_check check \(\(status = 'applying'\) = \(execution_phase is not null\)\)/)
    const claim = functionBody(sql, 'h2a_claim_review_resolution')
    assert.match(claim, /v_phase := case\s+when v_row\.status = 'applying' then v_row\.execution_phase\s+when v_row\.status in \('waiting_on_albi', 'ready_to_recheck'\) then v_row\.status\s+else 'applying' end/)
    assert.match(claim, /v_phase is null[\s\S]*'invalid_claim_phase'/)
    assert.match(claim, /execution_phase = v_phase/)
    assert.match(claim, /'claimed', pg_catalog\.jsonb_build_object\('execution_phase', v_phase\)/)
    const finish = functionBody(sql, 'h2a_finish_review_resolution')
    const graph = finish.match(/if v_row\.execution_phase in \('waiting_on_albi', 'ready_to_recheck'\) then([\s\S]*?)elsif v_row\.execution_phase = 'applying' then/)
    assert.ok(graph, 'finish must branch on the persisted execution phase')
    assert.match(graph[1], /p_status not in \('waiting_on_albi', 'ready_to_recheck', 'completed', 'superseded'\)/)
    assert.doesNotMatch(graph[1], /p_status = '(?:pending|failed)'/)
    assert.doesNotMatch(graph[1], /p_event_type = 'provider_applied'/)
    for (const [status, event] of [['waiting_on_albi', 'waiting_on_albi'], ['ready_to_recheck', 'recheck_requested'], ['completed', 'completed'], ['superseded', 'superseded']]) {
      assert.match(graph[1], new RegExp(`p_status = '${status}' and p_event_type = '${event}'`))
    }
    assert.match(graph[1], /p_status = v_row\.execution_phase and p_event_type = 'failed'/)
    assert.match(finish, /execution_phase = null/)
    assert.match(sql, /add column if not exists execution_phase text/)
    assert.match(sql, /conname = 'h2a_review_resolutions_execution_phase_check'/)
  }
})

test('exact client and semantic resolution replays return before new-insert freshness CAS', () => {
  for (const sql of [readSchema(), readResolutionMigration()]) {
    const create = functionBody(sql, 'h2a_create_review_resolution')
    const lock = create.indexOf('for update;')
    const clientLookup = create.indexOf('r.client_request_id = p_client_request_id')
    const semanticLookup = create.indexOf('r.expected_review_updated_at = p_expected_review_updated_at and r.decision_hash = p_decision_hash')
    const conflict = create.indexOf("'request_conflict'")
    const replayReturn = create.indexOf("'created', false")
    const cas = create.indexOf('v_review.updated_at is distinct from p_expected_review_updated_at')
    const insertion = create.indexOf('insert into public.h2a_dry_run_review_resolutions')
    assert.ok(lock < clientLookup && clientLookup < semanticLookup && semanticLookup < conflict, 'resolve replay identity under the review lock')
    assert.ok(conflict < replayReturn && replayReturn < cas && cas < insertion, 'exact replays precede freshness; only new requests are CAS-gated')
    const validation = create.slice(semanticLookup, replayReturn)
    for (const field of ['run_id', 'review_id', 'portal_id', 'object_type', 'source_id', 'action', 'expected_review_updated_at', 'decision_hash', 'decision']) {
      assert.match(validation, new RegExp(`v_row\\.${field} is distinct from p_${field}`))
    }
    assert.match(create.slice(insertion), /on conflict do nothing/)
    assert.match(create.slice(insertion), /'request_conflict'/)
  }
})

test('dry-run review storage is tenant-safe, bounded, service-only, and CAS-updated', () => {
  const sql = readSchema()
  const reviews = tableBody(sql, 'public.h2a_dry_run_reviews')
  const events = tableBody(sql, 'public.h2a_dry_run_review_events')
  const migration = readReviewMigration()

  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /review_capture_version smallint/)
  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /review_capture_version smallint check \(review_capture_version is null or \(\s*mode = 'dry_run' and sample_limit_per_type is not null and sample_limit_per_type = 10 and review_capture_version = 1/)
  assert.match(reviews, /object_type text not null check \(object_type in \('contacts', 'companies'\)\)/)
  assert.match(reviews, /unique \(company_id, id\)/)
  assert.match(reviews, /unique \(company_id, run_id, portal_id, object_type, source_id\)/)
  assert.match(reviews, /foreign key \(company_id, run_id\) references public\.h2a_sync_runs \(company_id, id\)/)
  assert.match(reviews, /jsonb_typeof\(candidate_snapshots\) = 'array' and jsonb_array_length\(candidate_snapshots\) <= 10/)
  assert.match(events, /foreign key \(company_id, review_id\) references public\.h2a_dry_run_reviews \(company_id, id\) on delete cascade/)
  for (const source of [sql, migration]) {
    for (const table of serviceOnlyTables) {
      assert.match(source, new RegExp(`alter table public\\.${table} enable row level security;`))
      assert.match(source, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role;`))
      assert.doesNotMatch(source, new RegExp(`grant [^;]*public\\.${table} to authenticated`))
      assert.doesNotMatch(source, new RegExp(`create policy[^;]+public\\.${table}`))
    }
    assert.match(source, /grant select, insert, update, delete on table public\.h2a_dry_run_reviews to service_role;/)
    assert.match(source, /grant select, insert on table public\.h2a_dry_run_review_events to service_role;/)
    assert.doesNotMatch(source, /grant [^;]*(?:update|delete)[^;]*public\.h2a_dry_run_review_events/)
    assert.doesNotMatch(source, /before update or delete on public\.h2a_dry_run_review_events/)
  }
  const rpc = functionBody(sql, 'h2a_apply_dry_run_recheck')
  assert.match(rpc, /where r\.company_id = p_company_id and r\.id = p_review_id[\s\S]*for update/)
  assert.match(rpc, /v_current_run_id is distinct from v_review\.run_id[\s\S]*'superseded'/)
  assert.match(rpc, /v_review\.updated_at is distinct from p_expected_updated_at/)
  for (const parameter of ['company_id', 'review_id', 'expected_updated_at', 'actor_id', 'status', 'recheck_outcome',
    'reason', 'conflict_type', 'source_snapshot', 'candidate_snapshots', 'match_evidence', 'proposed_changes', 'event_type', 'event_details', 'now']) {
    assert.match(rpc, new RegExp(`p_${parameter} is null`))
  }
  assert.ok(rpc.indexOf('p_expected_updated_at is null') < rpc.indexOf('v_review.updated_at is distinct from'), 'missing CAS timestamps must be rejected first')
  assert.match(rpc, /length\(pg_catalog\.btrim\(p_reason\)\) = 0/)
  assert.match(rpc, /length\(pg_catalog\.btrim\(p_conflict_type\)\) = 0/)
  assert.match(rpc, /insert into public\.h2a_dry_run_review_events/)
  assert.match(migration, /add column if not exists review_capture_version smallint/)
  assert.match(migration, /drop constraint if exists h2a_sync_runs_review_capture_version_check/)
  assert.match(migration, /add constraint h2a_sync_runs_review_capture_version_check[\s\S]*not valid;/)
  assert.match(migration, /check \(review_capture_version is null or \(\s*mode = 'dry_run' and sample_limit_per_type is not null and sample_limit_per_type = 10 and review_capture_version = 1/)
  assert.match(migration, /validate constraint h2a_sync_runs_review_capture_version_check/)
  for (const table of serviceOnlyTables) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`))
  }
  for (const name of ['h2a_dry_reviews_company_run_status_idx', 'h2a_dry_reviews_company_run_reason_idx',
    'h2a_dry_reviews_last_rechecked_by_idx', 'h2a_dry_review_events_company_review_idx']) {
    assert.match(sql, new RegExp(`create index ${name}`))
    assert.match(migration, new RegExp(`create index if not exists ${name}`))
  }
})

test('captured events are unique per tenant/review through an idempotent service-only partial index', () => {
  for (const [sql, declaration] of [[readSchema(), 'create unique index'], [readReviewMigration(), 'create unique index if not exists']]) {
    assert.match(sql, new RegExp(`${declaration} h2a_dry_review_events_captured_once_idx\\s+on public\\.h2a_dry_run_review_events \\(company_id, review_id\\)\\s+where event_type = 'captured';`))
    assert.match(sql, /revoke all on table public\.h2a_dry_run_review_events from public, anon, authenticated, service_role;/)
    assert.match(sql, /grant select, insert on table public\.h2a_dry_run_review_events to service_role;/)
    assert.doesNotMatch(sql, /grant [^;]*h2a_dry_run_review_events to (?:public|anon|authenticated)/)
  }
})

test('recheck RPC rejects a newer completed historical bounded sample as superseded under the review lock', () => {
  for (const sql of [readSchema(), readReviewMigration()]) {
    const rpc = functionBody(sql.replace('create or replace function public.h2a_apply_dry_run_recheck', 'create function public.h2a_apply_dry_run_recheck'), 'h2a_apply_dry_run_recheck')
    const selection = rpc.match(/select r\.id[^;]+from public\.h2a_sync_runs[^;]+;/)?.[0]
    assert.ok(selection)
    assert.match(selection, /select r\.id, r\.review_capture_version into v_current_run_id, v_current_review_version/)
    assert.match(selection, /r\.company_id = p_company_id[\s\S]*r\.mode = 'dry_run'[\s\S]*r\.status = 'completed'[\s\S]*r\.sample_limit_per_type = 10/)
    assert.doesNotMatch(selection, /and r\.review_capture_version = 1/)
    assert.match(selection, /order by r\.created_at desc, r\.id desc\s+limit 1/)
    assert.match(rpc, /if v_current_run_id is distinct from v_review\.run_id\s+or v_current_review_version is distinct from 1 then\s+return pg_catalog\.jsonb_build_object\('error', 'superseded'\)/)
    assert.ok(rpc.indexOf('for update;') < rpc.indexOf(selection))
    assert.ok(rpc.indexOf("'superseded'") < rpc.indexOf('update public.h2a_dry_run_reviews set'))
  }
})

test('dry-run recheck RPC uses invoker privileges with service-only execution and a pinned search path', () => {
  for (const sql of [readSchema(), readReviewMigration()]) {
    const definition = sql.match(/create (?:or replace )?function public\.h2a_apply_dry_run_recheck\(([\s\S]*?)as \$\$/)?.[1]
    assert.ok(definition)
    assert.match(definition, /security invoker set search_path = ''/)
    assert.doesNotMatch(definition, /security definer/)
    assert.match(sql, /revoke execute on function public\.h2a_apply_dry_run_recheck\([^;]+\) from public, anon, authenticated;/)
    assert.match(sql, /grant execute on function public\.h2a_apply_dry_run_recheck\([^;]+\) to service_role;/)
  }
})

test('private credentials accept complete encrypted envelopes and have no browser grants', () => {
  const sql = readSchema()
  const body = tableBody(sql, 'private.h2a_credentials')
  assert.match(body, /company_id uuid primary key/)
  for (const provider of ['hubspot', 'albi']) {
    for (const field of ['ciphertext', 'iv', 'tag', 'key_version']) {
      assert.match(body, new RegExp(`${provider}_${field} (?:text|integer) not null`))
    }
  }
  assert.match(body, /updated_by uuid references auth\.users\(id\)/)
  assert.match(sql, /alter table private\.h2a_credentials enable row level security;/)
  assert.match(sql, /revoke all on table private\.h2a_credentials from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /grant [^;]*on (?:table )?private\.h2a_credentials to (?:public|anon|authenticated)/)
})

test('idempotency includes every delivery identity and permits reviewed many-to-one targets', () => {
  const sql = readSchema()
  assert.match(tableBody(sql, 'public.h2a_activity_deliveries'), /unique \(company_id, portal_id, object_type, activity_id, albi_target_type, albi_target_id\)/)
  for (const table of ['h2a_contact_mappings', 'h2a_organization_mappings']) {
    const body = tableBody(sql, `public.${table}`)
    assert.match(body, /unique \(company_id, portal_id, hubspot_id\)/)
    assert.doesNotMatch(body, /unique\s*\([^)]*albi_/)
    assert.match(body, /reviewed_by uuid references auth\.users\(id\)/)
  }
  assert.match(tableBody(sql, 'public.h2a_daily_claims'), /unique \(company_id, business_date\)/)
  assert.match(tableBody(sql, 'public.h2a_conflict_resumes'), /worker_failed boolean not null default false/)
  assert.match(tableBody(sql, 'public.h2a_company_config'), /selected_start_date date/)
  assert.match(tableBody(sql, 'public.h2a_company_config'), /notification_recipients text\[\].*cardinality\(notification_recipients\) <= 20/)
  assert.match(tableBody(sql, 'public.h2a_company_config'), /'disabled', 'ready', 'dry_run', 'live'/)
  assert.match(tableBody(sql, 'public.h2a_option_mappings'), /'activity_type', 'default_contact_type', 'default_organization_type', 'organization_to_contact_type'/)
  assert.match(tableBody(sql, 'public.h2a_activity_deliveries'), /'reserved', 'delivered', 'reconciled', 'failed'/)
})

test('access-path indexes and tenant-safe run/activity/conflict references are present', () => {
  const sql = readSchema()
  const indexes = [...sql.matchAll(/create (?:unique )?index (\w+)/g)].map((match) => match[1])
  assert.ok(indexes.length > 0)
  assert.ok(indexes.every((index) => index.startsWith('h2a_')))
  assert.match(sql, /create index h2a_runs_company_started_idx on public\.h2a_sync_runs \(company_id, started_at desc\)/)
  assert.match(sql, /create index h2a_conflicts_company_open_idx on public\.h2a_conflicts \(company_id, created_at desc\) where status = 'open'/)
  assert.match(sql, /create index h2a_items_run_created_idx on public\.h2a_item_results \(run_id, created_at, id\)/)
  assert.match(sql, /create index h2a_backfills_company_pending_idx on public\.h2a_backfill_windows \(company_id, start_at\) where status in \('pending', 'running'\)/)
  assert.match(tableBody(sql, 'public.h2a_item_results'), /foreign key \(company_id, run_id\) references public\.h2a_sync_runs \(company_id, id\)/)
  assert.match(tableBody(sql, 'public.h2a_conflicts'), /foreign key \(company_id, activity_delivery_id\) references public\.h2a_activity_deliveries \(company_id, id\)/)
  assert.match(tableBody(sql, 'public.h2a_conflict_events'), /foreign key \(company_id, conflict_id\) references public\.h2a_conflicts \(company_id, id\)/)
  assert.match(sql, /before update or delete on public\.h2a_conflict_events/)
})

test('all public RPCs restrict execution to service role and pin their search path', () => {
  const sql = readSchema()
  for (const name of ['h2a_get_credentials', 'h2a_put_credentials', 'h2a_claim_lease', 'h2a_heartbeat_lease', 'h2a_release_lease',
    'h2a_claim_daily_run', 'h2a_reserve_delivery', 'h2a_transition_delivery', 'h2a_resolve_conflict',
    'h2a_save_mapping', 'h2a_claim_conflict_resume', 'h2a_finish_conflict_resume', 'h2a_requeue_conflict_resume']) {
    const definition = sql.match(new RegExp(`create (?:or replace )?function public\\.${name}\\(([\\s\\S]*?)as \\$\\$`))?.[1]
    assert.ok(definition, name)
    assert.match(definition, /set search_path = ''/)
    assert.match(sql, new RegExp(`revoke execute on function public\\.${name}\\([^;]+\\) from public, anon, authenticated;`))
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]+\\) to service_role;`))
  }
})

test('delivery RPCs atomically reclaim eligible attempts and fence terminal transitions', () => {
  const sql = readSchema()
  const reserve = functionBody(sql, 'h2a_reserve_delivery')
  assert.match(reserve, /on conflict \(company_id, portal_id, object_type, activity_id, albi_target_type, albi_target_id\)\s+do nothing/)
  assert.match(reserve, /company_id = p_company_id[\s\S]*?for update/)
  assert.match(reserve, /v_row\.last_attempt_at <= p_stale_before/)
  assert.match(reserve, /v_row\.next_attempt_at is not null and v_row\.next_attempt_at <= p_retry_eligible_at/)
  assert.match(reserve, /attempt_count = attempt_count \+ 1/)
  const transition = functionBody(sql, 'h2a_transition_delivery')
  assert.match(transition, /where company_id = p_company_id and id = p_delivery_id and state = 'reserved'/)
  assert.match(transition, /and attempt_count = p_expected_attempt_count/)
})

test('claims are atomic and heartbeat/release cannot alter a successor lease', () => {
  const sql = readSchema()
  for (const name of ['h2a_claim_lease', 'h2a_heartbeat_lease']) {
    assert.match(sql, new RegExp(`create function public\\.${name}\\(p_company_id uuid, p_owner_token uuid, p_ttl_seconds integer\\)\\s+returns boolean`))
    assert.match(functionBody(sql, name), /p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600/)
  }
  assert.match(sql, /create function public\.h2a_release_lease\(p_company_id uuid, p_owner_token uuid\)\s+returns boolean/)
  assert.match(sql, /create function public\.h2a_claim_daily_run\(p_company_id uuid, p_business_date date, p_owner_token uuid, p_ttl_seconds integer default 180\)\s+returns jsonb/)
  const claim = functionBody(sql, 'h2a_claim_lease')
  assert.match(claim, /insert into public\.h2a_execution_leases/)
  assert.match(claim, /on conflict \(company_id\) do update/)
  assert.match(claim, /where leases\.expires_at <= v_now/)
  assert.match(claim, /returning owner_token into v_token/)
  for (const name of ['h2a_heartbeat_lease', 'h2a_release_lease']) {
    assert.match(functionBody(sql, name), /leases\.company_id = p_company_id and leases\.owner_token = p_owner_token/)
  }
  assert.match(functionBody(sql, 'h2a_heartbeat_lease'), /leases\.expires_at > v_now/)
  const daily = functionBody(sql, 'h2a_claim_daily_run')
  assert.match(daily, /on conflict \(company_id, business_date\) do nothing/)
  assert.match(daily, /p_business_date is null/)
  assert.match(daily, /v_row\.status = 'dispatched'/)
  assert.match(daily, /lease_expires_at > v_now/)
  assert.match(daily, /attempt_count = attempt_count \+ 1/)
  const finish = functionBody(sql, 'h2a_finish_daily_run')
  assert.match(finish, /owner_token = p_owner_token/)
  assert.match(finish, /status = case when p_accepted then 'dispatched' else 'pending' end/)
  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /scheduler_claim_id uuid/)
  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /resume_id uuid/)
  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /cancel_requested_at timestamptz/)
  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /cancel_requested_by uuid references auth\.users\(id\)/)
  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /sample_limit_per_type smallint/)
  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /sample_limit_per_type is null or \(mode = 'dry_run' and sample_limit_per_type between 1 and 50\)/)
  const checkpoints = tableBody(sql, 'public.h2a_run_checkpoints')
  assert.match(checkpoints, /upper_bound timestamptz not null/)
  assert.match(checkpoints, /page_after text/)
  assert.match(checkpoints, /processed_count smallint not null default 0/)
  assert.match(checkpoints, /processed_count between 0 and 50/)
  assert.match(checkpoints, /unique \(company_id, run_id, object_type\)/)
  assert.match(checkpoints, /foreign key \(company_id, run_id\) references public\.h2a_sync_runs \(company_id, id\)/)
  assert.match(checkpoints, /check \(\(cursor_timestamp is null\) = \(cursor_object_id is null\)\)/)
  assert.match(sql, /create unique index h2a_runs_company_scheduler_claim_uidx/)
  assert.match(sql, /create unique index h2a_runs_company_resume_uidx/)
})

test('sample dry-run migration is idempotent and constrains the server-owned per-type limit', () => {
  const sql = readSampleMigration()
  assert.match(sql, /alter table public\.h2a_sync_runs\s+add column if not exists sample_limit_per_type smallint/)
  assert.match(sql, /drop constraint if exists h2a_sync_runs_sample_limit_per_type_check/)
  assert.match(sql, /add constraint h2a_sync_runs_sample_limit_per_type_check\s+check \(sample_limit_per_type is null or \(mode = 'dry_run' and sample_limit_per_type between 1 and 50\)\)/)
  assert.match(sql, /alter table public\.h2a_run_checkpoints\s+add column if not exists processed_count smallint not null default 0/)
  assert.match(sql, /add constraint h2a_run_checkpoints_processed_count_check\s+check \(processed_count between 0 and 50\)/)
})

test('execution lease fencing tokens are not directly readable by authenticated users', () => {
  const sql = readSchema()
  assert.match(sql, /revoke all on table public\.h2a_execution_leases from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /grant [^;]*on table public\.h2a_execution_leases to authenticated;/)
  assert.doesNotMatch(sql, /create policy h2a_execution_leases_select/)
  assert.match(sql, /grant select on table public\.h2a_execution_leases to service_role;/)
  for (const name of ['h2a_claim_lease', 'h2a_heartbeat_lease', 'h2a_release_lease']) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]+\\) to service_role;`))
  }
})

test('conflict resolution is an atomic tenant-scoped CAS that appends audit, mapping, and unique resume intent', () => {
  const sql = readSchema()
  const body = functionBody(sql, 'h2a_resolve_conflict')
  assert.match(body, /where company_id = p_company_id and id = p_conflict_id\s+for update/)
  assert.match(body, /v_conflict\.updated_at <> p_expected_updated_at/)
  assert.match(body, /v_conflict\.status <> 'open'/)
  assert.match(body, /when 'approve_fields' then 'approve_hubspot'/)
  assert.match(body, /pg_advisory_xact_lock/)
  assert.match(body, /many_to_one_required/)
  const sourceIdentityLock = body.indexOf("'source',\n        v_conflict.object_type, v_conflict.source_id")
  const contactTargetLock = body.indexOf("'target', v_conflict.object_type, v_target_id")
  const organizationTargetLock = contactTargetLock
  assert.ok(sourceIdentityLock >= 0, 'source identity lock must include the HubSpot source ID')
  assert.ok(contactTargetLock > sourceIdentityLock, 'contact target lock must follow the source lock')
  assert.ok(organizationTargetLock > sourceIdentityLock, 'organization target lock must follow the source lock')
  assert.match(body, /hubspot_id = v_conflict\.source_id and m\.albi_contact_id <> v_target_id/)
  assert.match(body, /hubspot_id = v_conflict\.source_id and m\.albi_organization_id <> v_target_id/)
  assert.match(body, /update public\.h2a_contact_mappings[\s\S]*?set match_method = 'reviewed', approved_many_to_one = approved_many_to_one or v_many_to_one, reviewed_by = p_actor_id,\s*reviewed_at = p_now, updated_at = p_now[\s\S]*?and albi_contact_id = v_target_id/)
  assert.match(body, /update public\.h2a_organization_mappings[\s\S]*?set match_method = 'reviewed', approved_many_to_one = approved_many_to_one or v_many_to_one, reviewed_by = p_actor_id,\s*reviewed_at = p_now, updated_at = p_now[\s\S]*?and albi_organization_id = v_target_id/)
  assert.doesNotMatch(body, /on conflict \(company_id, portal_id, hubspot_id\) do update set albi_(?:contact|organization)_id/)
  assert.match(body, /insert into public\.h2a_contact_mappings/)
  assert.match(body, /insert into public\.h2a_organization_mappings/)
  assert.match(body, /insert into public\.h2a_conflict_events/)
  assert.match(body, /insert into public\.h2a_conflict_resumes/)
  assert.match(body, /resolutionrequest/)
  assert.match(body, /source_field\.key in \('id', 'firstname'/)
  assert.match(body, /jsonb_typeof\(source_field\.value\) in \('string', 'number', 'boolean'\)/)
  assert.match(body, /approvemanytoone/)
  assert.match(tableBody(sql, 'public.h2a_conflict_resumes'), /unique \(company_id, conflict_id\)/)
  assert.match(sql, /create index h2a_conflict_resumes_pending_idx on public\.h2a_conflict_resumes \(company_id, status, created_at, id\)/)
})

test('generic mapping saves share source locking, preserve target identity, and reject replacement', () => {
  const sql = readSchema()
  const save = functionBody(sql, 'h2a_save_mapping')
  const resolve = functionBody(sql, 'h2a_resolve_conflict')
  assert.match(save, /p_object_type not in \('contacts', 'companies'\)/)
  assert.match(save, /pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(/)
  assert.match(save, /jsonb_build_array\(p_company_id::text, p_portal_id, 'source', p_object_type, p_source_id\)::text, 0\)/)
  assert.equal((save.match(/where m\.company_id = p_company_id and m\.portal_id = p_portal_id and m\.hubspot_id = p_source_id/g) ?? []).length, 4)
  assert.match(resolve, /jsonb_build_array\(p_company_id::text, v_conflict\.portal_id, 'source',[\s\S]*?v_conflict\.object_type, v_conflict\.source_id\)::text, 0\)/)
  for (const target of ['albi_contact_id', 'albi_organization_id']) {
    assert.match(save, new RegExp(`${target} <> p_target_id[\\s\\S]*?mapping_conflict`))
    assert.doesNotMatch(save, new RegExp(`set ${target} =`))
  }
  assert.match(save, /if found then[\s\S]*?if v_contact\.albi_contact_id <> p_target_id then[\s\S]*?mapping_conflict[\s\S]*?return pg_catalog\.to_jsonb\(v_contact\);/)
  assert.match(save, /if found then[\s\S]*?if v_organization\.albi_organization_id <> p_target_id then[\s\S]*?mapping_conflict[\s\S]*?return pg_catalog\.to_jsonb\(v_organization\);/)
  const repository = readFileSync(new URL('../netlify/functions/_h2a/repository.js', import.meta.url), 'utf8')
  assert.match(repository, /rpc\('h2a_save_mapping'/)
  assert.doesNotMatch(repository, /from\(table\)\.upsert/)
})

test('mapping ownership is tenant-wide, source-then-target serialized, and requires explicit reviewed approval', () => {
  assert.ok(existsSync(mappingOwnershipMigrationUrl), 'deployable mapping ownership migration must exist')
  const migration = readFileSync(mappingOwnershipMigrationUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
  for (const sql of [readSchema(), migration]) {
    const save = functionBody(sql, 'h2a_save_mapping'), resolve = functionBody(sql, 'h2a_resolve_conflict')
    assert.match(sql, /p_approve_many_to_one boolean default false/)
    const sourceLock = save.indexOf("p_portal_id, 'source'")
    const targetLock = save.indexOf("p_company_id::text, 'target', p_object_type, p_target_id")
    assert.ok(sourceLock >= 0 && targetLock > sourceLock)
    assert.ok(targetLock < save.indexOf('select * into v_contact'))
    for (const [table, target] of [['h2a_contact_mappings', 'albi_contact_id'], ['h2a_organization_mappings', 'albi_organization_id']]) {
      assert.match(sql, new RegExp(`(?:create table public\\.${table}[\\s\\S]*?|alter table public\\.${table} add column if not exists )approved_many_to_one boolean not null default false`))
      assert.match(save, new RegExp(`from public\\.${table} m where m\\.company_id = p_company_id\\s+and m\\.${target} = p_target_id\\s+and \\(m\\.portal_id <> p_portal_id or m\\.hubspot_id <> p_source_id\\)`))
      assert.match(resolve, new RegExp(`and m\\.${target} = v_target_id and \\(m\\.portal_id <> v_conflict\\.portal_id or m\\.hubspot_id <> v_conflict\\.source_id\\)`))
      assert.ok(save.indexOf('many_to_one_required') < save.indexOf(`insert into public.${table}`))
    }
    assert.match(save, /p_approve_many_to_one and p_match_method <> 'reviewed'/)
    assert.match(resolve, /p_company_id::text, 'target', v_conflict\.object_type, v_target_id/)
    assert.match(sql, /revoke execute on function public\.h2a_save_mapping\(uuid, text, text, text, text, text, uuid, timestamptz, boolean, uuid\) from public, anon, authenticated/)
  }
  assert.match(migration, /drop function if exists public\.h2a_save_mapping\(uuid, text, text, text, text, text, uuid, timestamptz\)/)
  for (const name of ['h2a_save_mapping', 'h2a_resolve_conflict']) {
    const normalize = value => value.replace(/\s+/g, ' ').trim()
    assert.equal(normalize(functionBody(readSchema(), name)), normalize(functionBody(migration, name)))
  }
})

test('reviewed sharing upgrades the pre-existing owner and same-target approval without downgrading replay', () => {
  for (const sql of [readSchema(), readFileSync(mappingOwnershipMigrationUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()]) {
    const save = functionBody(sql, 'h2a_save_mapping'), resolve = functionBody(sql, 'h2a_resolve_conflict')
    for (const [table, row, target] of [
      ['h2a_contact_mappings', 'v_contact', 'albi_contact_id'],
      ['h2a_organization_mappings', 'v_organization', 'albi_organization_id'],
    ]) {
      assert.match(save, new RegExp(`if p_approve_many_to_one and not ${row}\\.approved_many_to_one then[\\s\\S]*?update public\\.${table} set match_method = 'reviewed', approved_many_to_one = true[\\s\\S]*?returning \\* into ${row}`))
      assert.match(save, new RegExp(`if v_peer_count = 1 and v_unapproved_count = 1 then[\\s\\S]*?update public\\.${table} set match_method = 'reviewed', approved_many_to_one = true[\\s\\S]*?${target} = p_target_id`))
      assert.match(resolve, new RegExp(`if v_peer_count = 1 and v_unapproved_count = 1 then[\\s\\S]*?update public\\.${table} set match_method = 'reviewed', approved_many_to_one = true[\\s\\S]*?${target} = v_target_id`))
    }
    assert.match(save, /if v_unapproved_count > 0 and v_peer_count <> 1 then[\s\S]*?'many_to_one_required'/)
    assert.match(resolve, /if v_unapproved_count > 0 and v_peer_count <> 1 then[\s\S]*?'many_to_one_required'/)
    assert.match(save, /if p_approve_many_to_one and not v_contact\.approved_many_to_one then/)
    assert.match(save, /if p_approve_many_to_one and not v_organization\.approved_many_to_one then/)
  }
})

test('targeted resume dispatch claims are fenced and remain retryable until accepted', () => {
  const sql = readSchema()
  for (const name of ['h2a_claim_conflict_resume', 'h2a_finish_conflict_resume']) {
    const definition = sql.match(new RegExp(`create function public\\.${name}\\(([\\s\\S]*?)as \\$\\$`))?.[1]
    assert.ok(definition, name)
    assert.match(definition, /set search_path = ''/)
    assert.match(sql, new RegExp(`revoke execute on function public\\.${name}\\([^;]+\\) from public, anon, authenticated;`))
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]+\\) to service_role;`))
  }
  assert.match(functionBody(sql, 'h2a_claim_conflict_resume'), /dispatch_owner_token is null or .*dispatch_lease_expires_at <= v_now/)
  assert.match(functionBody(sql, 'h2a_claim_conflict_resume'), /dispatch_attempt_count = dispatch_attempt_count \+ 1/)
  assert.match(functionBody(sql, 'h2a_finish_conflict_resume'), /p_accepted and not worker_failed then 'dispatched' else 'pending'/)
  assert.match(functionBody(sql, 'h2a_finish_conflict_resume'), /dispatch_owner_token = p_owner_token/)
  assert.match(functionBody(sql, 'h2a_requeue_conflict_resume'), /worker_failed = true/)
})

test('recheck batches allow one active batch per company and stay service-only in migration and canonical schema', () => {
  assert.ok(existsSync(recheckBatchMigrationUrl), 'deployable recheck batch migration must exist')
  const migration = readFileSync(recheckBatchMigrationUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
  for (const sql of [readSchema(), migration]) {
    const body = tableBody(sql, sql === migration ? 'if not exists public.h2a_review_recheck_batches' : 'public.h2a_review_recheck_batches')
    assert.match(body, /id uuid primary key default gen_random_uuid\(\)/)
    assert.match(body, /company_id uuid not null references public\.companies\(id\)/)
    assert.match(body, /foreign key \(company_id, run_id\) references public\.h2a_sync_runs \(company_id, id\) on delete cascade/)
    assert.match(body, /status text not null default 'queued' check \(status in \('queued', 'running', 'completed', 'failed'\)\)/)
    for (const column of ['total', 'done', 'cleared', 'still_needs_review', 'no_longer_in_scope', 'stale', 'failed']) {
      assert.match(body, new RegExp(`${column} integer not null default 0 check \\(${column} >= 0\\)`))
    }
    assert.match(body, /error_code text check \(error_code in \(/)
    assert.match(sql, /create unique index (?:if not exists )?h2a_review_recheck_batches_one_active_idx\s+on public\.h2a_review_recheck_batches \(company_id\)\s+where status in \('queued', 'running'\)/)
    assert.match(sql, /create index (?:if not exists )?\w+\s+on public\.h2a_review_recheck_batches \(requested_by\)/)
    assert.match(sql, /create index (?:if not exists )?\w+\s+on public\.h2a_review_recheck_batches \(company_id, created_at desc, id desc\)/)
    assert.match(sql, /alter table public\.h2a_review_recheck_batches enable row level security;/)
    assert.match(sql, /revoke all on table public\.h2a_review_recheck_batches from public, anon, authenticated, service_role;/)
    assert.match(sql, /grant select, insert, update on table public\.h2a_review_recheck_batches to service_role;/)
    assert.doesNotMatch(sql, /grant [^;]*public\.h2a_review_recheck_batches to (?:public|anon|authenticated)/)
    assert.doesNotMatch(sql, /create policy[^;]*public\.h2a_review_recheck_batches/)
  }
})

const readLiveMigration = () => {
  assert.ok(existsSync(liveReviewMigrationUrl), 'live review workspace migration must exist')
  return readFileSync(liveReviewMigrationUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
}

test('live review workspace migration exists and is mirrored in h2a-schema.sql', () => {
  const migration = readLiveMigration()
  const schema = readSchema()
  for (const sql of [migration, schema]) {
    assert.match(sql, /add column if not exists review_kind text not null default 'sample' check \(review_kind in \('sample', 'live'\)\)/)
    assert.match(sql, /add column if not exists triage_bucket text not null default 'decision'\s+check \(triage_bucket in \('quick', 'todo', 'decision', 'blocked', 'done'\)\)/)
    assert.match(sql, /add column if not exists triage_details jsonb not null default '\{\}'::jsonb\s+check \(jsonb_typeof\(triage_details\) = 'object'\)/)
    assert.match(sql, /create or replace function public\.h2a_block_run_delete_with_open_live_reviews\(\)/)
    assert.match(sql, /create trigger h2a_block_run_delete_with_open_live_reviews\s+before delete on public\.h2a_sync_runs/)
    assert.match(sql, /r\.review_kind = 'live' and r\.status = 'needs_review'/)
  }
})

test('live review rows are unique per open HubSpot source', () => {
  for (const sql of [readLiveMigration(), readSchema()]) {
    assert.match(sql, /create unique index (?:if not exists )?h2a_live_review_open_source_idx\s+on public\.h2a_dry_run_reviews \(company_id, portal_id, object_type, source_id\)\s+where review_kind = 'live' and status = 'needs_review'/)
  }
})

test('h2a_live_review_conflicts is service-only and unique per conflict', () => {
  for (const sql of [readLiveMigration(), readSchema()]) {
    const body = tableBody(sql, 'public.h2a_live_review_conflicts')
    assert.match(body, /foreign key \(company_id, review_id\) references public\.h2a_dry_run_reviews \(company_id, id\)/)
    assert.match(body, /foreign key \(company_id, conflict_id\) references public\.h2a_conflicts \(company_id, id\)/)
    assert.match(body, /unique \(company_id, conflict_id\)/)
    assert.match(sql, /alter table public\.h2a_live_review_conflicts enable row level security;/)
    assert.match(sql, /revoke all on table public\.h2a_live_review_conflicts from public, anon, authenticated, service_role;/)
    assert.doesNotMatch(sql, /grant [^;]*public\.h2a_live_review_conflicts to (?:public|anon|authenticated)/)
    assert.doesNotMatch(sql, /create policy[^;]*public\.h2a_live_review_conflicts/)
  }
})

test('h2a_close_live_review closes conflicts and inserts resumes in one function body', () => {
  for (const sql of [readLiveMigration(), readSchema()]) {
    const body = functionBody(sql, 'h2a_close_live_review')
    assert.match(body, /update public\.h2a_conflicts/)
    assert.match(body, /insert into public\.h2a_conflict_resumes/)
    assert.match(body, /on conflict \(company_id, conflict_id\) do nothing/)
    assert.match(body, /insert into public\.h2a_conflict_events/)
    assert.match(body, /for update/)
    assert.match(body, /p_outcome is null or p_outcome not in \('resolved', 'resolved_by_sync', 'skipped', 'source_missing'\)/)
    assert.match(body, /p_outcome = 'resolved' and coalesce\(p_resolution_action, ''\) not in \('link_existing', 'create_new'\)/)
    assert.match(body, /when p_outcome = 'resolved_by_sync' then 'link_existing'/)
    assert.match(body, /if p_outcome in \('resolved', 'resolved_by_sync'\) then[\s\S]*?insert into public\.h2a_conflict_resumes/)
    assert.match(sql, /create or replace function public\.h2a_close_live_review\([\s\S]*?security definer set search_path = ''/)
    assert.match(sql, /revoke execute on function public\.h2a_close_live_review\(uuid, uuid, uuid, text, text\) from public, anon, authenticated;/)
    assert.match(sql, /grant execute on function public\.h2a_close_live_review\(uuid, uuid, uuid, text, text\) to service_role;/)
    assert.doesNotMatch(sql, /grant execute on function public\.h2a_close_live_review\([^;]*to (?:public|anon|authenticated)/)
  }
})

test('recheck batches are scoped by review_kind and may list review_ids', () => {
  for (const sql of [readLiveMigration(), readSchema()]) {
    assert.match(sql, /alter table public\.h2a_review_recheck_batches\s+add column if not exists review_kind text not null default 'sample' check \(review_kind in \('sample', 'live'\)\),\s+add column if not exists review_ids uuid\[\];/)
    assert.match(sql, /alter table public\.h2a_review_recheck_batches alter column run_id drop not null;/)
    assert.match(sql, /check \(review_kind = 'live' or run_id is not null\)/)
    assert.match(sql, /create unique index (?:if not exists )?h2a_review_recheck_batches_one_active_kind_idx\s+on public\.h2a_review_recheck_batches \(company_id, review_kind\)\s+where status in \('queued', 'running'\)/)
  }
})
