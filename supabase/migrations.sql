-- ============================================================
-- HubSpot Deal Importer — Supabase Migration
-- Run in the Supabase SQL Editor for your existing project.
-- DO NOT modify existing Call Analyzer tables.
-- ============================================================

-- hs_user_config
-- Stores per-user HubSpot API key and all user-configurable settings
-- (mirrors the Config tab in the Google Sheet, but sandboxed per user)
CREATE TABLE IF NOT EXISTS hs_user_config (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- HubSpot credentials
  hubspot_api_key   text,                 -- Encrypted at rest via Supabase Vault or pgcrypto
  hubspot_partner_id text,               -- HubSpot portal/partner ID

  -- Config check state
  config_status     text NOT NULL DEFAULT 'unchecked'
                    CHECK (config_status IN ('unchecked', 'valid', 'invalid')),
  config_checked_at timestamptz,
  config_errors     jsonb DEFAULT '[]'::jsonb,

  -- Per-user import rules (equivalent to Config tab columns A/B)
  -- Example: {"WTR": "Water Mitigation", "EMS": "Water Mitigation", "RBL": "Rebuild"}
  pipeline_mapping  jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Suffixes to exclude from import (equivalent to excluded strings in Google Script)
  -- Example: ["WTY", "LTR", "SUB", "BDUP", "LUX"]
  excluded_suffixes jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Sales team (equivalent to Config tab columns C/D)
  -- Example: [{"name": "John Smith", "email": "john@example.com"}]
  sales_team        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Blacklisted job names — never imported regardless of other filters
  -- Mirrors the blacklist_deals sheet in the Google Script reference.
  -- Example: ["GPC-24-WTR999", "GPC-23-FIRE001"]
  blacklist         jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id)
);

-- hs_imports
-- Tracks each CSV import batch
CREATE TABLE IF NOT EXISTS hs_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  total_rows     integer NOT NULL DEFAULT 0,
  created_count  integer NOT NULL DEFAULT 0,
  updated_count  integer NOT NULL DEFAULT 0,
  error_count    integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'complete', 'error'))
);

-- hs_deals
-- Tracks individual deal rows created or updated in HubSpot
CREATE TABLE IF NOT EXISTS hs_deals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  import_id         uuid NOT NULL REFERENCES hs_imports(id) ON DELETE CASCADE,

  -- From Albi CSV
  job_id            text,                -- Albi Name field — upsert key (project_id in HubSpot)
  job_name          text,                -- dealName = Customer + " - " + Name
  job_status        text,                -- Status from Albi
  deal_value        numeric(12, 2),      -- Estimated Revenue
  accrual_revenue   numeric(12, 2),
  close_date        date,
  contact_name      text,               -- Customer field
  company_name      text,

  -- HubSpot result
  hubspot_deal_id   text,               -- Set after create/update
  action_taken      text                -- created | updated | skipped | error
                    CHECK (action_taken IN ('created', 'updated', 'skipped', 'error')),
  error_message     text,
  processed_at      timestamptz DEFAULT now()
);

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE hs_user_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE hs_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE hs_deals ENABLE ROW LEVEL SECURITY;

-- hs_user_config: users see only their own row
DROP POLICY IF EXISTS "hs_user_config: own row" ON hs_user_config;
CREATE POLICY "hs_user_config: own row" ON hs_user_config
  FOR ALL USING (auth.uid() = user_id);

-- hs_imports: users see only their own imports
DROP POLICY IF EXISTS "hs_imports: own rows" ON hs_imports;
CREATE POLICY "hs_imports: own rows" ON hs_imports
  FOR ALL USING (auth.uid() = user_id);

-- hs_deals: users see only their own deal rows
DROP POLICY IF EXISTS "hs_deals: own rows" ON hs_deals;
CREATE POLICY "hs_deals: own rows" ON hs_deals
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- Trigger: keep updated_at current on hs_user_config
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hs_user_config_updated_at ON hs_user_config;

CREATE TRIGGER hs_user_config_updated_at
  BEFORE UPDATE ON hs_user_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- HubSpot local sync cache tables
-- Pulled from HubSpot and stored for fast lookups during import.
-- Never shown to the user — internal use only.
-- Refresh by running hs-sync before each import.
-- ============================================================

