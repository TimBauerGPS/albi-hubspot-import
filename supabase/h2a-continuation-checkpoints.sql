-- Incremental H2A migration: durable run cancellation and dry-run continuation checkpoints.
-- Run once in the shared Supabase project's SQL Editor before deploying the matching app code.
begin;

alter table public.h2a_sync_runs
  add column if not exists cancel_requested_at timestamptz;

alter table public.h2a_sync_runs
  add column if not exists cancel_requested_by uuid references auth.users(id) on delete set null;

create index if not exists h2a_runs_cancel_requested_by_idx
  on public.h2a_sync_runs (cancel_requested_by);

create table if not exists public.h2a_run_checkpoints (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  run_id uuid not null,
  object_type text not null check (object_type in ('meetings', 'calls', 'emails', 'communications', 'notes')),
  upper_bound timestamptz not null,
  page_after text check (page_after is null or length(page_after) <= 2000),
  cursor_timestamp timestamptz,
  cursor_object_id text,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id),
  unique (company_id, run_id, object_type),
  check ((cursor_timestamp is null) = (cursor_object_id is null))
);

alter table public.h2a_run_checkpoints enable row level security;
revoke all on table public.h2a_run_checkpoints from public, anon, authenticated;
revoke all on table public.h2a_run_checkpoints from service_role;
grant select, insert, update on table public.h2a_run_checkpoints to service_role;

commit;
