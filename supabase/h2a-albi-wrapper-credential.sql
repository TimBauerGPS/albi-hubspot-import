-- The Guardian Albi wrapper key, used only to read activities for the delivery duplicate check while the Albi Public
-- API key lacks Permissions.Activities.View. Same rules as private.h2a_credentials: ciphertext envelopes only;
-- encryption and company authorization occur in Netlify. Safe to re-run.
begin;

create table if not exists private.h2a_albi_wrapper_credentials (
  company_id uuid primary key references public.companies(id) on delete cascade,
  ciphertext text not null check (length(btrim(ciphertext)) > 0),
  iv text not null check (length(btrim(iv)) > 0),
  tag text not null check (length(btrim(tag)) > 0),
  key_version integer not null check (key_version > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table private.h2a_albi_wrapper_credentials enable row level security;
revoke all on table private.h2a_albi_wrapper_credentials from public, anon, authenticated, service_role;

create or replace function public.h2a_get_albi_wrapper_credential(p_company_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('ciphertext', c.ciphertext, 'iv', c.iv, 'tag', c.tag, 'key_version', c.key_version)
  from private.h2a_albi_wrapper_credentials c where c.company_id = p_company_id;
$$;
revoke execute on function public.h2a_get_albi_wrapper_credential(uuid) from public, anon, authenticated;
grant execute on function public.h2a_get_albi_wrapper_credential(uuid) to service_role;

create or replace function public.h2a_put_albi_wrapper_credential(p_company_id uuid, p_envelope jsonb, p_updated_by uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_company_id is null or p_updated_by is null or p_envelope is null or pg_catalog.jsonb_typeof(p_envelope) <> 'object' then
    raise exception 'Company, actor, and encrypted credential envelope are required' using errcode = '22023';
  end if;
  insert into private.h2a_albi_wrapper_credentials (company_id, ciphertext, iv, tag, key_version, updated_by)
  values (p_company_id, p_envelope->>'ciphertext', p_envelope->>'iv', p_envelope->>'tag', (p_envelope->>'key_version')::integer, p_updated_by)
  on conflict (company_id) do update set ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
    key_version = excluded.key_version, updated_by = excluded.updated_by, updated_at = pg_catalog.clock_timestamp();
end;
$$;
revoke execute on function public.h2a_put_albi_wrapper_credential(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.h2a_put_albi_wrapper_credential(uuid, jsonb, uuid) to service_role;

commit;
