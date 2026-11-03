-- A per-company copy of Albi's contacts and organizations, kept current with Albi's changedSince filter so a read
-- of "every Albi contact" costs one or two Albi requests instead of a walk of the whole list. Albi reports no
-- deletes, so the copy is rebuilt from a full walk once a day (h2a_albi_mirror_state.full_at).
-- Server-side only (service role). Safe to re-run. The functions fall back to reading Albi directly until it is applied.
begin;

create table if not exists public.h2a_albi_mirror (
  company_id uuid not null references public.companies(id) on delete cascade,
  object_type text not null check (object_type in ('contacts', 'organizations')),
  albi_id text not null check (albi_id ~ '^[1-9][0-9]{0,99}$'),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  seen_at timestamptz not null default now(),
  primary key (company_id, object_type, albi_id)
);

create table if not exists public.h2a_albi_mirror_state (
  company_id uuid not null references public.companies(id) on delete cascade,
  object_type text not null check (object_type in ('contacts', 'organizations')),
  -- When the last complete walk started (records not seen by it were removed) and when the last read started.
  full_at timestamptz,
  synced_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (company_id, object_type)
);

alter table public.h2a_albi_mirror enable row level security;
alter table public.h2a_albi_mirror_state enable row level security;
revoke all on public.h2a_albi_mirror from public, anon, authenticated;
revoke all on public.h2a_albi_mirror_state from public, anon, authenticated;
grant select, insert, update, delete on public.h2a_albi_mirror to service_role;
grant select, insert, update, delete on public.h2a_albi_mirror_state to service_role;

commit;
