-- ============================================================
-- HubSpot Importer — Multi-tenant migration
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor)
-- ============================================================

-- STEP 1: Add company_id to the 4 app tables that exist.
-- The companies table already exists in the shared Supabase project.

ALTER TABLE hs_user_config ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
ALTER TABLE hs_imports      ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
ALTER TABLE hs_deals        ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
ALTER TABLE hs_held_deals   ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);


-- STEP 2: Backfill your own company_id
-- First, find your user_id from the Supabase Auth dashboard (Authentication → Users).
-- Then run the following — fill in YOUR_USER_ID and YOUR_COMPANY_NAME:

/*
DO $$
DECLARE
  my_user_id uuid := 'YOUR_USER_ID';     -- <-- replace
  my_company_name text := 'YOUR_COMPANY_NAME';  -- <-- replace (e.g. 'Allied Restoration')
  new_company_id uuid;
BEGIN
  -- Create a companies row if it doesn't exist yet
  INSERT INTO companies (name) VALUES (my_company_name)
  ON CONFLICT DO NOTHING;

  SELECT id INTO new_company_id FROM companies WHERE name = my_company_name LIMIT 1;

  -- Insert yourself into company_members as admin
  INSERT INTO company_members (company_id, user_id, role)
  VALUES (new_company_id, my_user_id, 'admin')
  ON CONFLICT (company_id, user_id) DO NOTHING;

  -- Insert yourself into super_admins
  INSERT INTO super_admins (user_id)
  VALUES (my_user_id)
  ON CONFLICT DO NOTHING;

  -- Backfill company_id on your existing hs_user_config row
  UPDATE hs_user_config SET company_id = new_company_id WHERE user_id = my_user_id;

  -- Backfill company_id on your existing import history
  UPDATE hs_imports    SET company_id = new_company_id WHERE user_id = my_user_id;
  UPDATE hs_deals      SET company_id = new_company_id WHERE user_id = my_user_id;
  UPDATE hs_held_deals SET company_id = new_company_id WHERE user_id = my_user_id;
END $$;
*/


-- STEP 3: Update RLS policies for company-level isolation
-- The pattern: allow access when company_id matches get_my_company_id(),
-- OR fall back to user_id match for rows that haven't been migrated yet.
--
-- Example for hs_user_config (repeat for each table as needed).
-- First drop the old policy, then create the new one.

/*
-- hs_user_config
DROP POLICY IF EXISTS "Users can only access their own config" ON hs_user_config;
CREATE POLICY "company_isolated_access" ON hs_user_config
  USING (
    (company_id IS NOT NULL AND company_id = get_my_company_id())
    OR (company_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (company_id IS NOT NULL AND company_id = get_my_company_id())
    OR (company_id IS NULL AND user_id = auth.uid())
  );

-- Repeat the same pattern for: hs_imports, hs_deals, hs_held_deals
*/


-- STEP 4 (Optional — do AFTER verifying migration works):
-- Drop the old columns from hs_user_config that are no longer used.

/*
ALTER TABLE hs_user_config DROP COLUMN IF EXISTS is_admin;
ALTER TABLE hs_user_config DROP COLUMN IF EXISTS company_name;
*/

-- Allied Google Sheet import support
ALTER TABLE hs_user_config
  ADD COLUMN IF NOT EXISTS google_sheet_url text;
