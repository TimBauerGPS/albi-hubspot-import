-- "Create selected" batches for the review workspace. Each batch creates the selected reviewed records in
-- Albi with one referral source from a background function, reading Albi once; the browser polls this
-- progress row through an authorized endpoint. At most one queued/running batch exists per company.
-- Apply after h2a-live-review-workspace.sql. Safe to re-run.
begin;

create table if not exists public.h2a_review_create_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  review_kind text not null default 'sample' check (review_kind in ('sample', 'live')),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 50),
  referral_source_id text not null check (referral_source_id ~ '^[1-9][0-9]{0,99}$'),
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  total integer not null default 0 check (total >= 0),
  done integer not null default 0 check (done >= 0),
  created integer not null default 0 check (created >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  failed integer not null default 0 check (failed >= 0),
  error_code text check (error_code in ('timeout', 'expired', 'dispatch_failed', 'operation_failed')),
  results jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array' and jsonb_array_length(results) <= 50),
  heartbeat_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

-- Per-record outcomes and skip reasons (added after the first release of this file).
alter table public.h2a_review_create_batches
  add column if not exists results jsonb not null default '[]'::jsonb
  check (jsonb_typeof(results) = 'array' and jsonb_array_length(results) <= 50);

create unique index if not exists h2a_review_create_batches_one_active_idx
  on public.h2a_review_create_batches (company_id)
  where status in ('queued', 'running');
create index if not exists h2a_review_create_batches_latest_idx
  on public.h2a_review_create_batches (company_id, review_kind, created_at desc, id desc);
create index if not exists h2a_review_create_batches_requested_by_idx
  on public.h2a_review_create_batches (requested_by);

-- Batch progress is available only through authorized server endpoints.
alter table public.h2a_review_create_batches enable row level security;
revoke all on table public.h2a_review_create_batches from public, anon, authenticated, service_role;
grant select, insert, update on table public.h2a_review_create_batches to service_role;

commit;
