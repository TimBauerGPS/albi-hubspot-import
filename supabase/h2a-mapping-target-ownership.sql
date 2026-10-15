-- Tenant-wide target ownership; eight-argument callers retain a safe false default.

-- All mapping writers share source-then-target transaction advisory locks.

begin;

alter table public.h2a_contact_mappings add column if not exists approved_many_to_one boolean not null default false;
alter table public.h2a_organization_mappings add column if not exists approved_many_to_one boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'h2a_contact_many_to_one_reviewed_check'
    and conrelid = 'public.h2a_contact_mappings'::pg_catalog.regclass) then
    alter table public.h2a_contact_mappings add constraint h2a_contact_many_to_one_reviewed_check
      check (not approved_many_to_one or match_method = 'reviewed');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'h2a_organization_many_to_one_reviewed_check'
    and conrelid = 'public.h2a_organization_mappings'::pg_catalog.regclass) then
    alter table public.h2a_organization_mappings add constraint h2a_organization_many_to_one_reviewed_check
      check (not approved_many_to_one or match_method = 'reviewed');
  end if;
end;
$$;

drop function if exists public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz);
drop function if exists public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz, boolean);
drop function if exists public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz, boolean, uuid);
drop function if exists public.h2a_save_mapping_unfenced(uuid, text, text, text, text, text, uuid, timestamptz, boolean);

