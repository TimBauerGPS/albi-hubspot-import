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
  notification_recipients text[] not null default '{}'::text[] check (cardinality(notification_recipients) <= 20),
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
  scheduler_claim_id uuid,
  resume_id uuid,
  cancel_requested_at timestamptz,
  cancel_requested_by uuid references auth.users(id) on delete set null,
  sample_limit_per_type smallint check (sample_limit_per_type is null or (mode = 'dry_run' and sample_limit_per_type between 1 and 50)),
  review_capture_version smallint check (review_capture_version is null or (
    mode = 'dry_run' and sample_limit_per_type is not null and sample_limit_per_type = 10 and review_capture_version = 1
  )),
  started_at timestamptz,
  finished_at timestamptz,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (finished_at is null or (started_at is not null and finished_at >= started_at))
);

create table public.h2a_run_checkpoints (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  run_id uuid not null,
  object_type text not null check (object_type in ('meetings', 'calls', 'emails', 'communications', 'notes')),
  upper_bound timestamptz not null,
  page_after text check (page_after is null or length(page_after) <= 2000),
  cursor_timestamp timestamptz,
  cursor_object_id text,
  processed_count smallint not null default 0 check (processed_count between 0 and 50),
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id),
  unique (company_id, run_id, object_type),
  check ((cursor_timestamp is null) = (cursor_object_id is null))
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
  approved_many_to_one boolean not null default false check (not approved_many_to_one or match_method = 'reviewed'),
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
  approved_many_to_one boolean not null default false check (not approved_many_to_one or match_method = 'reviewed'),
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

create table public.h2a_dry_run_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  run_id uuid not null,
  portal_id text not null check (length(btrim(portal_id)) > 0),
  object_type text not null check (object_type in ('contacts', 'companies')),
  source_id text not null check (length(btrim(source_id)) > 0),
  reason text not null check (length(btrim(reason)) > 0),
  conflict_type text not null check (length(btrim(conflict_type)) > 0),
  source_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(source_snapshot) = 'object'),
  candidate_snapshots jsonb not null default '[]'::jsonb check (
    jsonb_typeof(candidate_snapshots) = 'array' and jsonb_array_length(candidate_snapshots) <= 10
  ),
  match_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(match_evidence) = 'object'),
  proposed_changes jsonb not null default '{}'::jsonb check (jsonb_typeof(proposed_changes) = 'object'),
  status text not null default 'needs_review' check (status in ('needs_review', 'cleared', 'no_longer_in_scope')),
  recheck_outcome text check (recheck_outcome in ('still_needs_review', 'safe_to_link', 'safe_to_create', 'source_missing')),
  last_rechecked_at timestamptz,
  last_rechecked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id) on delete cascade,
  unique (company_id, id),
  unique (company_id, run_id, portal_id, object_type, source_id)
);

create table public.h2a_dry_run_review_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  review_id uuid not null,
  actor_id uuid,
  event_type text not null check (event_type in (
    'captured', 'recheck_started', 'still_needs_review', 'cleared',
    'no_longer_in_scope', 'recheck_failed'
  )),
  reason text,
  sanitized_details jsonb not null default '{}'::jsonb check (jsonb_typeof(sanitized_details) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (company_id, review_id) references public.h2a_dry_run_reviews (company_id, id) on delete cascade
);

create table public.h2a_review_recheck_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  run_id uuid not null,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  total integer not null default 0 check (total >= 0),
  done integer not null default 0 check (done >= 0),
  cleared integer not null default 0 check (cleared >= 0),
  still_needs_review integer not null default 0 check (still_needs_review >= 0),
  no_longer_in_scope integer not null default 0 check (no_longer_in_scope >= 0),
  stale integer not null default 0 check (stale >= 0),
  failed integer not null default 0 check (failed >= 0),
  error_code text check (error_code in (
    'superseded', 'timeout', 'expired', 'dispatch_failed', 'operation_failed',
    'pagination_loop', 'malformed_response', 'application_error', 'unsupported_contract', 'network'
  )),
  heartbeat_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id) on delete cascade,
  unique (company_id, id)
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

