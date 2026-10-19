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

commit;