create or replace function public.h2a_save_mapping(
  p_company_id uuid, p_portal_id text, p_object_type text, p_source_id text,
  p_target_id text, p_match_method text, p_reviewed_by uuid, p_now timestamptz,
  p_approve_many_to_one boolean default false, p_force_resolution_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_contact public.h2a_contact_mappings%rowtype;
  v_organization public.h2a_organization_mappings%rowtype;
  v_peer_count bigint;
  v_unapproved_count bigint;
  v_force_reservation uuid;
begin
  if p_company_id is null or nullif(pg_catalog.btrim(p_portal_id), '') is null
    or p_object_type is null or p_object_type not in ('contacts', 'companies')
    or nullif(pg_catalog.btrim(p_source_id), '') is null
    or nullif(pg_catalog.btrim(p_target_id), '') is null
    or p_match_method is null or p_match_method not in ('automatic', 'created', 'reviewed') or p_now is null
    or p_approve_many_to_one is null or (p_approve_many_to_one and p_match_method <> 'reviewed')
    or (p_match_method = 'reviewed' and p_reviewed_by is null)
    or (p_match_method <> 'reviewed' and p_reviewed_by is not null) then
    return pg_catalog.jsonb_build_object('error', 'invalid_mapping');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(p_company_id::text, p_portal_id, 'source', p_object_type, p_source_id)::text, 0));
  if pg_catalog.to_regclass('public.h2a_dry_run_review_resolutions') is not null then
    execute 'select r.id from public.h2a_dry_run_review_resolutions r
      where r.company_id = $1 and r.portal_id = $2 and r.object_type = $3 and r.source_id = $4
        and r.action = ''force_create_albi'' and r.status in (''pending'', ''applying'')
      order by r.created_at desc, r.id desc limit 1'
      into v_force_reservation using p_company_id, p_portal_id, p_object_type, p_source_id;
    if v_force_reservation is not null and p_force_resolution_id is distinct from v_force_reservation then
      return pg_catalog.jsonb_build_object('error', 'mapping_reserved');
    end if;
    if p_force_resolution_id is not null and
      (v_force_reservation is null or v_force_reservation <> p_force_resolution_id) then
      return pg_catalog.jsonb_build_object('error', 'invalid_mapping');
    end if;
  elsif p_force_resolution_id is not null then
    return pg_catalog.jsonb_build_object('error', 'invalid_mapping');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(p_company_id::text, 'target', p_object_type, p_target_id)::text, 0));

  if p_object_type = 'contacts' then
    select * into v_contact from public.h2a_contact_mappings m
      where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id;
    if found then
      if v_contact.albi_contact_id <> p_target_id then
        return pg_catalog.jsonb_build_object('error', 'mapping_conflict');
      end if;
      -- Only a new explicit reviewed approval upgrades a same-target row.
      if p_approve_many_to_one and not v_contact.approved_many_to_one then
        update public.h2a_contact_mappings set match_method = 'reviewed', approved_many_to_one = true,
          reviewed_by = p_reviewed_by, reviewed_at = p_now, updated_at = p_now
          where company_id = p_company_id and portal_id = p_portal_id and hubspot_id = p_source_id
            and albi_contact_id = p_target_id returning * into v_contact;
      end if;
      return pg_catalog.to_jsonb(v_contact);
    end if;
    select count(*), count(*) filter (where not m.approved_many_to_one)
      into v_peer_count, v_unapproved_count from public.h2a_contact_mappings m where m.company_id = p_company_id
      and m.albi_contact_id = p_target_id
      and (m.portal_id <> p_portal_id or m.hubspot_id <> p_source_id);
    if v_peer_count > 0 and not p_approve_many_to_one then
      return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
    end if;
    -- A reviewed share includes its sole original owner. Never silently approve
    -- an already-ambiguous group with multiple unreviewed source identities.
    if v_unapproved_count > 0 and v_peer_count <> 1 then
      return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
    end if;
    if v_peer_count = 1 and v_unapproved_count = 1 then
      update public.h2a_contact_mappings set match_method = 'reviewed', approved_many_to_one = true,
        reviewed_by = p_reviewed_by, reviewed_at = p_now, updated_at = p_now
        where company_id = p_company_id and albi_contact_id = p_target_id
          and (portal_id <> p_portal_id or hubspot_id <> p_source_id) and not approved_many_to_one;
    end if;
    insert into public.h2a_contact_mappings (company_id, portal_id, hubspot_id, albi_contact_id,
      match_method, approved_many_to_one, reviewed_by, reviewed_at, updated_at)
    values (p_company_id, p_portal_id, p_source_id, p_target_id, p_match_method, p_approve_many_to_one, p_reviewed_by,
      case when p_match_method = 'reviewed' then p_now else null end, p_now)
    on conflict (company_id, portal_id, hubspot_id) do nothing returning * into v_contact;
    if not found then
      select * into v_contact from public.h2a_contact_mappings m
        where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id;
      if not found or v_contact.albi_contact_id <> p_target_id then
        return pg_catalog.jsonb_build_object('error', 'mapping_conflict');
      end if;
    end if;
    return pg_catalog.to_jsonb(v_contact);
  end if;

  select * into v_organization from public.h2a_organization_mappings m
    where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id;
  if found then
    if v_organization.albi_organization_id <> p_target_id then
      return pg_catalog.jsonb_build_object('error', 'mapping_conflict');
    end if;
    if p_approve_many_to_one and not v_organization.approved_many_to_one then
      update public.h2a_organization_mappings set match_method = 'reviewed', approved_many_to_one = true,
        reviewed_by = p_reviewed_by, reviewed_at = p_now, updated_at = p_now
        where company_id = p_company_id and portal_id = p_portal_id and hubspot_id = p_source_id
          and albi_organization_id = p_target_id returning * into v_organization;
    end if;
    return pg_catalog.to_jsonb(v_organization);
  end if;
  select count(*), count(*) filter (where not m.approved_many_to_one)
    into v_peer_count, v_unapproved_count from public.h2a_organization_mappings m where m.company_id = p_company_id
    and m.albi_organization_id = p_target_id
    and (m.portal_id <> p_portal_id or m.hubspot_id <> p_source_id);
  if v_peer_count > 0 and not p_approve_many_to_one then
    return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
  end if;
  if v_unapproved_count > 0 and v_peer_count <> 1 then
    return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
  end if;
  if v_peer_count = 1 and v_unapproved_count = 1 then
    update public.h2a_organization_mappings set match_method = 'reviewed', approved_many_to_one = true,
      reviewed_by = p_reviewed_by, reviewed_at = p_now, updated_at = p_now
      where company_id = p_company_id and albi_organization_id = p_target_id
        and (portal_id <> p_portal_id or hubspot_id <> p_source_id) and not approved_many_to_one;
  end if;
  insert into public.h2a_organization_mappings (company_id, portal_id, hubspot_id, albi_organization_id,
    match_method, approved_many_to_one, reviewed_by, reviewed_at, updated_at)
  values (p_company_id, p_portal_id, p_source_id, p_target_id, p_match_method, p_approve_many_to_one, p_reviewed_by,
    case when p_match_method = 'reviewed' then p_now else null end, p_now)
  on conflict (company_id, portal_id, hubspot_id) do nothing returning * into v_organization;
  if not found then
    select * into v_organization from public.h2a_organization_mappings m
      where m.company_id = p_company_id and m.portal_id = p_portal_id and m.hubspot_id = p_source_id;
    if not found or v_organization.albi_organization_id <> p_target_id then
      return pg_catalog.jsonb_build_object('error', 'mapping_conflict');
    end if;
  end if;
  return pg_catalog.to_jsonb(v_organization);
