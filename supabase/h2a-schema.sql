-- H2A module: run ONCE in the existing project's SQL Editor after local validation.
-- Prerequisites: public.companies(id), public.company_members(company_id,user_id,role),
-- public.super_admins(user_id), auth.users(id), and the standard Supabase roles.
-- Membership/user lookups rely on the existing shared tables' indexed keys.
-- This script deliberately does not alter the shared tables or their policies.
-- Dates are America/Los_Angeles business dates; timestamps are absolute instants.
-- Operational JSON must be sanitized by the server before persistence.
-- Audit/history FKs restrict deletion; explicit retention work is a separate operation.
begin;

create schema if not exists private;

create table private.h2a_credentials (
  company_id uuid primary key references public.companies(id),
  hubspot_ciphertext text not null check (length(btrim(hubspot_ciphertext)) > 0),
  hubspot_iv text not null check (length(btrim(hubspot_iv)) > 0),
  hubspot_tag text not null check (length(btrim(hubspot_tag)) > 0),
  hubspot_key_version integer not null check (hubspot_key_version > 0),
  albi_ciphertext text not null check (length(btrim(albi_ciphertext)) > 0),
  albi_iv text not null check (length(btrim(albi_iv)) > 0),
  albi_tag text not null check (length(btrim(albi_tag)) > 0),
  albi_key_version integer not null check (albi_key_version > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.h2a_company_config (
  company_id uuid primary key references public.companies(id),
  state text not null default 'disabled' check (state in ('disabled', 'ready', 'dry_run', 'live')),
  portal_id text check (length(btrim(portal_id)) > 0),
  selected_start_date date,
  initial_start_locked_at timestamptz,
  preflight_status text not null default 'unchecked' check (preflight_status in ('unchecked', 'running', 'valid', 'invalid')),
  preflight_details jsonb not null default '{}'::jsonb check (jsonb_typeof(preflight_details) = 'object'),
  preflight_checked_at timestamptz,
  option_confirmation_status text not null default 'unconfirmed' check (option_confirmation_status in ('unconfirmed', 'confirmed')),
  options_confirmed_by uuid references auth.users(id) on delete set null,
  options_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.h2a_option_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  mapping_kind text not null check (mapping_kind in ('activity_type', 'default_contact_type', 'default_organization_type', 'organization_to_contact_type')),
  source_key text not null check (length(btrim(source_key)) > 0),
  albi_id text not null check (length(btrim(albi_id)) > 0),
  label text not null,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, mapping_kind, source_key)
);

create table public.h2a_sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  mode text not null check (mode in ('dry_run', 'live')),
  trigger text not null check (trigger in ('manual', 'scheduled', 'resume', 'backfill', 'conflict_resolution')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'partially_failed', 'failed', 'cancelled', 'paused')),
  totals jsonb not null default '{}'::jsonb check (jsonb_typeof(totals) = 'object'),
  requested_by uuid references auth.users(id) on delete set null,
  business_date date,
  started_at timestamptz,
  finished_at timestamptz,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (finished_at is null or (started_at is not null and finished_at >= started_at))
);

create table public.h2a_cursors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  object_type text not null check (object_type in ('meetings', 'calls', 'emails', 'communications', 'notes')),
  cursor_timestamp timestamptz not null,
  cursor_object_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, object_type)
);

create table public.h2a_backfill_windows (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  object_type text not null check (object_type in ('meetings', 'calls', 'emails', 'communications', 'notes')),
  checkpoint_timestamp timestamptz,
  checkpoint_object_id text,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  request_id uuid not null,
  requested_by uuid references auth.users(id) on delete set null,
  requested_start_date date not null,
  requested_at timestamptz not null default now(),
  request_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(request_metadata) = 'object'),
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id),
  unique (company_id, request_id, object_type, start_at, end_at),
  check (end_at > start_at),
  check ((checkpoint_timestamp is null) = (checkpoint_object_id is null)),
  check (checkpoint_timestamp is null or (checkpoint_timestamp >= start_at and checkpoint_timestamp <= end_at))
);

-- Only source identities are unique. Reviewed many-to-one targets are allowed.
create table public.h2a_contact_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  portal_id text not null check (length(btrim(portal_id)) > 0),
  hubspot_id text not null check (length(btrim(hubspot_id)) > 0),
  albi_contact_id text not null check (length(btrim(albi_contact_id)) > 0),
  match_method text not null check (match_method in ('automatic', 'created', 'reviewed')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, portal_id, hubspot_id)
);

