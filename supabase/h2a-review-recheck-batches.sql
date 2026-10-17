-- "Recheck all" batches for sample review. Each batch rechecks every open review of the current
-- sample against one Albi snapshot from a background function; the browser polls this progress
-- row through an authorized endpoint. At most one queued/running batch exists per company.
-- Apply after h2a-dry-run-review-workflow.sql. Safe to re-run.
begin;

create table if not exists public.h2a_review_recheck_batches (
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

create unique index if not exists h2a_review_recheck_batches_one_active_idx
  on public.h2a_review_recheck_batches (company_id)
  where status in ('queued', 'running');
create index if not exists h2a_review_recheck_batches_latest_idx
  on public.h2a_review_recheck_batches (company_id, created_at desc, id desc);
create index if not exists h2a_review_recheck_batches_requested_by_idx
  on public.h2a_review_recheck_batches (requested_by);

-- Batch progress is available only through authorized server endpoints.
alter table public.h2a_review_recheck_batches enable row level security;
revoke all on table public.h2a_review_recheck_batches from public, anon, authenticated, service_role;
grant select, insert, update on table public.h2a_review_recheck_batches to service_role;

commit;