-- Durable, deduplicated work intent. Netlify dispatch is retried separately;
-- the stable resume ID is the consumer idempotency key.
create table public.h2a_conflict_resumes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  conflict_id uuid not null,
  resolution_action text not null check (resolution_action in ('link_existing', 'create_new')),
  source_object_type text not null check (source_object_type in ('contacts', 'companies', 'meetings', 'calls', 'emails', 'communications', 'notes')),
  source_id text not null check (length(btrim(source_id)) > 0),
  activity_object_type text check (activity_object_type in ('meetings', 'calls', 'emails', 'communications', 'notes')),
  activity_id text,
  originating_run_id uuid,
  activity_delivery_id uuid,
  status text not null default 'pending' check (status in ('pending', 'dispatched')),
  dispatch_attempt_count integer not null default 0 check (dispatch_attempt_count >= 0),
  worker_failed boolean not null default false,
  dispatch_owner_token uuid,
  dispatch_lease_expires_at timestamptz,
  last_dispatch_error_code text check (last_dispatch_error_code in ('dispatch_failed', 'dispatch_not_accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  dispatched_at timestamptz,
  foreign key (company_id, conflict_id) references public.h2a_conflicts (company_id, id),
  foreign key (company_id, originating_run_id) references public.h2a_sync_runs (company_id, id),
  foreign key (company_id, activity_delivery_id) references public.h2a_activity_deliveries (company_id, id),
  unique (company_id, conflict_id),
  check ((activity_object_type is null) = (activity_id is null)),
  check ((dispatch_owner_token is null) = (dispatch_lease_expires_at is null)),
  check ((status = 'dispatched') = (dispatched_at is not null))
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
  status text not null default 'pending' check (status in ('pending', 'dispatched')),
  owner_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_dispatch_error_code text check (last_dispatch_error_code in ('dispatch_failed', 'dispatch_not_accepted')),
  dispatched_at timestamptz,
  unique (company_id, business_date),
  check ((owner_token is null) = (lease_expires_at is null)),
  check ((status = 'dispatched') = (dispatched_at is not null))
);

-- Company-leading primary/unique indexes cover tenant predicates and company FKs.
create index h2a_dry_reviews_company_run_status_idx
  on public.h2a_dry_run_reviews (company_id, run_id, status, object_type, created_at desc, id desc);
create index h2a_dry_reviews_company_run_reason_idx
  on public.h2a_dry_run_reviews (company_id, run_id, reason, created_at desc, id desc);
create index h2a_dry_reviews_last_rechecked_by_idx
  on public.h2a_dry_run_reviews (last_rechecked_by);
create unique index h2a_review_recheck_batches_one_active_idx
  on public.h2a_review_recheck_batches (company_id)
  where status in ('queued', 'running');
create index h2a_review_recheck_batches_latest_idx
  on public.h2a_review_recheck_batches (company_id, created_at desc, id desc);
create index h2a_review_recheck_batches_requested_by_idx
  on public.h2a_review_recheck_batches (requested_by);
create index h2a_dry_review_events_company_review_idx
  on public.h2a_dry_run_review_events (company_id, review_id, created_at, id);
create unique index h2a_dry_review_events_captured_once_idx
  on public.h2a_dry_run_review_events (company_id, review_id)
  where event_type = 'captured';

-- Additional FK indexes cover user references and composite run/delivery/conflict FKs.
create index h2a_credentials_updated_by_idx on private.h2a_credentials (updated_by);
create index h2a_config_confirmed_by_idx on public.h2a_company_config (options_confirmed_by);
create index h2a_options_confirmed_by_idx on public.h2a_option_mappings (confirmed_by);
create index h2a_runs_requested_by_idx on public.h2a_sync_runs (requested_by);
create index h2a_runs_cancel_requested_by_idx on public.h2a_sync_runs (cancel_requested_by);
create index h2a_runs_company_started_idx on public.h2a_sync_runs (company_id, started_at desc);
create unique index h2a_runs_company_scheduler_claim_uidx on public.h2a_sync_runs (company_id, scheduler_claim_id) where scheduler_claim_id is not null;
create unique index h2a_runs_company_resume_uidx on public.h2a_sync_runs (company_id, resume_id) where resume_id is not null;
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
create index h2a_conflict_resumes_pending_idx on public.h2a_conflict_resumes (company_id, status, created_at, id);
create index h2a_conflict_resumes_company_run_idx on public.h2a_conflict_resumes (company_id, originating_run_id);
create index h2a_conflict_resumes_company_delivery_idx on public.h2a_conflict_resumes (company_id, activity_delivery_id);

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

alter table public.h2a_run_checkpoints enable row level security;
revoke all on table public.h2a_run_checkpoints from public, anon, authenticated;
revoke all on table public.h2a_run_checkpoints from service_role;
grant select, insert, update on table public.h2a_run_checkpoints to service_role;

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
revoke insert, update, delete on table public.h2a_contact_mappings from service_role;
grant select on table public.h2a_contact_mappings to authenticated, service_role;
create policy h2a_contact_mappings_select on public.h2a_contact_mappings
  for select to authenticated using (
    exists (select 1 from public.company_members m where m.user_id = (select auth.uid()) and m.company_id = h2a_contact_mappings.company_id)
    or exists (select 1 from public.super_admins s where s.user_id = (select auth.uid()))
  );

alter table public.h2a_organization_mappings enable row level security;
revoke all on table public.h2a_organization_mappings from public, anon, authenticated;
revoke insert, update, delete on table public.h2a_organization_mappings from service_role;
grant select on table public.h2a_organization_mappings to authenticated, service_role;
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

alter table public.h2a_conflict_resumes enable row level security;
revoke all on table public.h2a_conflict_resumes from public, anon, authenticated;
grant select on table public.h2a_conflict_resumes to service_role;

alter table public.h2a_execution_leases enable row level security;
revoke all on table public.h2a_execution_leases from public, anon, authenticated;
revoke all on table public.h2a_execution_leases from service_role;
grant select on table public.h2a_execution_leases to service_role;

alter table public.h2a_daily_claims enable row level security;
revoke all on table public.h2a_daily_claims from public, anon, authenticated;
revoke all on table public.h2a_daily_claims from service_role;
grant select on table public.h2a_daily_claims to service_role;

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

-- Sample reviews are available only through authorized server endpoints.
alter table public.h2a_dry_run_reviews enable row level security;
revoke all on table public.h2a_dry_run_reviews from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.h2a_dry_run_reviews to service_role;

-- Append-only for service callers; parent cleanup can still cascade events.
alter table public.h2a_dry_run_review_events enable row level security;
revoke all on table public.h2a_dry_run_review_events from public, anon, authenticated, service_role;
grant select, insert on table public.h2a_dry_run_review_events to service_role;

-- Recheck-all batch progress is available only through authorized server endpoints.
alter table public.h2a_review_recheck_batches enable row level security;
revoke all on table public.h2a_review_recheck_batches from public, anon, authenticated, service_role;
grant select, insert, update on table public.h2a_review_recheck_batches to service_role;

create function public.h2a_apply_dry_run_recheck(
  p_company_id uuid,
  p_review_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid,
  p_status text,
  p_recheck_outcome text,
  p_reason text,
  p_conflict_type text,
  p_source_snapshot jsonb,
  p_candidate_snapshots jsonb,
  p_match_evidence jsonb,
  p_proposed_changes jsonb,
  p_event_type text,
  p_event_details jsonb,
  p_now timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_review public.h2a_dry_run_reviews%rowtype;
  v_current_run_id uuid;
  v_current_review_version smallint;
begin
  -- Fail closed before locks or mutations, including NULL CAS timestamps.
  if p_company_id is null or p_review_id is null
    or p_expected_updated_at is null or p_actor_id is null or p_now is null
    or p_status is null or p_status not in ('needs_review', 'cleared', 'no_longer_in_scope')
    or p_recheck_outcome is null or p_recheck_outcome not in ('still_needs_review', 'safe_to_link', 'safe_to_create', 'source_missing')
    or p_event_type is null or p_event_type not in ('still_needs_review', 'cleared', 'no_longer_in_scope')
    or p_reason is null or length(pg_catalog.btrim(p_reason)) = 0
    or p_conflict_type is null or length(pg_catalog.btrim(p_conflict_type)) = 0
    or p_source_snapshot is null or pg_catalog.jsonb_typeof(p_source_snapshot) <> 'object'
    or p_candidate_snapshots is null or pg_catalog.jsonb_typeof(p_candidate_snapshots) <> 'array'
    or p_match_evidence is null or pg_catalog.jsonb_typeof(p_match_evidence) <> 'object'
    or p_proposed_changes is null or pg_catalog.jsonb_typeof(p_proposed_changes) <> 'object'
    or p_event_details is null or pg_catalog.jsonb_typeof(p_event_details) <> 'object' then
    return pg_catalog.jsonb_build_object('error', 'invalid_recheck');
  end if;
  -- Only inspect array length after its type has been validated.
  if pg_catalog.jsonb_array_length(p_candidate_snapshots) > 10 then
    return pg_catalog.jsonb_build_object('error', 'invalid_recheck');
  end if;

  select * into v_review
    from public.h2a_dry_run_reviews r
    where r.company_id = p_company_id and r.id = p_review_id
    for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  select r.id, r.review_capture_version into v_current_run_id, v_current_review_version
    from public.h2a_sync_runs r
    where r.company_id = p_company_id
      and r.mode = 'dry_run'
      and r.status = 'completed'
      and r.sample_limit_per_type = 10
    order by r.created_at desc, r.id desc
    limit 1;
  if v_current_run_id is distinct from v_review.run_id
    or v_current_review_version is distinct from 1 then
    return pg_catalog.jsonb_build_object('error', 'superseded');
  end if;
  if v_review.updated_at is distinct from p_expected_updated_at then
    return pg_catalog.jsonb_build_object('error', 'stale');
  end if;

  update public.h2a_dry_run_reviews set
    status = p_status,
    recheck_outcome = p_recheck_outcome,
    reason = p_reason,
    conflict_type = p_conflict_type,
    source_snapshot = p_source_snapshot,
    candidate_snapshots = p_candidate_snapshots,
    match_evidence = p_match_evidence,
    proposed_changes = p_proposed_changes,
    last_rechecked_at = p_now,
    last_rechecked_by = p_actor_id,
    updated_at = p_now
  where company_id = p_company_id and id = p_review_id
  returning * into v_review;

  insert into public.h2a_dry_run_review_events (
    company_id, review_id, actor_id, event_type, reason, sanitized_details, created_at
  ) values (
    p_company_id, p_review_id, p_actor_id, p_event_type, p_reason, p_event_details, p_now
  );
  return pg_catalog.jsonb_build_object('review', pg_catalog.to_jsonb(v_review));
end;
$$;
revoke execute on function public.h2a_apply_dry_run_recheck(uuid, uuid, timestamptz, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.h2a_apply_dry_run_recheck(uuid, uuid, timestamptz, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, jsonb, timestamptz) to service_role;

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

-- Delivery reservation is one transaction: new identity insert or row-locked stale/due
-- reclaim. The returned attempt_count is the durable fencing generation.
create function public.h2a_reserve_delivery(
  p_company_id uuid, p_portal_id text, p_object_type text, p_activity_id text,
  p_albi_target_type text, p_albi_target_id text, p_source_marker text,
  p_now timestamptz, p_stale_before timestamptz, p_retry_eligible_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.h2a_activity_deliveries%rowtype;
  v_previous jsonb;
begin
  if p_company_id is null or nullif(pg_catalog.btrim(p_portal_id), '') is null
    or coalesce(p_object_type, '') not in ('meetings', 'calls', 'emails', 'communications', 'notes')
    or nullif(pg_catalog.btrim(p_activity_id), '') is null
    or coalesce(p_albi_target_type, '') not in ('contact', 'organization')
    or nullif(pg_catalog.btrim(p_albi_target_id), '') is null
    or nullif(pg_catalog.btrim(p_source_marker), '') is null
    or p_now is null or p_stale_before is null or p_retry_eligible_at is null
    or p_stale_before > p_now or p_retry_eligible_at > p_now then
    raise exception 'Invalid delivery reservation' using errcode = '22023';
  end if;
  insert into public.h2a_activity_deliveries (
    company_id, portal_id, object_type, activity_id, albi_target_type,
    albi_target_id, source_marker, state, attempt_count, last_attempt_at
  ) values (
    p_company_id, p_portal_id, p_object_type, p_activity_id, p_albi_target_type,
    p_albi_target_id, p_source_marker, 'reserved', 1, p_now
  ) on conflict (company_id, portal_id, object_type, activity_id, albi_target_type, albi_target_id)
    do nothing returning * into v_row;
  if found then
    return pg_catalog.jsonb_build_object('acquired', true, 'is_new', true, 'delivery', pg_catalog.to_jsonb(v_row));
  end if;
  select * into v_row from public.h2a_activity_deliveries
    where company_id = p_company_id and portal_id = p_portal_id and object_type = p_object_type
      and activity_id = p_activity_id and albi_target_type = p_albi_target_type
      and albi_target_id = p_albi_target_id for update;
  if not found then raise exception 'Delivery reservation disappeared' using errcode = '40001'; end if;
  if v_row.source_marker <> p_source_marker then raise exception 'Delivery marker mismatch' using errcode = '22023'; end if;
  if not ((v_row.state = 'reserved' and (v_row.last_attempt_at is null or v_row.last_attempt_at <= p_stale_before))
    or (v_row.state = 'failed' and v_row.next_attempt_at is not null and v_row.next_attempt_at <= p_retry_eligible_at)) then
    return pg_catalog.jsonb_build_object('acquired', false, 'is_new', false, 'delivery', pg_catalog.to_jsonb(v_row));
  end if;
  v_previous := pg_catalog.jsonb_build_object('state', v_row.state, 'last_attempt_at', v_row.last_attempt_at,
    'next_attempt_at', v_row.next_attempt_at);
  update public.h2a_activity_deliveries set state = 'reserved', attempt_count = attempt_count + 1,
    last_attempt_at = p_now, next_attempt_at = null, last_error_summary = null,
    updated_at = pg_catalog.clock_timestamp()
    where company_id = p_company_id and id = v_row.id returning * into v_row;
  return pg_catalog.jsonb_build_object('acquired', true, 'is_new', false,
    'previous', v_previous, 'delivery', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke execute on function public.h2a_reserve_delivery(uuid, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.h2a_reserve_delivery(uuid, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) to service_role;

create function public.h2a_transition_delivery(
  p_company_id uuid, p_delivery_id uuid, p_expected_attempt_count integer, p_patch jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.h2a_activity_deliveries%rowtype;
begin
  if p_company_id is null or p_delivery_id is null or p_expected_attempt_count is null or p_expected_attempt_count < 1
    or coalesce(pg_catalog.jsonb_typeof(p_patch), '') <> 'object'
    or coalesce(p_patch->>'state', '') not in ('delivered', 'reconciled', 'failed')
    or exists (select 1 from pg_catalog.jsonb_object_keys(p_patch) as patch_key(value)
      where patch_key.value not in ('state', 'albi_activity_id', 'delivered_at', 'next_attempt_at', 'last_error_summary')) then
    raise exception 'Invalid delivery transition' using errcode = '22023';
  end if;
  update public.h2a_activity_deliveries set state = p_patch->>'state',
    albi_activity_id = coalesce(p_patch->>'albi_activity_id', albi_activity_id),
    delivered_at = (p_patch->>'delivered_at')::timestamptz,
    next_attempt_at = (p_patch->>'next_attempt_at')::timestamptz,
    last_error_summary = p_patch->>'last_error_summary',
    updated_at = pg_catalog.clock_timestamp()
    where company_id = p_company_id and id = p_delivery_id and state = 'reserved'
      and attempt_count = p_expected_attempt_count returning * into v_row;
  if not found then return pg_catalog.jsonb_build_object('updated', false); end if;
  return pg_catalog.jsonb_build_object('updated', true, 'delivery', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke execute on function public.h2a_transition_delivery(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.h2a_transition_delivery(uuid, uuid, integer, jsonb) to service_role;

-- Caller supplies its America/Los_Angeles business date, never a UTC date.
-- Claims persist across dates so delayed duplicate scheduler calls remain no-ops.
create function public.h2a_claim_daily_run(p_company_id uuid, p_business_date date, p_owner_token uuid, p_ttl_seconds integer default 180)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_row public.h2a_daily_claims%rowtype;
begin
  if p_company_id is null or p_business_date is null or p_owner_token is null
    or p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    raise exception 'Company and Pacific business date are required' using errcode = '22023';
  end if;
  insert into public.h2a_daily_claims (company_id, business_date, owner_token, lease_expires_at, attempt_count)
  values (p_company_id, p_business_date, p_owner_token, v_now + pg_catalog.make_interval(secs => p_ttl_seconds), 1)
  on conflict (company_id, business_date) do nothing returning * into v_row;
  if found then return pg_catalog.jsonb_build_object('acquired', true, 'claim', pg_catalog.to_jsonb(v_row)); end if;
  select * into v_row from public.h2a_daily_claims c where c.company_id = p_company_id and c.business_date = p_business_date for update;
  if v_row.status = 'dispatched' or v_row.owner_token is not null and v_row.lease_expires_at > v_now then
    return pg_catalog.jsonb_build_object('acquired', false, 'claim', pg_catalog.to_jsonb(v_row));
  end if;
  update public.h2a_daily_claims set owner_token = p_owner_token,
    lease_expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds),
    attempt_count = attempt_count + 1, last_dispatch_error_code = null
    where id = v_row.id returning * into v_row;
  return pg_catalog.jsonb_build_object('acquired', true, 'claim', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke execute on function public.h2a_claim_daily_run(uuid, date, uuid, integer) from public, anon, authenticated;
grant execute on function public.h2a_claim_daily_run(uuid, date, uuid, integer) to service_role;

create function public.h2a_finish_daily_run(p_company_id uuid, p_claim_id uuid, p_owner_token uuid, p_accepted boolean, p_error_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_company_id is null or p_claim_id is null or p_owner_token is null or p_accepted is null
    or (p_accepted and p_error_code is not null)
    or (not p_accepted and coalesce(p_error_code, '') not in ('dispatch_failed', 'dispatch_not_accepted')) then
    raise exception 'Invalid daily run result' using errcode = '22023';
  end if;
  update public.h2a_daily_claims set status = case when p_accepted then 'dispatched' else 'pending' end,
    dispatched_at = case when p_accepted then pg_catalog.clock_timestamp() else null end,
    owner_token = null, lease_expires_at = null,
    last_dispatch_error_code = case when p_accepted then null else p_error_code end
    where company_id = p_company_id and id = p_claim_id and status = 'pending' and owner_token = p_owner_token;
  return found;
end;
$$;
revoke execute on function public.h2a_finish_daily_run(uuid, uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.h2a_finish_daily_run(uuid, uuid, uuid, boolean, text) to service_role;

-- All contact/organization mapping writes lock source, then tenant-wide target.
-- Service-role table grants are read-only so callers cannot bypass it.
drop function if exists public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz);
drop function if exists public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz, boolean);
drop function if exists public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz, boolean, uuid);
drop function if exists public.h2a_save_mapping_unfenced(uuid, text, text, text, text, text, uuid, timestamptz, boolean);
create or replace function public.h2a_save_mapping(
  p_company_id uuid, p_portal_id text, p_object_type text, p_source_id text,
  p_target_id text, p_match_method text, p_reviewed_by uuid, p_now timestamptz,
  p_approve_many_to_one boolean default false, p_force_resolution_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_contact public.h2a_contact_mappings%rowtype;
  v_organization public.h2a_organization_mappings%rowtype;
  v_peer_count bigint;
  v_unapproved_count bigint;
  v_force_reservation uuid;
begin
  if p_company_id is null or nullif(pg_catalog.btrim(p_portal_id), '') is null
    or p_object_type is null or p_object_type not in ('contacts', 'companies')
    or nullif(pg_catalog.btrim(p_source_id), '') is null
    or nullif(pg_catalog.btrim(p_target_id), '') is null
    or p_match_method is null or p_match_method not in ('automatic', 'created', 'reviewed') or p_now is null
    or p_approve_many_to_one is null or (p_approve_many_to_one and p_match_method <> 'reviewed')
    or (p_match_method = 'reviewed' and p_reviewed_by is null)
    or (p_match_method <> 'reviewed' and p_reviewed_by is not null) then
    return pg_catalog.jsonb_build_object('error', 'invalid_mapping');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(p_company_id::text, p_portal_id, 'source', p_object_type, p_source_id)::text, 0));
  if pg_catalog.to_regclass('public.h2a_dry_run_review_resolutions') is not null then
    execute 'select r.id from public.h2a_dry_run_review_resolutions r
      where r.company_id = $1 and r.portal_id = $2 and r.object_type = $3 and r.source_id = $4
        and r.action = ''force_create_albi'' and r.status in (''pending'', ''applying'')
      order by r.created_at desc, r.id desc limit 1'
      into v_force_reservation using p_company_id, p_portal_id, p_object_type, p_source_id;
    if v_force_reservation is not null and p_force_resolution_id is distinct from v_force_reservation then
      return pg_catalog.jsonb_build_object('error', 'mapping_reserved');
    end if;
    if p_force_resolution_id is not null and
      (v_force_reservation is null or v_force_reservation <> p_force_resolution_id) then
      return pg_catalog.jsonb_build_object('error', 'invalid_mapping');
    end if;
  elsif p_force_resolution_id is not null then
    return pg_catalog.jsonb_build_object('error', 'invalid_mapping');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(p_company_id::text, 'target', p_object_type, p_target_id)::text, 0));

  if p_object_type = 'contacts' then
    select * into v_contact from public.h2a_contact_mappings m
      where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id;
    if found then
      if v_contact.albi_contact_id <> p_target_id then
        return pg_catalog.jsonb_build_object('error', 'mapping_conflict');
      end if;
      -- Only a new explicit reviewed approval upgrades a same-target row.
      if p_approve_many_to_one and not v_contact.approved_many_to_one then
        update public.h2a_contact_mappings set match_method = 'reviewed', approved_many_to_one = true,
          reviewed_by = p_reviewed_by, reviewed_at = p_now, updated_at = p_now
          where company_id = p_company_id and portal_id = p_portal_id and hubspot_id = p_source_id
            and albi_contact_id = p_target_id returning * into v_contact;
      end if;
      return pg_catalog.to_jsonb(v_contact);
    end if;
    select count(*), count(*) filter (where not m.approved_many_to_one)
      into v_peer_count, v_unapproved_count from public.h2a_contact_mappings m where m.company_id = p_company_id
      and m.albi_contact_id = p_target_id
      and (m.portal_id <> p_portal_id or m.hubspot_id <> p_source_id);
    if v_peer_count > 0 and not p_approve_many_to_one then
      return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
    end if;
    -- A reviewed share includes its sole original owner. Never silently approve
    -- an already-ambiguous group with multiple unreviewed source identities.
    if v_unapproved_count > 0 and v_peer_count <> 1 then
      return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
    end if;
    if v_peer_count = 1 and v_unapproved_count = 1 then
      update public.h2a_contact_mappings set match_method = 'reviewed', approved_many_to_one = true,
        reviewed_by = p_reviewed_by, reviewed_at = p_now, updated_at = p_now
        where company_id = p_company_id and albi_contact_id = p_target_id
          and (portal_id <> p_portal_id or hubspot_id <> p_source_id) and not approved_many_to_one;
    end if;
    insert into public.h2a_contact_mappings (company_id, portal_id, hubspot_id, albi_contact_id,
      match_method, approved_many_to_one, reviewed_by, reviewed_at, updated_at)
    values (p_company_id, p_portal_id, p_source_id, p_target_id, p_match_method, p_approve_many_to_one, p_reviewed_by,
      case when p_match_method = 'reviewed' then p_now else null end, p_now)
    on conflict (company_id, portal_id, hubspot_id) do nothing returning * into v_contact;
    if not found then
      select * into v_contact from public.h2a_contact_mappings m
        where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id;
      if not found or v_contact.albi_contact_id <> p_target_id then
        return pg_catalog.jsonb_build_object('error', 'mapping_conflict');
      end if;
    end if;
    return pg_catalog.to_jsonb(v_contact);
  end if;

  select * into v_organization from public.h2a_organization_mappings m
    where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id;
  if found then
    if v_organization.albi_organization_id <> p_target_id then
      return pg_catalog.jsonb_build_object('error', 'mapping_conflict');
    end if;
    if p_approve_many_to_one and not v_organization.approved_many_to_one then
      update public.h2a_organization_mappings set match_method = 'reviewed', approved_many_to_one = true,
        reviewed_by = p_reviewed_by, reviewed_at = p_now, updated_at = p_now
        where company_id = p_company_id and portal_id = p_portal_id and hubspot_id = p_source_id
          and albi_organization_id = p_target_id returning * into v_organization;
    end if;
    return pg_catalog.to_jsonb(v_organization);
  end if;
  select count(*), count(*) filter (where not m.approved_many_to_one)
    into v_peer_count, v_unapproved_count from public.h2a_organization_mappings m where m.company_id = p_company_id
    and m.albi_organization_id = p_target_id
    and (m.portal_id <> p_portal_id or m.hubspot_id <> p_source_id);
  if v_peer_count > 0 and not p_approve_many_to_one then
    return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
  end if;
  if v_unapproved_count > 0 and v_peer_count <> 1 then
    return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
  end if;
  if v_peer_count = 1 and v_unapproved_count = 1 then
    update public.h2a_organization_mappings set match_method = 'reviewed', approved_many_to_one = true,
      reviewed_by = p_reviewed_by, reviewed_at = p_now, updated_at = p_now
      where company_id = p_company_id and albi_organization_id = p_target_id
        and (portal_id <> p_portal_id or hubspot_id <> p_source_id) and not approved_many_to_one;
  end if;
  insert into public.h2a_organization_mappings (company_id, portal_id, hubspot_id, albi_organization_id,
    match_method, approved_many_to_one, reviewed_by, reviewed_at, updated_at)
  values (p_company_id, p_portal_id, p_source_id, p_target_id, p_match_method, p_approve_many_to_one, p_reviewed_by,
    case when p_match_method = 'reviewed' then p_now else null end, p_now)
  on conflict (company_id, portal_id, hubspot_id) do nothing returning * into v_organization;
  if not found then
    select * into v_organization from public.h2a_organization_mappings m
      where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id;
    if not found or v_organization.albi_organization_id <> p_target_id then
      return pg_catalog.jsonb_build_object('error', 'mapping_conflict');
    end if;
  end if;
  return pg_catalog.to_jsonb(v_organization);
end;
$$;
revoke execute on function public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz, boolean, uuid) from public, anon, authenticated;
grant execute on function public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz, boolean, uuid) to service_role;

-- Resolution, optional identity mapping, audit, and targeted work intent commit
-- together. No provider request is made from this transaction or endpoint.
create function public.h2a_resolve_conflict(
  p_company_id uuid, p_conflict_id uuid, p_expected_updated_at timestamptz, p_actor_id uuid,
  p_api_action text, p_db_action text, p_request jsonb, p_now timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_conflict public.h2a_conflicts%rowtype;
  v_before jsonb;
  v_source_snapshot jsonb;
  v_candidate_snapshots jsonb;
  v_proposed_fields jsonb;
  v_event public.h2a_conflict_events%rowtype;
  v_resume public.h2a_conflict_resumes%rowtype;
  v_expected_db_action text;
  v_target_id text;
  v_many_to_one boolean;
  v_peer_count bigint;
  v_unapproved_count bigint;
  v_force_reserved boolean := false;
  v_field text;
begin
  v_expected_db_action := case p_api_action
    when 'link_existing' then 'link_existing'
    when 'create_new' then 'create_new'
    when 'approve_fields' then 'approve_hubspot'
    when 'retain_albi' then 'retain_albi'
    when 'skip_item' then 'skip'
    else null end;
  if p_company_id is null or p_conflict_id is null or p_expected_updated_at is null or p_actor_id is null
    or p_now is null or v_expected_db_action is null or p_db_action is distinct from v_expected_db_action
    or coalesce(pg_catalog.jsonb_typeof(p_request), '') <> 'object'
    or exists (select 1 from pg_catalog.jsonb_object_keys(p_request) as request_key(value)
      where request_key.value not in ('targetId', 'selectedFields', 'approveManyToOne'))
    or coalesce(pg_catalog.jsonb_typeof(p_request->'selectedFields'), '') <> 'array'
    or coalesce(pg_catalog.jsonb_typeof(p_request->'approveManyToOne'), '') <> 'boolean' then
    return pg_catalog.jsonb_build_object('error', 'invalid_action');
  end if;
  v_target_id := nullif(pg_catalog.btrim(p_request->>'targetId'), '');
  v_many_to_one := (p_request->>'approveManyToOne')::boolean;
  if (p_api_action = 'link_existing' and (v_target_id is null or pg_catalog.jsonb_array_length(p_request->'selectedFields') <> 0))
    or (p_api_action <> 'link_existing' and (v_target_id is not null or v_many_to_one))
    or (p_api_action not in ('approve_fields', 'retain_albi') and pg_catalog.jsonb_array_length(p_request->'selectedFields') <> 0)
    or (p_api_action in ('approve_fields', 'retain_albi') and pg_catalog.jsonb_array_length(p_request->'selectedFields') = 0) then
    return pg_catalog.jsonb_build_object('error', 'invalid_action');
  end if;

  select * into v_conflict from public.h2a_conflicts
    where company_id = p_company_id and id = p_conflict_id for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;

  if v_conflict.status <> 'open' then
    select * into v_event from public.h2a_conflict_events e
      where e.company_id = p_company_id and e.conflict_id = p_conflict_id
        and e.actor_id = p_actor_id and e.resolution_action = p_db_action
        and e.sanitized_details->>'apiAction' = p_api_action
        and e.sanitized_details->'resolutionRequest' = p_request
      order by e.created_at desc, e.id desc limit 1;
    if found then
      select * into v_resume from public.h2a_conflict_resumes r
        where r.company_id = p_company_id and r.conflict_id = p_conflict_id;
      return pg_catalog.jsonb_build_object('conflict', pg_catalog.to_jsonb(v_conflict),
        'event', pg_catalog.to_jsonb(v_event), 'resume', case when v_resume.id is null then null else pg_catalog.to_jsonb(v_resume) end,
        'replayed', true);
    end if;
    return pg_catalog.jsonb_build_object('error', 'not_open');
  end if;
  if v_conflict.updated_at <> p_expected_updated_at then return pg_catalog.jsonb_build_object('error', 'stale'); end if;

  if p_api_action in ('link_existing', 'create_new') and v_conflict.object_type not in ('contacts', 'companies') then
    return pg_catalog.jsonb_build_object('error', 'invalid_conflict_type');
  end if;
  if p_api_action in ('approve_fields', 'retain_albi') then
    if v_conflict.object_type not in ('contacts', 'companies') then
      return pg_catalog.jsonb_build_object('error', 'invalid_conflict_type');
    end if;
    for v_field in select pg_catalog.jsonb_array_elements_text(p_request->'selectedFields') loop
      if v_field not in ('firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
        'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country')
        or not (coalesce(v_conflict.proposed_changes->'updates', '{}'::jsonb) ? v_field
          or coalesce(v_conflict.proposed_changes->'conflicts', '{}'::jsonb) ? v_field) then
        return pg_catalog.jsonb_build_object('error', 'invalid_action');
      end if;
    end loop;
  end if;

  if p_api_action = 'link_existing' then
    -- Serialize resolutions for this tenant-scoped source identity before taking
    -- any target lock. Every link_existing path uses source-then-target ordering.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_company_id::text, v_conflict.portal_id, 'source',
        v_conflict.object_type, v_conflict.source_id)::text, 0));
    if pg_catalog.to_regclass('public.h2a_dry_run_review_resolutions') is not null then
      execute 'select exists (select 1 from public.h2a_dry_run_review_resolutions r
        where r.company_id = $1 and r.portal_id = $2 and r.object_type = $3 and r.source_id = $4
          and r.action = ''force_create_albi'' and r.status in (''pending'', ''applying''))'
        into v_force_reserved using p_company_id, v_conflict.portal_id, v_conflict.object_type, v_conflict.source_id;
      if v_force_reserved then return pg_catalog.jsonb_build_object('error', 'mapping_conflict'); end if;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_company_id::text, 'target', v_conflict.object_type, v_target_id)::text, 0));
    if v_conflict.object_type = 'contacts' then
      if exists (select 1 from public.h2a_contact_mappings m where m.company_id = p_company_id
        and m.portal_id = v_conflict.portal_id and m.hubspot_id = v_conflict.source_id and m.albi_contact_id <> v_target_id)
        then return pg_catalog.jsonb_build_object('error', 'mapping_conflict'); end if;
      select count(*), count(*) filter (where not m.approved_many_to_one)
        into v_peer_count, v_unapproved_count from public.h2a_contact_mappings m where m.company_id = p_company_id
          and m.albi_contact_id = v_target_id and (m.portal_id <> v_conflict.portal_id or m.hubspot_id <> v_conflict.source_id);
      if v_peer_count > 0 and not v_many_to_one then
        return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
      end if;
      if v_unapproved_count > 0 and v_peer_count <> 1 then
        return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
      end if;
      if v_peer_count = 1 and v_unapproved_count = 1 then
        update public.h2a_contact_mappings set match_method = 'reviewed', approved_many_to_one = true,
          reviewed_by = p_actor_id, reviewed_at = p_now, updated_at = p_now
          where company_id = p_company_id and albi_contact_id = v_target_id
            and (portal_id <> v_conflict.portal_id or hubspot_id <> v_conflict.source_id) and not approved_many_to_one;
      end if;
      update public.h2a_contact_mappings set match_method = 'reviewed', approved_many_to_one = approved_many_to_one or v_many_to_one, reviewed_by = p_actor_id,
        reviewed_at = p_now, updated_at = p_now
        where company_id = p_company_id and portal_id = v_conflict.portal_id
          and hubspot_id = v_conflict.source_id and albi_contact_id = v_target_id;
      if not found then
        insert into public.h2a_contact_mappings (company_id, portal_id, hubspot_id, albi_contact_id,
          match_method, approved_many_to_one, reviewed_by, reviewed_at, updated_at)
        values (p_company_id, v_conflict.portal_id, v_conflict.source_id, v_target_id, 'reviewed', v_many_to_one, p_actor_id, p_now, p_now)
        on conflict (company_id, portal_id, hubspot_id) do nothing;
      end if;
    else
      if exists (select 1 from public.h2a_organization_mappings m where m.company_id = p_company_id
        and m.portal_id = v_conflict.portal_id and m.hubspot_id = v_conflict.source_id and m.albi_organization_id <> v_target_id)
        then return pg_catalog.jsonb_build_object('error', 'mapping_conflict'); end if;
      select count(*), count(*) filter (where not m.approved_many_to_one)
        into v_peer_count, v_unapproved_count from public.h2a_organization_mappings m where m.company_id = p_company_id
          and m.albi_organization_id = v_target_id and (m.portal_id <> v_conflict.portal_id or m.hubspot_id <> v_conflict.source_id);
      if v_peer_count > 0 and not v_many_to_one then
        return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
      end if;
      if v_unapproved_count > 0 and v_peer_count <> 1 then
        return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
      end if;
      if v_peer_count = 1 and v_unapproved_count = 1 then
        update public.h2a_organization_mappings set match_method = 'reviewed', approved_many_to_one = true,
          reviewed_by = p_actor_id, reviewed_at = p_now, updated_at = p_now
          where company_id = p_company_id and albi_organization_id = v_target_id
            and (portal_id <> v_conflict.portal_id or hubspot_id <> v_conflict.source_id) and not approved_many_to_one;
      end if;
      update public.h2a_organization_mappings set match_method = 'reviewed', approved_many_to_one = approved_many_to_one or v_many_to_one, reviewed_by = p_actor_id,
        reviewed_at = p_now, updated_at = p_now
        where company_id = p_company_id and portal_id = v_conflict.portal_id
          and hubspot_id = v_conflict.source_id and albi_organization_id = v_target_id;
      if not found then
        insert into public.h2a_organization_mappings (company_id, portal_id, hubspot_id, albi_organization_id,
          match_method, approved_many_to_one, reviewed_by, reviewed_at, updated_at)
        values (p_company_id, v_conflict.portal_id, v_conflict.source_id, v_target_id, 'reviewed', v_many_to_one, p_actor_id, p_now, p_now)
        on conflict (company_id, portal_id, hubspot_id) do nothing;
      end if;
    end if;
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(source_field.key, source_field.value), '{}'::jsonb)
    into v_source_snapshot
    from pg_catalog.jsonb_each(coalesce(v_conflict.source_snapshot, '{}'::jsonb)) as source_field(key, value)
    where source_field.key in ('id', 'firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
      'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country')
      and pg_catalog.jsonb_typeof(source_field.value) in ('string', 'number', 'boolean');
  select coalesce(pg_catalog.jsonb_agg(candidate.safe_snapshot), '[]'::jsonb)
    into v_candidate_snapshots
    from (
      select (select coalesce(pg_catalog.jsonb_object_agg(candidate_field.key, candidate_field.value), '{}'::jsonb)
        from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(candidate.value) = 'object'
          then candidate.value else '{}'::jsonb end) as candidate_field(key, value)
        where candidate_field.key in ('id', 'firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
          'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country')
          and pg_catalog.jsonb_typeof(candidate_field.value) in ('string', 'number', 'boolean')) as safe_snapshot
      from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(v_conflict.candidate_snapshots) = 'array'
        then v_conflict.candidate_snapshots else '[]'::jsonb end) as candidate(value)
      limit 10
    ) candidate;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(field_name) order by field_name), '[]'::jsonb)
    into v_proposed_fields from (
      select key as field_name from pg_catalog.jsonb_object_keys(coalesce(v_conflict.proposed_changes->'updates', '{}'::jsonb)) as update_field(key)
      union
      select key as field_name from pg_catalog.jsonb_object_keys(coalesce(v_conflict.proposed_changes->'conflicts', '{}'::jsonb)) as conflict_field(key)
    ) proposed where field_name in ('firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
      'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country');
  v_before := pg_catalog.jsonb_build_object('status', v_conflict.status, 'updatedAt', v_conflict.updated_at,
    'sourceSnapshot', v_source_snapshot, 'candidateSnapshots', v_candidate_snapshots, 'proposedFieldNames', v_proposed_fields);
  update public.h2a_conflicts set status = case when p_api_action = 'skip_item' then 'skipped' else 'resolved' end,
    resolved_by = p_actor_id, resolution_action = p_db_action, resolved_at = p_now, updated_at = p_now
    where company_id = p_company_id and id = p_conflict_id and status = 'open'
      and updated_at = p_expected_updated_at returning * into v_conflict;
  if not found then return pg_catalog.jsonb_build_object('error', 'stale'); end if;

  insert into public.h2a_conflict_events (company_id, conflict_id, event_type, actor_id, resolution_action, sanitized_details, created_at)
  values (p_company_id, p_conflict_id, case when p_api_action = 'skip_item' then 'skipped' else 'resolved' end,
    p_actor_id, p_db_action, pg_catalog.jsonb_build_object('apiAction', p_api_action, 'dbAction', p_db_action,
      'resolutionRequest', p_request, 'selectedFields', p_request->'selectedFields',
      'approveManyToOne', v_many_to_one, 'before', v_before,
      'after', pg_catalog.jsonb_build_object('status', v_conflict.status, 'updatedAt', v_conflict.updated_at,
        'resolvedBy', p_actor_id, 'resolutionAction', p_db_action,
        'targetId', v_target_id, 'selectedFields', p_request->'selectedFields')), p_now)
  returning * into v_event;

  if p_api_action in ('link_existing', 'create_new') then
    insert into public.h2a_conflict_resumes (company_id, conflict_id, resolution_action, source_object_type, source_id,
      activity_object_type, activity_id, originating_run_id, activity_delivery_id, created_at, updated_at)
    values (p_company_id, p_conflict_id, p_api_action, v_conflict.object_type, v_conflict.source_id,
      v_conflict.activity_object_type, v_conflict.activity_id, v_conflict.run_id, v_conflict.activity_delivery_id, p_now, p_now)
    on conflict (company_id, conflict_id) do nothing;
    select * into v_resume from public.h2a_conflict_resumes r
      where r.company_id = p_company_id and r.conflict_id = p_conflict_id;
  end if;

  return pg_catalog.jsonb_build_object('conflict', pg_catalog.to_jsonb(v_conflict), 'event', pg_catalog.to_jsonb(v_event),
    'resume', case when v_resume.id is null then null else pg_catalog.to_jsonb(v_resume) end, 'replayed', false);
