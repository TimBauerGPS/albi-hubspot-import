-- Operational one-off: request cancellation of Allied's newest active H2A dry run.
-- Requires supabase/h2a-continuation-checkpoints.sql to have been applied first.
begin;

do $$
declare
  v_company_ids uuid[];
  v_run_ids uuid[];
  v_company_id uuid;
  v_run_id uuid;
  v_updated integer;
begin
  select array_agg(c.id order by c.id)
  into v_company_ids
  from public.companies c
  where c.name in ('Allied Restoration Services', 'Allied Restoration Services Inc');

  if coalesce(cardinality(v_company_ids), 0) <> 1 then
    raise exception 'Expected exactly one Allied company, found %', coalesce(cardinality(v_company_ids), 0);
  end if;
  v_company_id := v_company_ids[1];

  select array_agg(r.id order by r.created_at desc, r.id desc)
  into v_run_ids
  from public.h2a_sync_runs r
  where r.company_id = v_company_id
    and r.mode = 'dry_run'
    and r.status in ('queued', 'running', 'paused');

  if coalesce(cardinality(v_run_ids), 0) <> 1 then
    raise exception 'Expected exactly one active Allied dry run, found %', coalesce(cardinality(v_run_ids), 0);
  end if;
  v_run_id := v_run_ids[1];

  update public.h2a_sync_runs
  set cancel_requested_at = coalesce(cancel_requested_at, now()),
      updated_at = now()
  where company_id = v_company_id
    and id = v_run_id
    and mode = 'dry_run'
    and status in ('queued', 'running', 'paused');
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'Active dry run changed before cancellation could be requested';
  end if;
  raise notice 'Cancellation requested for company % run %', v_company_id, v_run_id;
end;
$$;

commit;