create table public.h2a_organization_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  portal_id text not null check (length(btrim(portal_id)) > 0),
  hubspot_id text not null check (length(btrim(hubspot_id)) > 0),
  albi_organization_id text not null check (length(btrim(albi_organization_id)) > 0),
  match_method text not null check (match_method in ('automatic', 'created', 'reviewed')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, portal_id, hubspot_id)
);

create table public.h2a_activity_deliveries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  portal_id text not null check (length(btrim(portal_id)) > 0),
  object_type text not null check (object_type in ('meetings', 'calls', 'emails', 'communications', 'notes')),
  activity_id text not null check (length(btrim(activity_id)) > 0),
  albi_target_type text not null check (albi_target_type in ('contact', 'organization')),
  albi_target_id text not null check (length(btrim(albi_target_id)) > 0),
  state text not null default 'reserved' check (state in ('reserved', 'delivered', 'reconciled', 'failed')),
  source_marker text not null check (length(btrim(source_marker)) > 0),
  albi_activity_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error_summary text,
  run_id uuid,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id),
  unique (company_id, id),
  unique (company_id, portal_id, object_type, activity_id, albi_target_type, albi_target_id)
);

create table public.h2a_item_results (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  run_id uuid not null,
  portal_id text not null check (length(btrim(portal_id)) > 0),
  object_type text not null check (object_type in ('contacts', 'companies', 'meetings', 'calls', 'emails', 'communications', 'notes')),
  source_id text not null check (length(btrim(source_id)) > 0),
  albi_target_type text check (albi_target_type in ('contact', 'organization')),
  albi_target_id text,
  activity_delivery_id uuid,
  outcome text not null check (outcome in ('created', 'updated', 'linked', 'delivered', 'reconciled', 'skipped', 'conflict', 'failed', 'dry_run')),
  sanitized_details jsonb not null default '{}'::jsonb check (jsonb_typeof(sanitized_details) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id),
  foreign key (company_id, activity_delivery_id) references public.h2a_activity_deliveries (company_id, id),
  check ((albi_target_type is null) = (albi_target_id is null))
);

create table public.h2a_conflicts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  portal_id text not null check (length(btrim(portal_id)) > 0),
  object_type text not null check (object_type in ('contacts', 'companies', 'meetings', 'calls', 'emails', 'communications', 'notes')),
  source_id text not null check (length(btrim(source_id)) > 0),
  conflict_type text not null check (length(btrim(conflict_type)) > 0),
  reason text not null,
  match_evidence jsonb not null default '{}'::jsonb,
  source_snapshot jsonb not null default '{}'::jsonb,
  candidate_snapshots jsonb not null default '[]'::jsonb,
  proposed_changes jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolving', 'resolved', 'skipped')),
  run_id uuid,
  activity_delivery_id uuid,
  activity_object_type text check (activity_object_type in ('meetings', 'calls', 'emails', 'communications', 'notes')),
  activity_id text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolution_action text check (resolution_action in ('link_existing', 'create_new', 'approve_hubspot', 'retain_albi', 'skip')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id),
  foreign key (company_id, activity_delivery_id) references public.h2a_activity_deliveries (company_id, id),
  unique (company_id, id),
  check ((activity_object_type is null) = (activity_id is null))
);

create table public.h2a_conflict_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  conflict_id uuid not null,
  event_type text not null check (event_type in ('opened', 'resolution_requested', 'resolved', 'resolution_failed', 'reopened', 'skipped')),
  -- Preserve audit actor identity without FK deletion side effects on immutable rows.
  actor_id uuid,
  resolution_action text check (resolution_action in ('link_existing', 'create_new', 'approve_hubspot', 'retain_albi', 'skip')),
  sanitized_details jsonb not null default '{}'::jsonb check (jsonb_typeof(sanitized_details) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (company_id, conflict_id) references public.h2a_conflicts (company_id, id)
);

create table public.h2a_execution_leases (
  company_id uuid primary key references public.companies(id),
  owner_token uuid not null,
  acquired_at timestamptz not null,
  heartbeat_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > heartbeat_at)
);

create table public.h2a_daily_claims (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  business_date date not null,
  claimed_at timestamptz not null default now(),
  unique (company_id, business_date)
);