-- hs_cached_contacts: contact lookup for deal association
CREATE TABLE IF NOT EXISTS hs_cached_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hubspot_id      text NOT NULL,
  email           text,
  first_name      text,
  last_name       text,
  company_hubspot_id text,           -- Associated company ID from HubSpot
  synced_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, hubspot_id)
);

-- hs_cached_companies: company lookup for deal association
CREATE TABLE IF NOT EXISTS hs_cached_companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hubspot_id      text NOT NULL,
  name            text,
  synced_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, hubspot_id)
);

-- hs_cached_deals: existing deal lookup by project_id (avoids per-row API search calls)
CREATE TABLE IF NOT EXISTS hs_cached_deals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hubspot_id      text NOT NULL,
  project_id      text,              -- Our upsert key
  deal_name       text,
  deal_stage      text,
  pipeline        text,
  total_estimates numeric,           -- Cached for local duplicate detection
  accrual_revenue numeric,           -- Cached for local duplicate detection
  synced_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, hubspot_id)
);

-- ⚠ If hs_cached_deals already exists (table was created before this column was added),
-- run these two ALTER statements manually in the Supabase SQL editor:
ALTER TABLE hs_cached_deals ADD COLUMN IF NOT EXISTS total_estimates numeric;
ALTER TABLE hs_cached_deals ADD COLUMN IF NOT EXISTS accrual_revenue numeric;

-- RLS for cache tables
ALTER TABLE hs_cached_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hs_cached_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hs_cached_deals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hs_cached_contacts: own rows" ON hs_cached_contacts;
CREATE POLICY "hs_cached_contacts: own rows" ON hs_cached_contacts
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "hs_cached_companies: own rows" ON hs_cached_companies;
CREATE POLICY "hs_cached_companies: own rows" ON hs_cached_companies
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "hs_cached_deals: own rows" ON hs_cached_deals;
CREATE POLICY "hs_cached_deals: own rows" ON hs_cached_deals
  FOR ALL USING (auth.uid() = user_id);

-- Indexes for fast lookup during import
CREATE INDEX IF NOT EXISTS idx_cached_contacts_email ON hs_cached_contacts (user_id, email);
CREATE INDEX IF NOT EXISTS idx_cached_companies_name ON hs_cached_companies (user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_cached_deals_project ON hs_cached_deals (user_id, project_id);

-- ============================================================
-- hs_held_deals
-- Deals that could not be imported because their referrer was not found
-- in HubSpot contacts or companies. Re-tried on each import run.
-- Resolved when referrer is found (deal created) or job is blacklisted.
-- ============================================================

CREATE TABLE IF NOT EXISTS hs_held_deals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- From Albi CSV
  job_id            text NOT NULL,           -- Albi Name field (project_id)
  deal_name         text NOT NULL,           -- Customer + " - " + Name
  referrer          text NOT NULL,           -- The unmatched referrer string
  sales_person      text,                    -- Sales Person name from Albi CSV
  pipeline          text,                    -- Albi pipeline label
  dealstage         text,                    -- Albi status label
  estimated_revenue numeric(12, 2) DEFAULT 0,
  accrual_revenue   numeric(12, 2) DEFAULT 0,

  -- Full HubSpot properties snapshot (for re-create when referrer is found)
  properties_json   jsonb DEFAULT '{}'::jsonb,

  -- Lifecycle
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,            -- Set when resolved (deal created or blacklisted)
  resolved_deal_id  text,                   -- HubSpot deal ID if resolved via deal creation

  UNIQUE (user_id, job_id)
);

ALTER TABLE hs_held_deals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hs_held_deals: own rows" ON hs_held_deals;
CREATE POLICY "hs_held_deals: own rows" ON hs_held_deals
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_held_deals_user_unresolved
  ON hs_held_deals (user_id, resolved_at)
  WHERE resolved_at IS NULL;

-- ============================================================
-- Default config row — insert on first config page visit
-- (done client-side via upsert, this is just reference)
-- ============================================================
-- INSERT INTO hs_user_config (user_id, pipeline_mapping, excluded_suffixes)
-- VALUES (auth.uid(), '{"WTR":"Water Mitigation","EMS":"Water Mitigation","FIRE":"Fire Mitigation","CON":"Contents","RBL":"Rebuild"}', '["WTY","LTR","SUB","BDUP","LUX"]')
-- ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- Allied Google Sheet import support
-- ============================================================
ALTER TABLE hs_user_config
  ADD COLUMN IF NOT EXISTS google_sheet_url text;
