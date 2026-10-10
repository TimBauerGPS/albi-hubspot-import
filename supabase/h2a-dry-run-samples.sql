-- Adds durable server-owned bounds for sample dry runs.
begin;

alter table public.h2a_sync_runs
  add column if not exists sample_limit_per_type smallint;

alter table public.h2a_sync_runs
  drop constraint if exists h2a_sync_runs_sample_limit_per_type_check;

alter table public.h2a_sync_runs
  add constraint h2a_sync_runs_sample_limit_per_type_check
  check (sample_limit_per_type is null or (mode = 'dry_run' and sample_limit_per_type between 1 and 50))
  not valid;

alter table public.h2a_sync_runs
  validate constraint h2a_sync_runs_sample_limit_per_type_check;

commit;