-- Company-leading primary/unique indexes cover tenant predicates and company FKs.
-- Additional FK indexes cover user references and composite run/delivery/conflict FKs.
create index h2a_credentials_updated_by_idx on private.h2a_credentials (updated_by);
create index h2a_config_confirmed_by_idx on public.h2a_company_config (options_confirmed_by);
create index h2a_options_confirmed_by_idx on public.h2a_option_mappings (confirmed_by);
create index h2a_runs_requested_by_idx on public.h2a_sync_runs (requested_by);
create index h2a_runs_company_started_idx on public.h2a_sync_runs (company_id, started_at desc);
create index h2a_backfills_requested_by_idx on public.h2a_backfill_windows (requested_by);
create index h2a_backfills_company_run_idx on public.h2a_backfill_windows (company_id, run_id);
create index h2a_backfills_company_pending_idx on public.h2a_backfill_windows (company_id, start_at) where status in ('pending', 'running');
create index h2a_contacts_reviewed_by_idx on public.h2a_contact_mappings (reviewed_by);
create index h2a_contacts_target_idx on public.h2a_contact_mappings (company_id, albi_contact_id);
create index h2a_organizations_reviewed_by_idx on public.h2a_organization_mappings (reviewed_by);
create index h2a_organizations_target_idx on public.h2a_organization_mappings (company_id, albi_organization_id);
create index h2a_deliveries_company_run_idx on public.h2a_activity_deliveries (company_id, run_id);
create index h2a_items_company_run_idx on public.h2a_item_results (company_id, run_id);
create index h2a_items_company_delivery_idx on public.h2a_item_results (company_id, activity_delivery_id);
create index h2a_items_run_created_idx on public.h2a_item_results (run_id, created_at, id);
create index h2a_conflicts_company_run_idx on public.h2a_conflicts (company_id, run_id);
create index h2a_conflicts_company_delivery_idx on public.h2a_conflicts (company_id, activity_delivery_id);
create index h2a_conflicts_resolved_by_idx on public.h2a_conflicts (resolved_by);
create index h2a_conflicts_company_open_idx on public.h2a_conflicts (company_id, created_at desc) where status = 'open';
create index h2a_events_company_conflict_idx on public.h2a_conflict_events (company_id, conflict_id, created_at, id);

alter table private.h2a_credentials enable row level security;
revoke all on table private.h2a_credentials from public, anon, authenticated;
revoke all on table private.h2a_credentials from service_role;

