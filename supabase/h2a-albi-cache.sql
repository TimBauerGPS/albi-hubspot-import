-- Small Albi reads worth keeping between functions: the company a key belongs to and Albi's option lists (relationship
-- types, statuses, referral sources, activity types, salespeople). Rows are tied to a fingerprint of the Albi key, so a
-- new key starts clean; the connection check clears them too. No secrets are stored.
-- Server-side only (service role). Safe to re-run. Functions read Albi directly until this is applied.
begin;

create table if not exists public.h2a_albi_cache (
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0 and length(name) <= 100),
  key_fingerprint text not null check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  value jsonb not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (company_id, name)
);

alter table public.h2a_albi_cache enable row level security;
revoke all on public.h2a_albi_cache from public, anon, authenticated;
grant select, insert, update, delete on public.h2a_albi_cache to service_role;

commit;
