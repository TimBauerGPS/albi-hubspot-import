import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Static deployment contract only: this does not replace PostgreSQL role/concurrency tests.
const schemaUrl = new URL('../supabase/h2a-schema.sql', import.meta.url)
const requiredTables = [
  'h2a_company_config', 'h2a_option_mappings', 'h2a_sync_runs',
  'h2a_cursors', 'h2a_backfill_windows', 'h2a_contact_mappings',
  'h2a_organization_mappings', 'h2a_activity_deliveries',
  'h2a_item_results', 'h2a_conflicts', 'h2a_conflict_events',
  'h2a_execution_leases', 'h2a_daily_claims',
]
const readSchema = () => readFileSync(schemaUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
const tableBody = (sql, table) => {
  const body = sql.match(new RegExp(`create table ${table.replace('.', '\\.')} \\(([\\s\\S]*?)\\n\\);`))?.[1]
  assert.ok(body, `${table} must exist`)
  return body
}
const functionBody = (sql, name) => {
  const body = sql.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1]
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
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`))
    assert.match(sql, new RegExp(`grant select on table public\\.${table} to authenticated;`))
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
  assert.match(tableBody(sql, 'public.h2a_company_config'), /selected_start_date date/)
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
  for (const name of ['h2a_get_credentials', 'h2a_put_credentials', 'h2a_claim_lease', 'h2a_heartbeat_lease', 'h2a_release_lease', 'h2a_claim_daily_run', 'h2a_reserve_delivery', 'h2a_transition_delivery']) {
    const definition = sql.match(new RegExp(`create function public\\.${name}\\(([\\s\\S]*?)as \\$\\$`))?.[1]
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
  assert.match(sql, /create function public\.h2a_claim_daily_run\(p_company_id uuid, p_business_date date\)\s+returns boolean/)
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
})