-- Browser clients may only read tenant operations; all writes use Netlify functions.
alter table public.h2a_company_config enable row level security;
revoke all on table public.h2a_company_config from public, anon, authenticated;
grant select on table public.h2a_company_config to authenticated;
grant select, insert, update, delete on table public.h2a_company_config to service_role;
create policy h2a_company_config_select on public.h2a_company_config
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_company_config.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_option_mappings enable row level security;
revoke all on table public.h2a_option_mappings from public, anon, authenticated;
grant select on table public.h2a_option_mappings to authenticated;
grant select, insert, update, delete on table public.h2a_option_mappings to service_role;
create policy h2a_option_mappings_select on public.h2a_option_mappings
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_option_mappings.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_sync_runs enable row level security;
revoke all on table public.h2a_sync_runs from public, anon, authenticated;
grant select on table public.h2a_sync_runs to authenticated;
grant select, insert, update, delete on table public.h2a_sync_runs to service_role;
create policy h2a_sync_runs_select on public.h2a_sync_runs
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_sync_runs.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_cursors enable row level security;
revoke all on table public.h2a_cursors from public, anon, authenticated;
grant select on table public.h2a_cursors to authenticated;
grant select, insert, update, delete on table public.h2a_cursors to service_role;
create policy h2a_cursors_select on public.h2a_cursors
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_cursors.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_backfill_windows enable row level security;
revoke all on table public.h2a_backfill_windows from public, anon, authenticated;
grant select on table public.h2a_backfill_windows to authenticated;
grant select, insert, update, delete on table public.h2a_backfill_windows to service_role;
create policy h2a_backfill_windows_select on public.h2a_backfill_windows
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_backfill_windows.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_contact_mappings enable row level security;
revoke all on table public.h2a_contact_mappings from public, anon, authenticated;
grant select on table public.h2a_contact_mappings to authenticated;
grant select, insert, update, delete on table public.h2a_contact_mappings to service_role;
create policy h2a_contact_mappings_select on public.h2a_contact_mappings
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_contact_mappings.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_organization_mappings enable row level security;
revoke all on table public.h2a_organization_mappings from public, anon, authenticated;
grant select on table public.h2a_organization_mappings to authenticated;
grant select, insert, update, delete on table public.h2a_organization_mappings to service_role;
create policy h2a_organization_mappings_select on public.h2a_organization_mappings
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_organization_mappings.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_activity_deliveries enable row level security;
revoke all on table public.h2a_activity_deliveries from public, anon, authenticated;
grant select on table public.h2a_activity_deliveries to authenticated;
grant select, insert, update, delete on table public.h2a_activity_deliveries to service_role;
create policy h2a_activity_deliveries_select on public.h2a_activity_deliveries
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_activity_deliveries.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_item_results enable row level security;
revoke all on table public.h2a_item_results from public, anon, authenticated;
grant select on table public.h2a_item_results to authenticated;
grant select, insert, update, delete on table public.h2a_item_results to service_role;
create policy h2a_item_results_select on public.h2a_item_results
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_item_results.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_conflicts enable row level security;
revoke all on table public.h2a_conflicts from public, anon, authenticated;
grant select on table public.h2a_conflicts to authenticated;
grant select, insert, update, delete on table public.h2a_conflicts to service_role;
create policy h2a_conflicts_select on public.h2a_conflicts
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_conflicts.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_conflict_events enable row level security;
revoke all on table public.h2a_conflict_events from public, anon, authenticated;
revoke all on table public.h2a_conflict_events from service_role;
grant select on table public.h2a_conflict_events to authenticated;
grant select, insert on table public.h2a_conflict_events to service_role;
create policy h2a_conflict_events_select on public.h2a_conflict_events
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_conflict_events.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_execution_leases enable row level security;
revoke all on table public.h2a_execution_leases from public, anon, authenticated;
revoke all on table public.h2a_execution_leases from service_role;
grant select on table public.h2a_execution_leases to authenticated;
grant select on table public.h2a_execution_leases to service_role;
create policy h2a_execution_leases_select on public.h2a_execution_leases
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_execution_leases.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_daily_claims enable row level security;
revoke all on table public.h2a_daily_claims from public, anon, authenticated;
revoke all on table public.h2a_daily_claims from service_role;
grant select on table public.h2a_daily_claims to authenticated;
grant select on table public.h2a_daily_claims to service_role;
create policy h2a_daily_claims_select on public.h2a_daily_claims
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_daily_claims.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

create function private.h2a_reject_audit_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'H2A conflict events are append-only' using errcode = '42501';
end;
$$;
revoke execute on function private.h2a_reject_audit_mutation() from public, anon, authenticated, service_role;
create trigger h2a_conflict_events_immutable
  before update or delete on public.h2a_conflict_events
  for each row execute function private.h2a_reject_audit_mutation();

-- Credential functions return/store ciphertext envelopes only. Encryption/decryption
-- and company authorization occur in Netlify; keys/plaintext never enter this schema.
create function public.h2a_get_credentials(p_company_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'hubspot_envelope', pg_catalog.jsonb_build_object('ciphertext', c.hubspot_ciphertext, 'iv', c.hubspot_iv, 'tag', c.hubspot_tag, 'key_version', c.hubspot_key_version),
    'albi_envelope', pg_catalog.jsonb_build_object('ciphertext', c.albi_ciphertext, 'iv', c.albi_iv, 'tag', c.albi_tag, 'key_version', c.albi_key_version),
    'updated_by', c.updated_by, 'updated_at', c.updated_at
  ) from private.h2a_credentials c where c.company_id = p_company_id;
$$;
revoke execute on function public.h2a_get_credentials(uuid) from public, anon, authenticated;
grant execute on function public.h2a_get_credentials(uuid) to service_role;