end;
$$;
revoke execute on function public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz, boolean, uuid) from public, anon, authenticated;
grant execute on function public.h2a_save_mapping(uuid, text, text, text, text, text, uuid, timestamptz, boolean, uuid) to service_role;

create or replace function public.h2a_resolve_conflict(
  p_company_id uuid, p_conflict_id uuid, p_expected_updated_at timestamptz, p_actor_id uuid,
  p_api_action text, p_db_action text, p_request jsonb, p_now timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_conflict public.h2a_conflicts%rowtype;
  v_before jsonb;
  v_source_snapshot jsonb;
  v_candidate_snapshots jsonb;
  v_proposed_fields jsonb;
  v_event public.h2a_conflict_events%rowtype;
  v_resume public.h2a_conflict_resumes%rowtype;
  v_expected_db_action text;
  v_target_id text;
  v_many_to_one boolean;
  v_peer_count bigint;
  v_unapproved_count bigint;
  v_force_reserved boolean := false;
  v_field text;
begin
  v_expected_db_action := case p_api_action
    when 'link_existing' then 'link_existing'
    when 'create_new' then 'create_new'
    when 'approve_fields' then 'approve_hubspot'
    when 'retain_albi' then 'retain_albi'
    when 'skip_item' then 'skip'
    else null end;
  if p_company_id is null or p_conflict_id is null or p_expected_updated_at is null or p_actor_id is null
    or p_now is null or v_expected_db_action is null or p_db_action is distinct from v_expected_db_action
    or coalesce(pg_catalog.jsonb_typeof(p_request), '') <> 'object'
    or exists (select 1 from pg_catalog.jsonb_object_keys(p_request) as request_key(value)
      where request_key.value not in ('targetId', 'selectedFields', 'approveManyToOne'))
    or coalesce(pg_catalog.jsonb_typeof(p_request->'selectedFields'), '') <> 'array'
    or coalesce(pg_catalog.jsonb_typeof(p_request->'approveManyToOne'), '') <> 'boolean' then
    return pg_catalog.jsonb_build_object('error', 'invalid_action');
  end if;
  v_target_id := nullif(pg_catalog.btrim(p_request->>'targetId'), '');
  v_many_to_one := (p_request->>'approveManyToOne')::boolean;
  if (p_api_action = 'link_existing' and (v_target_id is null or pg_catalog.jsonb_array_length(p_request->'selectedFields') <> 0))
    or (p_api_action <> 'link_existing' and (v_target_id is not null or v_many_to_one))
    or (p_api_action not in ('approve_fields', 'retain_albi') and pg_catalog.jsonb_array_length(p_request->'selectedFields') <> 0)
    or (p_api_action in ('approve_fields', 'retain_albi') and pg_catalog.jsonb_array_length(p_request->'selectedFields') = 0) then
    return pg_catalog.jsonb_build_object('error', 'invalid_action');
  end if;

  select * into v_conflict from public.h2a_conflicts
    where company_id = p_company_id and id = p_conflict_id for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;

  if v_conflict.status <> 'open' then
    select * into v_event from public.h2a_conflict_events e
      where e.company_id = p_company_id and e.conflict_id = p_conflict_id
        and e.actor_id = p_actor_id and e.resolution_action = p_db_action
        and e.sanitized_details->>'apiAction' = p_api_action
        and e.sanitized_details->'resolutionRequest' = p_request
      order by e.created_at desc, e.id desc limit 1;
    if found then
      select * into v_resume from public.h2a_conflict_resumes r
        where r.company_id = p_company_id and r.conflict_id = p_conflict_id;
      return pg_catalog.jsonb_build_object('conflict', pg_catalog.to_jsonb(v_conflict),
        'event', pg_catalog.to_jsonb(v_event), 'resume', case when v_resume.id is null then null else pg_catalog.to_jsonb(v_resume) end,
        'replayed', true);
    end if;
    return pg_catalog.jsonb_build_object('error', 'not_open');
  end if;
  if v_conflict.updated_at <> p_expected_updated_at then return pg_catalog.jsonb_build_object('error', 'stale'); end if;

  if p_api_action in ('link_existing', 'create_new') and v_conflict.object_type not in ('contacts', 'companies') then
    return pg_catalog.jsonb_build_object('error', 'invalid_conflict_type');
  end if;
  if p_api_action in ('approve_fields', 'retain_albi') then
    if v_conflict.object_type not in ('contacts', 'companies') then
      return pg_catalog.jsonb_build_object('error', 'invalid_conflict_type');
    end if;
    for v_field in select pg_catalog.jsonb_array_elements_text(p_request->'selectedFields') loop
      if v_field not in ('firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
        'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country')
        or not (coalesce(v_conflict.proposed_changes->'updates', '{}'::jsonb) ? v_field
          or coalesce(v_conflict.proposed_changes->'conflicts', '{}'::jsonb) ? v_field) then
        return pg_catalog.jsonb_build_object('error', 'invalid_action');
      end if;
    end loop;
  end if;

  if p_api_action = 'link_existing' then
    -- Serialize resolutions for this tenant-scoped source identity before taking
    -- any target lock. Every link_existing path uses source-then-target ordering.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_company_id::text, v_conflict.portal_id, 'source',
        v_conflict.object_type, v_conflict.source_id)::text, 0));
    if pg_catalog.to_regclass('public.h2a_dry_run_review_resolutions') is not null then
      execute 'select exists (select 1 from public.h2a_dry_run_review_resolutions r
        where r.company_id = $1 and r.portal_id = $2 and r.object_type = $3 and r.source_id = $4
          and r.action = ''force_create_albi'' and r.status in (''pending'', ''applying''))'
        into v_force_reserved using p_company_id, v_conflict.portal_id, v_conflict.object_type, v_conflict.source_id;
      if v_force_reserved then return pg_catalog.jsonb_build_object('error', 'mapping_conflict'); end if;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(p_company_id::text, 'target', v_conflict.object_type, v_target_id)::text, 0));
    if v_conflict.object_type = 'contacts' then
      if exists (select 1 from public.h2a_contact_mappings m where m.company_id = p_company_id
        and m.portal_id = v_conflict.portal_id and m.hubspot_id = v_conflict.source_id and m.albi_contact_id <> v_target_id)
        then return pg_catalog.jsonb_build_object('error', 'mapping_conflict'); end if;
      select count(*), count(*) filter (where not m.approved_many_to_one)
        into v_peer_count, v_unapproved_count from public.h2a_contact_mappings m where m.company_id = p_company_id
          and m.albi_contact_id = v_target_id and (m.portal_id <> v_conflict.portal_id or m.hubspot_id <> v_conflict.source_id);
      if v_peer_count > 0 and not v_many_to_one then
        return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
      end if;
      if v_unapproved_count > 0 and v_peer_count <> 1 then
        return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
      end if;
      if v_peer_count = 1 and v_unapproved_count = 1 then
        update public.h2a_contact_mappings set match_method = 'reviewed', approved_many_to_one = true,
          reviewed_by = p_actor_id, reviewed_at = p_now, updated_at = p_now
          where company_id = p_company_id and albi_contact_id = v_target_id
            and (portal_id <> v_conflict.portal_id or hubspot_id <> v_conflict.source_id) and not approved_many_to_one;
      end if;
      update public.h2a_contact_mappings set match_method = 'reviewed', approved_many_to_one = approved_many_to_one or v_many_to_one, reviewed_by = p_actor_id,
        reviewed_at = p_now, updated_at = p_now
        where company_id = p_company_id and portal_id = v_conflict.portal_id
          and hubspot_id = v_conflict.source_id and albi_contact_id = v_target_id;
      if not found then
        insert into public.h2a_contact_mappings (company_id, portal_id, hubspot_id, albi_contact_id,
          match_method, approved_many_to_one, reviewed_by, reviewed_at, updated_at)
        values (p_company_id, v_conflict.portal_id, v_conflict.source_id, v_target_id, 'reviewed', v_many_to_one, p_actor_id, p_now, p_now)
        on conflict (company_id, portal_id, hubspot_id) do nothing;
      end if;
    else
      if exists (select 1 from public.h2a_organization_mappings m where m.company_id = p_company_id
        and m.portal_id = v_conflict.portal_id and m.hubspot_id = v_conflict.source_id and m.albi_organization_id <> v_target_id)
        then return pg_catalog.jsonb_build_object('error', 'mapping_conflict'); end if;
      select count(*), count(*) filter (where not m.approved_many_to_one)
        into v_peer_count, v_unapproved_count from public.h2a_organization_mappings m where m.company_id = p_company_id
          and m.albi_organization_id = v_target_id and (m.portal_id <> v_conflict.portal_id or m.hubspot_id <> v_conflict.source_id);
      if v_peer_count > 0 and not v_many_to_one then
        return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
      end if;
      if v_unapproved_count > 0 and v_peer_count <> 1 then
        return pg_catalog.jsonb_build_object('error', 'many_to_one_required');
      end if;
      if v_peer_count = 1 and v_unapproved_count = 1 then
        update public.h2a_organization_mappings set match_method = 'reviewed', approved_many_to_one = true,
          reviewed_by = p_actor_id, reviewed_at = p_now, updated_at = p_now
          where company_id = p_company_id and albi_organization_id = v_target_id
            and (portal_id <> v_conflict.portal_id or hubspot_id <> v_conflict.source_id) and not approved_many_to_one;
      end if;
      update public.h2a_organization_mappings set match_method = 'reviewed', approved_many_to_one = approved_many_to_one or v_many_to_one, reviewed_by = p_actor_id,
        reviewed_at = p_now, updated_at = p_now
        where company_id = p_company_id and portal_id = v_conflict.portal_id
          and hubspot_id = v_conflict.source_id and albi_organization_id = v_target_id;
      if not found then
        insert into public.h2a_organization_mappings (company_id, portal_id, hubspot_id, albi_organization_id,
          match_method, approved_many_to_one, reviewed_by, reviewed_at, updated_at)
        values (p_company_id, v_conflict.portal_id, v_conflict.source_id, v_target_id, 'reviewed', v_many_to_one, p_actor_id, p_now, p_now)
        on conflict (company_id, portal_id, hubspot_id) do nothing;
      end if;
    end if;
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(source_field.key, source_field.value), '{}'::jsonb)
    into v_source_snapshot
    from pg_catalog.jsonb_each(coalesce(v_conflict.source_snapshot, '{}'::jsonb)) as source_field(key, value)
    where source_field.key in ('id', 'firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
      'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country')
      and pg_catalog.jsonb_typeof(source_field.value) in ('string', 'number', 'boolean');
  select coalesce(pg_catalog.jsonb_agg(candidate.safe_snapshot), '[]'::jsonb)
    into v_candidate_snapshots
    from (
      select (select coalesce(pg_catalog.jsonb_object_agg(candidate_field.key, candidate_field.value), '{}'::jsonb)
        from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(candidate.value) = 'object'
          then candidate.value else '{}'::jsonb end) as candidate_field(key, value)
        where candidate_field.key in ('id', 'firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
          'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country')
          and pg_catalog.jsonb_typeof(candidate_field.value) in ('string', 'number', 'boolean')) as safe_snapshot
      from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(v_conflict.candidate_snapshots) = 'array'
        then v_conflict.candidate_snapshots else '[]'::jsonb end) as candidate(value)
      limit 10
    ) candidate;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(field_name) order by field_name), '[]'::jsonb)
    into v_proposed_fields from (
      select key as field_name from pg_catalog.jsonb_object_keys(coalesce(v_conflict.proposed_changes->'updates', '{}'::jsonb)) as update_field(key)
      union
      select key as field_name from pg_catalog.jsonb_object_keys(coalesce(v_conflict.proposed_changes->'conflicts', '{}'::jsonb)) as conflict_field(key)
    ) proposed where field_name in ('firstname', 'lastname', 'firstName', 'lastName', 'name', 'email', 'phone',
      'phoneNumber', 'mobilephone', 'mobileNumber', 'domain', 'address', 'address1', 'city', 'state', 'zip', 'zipcode', 'country');
  v_before := pg_catalog.jsonb_build_object('status', v_conflict.status, 'updatedAt', v_conflict.updated_at,
    'sourceSnapshot', v_source_snapshot, 'candidateSnapshots', v_candidate_snapshots, 'proposedFieldNames', v_proposed_fields);
  update public.h2a_conflicts set status = case when p_api_action = 'skip_item' then 'skipped' else 'resolved' end,
    resolved_by = p_actor_id, resolution_action = p_db_action, resolved_at = p_now, updated_at = p_now
    where company_id = p_company_id and id = p_conflict_id and status = 'open'
      and updated_at = p_expected_updated_at returning * into v_conflict;
  if not found then return pg_catalog.jsonb_build_object('error', 'stale'); end if;

  insert into public.h2a_conflict_events (company_id, conflict_id, event_type, actor_id, resolution_action, sanitized_details, created_at)
  values (p_company_id, p_conflict_id, case when p_api_action = 'skip_item' then 'skipped' else 'resolved' end,
    p_actor_id, p_db_action, pg_catalog.jsonb_build_object('apiAction', p_api_action, 'dbAction', p_db_action,
      'resolutionRequest', p_request, 'selectedFields', p_request->'selectedFields',
      'approveManyToOne', v_many_to_one, 'before', v_before,
      'after', pg_catalog.jsonb_build_object('status', v_conflict.status, 'updatedAt', v_conflict.updated_at,
        'resolvedBy', p_actor_id, 'resolutionAction', p_db_action,
        'targetId', v_target_id, 'selectedFields', p_request->'selectedFields')), p_now)
  returning * into v_event;

  if p_api_action in ('link_existing', 'create_new') then
    insert into public.h2a_conflict_resumes (company_id, conflict_id, resolution_action, source_object_type, source_id,
      activity_object_type, activity_id, originating_run_id, activity_delivery_id, created_at, updated_at)
    values (p_company_id, p_conflict_id, p_api_action, v_conflict.object_type, v_conflict.source_id,
      v_conflict.activity_object_type, v_conflict.activity_id, v_conflict.run_id, v_conflict.activity_delivery_id, p_now, p_now)
    on conflict (company_id, conflict_id) do nothing;
    select * into v_resume from public.h2a_conflict_resumes r
      where r.company_id = p_company_id and r.conflict_id = p_conflict_id;
  end if;

  return pg_catalog.jsonb_build_object('conflict', pg_catalog.to_jsonb(v_conflict), 'event', pg_catalog.to_jsonb(v_event),
    'resume', case when v_resume.id is null then null else pg_catalog.to_jsonb(v_resume) end, 'replayed', false);
end;
$$;
revoke execute on function public.h2a_resolve_conflict(uuid, uuid, timestamptz, uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.h2a_resolve_conflict(uuid, uuid, timestamptz, uuid, text, text, jsonb, timestamptz) to service_role;

commit;
