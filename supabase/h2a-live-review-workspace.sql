-- Live review workspace (fast review and Conflicts parity). Apply after
-- h2a-review-recheck-batches.sql and h2a-mapping-target-ownership.sql. Safe to re-run.
begin;

-- Live review workspace: live HubSpot->Albi conflicts share the sample review row table.
alter table public.h2a_dry_run_reviews
  add column if not exists review_kind text not null default 'sample' check (review_kind in ('sample', 'live')),
  add column if not exists triage_bucket text not null default 'decision'
    check (triage_bucket in ('quick', 'todo', 'decision', 'blocked', 'done')),
  add column if not exists triage_details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(triage_details) = 'object');

-- One open live review per HubSpot source, so concurrent runs share a single row.
create unique index if not exists h2a_live_review_open_source_idx
  on public.h2a_dry_run_reviews (company_id, portal_id, object_type, source_id)
  where review_kind = 'live' and status = 'needs_review';
create index if not exists h2a_dry_reviews_company_kind_bucket_idx
  on public.h2a_dry_run_reviews (company_id, review_kind, status, triage_bucket, created_at desc, id desc);

create table if not exists public.h2a_live_review_conflicts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  review_id uuid not null,
  conflict_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (company_id, review_id) references public.h2a_dry_run_reviews (company_id, id) on delete cascade,
  foreign key (company_id, conflict_id) references public.h2a_conflicts (company_id, id),
  unique (company_id, conflict_id)
);
create index if not exists h2a_live_review_conflicts_review_idx
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
create unique index if not exists h2a_review_recheck_batches_one_active_kind_idx
  on public.h2a_review_recheck_batches (company_id, review_kind)
  where status in ('queued', 'running');

