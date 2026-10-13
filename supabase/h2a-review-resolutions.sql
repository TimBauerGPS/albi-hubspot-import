-- Durable, service-owned review decisions. Apply only after review-workflow storage.
-- Provider evidence must be validated/sanitized by the server before these RPCs.
-- No provider calls belong inside these short transactions.
begin;

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

create table if not exists public.h2a_dry_run_review_resolutions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  run_id uuid not null,
  review_id uuid not null,
  portal_id text not null check (length(btrim(portal_id)) > 0),
  object_type text not null check (object_type in ('contacts', 'companies')),
  source_id text not null check (length(btrim(source_id)) > 0),
  action text not null check (action in ('resolve_fields', 'link_existing', 'create_albi', 'choose_organization')),
  status text not null default 'pending' check (status in ('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded')),
  expected_review_updated_at timestamptz not null,
  decision jsonb not null check (jsonb_typeof(decision) = 'object'),
  decision_hash text not null check (decision_hash ~ '^[a-f0-9]{64}$'),
  client_request_id uuid not null,
  lease_owner uuid,
  lease_expires_at timestamptz,
  provider_outcome_code text check (provider_outcome_code is null or provider_outcome_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id) on delete cascade,
  foreign key (company_id, run_id, review_id) references public.h2a_dry_run_reviews (company_id, run_id, id) on delete cascade,
  unique (company_id, id),
  unique (company_id, review_id, expected_review_updated_at, decision_hash),
  unique (company_id, client_request_id),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check ((status = 'applying') = (lease_owner is not null))
);

create table if not exists public.h2a_dry_run_review_resolution_events (
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
create table if not exists public.h2a_contact_organization_choices (
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

create index if not exists h2a_review_resolutions_active_idx
  on public.h2a_dry_run_review_resolutions (company_id, status, created_at, id)
  where status in ('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'failed');
create index if not exists h2a_review_resolutions_run_idx on public.h2a_dry_run_review_resolutions (run_id);
create index if not exists h2a_review_resolutions_review_idx on public.h2a_dry_run_review_resolutions (review_id);
create index if not exists h2a_review_resolutions_creator_idx on public.h2a_dry_run_review_resolutions (created_by);
create index if not exists h2a_review_resolutions_company_run_review_idx
  on public.h2a_dry_run_review_resolutions (company_id, run_id, review_id);
create index if not exists h2a_review_resolution_events_resolution_idx on public.h2a_dry_run_review_resolution_events (resolution_id);
create index if not exists h2a_review_resolution_events_actor_idx on public.h2a_dry_run_review_resolution_events (actor_id);
create index if not exists h2a_review_resolution_events_company_resolution_idx
  on public.h2a_dry_run_review_resolution_events (company_id, resolution_id, created_at, id);
create unique index if not exists h2a_review_resolution_events_planned_once_idx
  on public.h2a_dry_run_review_resolution_events (company_id, resolution_id) where event_type = 'planned';
create index if not exists h2a_organization_choices_reviewer_idx on public.h2a_contact_organization_choices (reviewed_by);
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
    or p_action is null or p_action not in ('resolve_fields', 'link_existing', 'create_albi', 'choose_organization')
    or p_expected_review_updated_at is null or p_decision is null or pg_catalog.jsonb_typeof(p_decision) <> 'object'
    or p_decision_hash is null or p_decision_hash !~ '^[a-f0-9]{64}$'
    or p_client_request_id is null or p_actor_id is null then
    return pg_catalog.jsonb_build_object('error', 'invalid_resolution');
  end if;
  select * into v_review from public.h2a_dry_run_reviews r
    where r.company_id = p_company_id and r.id = p_review_id for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  if v_review.run_id is distinct from p_run_id
    or v_review.portal_id is distinct from p_portal_id
    or v_review.object_type is distinct from p_object_type
    or v_review.source_id is distinct from p_source_id then
    return pg_catalog.jsonb_build_object('error', 'identity_mismatch');
  end if;
  if v_review.updated_at is distinct from p_expected_review_updated_at then
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
  if found then
    insert into public.h2a_dry_run_review_resolution_events (
      company_id, resolution_id, actor_id, event_type, created_at
    ) values (p_company_id, v_row.id, p_actor_id, 'planned', v_now);
    return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row), 'created', true);
  end if;
  -- Client UUID reuse must not silently select a different semantic decision.
  select * into v_row from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.client_request_id = p_client_request_id;
  if not found then
    select * into v_row from public.h2a_dry_run_review_resolutions r
      where r.company_id = p_company_id and r.review_id = p_review_id
        and r.expected_review_updated_at = p_expected_review_updated_at and r.decision_hash = p_decision_hash;
  end if;
  if v_row.id is null or v_row.run_id is distinct from p_run_id or v_row.review_id is distinct from p_review_id
    or v_row.portal_id is distinct from p_portal_id or v_row.object_type is distinct from p_object_type
    or v_row.source_id is distinct from p_source_id or v_row.action is distinct from p_action
    or v_row.expected_review_updated_at is distinct from p_expected_review_updated_at
    or v_row.decision_hash is distinct from p_decision_hash or v_row.decision is distinct from p_decision then
    return pg_catalog.jsonb_build_object('error', 'request_conflict');
  end if;
  return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row), 'created', false);
