-- Outbox for review actions. Link, create, skip and field actions from the review workspace are queued here and
-- sent to Albi/HubSpot by one background worker per company at a steady pace, backing off when Albi is busy
-- (429). A failed action stays in the outbox with its reason until it is retried or returned to review.
-- Apply after h2a-review-create-batches.sql. Safe to re-run.
begin;

create table if not exists public.h2a_review_outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  review_id uuid not null references public.h2a_dry_run_reviews(id) on delete cascade,
  review_kind text not null check (review_kind in ('sample', 'live')),
  expected_updated_at timestamptz not null,
  client_request_id uuid not null,
  action jsonb not null check (jsonb_typeof(action) = 'object'),
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  error_detail jsonb not null default '{}'::jsonb check (jsonb_typeof(error_detail) = 'object'),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one open action per record; a retry reuses its row.
create unique index if not exists h2a_review_outbox_one_open_idx
  on public.h2a_review_outbox (company_id, review_id) where status in ('queued', 'sending', 'failed');
create index if not exists h2a_review_outbox_due_idx
  on public.h2a_review_outbox (company_id, status, next_attempt_at, created_at, id);
create index if not exists h2a_review_outbox_review_idx on public.h2a_review_outbox (review_id);
create index if not exists h2a_review_outbox_requested_by_idx on public.h2a_review_outbox (requested_by);

-- One worker per company sends at a time.
create table if not exists public.h2a_review_outbox_workers (
  company_id uuid primary key references public.companies(id),
  owner_token uuid not null,
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.h2a_review_outbox enable row level security;
alter table public.h2a_review_outbox_workers enable row level security;
revoke all on table public.h2a_review_outbox from public, anon, authenticated, service_role;
revoke all on table public.h2a_review_outbox_workers from public, anon, authenticated, service_role;
grant select, insert, update on table public.h2a_review_outbox to service_role;
grant select, insert, update, delete on table public.h2a_review_outbox_workers to service_role;

-- Claims (or renews) the company's worker lock; false while another live worker holds it.
create or replace function public.h2a_claim_review_outbox_worker(p_company_id uuid, p_owner_token uuid, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_company_id is null or p_owner_token is null or p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 1800 then
    raise exception 'Invalid outbox worker claim' using errcode = '22023';
  end if;
  insert into public.h2a_review_outbox_workers (company_id, owner_token, heartbeat_at, expires_at)
    values (p_company_id, p_owner_token, v_now, v_now + pg_catalog.make_interval(secs => p_ttl_seconds))
  on conflict (company_id) do update set owner_token = excluded.owner_token, heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
    where public.h2a_review_outbox_workers.owner_token = excluded.owner_token
      or public.h2a_review_outbox_workers.expires_at <= v_now;
  return found;
end;
$$;

-- Hands the worker the next due action, one at a time per company. A send whose lease expired (a worker that
-- stopped mid-send) is queued again: every action is idempotent by its client request id.
create or replace function public.h2a_claim_review_outbox_item(p_company_id uuid, p_lease_seconds integer)
returns setof public.h2a_review_outbox language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_row public.h2a_review_outbox%rowtype;
begin
  if p_company_id is null or p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 900 then
    raise exception 'Invalid outbox claim' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('h2a_review_outbox:' || p_company_id::text, 0));
  update public.h2a_review_outbox set status = 'queued', lease_expires_at = null, updated_at = v_now
    where company_id = p_company_id and status = 'sending' and lease_expires_at <= v_now;
  if exists (select 1 from public.h2a_review_outbox where company_id = p_company_id and status = 'sending') then
    return;
  end if;
  select * into v_row from public.h2a_review_outbox
    where company_id = p_company_id and status = 'queued' and next_attempt_at <= v_now
    order by next_attempt_at, created_at, id limit 1 for update;
  if not found then return; end if;
  update public.h2a_review_outbox set status = 'sending', attempts = attempts + 1,
    lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds), updated_at = v_now
    where id = v_row.id returning * into v_row;
  return next v_row;
end;
$$;

revoke all on function public.h2a_claim_review_outbox_worker(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.h2a_claim_review_outbox_item(uuid, integer) from public, anon, authenticated;
grant execute on function public.h2a_claim_review_outbox_worker(uuid, uuid, integer) to service_role;
grant execute on function public.h2a_claim_review_outbox_item(uuid, integer) to service_role;

-- Records waiting in, or failed in, the outbox have their own review tab.
do $$
declare
  v_constraint text;
begin
  for v_constraint in select conname from pg_catalog.pg_constraint
    where conrelid = 'public.h2a_dry_run_reviews'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%triage_bucket%'
  loop
    execute pg_catalog.format('alter table public.h2a_dry_run_reviews drop constraint %I', v_constraint);
  end loop;
  alter table public.h2a_dry_run_reviews add constraint h2a_dry_run_reviews_triage_bucket_check
    check (triage_bucket in ('quick', 'todo', 'decision', 'blocked', 'done', 'outbox'));
end;
$$;

commit;