create or replace function public.h2a_close_live_review(
  p_company_id uuid, p_review_id uuid, p_actor_id uuid, p_outcome text, p_resolution_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_review public.h2a_dry_run_reviews%rowtype;
  v_conflict public.h2a_conflicts%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_replay boolean;
  v_actor_id uuid;
  v_outcome text;
  v_action text;
  v_status text;
  v_event_type text;
  v_db_action text;
  v_closed uuid[] := '{}';
  v_resumes uuid[] := '{}';
  v_all uuid[] := '{}';
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
    -- Replay. A conflict linked after the first close (live capture raced the close) is still open:
    -- close it with the outcome, action and actor the row was closed with, which the first close
    -- recorded on the row's own close event. The caller's outcome is never used for a replay.
    v_replay := true;
    select e.actor_id, e.sanitized_details ->> 'outcome', e.sanitized_details ->> 'resolutionAction'
      into v_actor_id, v_outcome, v_action
      from public.h2a_dry_run_review_events e
      where e.company_id = p_company_id and e.review_id = p_review_id
        and e.event_type in ('cleared', 'no_longer_in_scope') and e.sanitized_details ? 'outcome'
      order by e.created_at desc, e.id desc limit 1;
    if v_actor_id is null or v_outcome is null
      or v_outcome not in ('resolved', 'resolved_by_sync', 'skipped', 'source_missing')
      or (v_outcome = 'resolved' and coalesce(v_action, '') not in ('link_existing', 'create_new'))
      or (v_outcome in ('skipped', 'source_missing') and v_action is distinct from 'skip')
      or (v_outcome = 'resolved_by_sync' and v_action is not null and v_action <> 'link_existing') then
      v_outcome := null;
    end if;
  else
    v_replay := false;
    v_actor_id := p_actor_id;
    v_outcome := p_outcome;
    v_action := p_resolution_action;
  end if;

  if v_outcome is not null then
    v_status := case when v_outcome = 'skipped' or v_outcome = 'source_missing' then 'skipped' else 'resolved' end;
    v_event_type := case when v_status = 'skipped' then 'skipped' else 'resolved' end;
    v_db_action := case when v_outcome = 'resolved_by_sync' then 'link_existing' else v_action end;

    for v_conflict in
      select c.* from public.h2a_conflicts c
        join public.h2a_live_review_conflicts l on l.company_id = c.company_id and l.conflict_id = c.id
        where l.company_id = p_company_id and l.review_id = p_review_id and c.status in ('open', 'resolving')
        order by c.id for update of c
    loop
      update public.h2a_conflicts set status = v_status, resolution_action = v_db_action,
        resolved_by = v_actor_id, resolved_at = v_now, updated_at = v_now
        where company_id = p_company_id and id = v_conflict.id;
      insert into public.h2a_conflict_events (company_id, conflict_id, event_type, actor_id, resolution_action,
        sanitized_details, created_at)
      values (p_company_id, v_conflict.id, v_event_type, v_actor_id, v_db_action,
        pg_catalog.jsonb_build_object('closedByReview', p_review_id, 'outcome', v_outcome, 'lateLink', v_replay,
          'before', pg_catalog.jsonb_build_object('status', v_conflict.status, 'updatedAt', v_conflict.updated_at),
          'after', pg_catalog.jsonb_build_object('status', v_status, 'resolutionAction', v_db_action)), v_now);
      v_closed := v_closed || v_conflict.id;
      if v_outcome in ('resolved', 'resolved_by_sync') then
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
  end if;

  if v_replay then
    -- Every linked conflict and its resumes, as before, plus the ones this replay closed.
    select coalesce(pg_catalog.array_agg(l.conflict_id order by l.conflict_id), '{}') into v_all
      from public.h2a_live_review_conflicts l where l.company_id = p_company_id and l.review_id = p_review_id;
    select coalesce(pg_catalog.array_agg(r.id order by r.id), '{}') into v_resumes
      from public.h2a_conflict_resumes r where r.company_id = p_company_id and r.conflict_id = any (v_all);
    return pg_catalog.jsonb_build_object('closedConflictIds', pg_catalog.to_jsonb(v_all),
      'resumeIds', pg_catalog.to_jsonb(v_resumes), 'replayed', true,
      'lateClosedConflictIds', pg_catalog.to_jsonb(v_closed));
  end if;

  update public.h2a_dry_run_reviews set
    status = case when p_outcome = 'resolved' then 'cleared' else 'no_longer_in_scope' end,
    triage_bucket = 'done',
    recheck_outcome = case when p_outcome = 'source_missing' then 'source_missing' else recheck_outcome end,
    updated_at = v_now
    where company_id = p_company_id and id = p_review_id;
  -- This close event is the durable record a later replay closes late-linked conflicts from.
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

-- One-off, re-runnable triage backfill. Rows captured before triage existed still carry the column
-- defaults ('decision', '{}'). Settled rows are bucketed the way computeTriage does: a cleared row with
-- a safe recheck and no completed resolution is a Quick win (its Albi to-do, when waiting_on_albi, wins),
-- everything else settled is Done. Open (needs_review) rows are left for a recheck or detail load, which
-- compute their triage from live evidence. Only never-bucketed rows match, so a re-run changes nothing,
-- and updated_at is untouched so reviewers' expectedUpdatedAt stays valid.
with pending as (
  select r.company_id, r.id, r.status, r.recheck_outcome,
    (select s.status from public.h2a_dry_run_review_resolutions s
      where s.company_id = r.company_id and s.review_id = r.id
      order by s.created_at desc, s.id desc limit 1) as resolution_status
  from public.h2a_dry_run_reviews r
  where r.status <> 'needs_review'
    and r.triage_bucket = 'decision'
    and r.triage_details = '{}'::jsonb
)
update public.h2a_dry_run_reviews r set
  triage_bucket = case
    when p.status = 'cleared' and p.resolution_status = 'waiting_on_albi' then 'todo'
    when p.status = 'cleared' and p.recheck_outcome in ('safe_to_link', 'safe_to_create')
      and p.resolution_status is distinct from 'completed' then 'quick'
    else 'done' end,
  triage_details = case
    when p.status = 'cleared' and p.recheck_outcome in ('safe_to_link', 'safe_to_create')
      and p.resolution_status is distinct from 'completed' and p.resolution_status is distinct from 'waiting_on_albi'
      then pg_catalog.jsonb_build_object('quickKind', case when p.recheck_outcome = 'safe_to_link' then 'link' else 'create' end)
    else '{}'::jsonb end
  from pending p
  where r.company_id = p.company_id and r.id = p.id;

commit;
