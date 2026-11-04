-- Lets a user's nightly Albi-to-HubSpot deal import skip the Google Sheet. 'google_sheet' (the default) keeps the sheet;
-- 'albi_api' now reads Mother Brain (the value predates that move and needs no change). Safe to re-run.
begin;

alter table public.hs_user_config add column if not exists import_source text not null default 'google_sheet';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'hs_user_config_import_source_check') then
    alter table public.hs_user_config add constraint hs_user_config_import_source_check check (import_source in ('google_sheet', 'albi_api'));
  end if;
end $$;

commit;