end;
$$;
revoke execute on function public.h2a_resolve_conflict(uuid, uuid, timestamptz, uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.h2a_resolve_conflict(uuid, uuid, timestamptz, uuid, text, text, jsonb, timestamptz) to service_role;

create function public.h2a_claim_conflict_resume(p_company_id uuid, p_resume_id uuid, p_owner_token uuid, p_ttl_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_row public.h2a_conflict_resumes%rowtype;
begin
  if p_company_id is null or p_resume_id is null or p_owner_token is null
    or p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    raise exception 'Invalid conflict resume claim' using errcode = '22023';
  end if;
  select * into v_row from public.h2a_conflict_resumes r
    where r.company_id = p_company_id and r.id = p_resume_id and r.status = 'pending'
      and (r.dispatch_owner_token is null or r.dispatch_lease_expires_at <= v_now) for update;
  if not found then return null; end if;
  update public.h2a_conflict_resumes set dispatch_owner_token = p_owner_token,
    dispatch_lease_expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds),
    dispatch_attempt_count = dispatch_attempt_count + 1, last_dispatch_error_code = null, worker_failed = false, updated_at = v_now
    where company_id = p_company_id and id = p_resume_id returning * into v_row;
  return pg_catalog.to_jsonb(v_row);
end;
$$;
revoke execute on function public.h2a_claim_conflict_resume(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.h2a_claim_conflict_resume(uuid, uuid, uuid, integer) to service_role;

create function public.h2a_finish_conflict_resume(
  p_company_id uuid, p_resume_id uuid, p_owner_token uuid, p_accepted boolean, p_error_code text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_company_id is null or p_resume_id is null or p_owner_token is null or p_accepted is null
    or (p_accepted and p_error_code is not null)
    or (not p_accepted and coalesce(p_error_code, '') not in ('dispatch_failed', 'dispatch_not_accepted')) then
    raise exception 'Invalid conflict resume result' using errcode = '22023';
  end if;
  update public.h2a_conflict_resumes set status = case when p_accepted and not worker_failed then 'dispatched' else 'pending' end,
    dispatched_at = case when p_accepted and not worker_failed then pg_catalog.clock_timestamp() else null end,
    dispatch_owner_token = null, dispatch_lease_expires_at = null,
    last_dispatch_error_code = case when p_accepted then null else p_error_code end,
    updated_at = pg_catalog.clock_timestamp()
    where company_id = p_company_id and id = p_resume_id and status = 'pending'
      and dispatch_owner_token = p_owner_token;
  return found;
end;
$$;
revoke execute on function public.h2a_finish_conflict_resume(uuid, uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.h2a_finish_conflict_resume(uuid, uuid, uuid, boolean, text) to service_role;

create function public.h2a_requeue_conflict_resume(p_company_id uuid, p_resume_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_company_id is null or p_resume_id is null then
    raise exception 'Invalid conflict resume retry' using errcode = '22023';
  end if;
  update public.h2a_conflict_resumes set worker_failed = true,
    status = case when status = 'dispatched' then 'pending' else status end,
    dispatched_at = null, updated_at = pg_catalog.clock_timestamp()
    where company_id = p_company_id and id = p_resume_id and status in ('pending', 'dispatched');
  return found;
end;
$$;
revoke execute on function public.h2a_requeue_conflict_resume(uuid, uuid) from public, anon, authenticated;
grant execute on function public.h2a_requeue_conflict_resume(uuid, uuid) to service_role;

-- Durable service-owned review resolution storage.


-- Live review workspace: live HubSpot->Albi conflicts share the sample review row table.
alter table public.h2a_dry_run_reviews
  add column if not exists review_kind text not null default 'sample' check (review_kind in ('sample', 'live')),
  add column if not exists triage_bucket text not null default 'decision'
    check (triage_bucket in ('quick', 'todo', 'decision', 'blocked', 'done')),
  add column if not exists triage_details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(triage_details) = 'object');

-- One open live review per HubSpot source, so concurrent runs share a single row.
create unique index h2a_live_review_open_source_idx
  on public.h2a_dry_run_reviews (company_id, portal_id, object_type, source_id)
  where review_kind = 'live' and status = 'needs_review';
create index h2a_dry_reviews_company_kind_bucket_idx
  on public.h2a_dry_run_reviews (company_id, review_kind, status, triage_bucket, created_at desc, id desc);

create table public.h2a_live_review_conflicts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  review_id uuid not null,
  conflict_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (company_id, review_id) references public.h2a_dry_run_reviews (company_id, id) on delete cascade,
  foreign key (company_id, conflict_id) references public.h2a_conflicts (company_id, id),
  unique (company_id, conflict_id)
);
create index h2a_live_review_conflicts_review_idx
  on public.h2a_live_review_conflicts (company_id, review_id);

alter table public.h2a_live_review_conflicts enable row level security;
revoke all on table public.h2a_live_review_conflicts from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.h2a_live_review_conflicts to service_role;

-- Sample rows keep cascading with their run; a run with open live rows cannot be deleted.
create or replace function public.h2a_block_run_delete_with_open_live_reviews()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.h2a_dry_run_reviews r
    where r.company_id = old.company_id and r.run_id = old.id
      and r.review_kind = 'live' and r.status = 'needs_review') then
    raise exception 'run has open live reviews' using errcode = '23503';
  end if;
  return old;
end;
$$;
drop trigger if exists h2a_block_run_delete_with_open_live_reviews on public.h2a_sync_runs;
create trigger h2a_block_run_delete_with_open_live_reviews
  before delete on public.h2a_sync_runs
  for each row execute function public.h2a_block_run_delete_with_open_live_reviews();

-- Recheck batches may cover live reviews, which have no single sample run.
alter table public.h2a_review_recheck_batches
  add column if not exists review_kind text not null default 'sample' check (review_kind in ('sample', 'live')),
  add column if not exists review_ids uuid[];
alter table public.h2a_review_recheck_batches alter column run_id drop not null;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
    where conname = 'h2a_review_recheck_batches_run_required_check'
      and conrelid = 'public.h2a_review_recheck_batches'::pg_catalog.regclass) then
    alter table public.h2a_review_recheck_batches
      add constraint h2a_review_recheck_batches_run_required_check
      check (review_kind = 'live' or run_id is not null);
  end if;
end;
$$;
drop index if exists public.h2a_review_recheck_batches_one_active_idx;
create unique index h2a_review_recheck_batches_one_active_kind_idx
  on public.h2a_review_recheck_batches (company_id, review_kind)
  where status in ('queued', 'running');

create or replace function public.h2a_close_live_review(
  p_company_id uuid, p_review_id uuid, p_actor_id uuid, p_outcome text, p_resolution_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_review public.h2a_dry_run_reviews%rowtype;
  v_conflict public.h2a_conflicts%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_status text;
  v_event_type text;
  v_db_action text;
  v_closed uuid[] := '{}';
  v_resumes uuid[] := '{}';
  v_resume_id uuid;
begin
  if p_company_id is null or p_review_id is null or p_actor_id is null
    or p_outcome is null or p_outcome not in ('resolved', 'resolved_by_sync', 'skipped', 'source_missing')
    or (p_resolution_action is not null and p_resolution_action not in ('link_existing', 'create_new', 'skip'))
    or (p_outcome = 'resolved' and coalesce(p_resolution_action, '') not in ('link_existing', 'create_new'))
    or (p_outcome in ('skipped', 'source_missing') and p_resolution_action is distinct from 'skip')
    or (p_outcome = 'resolved_by_sync' and p_resolution_action is not null and p_resolution_action <> 'link_existing') then
    return pg_catalog.jsonb_build_object('error', 'invalid_action');
  end if;

  select * into v_review from public.h2a_dry_run_reviews
    where company_id = p_company_id and id = p_review_id and review_kind = 'live' for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;

  if v_review.status <> 'needs_review' then
    select coalesce(pg_catalog.array_agg(l.conflict_id order by l.conflict_id), '{}') into v_closed
      from public.h2a_live_review_conflicts l where l.company_id = p_company_id and l.review_id = p_review_id;
    select coalesce(pg_catalog.array_agg(r.id order by r.id), '{}') into v_resumes
      from public.h2a_conflict_resumes r where r.company_id = p_company_id and r.conflict_id = any (v_closed);
    return pg_catalog.jsonb_build_object('closedConflictIds', pg_catalog.to_jsonb(v_closed),
      'resumeIds', pg_catalog.to_jsonb(v_resumes), 'replayed', true);
  end if;

  v_status := case when p_outcome = 'skipped' or p_outcome = 'source_missing' then 'skipped' else 'resolved' end;
  v_event_type := case when v_status = 'skipped' then 'skipped' else 'resolved' end;
  v_db_action := case when p_outcome = 'resolved_by_sync' then 'link_existing' else p_resolution_action end;

  for v_conflict in
    select c.* from public.h2a_conflicts c
      join public.h2a_live_review_conflicts l on l.company_id = c.company_id and l.conflict_id = c.id
      where l.company_id = p_company_id and l.review_id = p_review_id and c.status in ('open', 'resolving')
      order by c.id for update of c
  loop
    update public.h2a_conflicts set status = v_status, resolution_action = v_db_action,
      resolved_by = p_actor_id, resolved_at = v_now, updated_at = v_now
      where company_id = p_company_id and id = v_conflict.id;
    insert into public.h2a_conflict_events (company_id, conflict_id, event_type, actor_id, resolution_action,
      sanitized_details, created_at)
    values (p_company_id, v_conflict.id, v_event_type, p_actor_id, v_db_action,
      pg_catalog.jsonb_build_object('closedByReview', p_review_id, 'outcome', p_outcome,
        'before', pg_catalog.jsonb_build_object('status', v_conflict.status, 'updatedAt', v_conflict.updated_at),
        'after', pg_catalog.jsonb_build_object('status', v_status, 'resolutionAction', v_db_action)), v_now);
    v_closed := v_closed || v_conflict.id;
    if p_outcome in ('resolved', 'resolved_by_sync') then
      v_resume_id := null;
      insert into public.h2a_conflict_resumes (company_id, conflict_id, resolution_action, source_object_type, source_id,
        activity_object_type, activity_id, originating_run_id, activity_delivery_id, created_at, updated_at)
      values (p_company_id, v_conflict.id, v_db_action, v_conflict.object_type, v_conflict.source_id,
        v_conflict.activity_object_type, v_conflict.activity_id, v_conflict.run_id, v_conflict.activity_delivery_id, v_now, v_now)
      on conflict (company_id, conflict_id) do nothing
      returning id into v_resume_id;
      if v_resume_id is not null then v_resumes := v_resumes || v_resume_id; end if;
    end if;
  end loop;

  update public.h2a_dry_run_reviews set
    status = case when p_outcome = 'resolved' then 'cleared' else 'no_longer_in_scope' end,
    triage_bucket = 'done',
    recheck_outcome = case when p_outcome = 'source_missing' then 'source_missing' else recheck_outcome end,
    updated_at = v_now
    where company_id = p_company_id and id = p_review_id;
  insert into public.h2a_dry_run_review_events (company_id, review_id, actor_id, event_type, sanitized_details, created_at)
  values (p_company_id, p_review_id, p_actor_id,
    case when p_outcome = 'resolved' then 'cleared' else 'no_longer_in_scope' end,
    pg_catalog.jsonb_build_object('outcome', p_outcome, 'resolutionAction', p_resolution_action), v_now);

  return pg_catalog.jsonb_build_object('closedConflictIds', pg_catalog.to_jsonb(v_closed),
    'resumeIds', pg_catalog.to_jsonb(v_resumes), 'replayed', false);
end;
$$;
revoke execute on function public.h2a_close_live_review(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.h2a_close_live_review(uuid, uuid, uuid, text, text) to service_role;

-- Bind a resolution to the review's actual tenant AND run, including direct writes.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'h2a_dry_run_reviews_company_run_id_key'
      and conrelid = 'public.h2a_dry_run_reviews'::pg_catalog.regclass
  ) then
    alter table public.h2a_dry_run_reviews
      add constraint h2a_dry_run_reviews_company_run_id_key unique (company_id, run_id, id);
  end if;
end;
$$;

create table public.h2a_dry_run_review_resolutions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  run_id uuid not null,
  review_id uuid not null,
  portal_id text not null check (length(btrim(portal_id)) > 0),
  object_type text not null check (object_type in ('contacts', 'companies')),
  source_id text not null check (length(btrim(source_id)) > 0),
  action text not null check (action in ('resolve_fields', 'link_existing', 'create_albi', 'force_create_albi', 'choose_organization')),
  status text not null default 'pending' check (status in ('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded')),
  expected_review_updated_at timestamptz not null,
  decision jsonb not null check (jsonb_typeof(decision) = 'object'),
  decision_hash text not null check (decision_hash ~ '^[a-f0-9]{64}$'),
  client_request_id uuid not null,
  lease_owner uuid,
  lease_expires_at timestamptz,
  execution_phase text check (execution_phase in ('applying', 'waiting_on_albi', 'ready_to_recheck')),
  provider_outcome_code text check (provider_outcome_code is null or provider_outcome_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id) on delete restrict,
  foreign key (company_id, run_id, review_id) references public.h2a_dry_run_reviews (company_id, run_id, id) on delete restrict,
  unique (company_id, id),
  unique (company_id, review_id, expected_review_updated_at, decision_hash),
  unique (company_id, client_request_id),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check ((status = 'applying') = (lease_owner is not null)),
  constraint h2a_review_resolutions_execution_phase_check check ((status = 'applying') = (execution_phase is not null))
);

-- Extend existing deployments without weakening the action allowlist.
alter table public.h2a_dry_run_review_resolutions
  drop constraint if exists h2a_dry_run_review_resolutions_action_check;
alter table public.h2a_dry_run_review_resolutions
  add constraint h2a_dry_run_review_resolutions_action_check
  check (action in ('resolve_fields', 'link_existing', 'create_albi', 'force_create_albi', 'choose_organization'));

do $$
declare v_constraint record;
begin
  for v_constraint in select conname from pg_catalog.pg_constraint
    where conrelid = 'public.h2a_dry_run_review_resolutions'::pg_catalog.regclass
      and contype = 'f' and confrelid in ('public.h2a_sync_runs'::pg_catalog.regclass,
        'public.h2a_dry_run_reviews'::pg_catalog.regclass)
  loop
    execute pg_catalog.format('alter table public.h2a_dry_run_review_resolutions drop constraint %I', v_constraint.conname);
  end loop;
  alter table public.h2a_dry_run_review_resolutions
    add constraint h2a_review_resolution_run_retention_fk foreign key (company_id, run_id)
      references public.h2a_sync_runs (company_id, id) on delete restrict,
    add constraint h2a_review_resolution_review_retention_fk foreign key (company_id, run_id, review_id)
      references public.h2a_dry_run_reviews (company_id, run_id, id) on delete restrict;
end;
$$;

-- Reruns can add the phase column to a previous draft, but cannot guess the
-- source phase of an already-applying legacy lease. Validation fails closed.
alter table public.h2a_dry_run_review_resolutions add column if not exists execution_phase text;
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'h2a_dry_run_review_resolutions_execution_phase_check'
      and conrelid = 'public.h2a_dry_run_review_resolutions'::pg_catalog.regclass
  ) then
    alter table public.h2a_dry_run_review_resolutions
      add constraint h2a_dry_run_review_resolutions_execution_phase_check
      check (execution_phase in ('applying', 'waiting_on_albi', 'ready_to_recheck')) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'h2a_review_resolutions_execution_phase_check'
      and conrelid = 'public.h2a_dry_run_review_resolutions'::pg_catalog.regclass
  ) then
    alter table public.h2a_dry_run_review_resolutions
      add constraint h2a_review_resolutions_execution_phase_check
      check ((status = 'applying') = (execution_phase is not null)) not valid;
  end if;