end;
$$;
revoke execute on function public.h2a_create_review_resolution(uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.h2a_create_review_resolution(uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb, text, uuid, uuid) to service_role;

-- Active -> applying. A fresh token per claim fences expired workers.
create or replace function public.h2a_claim_review_resolution(
  p_company_id uuid, p_resolution_id uuid, p_owner_token uuid, p_actor_id uuid, p_ttl_seconds integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_review_id uuid;
  v_row public.h2a_dry_run_review_resolutions%rowtype;
  v_now timestamptz;
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
  v_now := pg_catalog.clock_timestamp();
  if exists (
    select 1 from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.review_id = v_review_id and r.id <> p_resolution_id
      and r.lease_owner is not null and r.lease_expires_at > v_now
  ) then return pg_catalog.jsonb_build_object('error', 'review_busy'); end if;
  update public.h2a_dry_run_review_resolutions set status = 'applying', lease_owner = p_owner_token,
    lease_expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds), updated_at = v_now
    where company_id = p_company_id and id = p_resolution_id returning * into v_row;
  insert into public.h2a_dry_run_review_resolution_events (
    company_id, resolution_id, actor_id, event_type, created_at
  ) values (p_company_id, p_resolution_id, p_actor_id, 'claimed', v_now);
  return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke execute on function public.h2a_claim_review_resolution(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.h2a_claim_review_resolution(uuid, uuid, uuid, uuid, integer) to service_role;

-- applying -> pending/waiting/ready/completed/failed/superseded, with an exact live lease.
-- Provider audit events may precede more work (pending), manual work, or recheck.
create or replace function public.h2a_finish_review_resolution(
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
  -- Fixed event/state graph: provider success can retain further pending work.
  if not (
    (p_status in ('pending', 'waiting_on_albi', 'ready_to_recheck') and p_event_type in ('provider_applied', 'provider_reconciled'))
    or (p_status = 'waiting_on_albi' and p_event_type = 'waiting_on_albi')
    or (p_status = 'ready_to_recheck' and p_event_type = 'recheck_requested')
    or (p_status = 'completed' and p_event_type = 'completed')
    or (p_status = 'failed' and p_event_type = 'failed')
    or (p_status = 'superseded' and p_event_type = 'superseded')
  ) then return pg_catalog.jsonb_build_object('error', 'invalid_transition'); end if;
  select * into v_row from public.h2a_dry_run_review_resolutions r
    where r.company_id = p_company_id and r.id = p_resolution_id for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  v_now := pg_catalog.clock_timestamp();
  if v_row.status <> 'applying' or v_row.lease_owner is distinct from p_owner_token
    or v_row.lease_expires_at is null or v_row.lease_expires_at <= v_now then
    return pg_catalog.jsonb_build_object('error', 'lease_lost');
  end if;
  update public.h2a_dry_run_review_resolutions set status = p_status,
    provider_outcome_code = coalesce(p_provider_outcome_code, provider_outcome_code),
    lease_owner = null, lease_expires_at = null, updated_at = v_now
    where company_id = p_company_id and id = p_resolution_id returning * into v_row;
  insert into public.h2a_dry_run_review_resolution_events (
    company_id, resolution_id, actor_id, event_type, sanitized_details, created_at
  ) values (p_company_id, p_resolution_id, p_actor_id, p_event_type, p_event_details, v_now);
  return pg_catalog.jsonb_build_object('resolution', pg_catalog.to_jsonb(v_row));
end;
$$;
revoke execute on function public.h2a_finish_review_resolution(uuid, uuid, uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.h2a_finish_review_resolution(uuid, uuid, uuid, uuid, text, text, jsonb, text) to service_role;

create or replace function public.h2a_upsert_contact_organization_choice(
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

commit;
