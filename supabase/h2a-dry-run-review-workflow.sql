-- Service-owned review captures for ten-per-type dry runs.
begin;

alter table public.h2a_sync_runs
  add column if not exists review_capture_version smallint;

alter table public.h2a_sync_runs
  drop constraint if exists h2a_sync_runs_review_capture_version_check;

alter table public.h2a_sync_runs
  add constraint h2a_sync_runs_review_capture_version_check
  check (review_capture_version is null or (
    mode = 'dry_run' and sample_limit_per_type is not null and sample_limit_per_type = 10 and review_capture_version = 1
  ))
  not valid;

alter table public.h2a_sync_runs
  validate constraint h2a_sync_runs_review_capture_version_check;

create table if not exists public.h2a_dry_run_reviews (
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

create table if not exists public.h2a_dry_run_review_events (
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

create index if not exists h2a_dry_reviews_company_run_status_idx
  on public.h2a_dry_run_reviews (company_id, run_id, status, object_type, created_at desc, id desc);
create index if not exists h2a_dry_reviews_company_run_reason_idx
  on public.h2a_dry_run_reviews (company_id, run_id, reason, created_at desc, id desc);
create index if not exists h2a_dry_reviews_last_rechecked_by_idx
  on public.h2a_dry_run_reviews (last_rechecked_by);
create index if not exists h2a_dry_review_events_company_review_idx
  on public.h2a_dry_run_review_events (company_id, review_id, created_at, id);
create unique index if not exists h2a_dry_review_events_captured_once_idx
  on public.h2a_dry_run_review_events (company_id, review_id)
  where event_type = 'captured';

alter table public.h2a_dry_run_reviews enable row level security;
revoke all on table public.h2a_dry_run_reviews from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.h2a_dry_run_reviews to service_role;

-- Append-only for service callers; parent cleanup can still cascade events.
alter table public.h2a_dry_run_review_events enable row level security;
revoke all on table public.h2a_dry_run_review_events from public, anon, authenticated, service_role;
grant select, insert on table public.h2a_dry_run_review_events to service_role;

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

commit;