end;
$$;
alter table public.h2a_dry_run_review_resolutions validate constraint h2a_dry_run_review_resolutions_execution_phase_check;
alter table public.h2a_dry_run_review_resolutions validate constraint h2a_review_resolutions_execution_phase_check;

create table public.h2a_dry_run_review_resolution_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  resolution_id uuid not null,
  actor_id uuid not null references auth.users(id),
  event_type text not null check (event_type in ('planned', 'claimed', 'provider_applied', 'provider_reconciled', 'waiting_on_albi', 'recheck_requested', 'completed', 'failed', 'superseded')),
  sanitized_details jsonb not null default '{}'::jsonb check (jsonb_typeof(sanitized_details) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (company_id, resolution_id) references public.h2a_dry_run_review_resolutions (company_id, id) on delete cascade,
  unique (company_id, id)
);

-- One reviewed association context; does not remove other provider associations.
create table public.h2a_contact_organization_choices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  portal_id text not null check (length(btrim(portal_id)) > 0),
  hubspot_contact_id text not null check (length(btrim(hubspot_contact_id)) > 0),
  hubspot_company_id text not null check (length(btrim(hubspot_company_id)) > 0),
  reviewed_by uuid not null references auth.users(id),
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, portal_id, hubspot_contact_id)
);

create index h2a_review_resolutions_active_idx
  on public.h2a_dry_run_review_resolutions (company_id, status, created_at, id)
  where status in ('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'failed');
create index h2a_review_resolutions_run_idx on public.h2a_dry_run_review_resolutions (run_id);
create index h2a_review_resolutions_review_idx on public.h2a_dry_run_review_resolutions (review_id);
create index h2a_review_resolutions_creator_idx on public.h2a_dry_run_review_resolutions (created_by);
create index h2a_review_resolutions_company_run_review_idx
  on public.h2a_dry_run_review_resolutions (company_id, run_id, review_id);
create index h2a_review_resolution_events_resolution_idx on public.h2a_dry_run_review_resolution_events (resolution_id);
create index h2a_review_resolution_events_actor_idx on public.h2a_dry_run_review_resolution_events (actor_id);
create index h2a_review_resolution_events_company_resolution_idx
  on public.h2a_dry_run_review_resolution_events (company_id, resolution_id, created_at, id);
create unique index h2a_review_resolution_events_planned_once_idx
  on public.h2a_dry_run_review_resolution_events (company_id, resolution_id) where event_type = 'planned';
create index h2a_organization_choices_reviewer_idx on public.h2a_contact_organization_choices (reviewed_by);
-- The tenant/portal/contact unique constraint supplies the organization-choice lookup index.

alter table public.h2a_dry_run_review_resolutions enable row level security;
revoke all on table public.h2a_dry_run_review_resolutions from public, anon, authenticated, service_role;
grant select, insert, update on table public.h2a_dry_run_review_resolutions to service_role;

-- Append-only for service callers; tenant/review retention may cascade cleanup.
alter table public.h2a_dry_run_review_resolution_events enable row level security;
revoke all on table public.h2a_dry_run_review_resolution_events from public, anon, authenticated, service_role;
grant select, insert on table public.h2a_dry_run_review_resolution_events to service_role;

alter table public.h2a_contact_organization_choices enable row level security;
revoke all on table public.h2a_contact_organization_choices from public, anon, authenticated, service_role;
grant select, insert, update on table public.h2a_contact_organization_choices to service_role;

-- Forced creation depends on the fenced mapping migration. Refuse to install
-- over an older mapping writer or conflict resolver that could bypass it.
do $$
declare
  v_mapping_definition text;
  v_conflict_definition text;
begin
  select pg_catalog.pg_get_functiondef(p.oid) into v_mapping_definition
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.h2a_save_mapping(uuid,text,text,text,text,text,uuid,timestamptz,boolean,uuid)');
  select pg_catalog.pg_get_functiondef(p.oid) into v_conflict_definition
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.h2a_resolve_conflict(uuid,uuid,timestamptz,uuid,text,text,jsonb,timestamptz)');
  if v_mapping_definition is null or pg_catalog.strpos(v_mapping_definition, 'mapping_reserved') = 0
    or pg_catalog.strpos(v_mapping_definition, 'h2a_dry_run_review_resolutions') = 0
    or v_conflict_definition is null or pg_catalog.strpos(v_conflict_definition, 'force_create_albi') = 0 then
    raise exception 'Run h2a-mapping-target-ownership.sql before h2a-review-resolutions.sql';
  end if;
end;
$$;

create function public.h2a_create_review_resolution(
  p_company_id uuid, p_run_id uuid, p_review_id uuid,
  p_portal_id text, p_object_type text, p_source_id text, p_action text,
  p_expected_review_updated_at timestamptz, p_decision jsonb, p_decision_hash text,
  p_client_request_id uuid, p_actor_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_review public.h2a_dry_run_reviews%rowtype;
  v_row public.h2a_dry_run_review_resolutions%rowtype;
  v_now timestamptz;
begin
  if p_company_id is null or p_run_id is null or p_review_id is null
    or p_portal_id is null or length(pg_catalog.btrim(p_portal_id)) = 0
    or p_object_type is null or p_object_type not in ('contacts', 'companies')
    or p_source_id is null or length(pg_catalog.btrim(p_source_id)) = 0
    or p_action is null or p_action not in ('resolve_fields', 'link_existing', 'create_albi', 'force_create_albi', 'choose_organization')
    or p_expected_review_updated_at is null or p_decision is null or pg_catalog.jsonb_typeof(p_decision) <> 'object'
    or p_decision_hash is null or p_decision_hash !~ '^[a-f0-9]{64}$'
    or p_client_request_id is null or p_actor_id is null then
    return pg_catalog.jsonb_build_object('error', 'invalid_resolution');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(p_company_id::text, p_portal_id, 'source', p_object_type, p_source_id)::text, 0));
  select * into v_review from public.h2a_dry_run_reviews r
    where r.company_id = p_company_id and r.id = p_review_id for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  if v_review.run_id is distinct from p_run_id
    or v_review.portal_id is distinct from p_portal_id
    or v_review.object_type is distinct from p_object_type
    or v_review.source_id is distinct from p_source_id then
    return pg_catalog.jsonb_build_object('error', 'identity_mismatch');
  end if;
  -- Under the review lock, exact replays survive subsequent review rechecks.
  -- Client UUID reuse must not silently select a different semantic decision.
  select * into v_row from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.client_request_id = p_client_request_id;
  if not found then
    select * into v_row from public.h2a_dry_run_review_resolutions r
      where r.company_id = p_company_id and r.review_id = p_review_id
        and r.expected_review_updated_at = p_expected_review_updated_at and r.decision_hash = p_decision_hash;
  end if;
  if found then
    if v_row.run_id is distinct from p_run_id or v_row.review_id is distinct from p_review_id
      or v_row.portal_id is distinct from p_portal_id or v_row.object_type is distinct from p_object_type
      or v_row.source_id is distinct from p_source_id or v_row.action is distinct from p_action
      or v_row.expected_review_updated_at is distinct from p_expected_review_updated_at
      or v_row.decision_hash is distinct from p_decision_hash or v_row.decision is distinct from p_decision then
      return pg_catalog.jsonb_build_object('error', 'request_conflict');
    end if;
    return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row), 'created', false);
  end if;
  if p_action = 'force_create_albi' then
    if exists (select 1 from public.h2a_dry_run_review_resolutions r
      where r.company_id = p_company_id and r.portal_id = p_portal_id
        and r.object_type = p_object_type and r.source_id = p_source_id
        and r.action = 'force_create_albi' and r.status in ('pending', 'applying')) then
      return pg_catalog.jsonb_build_object('error', 'request_conflict');
    end if;
    if (p_object_type = 'contacts' and exists (select 1 from public.h2a_contact_mappings m
          where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id))
      or (p_object_type = 'companies' and exists (select 1 from public.h2a_organization_mappings m
          where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id)) then
      return pg_catalog.jsonb_build_object('error', 'stale');
    end if;
  end if;
  if v_review.updated_at is distinct from p_expected_review_updated_at then
    return pg_catalog.jsonb_build_object('error', 'stale');
  end if;
  if v_review.status <> 'needs_review' and not (p_action = 'create_albi'
    and v_review.status = 'cleared' and v_review.recheck_outcome = 'safe_to_create') then
    return pg_catalog.jsonb_build_object('error', 'stale');
  end if;
  v_now := pg_catalog.clock_timestamp();
  insert into public.h2a_dry_run_review_resolutions (
    company_id, run_id, review_id, portal_id, object_type, source_id, action,
    expected_review_updated_at, decision, decision_hash, client_request_id, created_by, created_at, updated_at
  ) values (
    p_company_id, p_run_id, p_review_id, p_portal_id, p_object_type, p_source_id, p_action,
    p_expected_review_updated_at, p_decision, p_decision_hash, p_client_request_id, p_actor_id, v_now, v_now
  ) on conflict do nothing returning * into v_row;
  -- Same-review RPC creators serialize on the lock; a remaining conflict means
  -- concurrent client-ID reuse by another review or an out-of-band service write.
  if not found then return pg_catalog.jsonb_build_object('error', 'request_conflict'); end if;
  insert into public.h2a_dry_run_review_resolution_events (
    company_id, resolution_id, actor_id, event_type, created_at
  ) values (p_company_id, v_row.id, p_actor_id, 'planned', v_now);
  return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row), 'created', true);