create function public.h2a_put_credentials(p_company_id uuid, p_hubspot_envelope jsonb, p_albi_envelope jsonb, p_updated_by uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_company_id is null or p_updated_by is null
     or p_hubspot_envelope is null or p_albi_envelope is null
     or pg_catalog.jsonb_typeof(p_hubspot_envelope) <> 'object'
     or pg_catalog.jsonb_typeof(p_albi_envelope) <> 'object' then
    raise exception 'Company, actor, and encrypted credential envelopes are required' using errcode = '22023';
  end if;
  insert into private.h2a_credentials (
    company_id, hubspot_ciphertext, hubspot_iv, hubspot_tag, hubspot_key_version,
    albi_ciphertext, albi_iv, albi_tag, albi_key_version, updated_by
  ) values (
    p_company_id, p_hubspot_envelope->>'ciphertext', p_hubspot_envelope->>'iv', p_hubspot_envelope->>'tag', (p_hubspot_envelope->>'key_version')::integer,
    p_albi_envelope->>'ciphertext', p_albi_envelope->>'iv', p_albi_envelope->>'tag', (p_albi_envelope->>'key_version')::integer, p_updated_by
  ) on conflict (company_id) do update set
    hubspot_ciphertext = excluded.hubspot_ciphertext, hubspot_iv = excluded.hubspot_iv,
    hubspot_tag = excluded.hubspot_tag, hubspot_key_version = excluded.hubspot_key_version,
    albi_ciphertext = excluded.albi_ciphertext, albi_iv = excluded.albi_iv,
    albi_tag = excluded.albi_tag, albi_key_version = excluded.albi_key_version,
    updated_by = excluded.updated_by, updated_at = pg_catalog.clock_timestamp();
end;
$$;
revoke execute on function public.h2a_put_credentials(uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.h2a_put_credentials(uuid, jsonb, jsonb, uuid) to service_role;

-- Each invocation must generate a fresh owner token. An occupied lease returns false,
-- even for the same token; renewal uses heartbeat. Expired leases can be replaced.
-- RPCs are short DB transactions; never keep one open during network calls.
create function public.h2a_claim_lease(p_company_id uuid, p_owner_token uuid, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_token uuid;
begin
  if p_company_id is null or p_owner_token is null or p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    raise exception 'Company, owner token, and TTL of 1..3600 seconds are required' using errcode = '22023';
  end if;
  insert into public.h2a_execution_leases as leases (company_id, owner_token, acquired_at, heartbeat_at, expires_at)
  values (p_company_id, p_owner_token, v_now, v_now, v_now + pg_catalog.make_interval(secs => p_ttl_seconds))
  on conflict (company_id) do update set
    owner_token = excluded.owner_token, acquired_at = excluded.acquired_at,
    heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at
  where leases.expires_at <= v_now
  returning owner_token into v_token;
  return v_token is not null;
end;
$$;
revoke execute on function public.h2a_claim_lease(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.h2a_claim_lease(uuid, uuid, integer) to service_role;

create function public.h2a_heartbeat_lease(p_company_id uuid, p_owner_token uuid, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_company_id is null or p_owner_token is null or p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    raise exception 'Company, owner token, and TTL of 1..3600 seconds are required' using errcode = '22023';
  end if;
  update public.h2a_execution_leases as leases
  set heartbeat_at = v_now, expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
  where leases.company_id = p_company_id and leases.owner_token = p_owner_token
    and leases.expires_at > v_now;
  return found;
end;
$$;
revoke execute on function public.h2a_heartbeat_lease(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.h2a_heartbeat_lease(uuid, uuid, integer) to service_role;

create function public.h2a_release_lease(p_company_id uuid, p_owner_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_company_id is null or p_owner_token is null then
    raise exception 'Company and owner token are required' using errcode = '22023';
  end if;
  delete from public.h2a_execution_leases as leases
  where leases.company_id = p_company_id and leases.owner_token = p_owner_token;
  return found;
end;
$$;
revoke execute on function public.h2a_release_lease(uuid, uuid) from public, anon, authenticated;
grant execute on function public.h2a_release_lease(uuid, uuid) to service_role;

-- Caller supplies its America/Los_Angeles business date, never a UTC date.
-- Claims persist across dates so delayed duplicate scheduler calls remain no-ops.
create function public.h2a_claim_daily_run(p_company_id uuid, p_business_date date)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_company_id is null or p_business_date is null then
    raise exception 'Company and Pacific business date are required' using errcode = '22023';
  end if;
  insert into public.h2a_daily_claims (company_id, business_date)
  values (p_company_id, p_business_date)
  on conflict (company_id, business_date) do nothing;
  return found;
end;
$$;
revoke execute on function public.h2a_claim_daily_run(uuid, date) from public, anon, authenticated;
grant execute on function public.h2a_claim_daily_run(uuid, date) to service_role;

commit;