end;
$$;
revoke execute on function public.h2a_create_review_resolution(uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.h2a_create_review_resolution(uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb, text, uuid, uuid) to service_role;

-- Active -> applying. A fresh token per claim fences expired workers.
create function public.h2a_claim_review_resolution(
  p_company_id uuid, p_resolution_id uuid, p_owner_token uuid, p_actor_id uuid, p_ttl_seconds integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_review_id uuid;
  v_phase text;
  v_row public.h2a_dry_run_review_resolutions%rowtype;
  v_now timestamptz;
  v_mapping_exists boolean;
begin
  if p_company_id is null or p_resolution_id is null or p_owner_token is null or p_actor_id is null
    or p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    return pg_catalog.jsonb_build_object('error', 'invalid_claim');
  end if;
  select r.review_id into v_review_id from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.id = p_resolution_id;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_company_id::text || ':' || v_review_id::text, 0));
  v_now := pg_catalog.clock_timestamp();
  select * into v_row from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.id = p_resolution_id
      and r.status in ('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'failed')
      and (r.lease_owner is null or r.lease_expires_at <= v_now) for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_claimable'); end if;
  if v_row.action = 'force_create_albi' and v_row.status = 'failed' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(v_row.company_id::text, v_row.portal_id, 'source', v_row.object_type, v_row.source_id)::text, 0));
    if v_row.object_type = 'contacts' then
      select exists (select 1 from public.h2a_contact_mappings m where m.company_id = v_row.company_id
        and m.portal_id = v_row.portal_id and m.hubspot_id = v_row.source_id) into v_mapping_exists;
    else
      select exists (select 1 from public.h2a_organization_mappings m where m.company_id = v_row.company_id
        and m.portal_id = v_row.portal_id and m.hubspot_id = v_row.source_id) into v_mapping_exists;
    end if;
    if v_mapping_exists then return pg_catalog.jsonb_build_object('error', 'stale'); end if;
  end if;
  v_now := pg_catalog.clock_timestamp();
  if exists (
    select 1 from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.review_id = v_review_id and r.id <> p_resolution_id
      and r.lease_owner is not null and r.lease_expires_at > v_now
  ) then return pg_catalog.jsonb_build_object('error', 'review_busy'); end if;
  v_phase := case
    when v_row.status = 'applying' then v_row.execution_phase
    when v_row.status in ('waiting_on_albi', 'ready_to_recheck') then v_row.status
    else 'applying' end;
  if v_phase is null then return pg_catalog.jsonb_build_object('error', 'invalid_claim_phase'); end if;
  update public.h2a_dry_run_review_resolutions set status = 'applying', execution_phase = v_phase, lease_owner = p_owner_token,
    lease_expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds), updated_at = v_now
    where company_id = p_company_id and id = p_resolution_id returning * into v_row;
  insert into public.h2a_dry_run_review_resolution_events (
    company_id, resolution_id, actor_id, event_type, sanitized_details, created_at
  ) values (p_company_id, p_resolution_id, p_actor_id, 'claimed', pg_catalog.jsonb_build_object('execution_phase', v_phase), v_now);
  return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke execute on function public.h2a_claim_review_resolution(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.h2a_claim_review_resolution(uuid, uuid, uuid, uuid, integer) to service_role;

-- applying -> pending/waiting/ready/completed/failed/superseded, with an exact live lease.
-- Provider audit events may precede more work (pending), manual work, or recheck.
create function public.h2a_finish_review_resolution(
  p_company_id uuid, p_resolution_id uuid, p_owner_token uuid, p_actor_id uuid,
  p_status text, p_event_type text, p_event_details jsonb, p_provider_outcome_code text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.h2a_dry_run_review_resolutions%rowtype;
  v_now timestamptz;
begin
  if p_company_id is null or p_resolution_id is null or p_owner_token is null or p_actor_id is null
    or p_status is null or p_status not in ('pending', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded')
    or p_event_type is null or p_event_type not in ('provider_applied', 'provider_reconciled', 'waiting_on_albi', 'recheck_requested', 'completed', 'failed', 'superseded')
    or p_event_details is null or pg_catalog.jsonb_typeof(p_event_details) <> 'object'
    or (p_provider_outcome_code is not null and p_provider_outcome_code !~ '^[a-z][a-z0-9_]{0,63}$') then
    return pg_catalog.jsonb_build_object('error', 'invalid_finish');
  end if;
  select * into v_row from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.id = p_resolution_id for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  v_now := pg_catalog.clock_timestamp();
  if v_row.status <> 'applying' or v_row.lease_owner is distinct from p_owner_token
    or v_row.lease_expires_at is null or v_row.lease_expires_at <= v_now then
    return pg_catalog.jsonb_build_object('error', 'lease_lost');
  end if;
  -- A waiting/recheck lease only evaluates existing work; it cannot restart
  -- provider mutations. Read failures preserve that phase with a failed event.
  if v_row.execution_phase in ('waiting_on_albi', 'ready_to_recheck') then
    if p_status not in ('waiting_on_albi', 'ready_to_recheck', 'completed', 'superseded') or not (
      (p_status = 'waiting_on_albi' and p_event_type = 'waiting_on_albi')
      or (p_status = 'ready_to_recheck' and p_event_type = 'recheck_requested')
      or (p_status = 'completed' and p_event_type = 'completed')
      or (p_status = 'superseded' and p_event_type = 'superseded')
      or (p_status = v_row.execution_phase and p_event_type = 'failed')
    ) then return pg_catalog.jsonb_build_object('error', 'invalid_transition'); end if;
  elsif v_row.execution_phase = 'applying' then
    if not (
      (p_status in ('pending', 'waiting_on_albi', 'ready_to_recheck') and p_event_type in ('provider_applied', 'provider_reconciled'))
      or (p_status = 'waiting_on_albi' and p_event_type = 'waiting_on_albi')
      or (p_status = 'ready_to_recheck' and p_event_type = 'recheck_requested')
      or (p_status = 'completed' and p_event_type = 'completed')
      or (p_status = 'failed' and p_event_type = 'failed')
      or (p_status = 'superseded' and p_event_type = 'superseded')
    ) then return pg_catalog.jsonb_build_object('error', 'invalid_transition'); end if;
  else return pg_catalog.jsonb_build_object('error', 'invalid_transition');
  end if;
  update public.h2a_dry_run_review_resolutions set status = p_status,
    provider_outcome_code = coalesce(p_provider_outcome_code, provider_outcome_code),
    lease_owner = null, lease_expires_at = null, execution_phase = null, updated_at = v_now
    where company_id = p_company_id and id = p_resolution_id returning * into v_row;
  insert into public.h2a_dry_run_review_resolution_events (
    company_id, resolution_id, actor_id, event_type, sanitized_details, created_at
  ) values (p_company_id, p_resolution_id, p_actor_id, p_event_type, p_event_details, v_now);
  return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke execute on function public.h2a_finish_review_resolution(uuid, uuid, uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.h2a_finish_review_resolution(uuid, uuid, uuid, uuid, text, text, jsonb, text) to service_role;

create function public.h2a_upsert_contact_organization_choice(
  p_company_id uuid, p_portal_id text, p_hubspot_contact_id text, p_hubspot_company_id text, p_actor_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.h2a_contact_organization_choices%rowtype;
  v_now timestamptz;
begin
  if p_company_id is null or p_portal_id is null or length(pg_catalog.btrim(p_portal_id)) = 0
    or p_hubspot_contact_id is null or length(pg_catalog.btrim(p_hubspot_contact_id)) = 0
    or p_hubspot_company_id is null or length(pg_catalog.btrim(p_hubspot_company_id)) = 0
    or p_actor_id is null then
    return pg_catalog.jsonb_build_object('error', 'invalid_choice');
  end if;
  -- JSON array encoding avoids ambiguous delimiters in external identities.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(p_company_id::text, p_portal_id, p_hubspot_contact_id)::text, 0));
  v_now := pg_catalog.clock_timestamp();
  insert into public.h2a_contact_organization_choices (
    company_id, portal_id, hubspot_contact_id, hubspot_company_id, reviewed_by, reviewed_at, created_at, updated_at
  ) values (
    p_company_id, p_portal_id, p_hubspot_contact_id, p_hubspot_company_id, p_actor_id, v_now, v_now, v_now
  ) on conflict (company_id, portal_id, hubspot_contact_id) do update
    set hubspot_company_id = excluded.hubspot_company_id, reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at returning * into v_row;
  return pg_catalog.jsonb_build_object('choice', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke execute on function public.h2a_upsert_contact_organization_choice(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.h2a_upsert_contact_organization_choice(uuid, text, text, text, uuid) to service_role;

create or replace function public.h2a_retain_review_resolution_runs(
  p_company_id uuid, p_keep_run_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_runs jsonb;
begin
  if p_company_id is null or p_keep_run_id is null or not exists (
    select 1 from public.h2a_sync_runs r where r.company_id = p_company_id and r.id = p_keep_run_id
      and r.mode = 'dry_run' and r.status = 'completed'
  ) then
    raise exception 'invalid_review_retention';
  end if;
  with changed as (
    update public.h2a_dry_run_review_resolutions r
      set status = 'superseded', provider_outcome_code = 'superseded', updated_at = pg_catalog.clock_timestamp()
      where r.company_id = p_company_id and r.run_id <> p_keep_run_id
        and r.status in ('pending', 'waiting_on_albi', 'ready_to_recheck', 'failed')
        and r.lease_owner is null
      returning r.company_id, r.id, r.created_by
  )
  insert into public.h2a_dry_run_review_resolution_events
    (company_id, resolution_id, actor_id, event_type, sanitized_details)
    select company_id, id, created_by, 'superseded', '{"code":"superseded"}'::jsonb from changed;
  select coalesce(pg_catalog.jsonb_agg(distinct r.run_id::text), '[]'::jsonb)
    into v_runs from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.run_id <> p_keep_run_id;
  return v_runs;
end;
$$;
revoke execute on function public.h2a_retain_review_resolution_runs(uuid, uuid) from public, anon, authenticated;
grant execute on function public.h2a_retain_review_resolution_runs(uuid, uuid) to service_role;

-- Live rows recheck without the sample gate: evidence refresh only, while the row is open.
create or replace function public.h2a_apply_dry_run_recheck(
  p_company_id uuid,
  p_review_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid,
  p_status text,
  p_recheck_outcome text,
  p_reason text,
  p_conflict_type text,
  p_source_snapshot jsonb,
  p_candidate_snapshots jsonb,
  p_match_evidence jsonb,
  p_proposed_changes jsonb,
  p_event_type text,
  p_event_details jsonb,
  p_now timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_review public.h2a_dry_run_reviews%rowtype;
  v_current_run_id uuid;
  v_current_review_version smallint;
begin
  -- Fail closed before locks or mutations, including NULL CAS timestamps.
  if p_company_id is null or p_review_id is null
    or p_expected_updated_at is null or p_actor_id is null or p_now is null
    or p_status is null or p_status not in ('needs_review', 'cleared', 'no_longer_in_scope')
    or p_recheck_outcome is null or p_recheck_outcome not in ('still_needs_review', 'safe_to_link', 'safe_to_create', 'source_missing')
    or p_event_type is null or p_event_type not in ('still_needs_review', 'cleared', 'no_longer_in_scope')
    or p_reason is null or length(pg_catalog.btrim(p_reason)) = 0
    or p_conflict_type is null or length(pg_catalog.btrim(p_conflict_type)) = 0
    or p_source_snapshot is null or pg_catalog.jsonb_typeof(p_source_snapshot) <> 'object'
    or p_candidate_snapshots is null or pg_catalog.jsonb_typeof(p_candidate_snapshots) <> 'array'
    or p_match_evidence is null or pg_catalog.jsonb_typeof(p_match_evidence) <> 'object'
    or p_proposed_changes is null or pg_catalog.jsonb_typeof(p_proposed_changes) <> 'object'
    or p_event_details is null or pg_catalog.jsonb_typeof(p_event_details) <> 'object' then
    return pg_catalog.jsonb_build_object('error', 'invalid_recheck');
  end if;
  -- Only inspect array length after its type has been validated.
  if pg_catalog.jsonb_array_length(p_candidate_snapshots) > 10 then
    return pg_catalog.jsonb_build_object('error', 'invalid_recheck');
  end if;

  select * into v_review
    from public.h2a_dry_run_reviews r
    where r.company_id = p_company_id and r.id = p_review_id
    for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  -- Live rows belong to the live run that captured them: they are current while open,
  -- and a live recheck only refreshes evidence (closing goes through h2a_close_live_review).
  if v_review.review_kind = 'live' then
    if v_review.status <> 'needs_review' then
      return pg_catalog.jsonb_build_object('error', 'stale');
    end if;
    if p_status <> 'needs_review' then
      return pg_catalog.jsonb_build_object('error', 'invalid_recheck');
    end if;
  else
    select r.id, r.review_capture_version into v_current_run_id, v_current_review_version
      from public.h2a_sync_runs r
      where r.company_id = p_company_id
        and r.mode = 'dry_run'
        and r.status = 'completed'
        and r.sample_limit_per_type = 10
      order by r.created_at desc, r.id desc
      limit 1;
    if v_current_run_id is distinct from v_review.run_id
      or v_current_review_version is distinct from 1 then
      return pg_catalog.jsonb_build_object('error', 'superseded');
    end if;
  end if;
  if v_review.updated_at is distinct from p_expected_updated_at then
    return pg_catalog.jsonb_build_object('error', 'stale');
  end if;

  update public.h2a_dry_run_reviews set
    status = p_status,
    recheck_outcome = p_recheck_outcome,
    reason = p_reason,
    conflict_type = p_conflict_type,
    source_snapshot = p_source_snapshot,
    candidate_snapshots = p_candidate_snapshots,
    match_evidence = p_match_evidence,
    proposed_changes = p_proposed_changes,
    last_rechecked_at = p_now,
    last_rechecked_by = p_actor_id,
    updated_at = p_now
  where company_id = p_company_id and id = p_review_id
  returning * into v_review;

  insert into public.h2a_dry_run_review_events (
    company_id, review_id, actor_id, event_type, reason, sanitized_details, created_at
  ) values (
    p_company_id, p_review_id, p_actor_id, p_event_type, p_reason, p_event_details, p_now
  );
  return pg_catalog.jsonb_build_object('review', pg_catalog.to_jsonb(v_review));
end;
$$;
revoke execute on function public.h2a_apply_dry_run_recheck(uuid, uuid, timestamptz, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.h2a_apply_dry_run_recheck(uuid, uuid, timestamptz, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, jsonb, timestamptz) to service_role;

-- Skip is a resolution on a live row, audited and idempotent like every other reviewer action.
alter table public.h2a_dry_run_review_resolutions
  drop constraint if exists h2a_dry_run_review_resolutions_action_check;
alter table public.h2a_dry_run_review_resolutions
  add constraint h2a_dry_run_review_resolutions_action_check
  check (action in ('resolve_fields', 'link_existing', 'create_albi', 'force_create_albi', 'choose_organization', 'skip_live'));

create or replace function public.h2a_create_review_resolution(
  p_company_id uuid, p_run_id uuid, p_review_id uuid,
  p_portal_id text, p_object_type text, p_source_id text, p_action text,
  p_expected_review_updated_at timestamptz, p_decision jsonb, p_decision_hash text,
  p_client_request_id uuid, p_actor_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_review public.h2a_dry_run_reviews%rowtype;
  v_row public.h2a_dry_run_review_resolutions%rowtype;
  v_now timestamptz;
begin
  if p_company_id is null or p_run_id is null or p_review_id is null
    or p_portal_id is null or length(pg_catalog.btrim(p_portal_id)) = 0
    or p_object_type is null or p_object_type not in ('contacts', 'companies')
    or p_source_id is null or length(pg_catalog.btrim(p_source_id)) = 0
    or p_action is null or p_action not in ('resolve_fields', 'link_existing', 'create_albi', 'force_create_albi', 'choose_organization', 'skip_live')
    or p_expected_review_updated_at is null or p_decision is null or pg_catalog.jsonb_typeof(p_decision) <> 'object'
    or p_decision_hash is null or p_decision_hash !~ '^[a-f0-9]{64}$'
    or p_client_request_id is null or p_actor_id is null then
    return pg_catalog.jsonb_build_object('error', 'invalid_resolution');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(p_company_id::text, p_portal_id, 'source', p_object_type, p_source_id)::text, 0));
  select * into v_review from public.h2a_dry_run_reviews r
    where r.company_id = p_company_id and r.id = p_review_id for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  if v_review.run_id is distinct from p_run_id
    or v_review.portal_id is distinct from p_portal_id
    or v_review.object_type is distinct from p_object_type
    or v_review.source_id is distinct from p_source_id then
    return pg_catalog.jsonb_build_object('error', 'identity_mismatch');
  end if;
  -- Skipping closes a live row's conflicts; a sample row has none to skip.
  if p_action = 'skip_live' and v_review.review_kind is distinct from 'live' then
    return pg_catalog.jsonb_build_object('error', 'invalid_resolution');
  end if;
  -- Under the review lock, exact replays survive subsequent review rechecks.
  -- Client UUID reuse must not silently select a different semantic decision.
  select * into v_row from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.client_request_id = p_client_request_id;
  if not found then
    select * into v_row from public.h2a_dry_run_review_resolutions r
      where r.company_id = p_company_id and r.review_id = p_review_id
        and r.expected_review_updated_at = p_expected_review_updated_at and r.decision_hash = p_decision_hash;
  end if;
  if found then
    if v_row.run_id is distinct from p_run_id or v_row.review_id is distinct from p_review_id
      or v_row.portal_id is distinct from p_portal_id or v_row.object_type is distinct from p_object_type
      or v_row.source_id is distinct from p_source_id or v_row.action is distinct from p_action
      or v_row.expected_review_updated_at is distinct from p_expected_review_updated_at
      or v_row.decision_hash is distinct from p_decision_hash or v_row.decision is distinct from p_decision then
      return pg_catalog.jsonb_build_object('error', 'request_conflict');
    end if;
    return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row), 'created', false);
  end if;
  if p_action = 'force_create_albi' then
    if exists (select 1 from public.h2a_dry_run_review_resolutions r
      where r.company_id = p_company_id and r.portal_id = p_portal_id
        and r.object_type = p_object_type and r.source_id = p_source_id
        and r.action = 'force_create_albi' and r.status in ('pending', 'applying')) then
      return pg_catalog.jsonb_build_object('error', 'request_conflict');
    end if;
    if (p_object_type = 'contacts' and exists (select 1 from public.h2a_contact_mappings m
          where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id))
      or (p_object_type = 'companies' and exists (select 1 from public.h2a_organization_mappings m
          where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id)) then
      return pg_catalog.jsonb_build_object('error', 'stale');
    end if;
  end if;
  if v_review.updated_at is distinct from p_expected_review_updated_at then
    return pg_catalog.jsonb_build_object('error', 'stale');
  end if;
  if v_review.status <> 'needs_review' and not (v_review.review_kind = 'sample' and p_action = 'create_albi'
    and v_review.status = 'cleared' and v_review.recheck_outcome = 'safe_to_create') then
    return pg_catalog.jsonb_build_object('error', 'stale');
  end if;
  v_now := pg_catalog.clock_timestamp();
  insert into public.h2a_dry_run_review_resolutions (
    company_id, run_id, review_id, portal_id, object_type, source_id, action,
    expected_review_updated_at, decision, decision_hash, client_request_id, created_by, created_at, updated_at
  ) values (
    p_company_id, p_run_id, p_review_id, p_portal_id, p_object_type, p_source_id, p_action,
    p_expected_review_updated_at, p_decision, p_decision_hash, p_client_request_id, p_actor_id, v_now, v_now
  ) on conflict do nothing returning * into v_row;
  -- Same-review RPC creators serialize on the lock; a remaining conflict means
  -- concurrent client-ID reuse by another review or an out-of-band service write.
  if not found then return pg_catalog.jsonb_build_object('error', 'request_conflict'); end if;
  insert into public.h2a_dry_run_review_resolution_events (
    company_id, resolution_id, actor_id, event_type, created_at
  ) values (p_company_id, v_row.id, p_actor_id, 'planned', v_now);
  return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row), 'created', true);
end;
$$;
revoke execute on function public.h2a_create_review_resolution(uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.h2a_create_review_resolution(uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb, text, uuid, uuid) to service_role;

commit;
