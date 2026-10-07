# HubSpot-to-Albi Relationship and Activity Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-isolated, resumable HubSpot-to-Albi relationship and activity sync with safe matching, guided configuration, selectable backfill dates, conflict review, and operational visibility.

**Architecture:** Build an isolated `h2a` module inside the existing React/Netlify/Supabase application. Netlify functions own authorization, credential encryption, API access, and orchestration; Supabase stores tenant configuration, checkpoints, mappings, deliveries, runs, and conflicts; React provides Settings, Overview, and Conflicts routes. Each company runs independently in short durable batches so Netlify execution limits and partial external failures never require restarting an entire run.

**Tech Stack:** React 18, React Router 6, Vite 5, Netlify Functions and Background Functions, Node.js ESM and `node:test`, Supabase/Postgres with RLS, HubSpot date-versioned CRM APIs, Albi v5 Integrations API, Resend.

**Spec:** `2026-10-02-hubspot-to-albi-sync-design.md`

## Global Constraints

- Preserve the existing Albi-to-HubSpot deal workflow without behavioral changes.
- All new database objects use the `h2a_` prefix; internal JavaScript lives under `netlify/functions/_h2a/`.
- Company ownership is mandatory on every operational row; service-role queries must still include `company_id`.
- Only company admins and super admins may change configuration, run syncs, or resolve conflicts; members are read-only.
- Credentials never enter browser-readable tables and are encrypted with AES-256-GCM using versioned Netlify environment keys.
- Use direct CRM email engagements only; exclude bulk marketing campaign sends, attachments, and full email threads.
- Do not propagate later HubSpot edits or deletions after an activity delivery succeeds.
- Use one cursor per company and HubSpot activity object type; use separate checkpointed backfill windows.
- Use America/Los_Angeles for selected start dates and once-per-local-day scheduling.
- Never automatically overwrite a different nonblank Albi value or infer a many-to-one identity mapping.
- Prefer a native Albi external identifier; otherwise use and reconcile a visible `Source: HubSpot <type> <id>` footer.
- Do not add production dependencies for core domain tests; use the built-in Node test runner.
- Pin any newly installed package version exactly and commit `package-lock.json`.
- Verify current official HubSpot, Albi, Supabase, and Netlify contracts again at implementation time.

## Review Focus

- Two manual or scheduled invocations race for the same company: exactly one lease holder proceeds and the other returns `already_running`.
- A worker stops after Albi accepted a write but before Supabase recorded it: retry reconciles the native external ID or source footer and records success without duplication.
- A direct email has several associated contacts, including one ambiguous match: safe contacts receive one delivery each while only the ambiguous target enters review.
- A super admin supplies another company's ID and a company admin tampers with it: the super admin may select it, while the company admin receives `403`.
- A backfill spans a DST transition or exceeds one invocation: date windows remain Pacific-calendar correct and resume without gaps or cursor rewind.

---

### Task 1: Test Harness and Domain Contracts

**Files:**
- Modify: `package.json`
- Create: `netlify/functions/_h2a/constants.js`
- Create: `netlify/functions/_h2a/keys.js`
- Create: `netlify/functions/_h2a/time.js`
- Create: `tests/h2a/domain-contracts.test.mjs`

**Interfaces:**
- Consumes: JavaScript `Date`, `Intl.DateTimeFormat`, and normalized string identifiers.
- Produces: `H2A_STATES`, `HUBSPOT_ACTIVITY_TYPES`, `makeDeliveryKey(input)`, `makeSourceMarker(input)`, `pacificStartOfDate(dateString)`, `pacificBusinessDate(date)`, and `isDailyRunDue(input)`.

- [ ] **Step 1: Add the H2A test command**

Add this script to `package.json`:

```json
"test:h2a": "node --test tests/h2a/*.test.mjs"
```

- [ ] **Step 2: Write failing domain-contract tests**

Create tests that assert:

```js
assert.equal(makeDeliveryKey({
  companyId: 'company-1', portalId: 'portal-1', objectType: 'emails',
  activityId: '42', albiTargetType: 'contact', albiTargetId: '99',
}), 'company-1:portal-1:emails:42:contact:99')

assert.equal(makeSourceMarker({ objectType: 'email', activityId: '42' }), 'Source: HubSpot email 42')
assert.equal(pacificStartOfDate('2026-03-08'), '2026-03-08T08:00:00.000Z')
assert.equal(pacificStartOfDate('2026-11-01'), '2026-11-01T07:00:00.000Z')
```

Also cover all five activity types, invalid calendar dates, a normal 2:00 a.m. run, the spring-forward 3:00 a.m. fallback, and duplicate claims for the same Pacific business date.

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npm run test:h2a`

Expected: FAIL because `_h2a/constants.js`, `_h2a/keys.js`, and `_h2a/time.js` do not exist.

- [ ] **Step 4: Implement the minimal domain contracts**

Use these exact constants:

```js
export const H2A_STATES = Object.freeze(['disabled', 'ready', 'dry_run', 'live'])
export const HUBSPOT_ACTIVITY_TYPES = Object.freeze(['meetings', 'calls', 'emails', 'communications', 'notes'])
```

`makeDeliveryKey` must reject missing parts and join all six identity components. `pacificStartOfDate` must validate `YYYY-MM-DD` and resolve midnight in `America/Los_Angeles`; do not append a fixed UTC offset. `isDailyRunDue` returns `{ due, businessDate }` and considers the run due on the first hourly tick whose Pacific hour is at least 2 when no claim exists for that local date.

- [ ] **Step 5: Run tests and build**

Run: `npm run test:h2a && npm run build`

Expected: all H2A tests pass and Vite builds successfully.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json netlify/functions/_h2a tests/h2a
git commit -m "test: establish HubSpot to Albi domain contracts"
```

### Task 2: Tenant Schema, RLS, and Atomic Claims

**Files:**
- Create: `supabase/h2a-schema.sql`
- Create: `scripts/test-h2a-schema-contract.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `companies(id)`, `company_members(company_id,user_id,role)`, and `super_admins(user_id)` tables.
- Produces: H2A tables, tenant `SELECT` policies, service-role-only `h2a_get_credentials` and `h2a_put_credentials` RPCs, `h2a_claim_lease`, `h2a_heartbeat_lease`, `h2a_release_lease`, and `h2a_claim_daily_run`.

- [ ] **Step 1: Write the failing schema-contract test**

The test must read `supabase/h2a-schema.sql` and assert the presence of:

```js
const requiredTables = [
  'h2a_company_config', 'h2a_option_mappings', 'h2a_sync_runs',
  'h2a_cursors', 'h2a_backfill_windows', 'h2a_contact_mappings',
  'h2a_organization_mappings', 'h2a_activity_deliveries',
  'h2a_item_results', 'h2a_conflicts', 'h2a_conflict_events',
  'h2a_execution_leases', 'h2a_daily_claims',
]
```

It must also reject `auth.role()`, require RLS on every `public.h2a_` table, require indexes beginning with `h2a_`, and require explicit `to authenticated` policies.

- [ ] **Step 2: Run the schema-contract test and verify it fails**

Run: `node --test scripts/test-h2a-schema-contract.mjs`

Expected: FAIL because `supabase/h2a-schema.sql` does not exist.

- [ ] **Step 3: Define the exact schema**

Create `supabase/h2a-schema.sql` with lowercase identifiers, UUID primary keys, `timestamptz` timestamps, `date` Pacific business dates, and text status columns protected by checks. Include:

- `private.h2a_credentials`: one row per company, two AES-GCM envelopes (`ciphertext`, `iv`, `tag`, `key_version`) and `updated_by`.
- `h2a_company_config`: one row per company with state, portal ID, selected start date, initial-start lock timestamp, preflight status/details, option-confirmation status, and timestamps.
- `h2a_option_mappings`: unique `(company_id, mapping_kind, source_key)` with Albi ID, label, confirmation metadata, and a `mapping_kind` check for `activity_type`, `default_contact_type`, `default_organization_type`, and `organization_to_contact_type`.
- `h2a_sync_runs`: mode, trigger, status, totals JSON, timestamps, and error summary.
- `h2a_cursors`: unique `(company_id, object_type)` with cursor timestamp and cursor object ID.
- `h2a_backfill_windows`: company, start/end timestamps, object type, checkpoint, status, and originating request metadata.
- Contact and organization mappings with unique HubSpot source identities; allow reviewed many-to-one Albi targets by not making target IDs unique.
- `h2a_activity_deliveries`: unique complete delivery key plus state `reserved|delivered|reconciled|failed`, source marker, Albi activity ID, and attempt metadata.
- `h2a_item_results`: run, source identity, target identity, outcome, sanitized details, and timestamps.
- `h2a_conflicts`: company, source identity, type, reason, snapshots, proposed changes, status, run/activity references, resolver, and resolution timestamps.
- `h2a_conflict_events`: append-only audit records referencing a conflict.
- Lease and daily-claim tables keyed by company.

Add foreign-key indexes and these access-path indexes:

```sql
create index h2a_runs_company_started_idx on public.h2a_sync_runs (company_id, started_at desc);
create index h2a_conflicts_company_open_idx on public.h2a_conflicts (company_id, created_at desc) where status = 'open';
create index h2a_items_run_created_idx on public.h2a_item_results (run_id, created_at, id);
create index h2a_backfills_company_pending_idx on public.h2a_backfill_windows (company_id, start_at) where status in ('pending', 'running');
```

- [ ] **Step 4: Add RLS and least-privilege policies**

Members may `SELECT` their company's non-secret H2A rows. Admins and super admins still mutate through Netlify functions, so browser roles receive no direct write policies. Wrap `(select auth.uid())` in policies and use indexed membership lookups. Revoke all access to `private.h2a_credentials` from `public`, `anon`, and `authenticated`.

Create `public.h2a_get_credentials(company_id uuid)` and `public.h2a_put_credentials(company_id uuid, hubspot_envelope jsonb, albi_envelope jsonb, updated_by uuid)` for encrypted credential reads/writes, plus the named atomic lease/daily-claim RPCs. Set `search_path = ''`, schema-qualify every relation, revoke function execution from `PUBLIC`, `anon`, and `authenticated`, and grant only to `service_role`.

- [ ] **Step 5: Add the schema test command and run it**

Add:

```json
"test:h2a:schema": "node --test scripts/test-h2a-schema-contract.mjs"
```

Run: `npm run test:h2a:schema`

Expected: PASS with every required table, policy, index, and RPC found.

- [ ] **Step 6: Validate against a disposable Supabase database**

Run `supabase --help` and use the installed CLI's documented local reset workflow. Apply `supabase/h2a-schema.sql` to a disposable local database, then test one member, one company admin, one unrelated member, and one super admin. Expected: tenant reads are isolated; browser writes fail; service-role RPCs work; two simultaneous lease claims yield one winner.

- [ ] **Step 7: Commit**

```bash
git add supabase/h2a-schema.sql scripts/test-h2a-schema-contract.mjs package.json package-lock.json
git commit -m "feat: add tenant-isolated H2A schema"
```

### Task 3: Server Authorization and Tenant Selection

**Files:**
- Create: `netlify/functions/_h2a/auth.js`
- Create: `tests/h2a/auth.test.mjs`

**Interfaces:**
- Consumes: `getAdminSupabase()`, Supabase JWT, optional requested company ID, and optional internal cron secret.
- Produces: `resolveH2AContext({ supabase, jwt, requestedCompanyId, requireAdmin })` and `requireH2ARequest(event, options)` returning `{ userId, companyId, companyName, role, isSuperAdmin, supabase }`.

- [ ] **Step 1: Write failing authorization tests**

Use dependency-injected fake Supabase responses to cover:

- member can read only their own company;
- member and company admin cannot select another company;
- company admin passes `requireAdmin` for their own company;
- super admin may select any existing company;
- missing membership and non-super-admin returns `403`;
- invalid JWT returns `401`;
- internal jobs require both the secret and an explicit existing company ID.

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test tests/h2a/auth.test.mjs`

Expected: FAIL because `_h2a/auth.js` does not exist.

- [ ] **Step 3: Implement authorization without trusting browser tenant IDs**

`resolveH2AContext` must query `super_admins` and `company_members`, derive the allowed company, and only honor `requestedCompanyId` for a verified super admin. `requireH2ARequest` parses the bearer token, validates it with `supabase.auth.getUser(jwt)`, and maps known authorization failures to status codes without exposing database details.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/h2a/auth.test.mjs && npm run test:h2a`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_h2a/auth.js tests/h2a/auth.test.mjs
git commit -m "feat: authorize H2A tenant selection"
```

### Task 4: Credential Encryption and Settings API

**Files:**
- Create: `netlify/functions/_h2a/crypto.js`
- Create: `netlify/functions/h2a-settings.js`
- Create: `tests/h2a/crypto.test.mjs`
- Create: `tests/h2a/settings-api.test.mjs`

**Interfaces:**
- Consumes: `H2A_CREDENTIAL_KEY_V1` as a base64-encoded 32-byte key, authenticated H2A context, and credential RPCs.
- Produces: `encryptSecret(plaintext, keyring)`, `decryptSecret(envelope, keyring)`, `maskSecret(secret)`, and GET/PUT `/.netlify/functions/h2a-settings`.

- [ ] **Step 1: Write failing AES-GCM tests**

Assert that two encryptions of the same value use different IVs, ciphertext does not contain the plaintext, tampering fails authentication, unknown key versions fail closed, rotation can decrypt v1 and write v2, and masks reveal only the approved prefix/suffix.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/h2a/crypto.test.mjs`

Expected: FAIL because `_h2a/crypto.js` does not exist.

- [ ] **Step 3: Implement encryption with Node `crypto`**

Use `randomBytes(12)`, `createCipheriv('aes-256-gcm', key, iv)`, `getAuthTag()`, and matching decipher validation. Store base64 strings and integer `keyVersion`; never log plaintext or envelopes.

- [ ] **Step 4: Write failing settings endpoint tests**

Cover admin-only PUT, member GET with masks only, super-admin selected company, start-date validation, forbidden attempts to change a fixed initial date forward, earlier-date backfill requests, and preflight invalidation after either credential changes.

- [ ] **Step 5: Implement the settings endpoint**

GET returns configuration, option mappings, preflight state, and `hubspotTokenMask`/`albiApiKeyMask`. PUT accepts only `replace_credentials`, `save_start_date`, `confirm_option_mappings`, `enter_dry_run`, `activate_live`, `disable`, and `request_earlier_backfill` actions. It encrypts supplied secrets through `h2a_put_credentials`, reads envelopes through `h2a_get_credentials`, resets preflight to `unchecked` after credential replacement, and never returns ciphertext or plaintext.

- [ ] **Step 6: Run tests and build**

Run: `node --test tests/h2a/crypto.test.mjs tests/h2a/settings-api.test.mjs && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/_h2a/crypto.js netlify/functions/h2a-settings.js tests/h2a
git commit -m "feat: secure H2A credentials and settings"
```

### Task 5: HubSpot and Albi API Adapters with Preflight

**Files:**
- Create: `netlify/functions/_h2a/http.js`
- Create: `netlify/functions/_h2a/hubspotClient.js`
- Create: `netlify/functions/_h2a/albiClient.js`
- Create: `netlify/functions/_h2a/preflight.js`
- Create: `netlify/functions/h2a-preflight.js`
- Create: `netlify/functions/h2a-estimate.js`
- Create: `tests/h2a/fixtures/hubspot/`
- Create: `tests/h2a/fixtures/albi/`
- Create: `tests/h2a/api-clients.test.mjs`
- Create: `tests/h2a/preflight.test.mjs`

**Interfaces:**
- Consumes: decrypted tenant credentials and injected `fetch`.
- Produces: `HubSpotClient`, `AlbiClient`, `runPreflight({ hubspot, albi })`, POST `/.netlify/functions/h2a-preflight`, and POST `/.netlify/functions/h2a-estimate`.

`HubSpotClient` methods:

```js
getAccountInfo()
listOwners()
estimateActivities({ objectType, occurredAtGte })
listActivities({ objectType, occurredAtGte, occurredAtLt, after, limit })
getAssociations({ objectType, objectIds, toObjectTypes })
getContacts(ids)
getCompanies(ids)
```

`AlbiClient` methods:

```js
verifyCredentials()
listOptions()
listContacts({ cursor, pageSize })
listOrganizations({ cursor, pageSize })
createContact(payload)
updateContact(id, payload)
createOrganization(payload)
updateOrganization(id, payload)
associateContact({ contactId, organizationId })
listActivities({ contactId, organizationId, startDate, endDate, page })
createActivity(payload)
```

- [ ] **Step 1: Verify and record official API contracts**

Before coding paths, inspect current official HubSpot date-versioned docs and the Albi v5 OpenAPI/ReadMe docs. Save redacted response fixtures for every method above and record the verified base path, HTTP method, required fields, pagination shape, scopes, and rate-limit headers in fixture metadata. Confirm in an Albi sandbox that contact creation requires `firstName`, `lastName`, and `contactTypeIds`, and determine whether activity creation supports a hidden external source ID.

- [ ] **Step 2: Write failing adapter tests from fixtures**

Tests must cover cursor pagination, HubSpot `429` with `Retry-After`, transient `5xx`, auth `401/403`, malformed response validation, direct email object selection, marketing-email exclusion, text-message or applicable communications records, Albi option normalization, and endpoint-specific validation errors.

- [ ] **Step 3: Run and verify failure**

Run: `node --test tests/h2a/api-clients.test.mjs`

Expected: FAIL because the adapters do not exist.

- [ ] **Step 4: Implement bounded HTTP behavior and adapters**

`http.js` must classify errors as `transient`, `rate_limit`, `auth`, `permission`, `validation`, or `permanent`; retry only transient/rate-limit responses with capped exponential backoff and jitter. Adapters return normalized internal records and do not expose raw credentials in thrown errors.

- [ ] **Step 5: Write failing preflight tests**

Assert a pass only when contact/company reads, writes, associations, activity creation capability, activity reads, and all required options are available. Assert human-readable missing-scope and missing-option results. Preflight may call metadata/read endpoints but must never create a production record.

- [ ] **Step 6: Implement preflight and endpoint**

The endpoint requires admin context, decrypts credentials, persists sanitized results, available options, portal ID, and checked timestamp, and leaves required mappings unconfirmed until an admin confirms them in Settings.

Implement `h2a-estimate.js` as an admin-only read operation. It validates the proposed Pacific start date, asks every HubSpot activity adapter for a count using the activity occurrence timestamp, and returns `{ total, byObjectType, capped }`. It must not save the initial start date, create conflicts, or advance any checkpoint.

- [ ] **Step 7: Run tests**

Run: `node --test tests/h2a/api-clients.test.mjs tests/h2a/preflight.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/_h2a netlify/functions/h2a-preflight.js netlify/functions/h2a-estimate.js tests/h2a/fixtures tests/h2a/api-clients.test.mjs tests/h2a/preflight.test.mjs
git commit -m "feat: add H2A API adapters and preflight"
```

### Task 6: Normalization and Identity Matching

**Files:**
- Create: `netlify/functions/_h2a/normalize.js`
- Create: `netlify/functions/_h2a/match.js`
- Create: `tests/h2a/normalize.test.mjs`
- Create: `tests/h2a/match.test.mjs`

**Interfaces:**
- Produces: `normalizePhone`, `formatAlbiPhone`, `normalizeEmail`, `normalizeName`, `normalizeDomain`, `normalizeAddress`, `decideContactMatch(input)`, `decideOrganizationMatch(input)`, and `decideFieldChanges(input)`.
- Match decisions return `{ action: 'link'|'create'|'conflict', targetId, reason, evidence, proposedChanges }`.

- [ ] **Step 1: Write normalization decision tables**

Cover ten-digit US values, leading `1`, punctuation, extensions, malformed lengths, international numbers, email case/whitespace, Unicode names, punctuation-insensitive names, domains with protocol/`www`/paths, and supporting-only addresses.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/h2a/normalize.test.mjs`

Expected: FAIL because `_h2a/normalize.js` does not exist.

- [ ] **Step 3: Implement normalization functions**

Return structured phone results such as `{ comparable, writable, extension, conflictReason }`; never truncate or invent digits. Preserve original source values separately from comparable values.

- [ ] **Step 4: Write match decision tables**

Cover exact unique email, exact unique phone, email/phone disagreement, duplicate candidate values, name-only candidates, unique organization domain, name plus phone/address corroboration, contradictory organization evidence, existing source mapping, and target already mapped to another source.

- [ ] **Step 5: Implement matching and field-change policy**

Existing source mappings win. A second source-to-target mapping always conflicts until reviewed. Equal normalized values remain unchanged, blank Albi values may fill, and different nonblank values become proposed conflicts.

- [ ] **Step 6: Run tests**

Run: `node --test tests/h2a/normalize.test.mjs tests/h2a/match.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/_h2a/normalize.js netlify/functions/_h2a/match.js tests/h2a
git commit -m "feat: add safe H2A identity matching"
```

### Task 7: Activity Targeting, Option Resolution, and Delivery Reservation

**Files:**
- Create: `netlify/functions/_h2a/activity.js`
- Create: `netlify/functions/_h2a/options.js`
- Create: `netlify/functions/_h2a/deliveries.js`
- Create: `tests/h2a/activity.test.mjs`
- Create: `tests/h2a/options.test.mjs`
- Create: `tests/h2a/deliveries.test.mjs`

**Interfaces:**
- Produces: `resolveActivityTargets(input)`, `buildAlbiActivity(input)`, `resolveContactType(input)`, `reserveDelivery(input)`, `reconcileDelivery(input)`, and `completeDelivery(input)`.

- [ ] **Step 1: Write failing targeting and payload tests**

Cover one contact plus company, several safe contacts, a mixture of safe and ambiguous contacts, company-only fallback, multiple company-only candidates, no target, concise HTML-to-text excerpts, owner/subject/outcome inclusion, original occurrence time, and source marker fallback.

- [ ] **Step 2: Implement targeting and payload construction**

Emit one target per safe contact and no organization duplicate. Emit one organization target only when no contact exists and exactly one organization resolves. Keep ambiguous associations as separate conflict descriptors.

- [ ] **Step 3: Write failing option-resolution tests**

Cover confirmed organization-type mapping, confirmed default contact type fallback, unconfirmed suggestions, missing required activity type, and organization/contact labels with different ID namespaces.

- [ ] **Step 4: Implement option resolution**

Only confirmed mappings may produce write payload IDs. Suggestions remain display metadata and must never authorize a write.

- [ ] **Step 5: Write failing delivery tests**

Cover duplicate reservation, successful create, native external-ID reconciliation, source-marker reconciliation after an uncertain timeout, deterministic validation failure, and retryable failure.

- [ ] **Step 6: Implement delivery state transitions**

Reserve the complete unique key before the outbound create. Never hold a database transaction open during HTTP. On uncertain failures, query recent target activities and reconcile before retrying. State transitions use conditional updates so only the current attempt can complete a reservation.

- [ ] **Step 7: Run tests**

Run: `node --test tests/h2a/activity.test.mjs tests/h2a/options.test.mjs tests/h2a/deliveries.test.mjs`

Expected: PASS, including the post-write/pre-record crash case from Review Focus.

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/_h2a/activity.js netlify/functions/_h2a/options.js netlify/functions/_h2a/deliveries.js tests/h2a
git commit -m "feat: build idempotent H2A activity deliveries"
```

### Task 8: Durable Sync Orchestrator and Backfill Windows

**Files:**
- Create: `netlify/functions/_h2a/checkpoints.js`
- Create: `netlify/functions/_h2a/repository.js`
- Create: `netlify/functions/_h2a/orchestrator.js`
- Create: `netlify/functions/h2a-run.js`
- Create: `netlify/functions/h2a-run-background.js`
- Create: `tests/h2a/checkpoints.test.mjs`
- Create: `tests/h2a/orchestrator.test.mjs`

**Interfaces:**
- Consumes: Tasks 3–7 interfaces.
- Produces: `planBackfillWindows`, `advanceCheckpoint`, `runCompanySync(deps, input)`, POST `h2a-run`, and background re-export `h2a-run-background`.

`runCompanySync` input:

```js
{
  companyId,
  mode: 'dry_run' | 'live' | 'backfill',
  trigger: 'manual' | 'scheduled' | 'resume' | 'conflict_resolution',
  runId: null | string,
  timeBudgetMs: 13 * 60 * 1000,
}
```

- [ ] **Step 1: Write failing checkpoint tests**

Cover timestamp-plus-ID ordering, overlap windows, equal timestamps with increasing IDs, independent object types, no advancement past an unresolved item, daily windows across both DST changes, and a resumed multi-window backfill.

- [ ] **Step 2: Implement checkpoint helpers**

Use keyset boundaries, never offsets. Live checkpoints and backfill checkpoints are separate. Dry runs read the configured start date and write only run/item previews, not mappings, deliveries, conflicts, or cursors.

- [ ] **Step 3: Write orchestrator tests with fake clients and repository**

Cover organization-first creation, safe contact creation, missing first or last name conflict, blank-field update, nonblank conflict, per-item isolation, multi-contact fan-out, API rate-limit retry, lease collision, time-budget continuation, repeated retrieval of an already delivered but later-edited source activity, and exact run totals.

- [ ] **Step 4: Implement repository methods**

Every service-role query takes `companyId` as its first argument and includes `.eq('company_id', companyId)`. Repository methods own table names and conditional updates; domain modules never call Supabase directly.

- [ ] **Step 5: Implement the orchestrator**

Acquire the atomic lease, create or resume a run, load paginated Albi contact and organization candidate indexes once for that invocation, iterate object types and keyset pages, process each item independently, persist outcomes before advancing checkpoints, heartbeat between pages, stop cleanly near the time budget, and release the lease in `finally`. For continuation, dispatch another background request with the same run ID only after durable state is saved. A source activity whose delivery already succeeded remains skipped even when its later HubSpot representation differs.

- [ ] **Step 6: Implement manual/background endpoints**

Manual runs require admin context. `h2a-run-background.js` re-exports the handler. Internal resume requests require the cron secret and explicit company ID. Return `202` for queued work and a stable status payload for already-running work.

- [ ] **Step 7: Run tests**

Run: `node --test tests/h2a/checkpoints.test.mjs tests/h2a/orchestrator.test.mjs`

Expected: PASS, including race and time-budget Review Focus cases.

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/_h2a netlify/functions/h2a-run.js netlify/functions/h2a-run-background.js tests/h2a
git commit -m "feat: orchestrate resumable H2A syncs"
```

### Task 9: Conflict Query and Resolution APIs

**Files:**
- Create: `netlify/functions/_h2a/conflicts.js`
- Create: `netlify/functions/h2a-conflicts.js`
- Create: `netlify/functions/h2a-conflict-resolve.js`
- Create: `tests/h2a/conflicts.test.mjs`

**Interfaces:**
- Produces: `listConflicts(input)`, `resolveConflict(deps, input)`, GET `h2a-conflicts`, and POST `h2a-conflict-resolve`.
- Resolution actions: `link_existing`, `create_new`, `approve_fields`, `retain_albi`, and `skip_item`.

- [ ] **Step 1: Write failing conflict tests**

Cover tenant-isolated keyset pagination, member read/admin resolve, stale version rejection, each resolution action, explicit many-to-one approval, repeated identical action idempotency, audit-event append, and immediate pending-activity resume.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/h2a/conflicts.test.mjs`

Expected: FAIL because conflict modules do not exist.

- [ ] **Step 3: Implement conflict services**

Require `expectedUpdatedAt` on mutation to prevent two reviewers overwriting each other. Record the resolver, action, selected fields, before/after snapshots, and timestamp. A successful identity resolution creates the mapping and queues a `conflict_resolution` resume for only the blocked activity.

- [ ] **Step 4: Implement endpoints and run tests**

Run: `node --test tests/h2a/conflicts.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_h2a/conflicts.js netlify/functions/h2a-conflicts.js netlify/functions/h2a-conflict-resolve.js tests/h2a/conflicts.test.mjs
git commit -m "feat: add H2A conflict resolution"
```

### Task 10: Scheduler and Tenant-Scoped Notifications

**Files:**
- Create: `netlify/functions/_h2a/notifications.js`
- Create: `netlify/functions/nightly-h2a-sync.js`
- Create: `tests/h2a/notifications.test.mjs`
- Create: `tests/h2a/scheduler.test.mjs`

**Interfaces:**
- Consumes: Task 1 time helpers, Task 3 internal authorization, existing Resend environment configuration, and Task 8 background endpoint.
- Produces: `resolveCompanyAdminRecipients`, `notifyRunExceptions`, and hourly scheduled dispatcher.

- [ ] **Step 1: Write notification tests**

Cover clean-run suppression, new-conflict summary, failed/partially failed summary, company-admin recipient lookup, global super-admin exclusion, explicitly configured recipient inclusion, no-recipient logging, redaction, and one-company-only data in each message.

- [ ] **Step 2: Implement notification service**

Reuse only the existing Resend transport behavior; use H2A-specific templates and recipient resolution. Never reuse `IMPORT_ALERT_EMAIL` as the tenant recipient source.

- [ ] **Step 3: Write scheduler tests**

Cover 1:00 a.m. skip, normal 2:00 a.m. claim, spring-forward 3:00 a.m. claim, repeated hourly invocation, disabled/invalid-preflight companies, independent company dispatch failures, and once-per-business-date guarantees.

- [ ] **Step 4: Implement hourly scheduler**

Export `config = { schedule: '17 * * * *' }`. On every invocation, identify eligible live companies, atomically claim their Pacific business date, and dispatch one background job per claimed company. A dispatch failure must mark the claim retryable rather than silently consuming the day.

- [ ] **Step 5: Run tests**

Run: `node --test tests/h2a/notifications.test.mjs tests/h2a/scheduler.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/_h2a/notifications.js netlify/functions/nightly-h2a-sync.js tests/h2a
git commit -m "feat: schedule and notify H2A syncs"
```

### Task 11: Frontend API Client, Routes, and Navigation

**Files:**
- Create: `src/lib/hubspotToAlbi.js`
- Create: `src/features/hubspotToAlbi/HubSpotToAlbiLayout.jsx`
- Create: `src/features/hubspotToAlbi/CompanySelector.jsx`
- Modify: `src/App.jsx`
- Modify: `src/components/AppShell.jsx`
- Create: `tests/h2a/frontend-contracts.test.mjs`

**Interfaces:**
- Produces: authenticated client functions `getH2ASettings`, `saveH2ASettings`, `runH2APreflight`, `estimateH2AActivities`, `runH2ASync`, `getH2AOverview`, `getH2AConflicts`, and `resolveH2AConflict`.
- Routes: `/hubspot-to-albi`, `/hubspot-to-albi/conflicts`, and `/hubspot-to-albi/settings`.

- [ ] **Step 1: Write failing frontend-contract tests**

Statically assert that every mutating request supplies the Supabase bearer token, the estimate request is authenticated but read-only, selected company is sent only through the H2A client, the three routes are protected by `ProtectedRoute`, Settings mutation controls receive `isAdmin`, and the super-admin selector receives `isSuperAdmin`.

- [ ] **Step 2: Implement the API client**

Centralize JSON parsing and error normalization. Never include credentials in GET query strings, local storage, React Router state, logs, or error messages.

- [ ] **Step 3: Add nested module layout and company selector**

Use a compact `HubSpot to Albi` top-level navigation entry opening module tabs for Overview, Conflicts, and Settings. Show the company selector only to super admins; changing company clears module query state before loading the new tenant.

- [ ] **Step 4: Add protected routes**

Pass `session`, `companyId`, `isAdmin`, and `isSuperAdmin` from `App.jsx`. Preserve `ProtectedRoute` as the app-access choke point and keep role enforcement in route components and backend functions.

- [ ] **Step 5: Run tests and build**

Run: `node --test tests/h2a/frontend-contracts.test.mjs && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/hubspotToAlbi.js src/features/hubspotToAlbi src/App.jsx src/components/AppShell.jsx tests/h2a/frontend-contracts.test.mjs
git commit -m "feat: add H2A routes and navigation"
```

### Task 12: Guided Settings and Dry-Run Activation UI

**Files:**
- Create: `src/features/hubspotToAlbi/SettingsPage.jsx`
- Create: `src/features/hubspotToAlbi/CredentialFields.jsx`
- Create: `src/features/hubspotToAlbi/OptionMappingForm.jsx`
- Create: `src/features/hubspotToAlbi/PreflightChecklist.jsx`
- Create: `tests/h2a/settings-ui-contract.test.mjs`

**Interfaces:**
- Consumes: Task 11 client and route context.
- Produces: guided settings flow for credentials, start date, mappings, preflight, dry run, and live activation.

- [ ] **Step 1: Write failing UI-contract tests**

Assert masked-only credential rendering, admin-only editing, required start date, Pacific interpretation copy, populated dropdowns, suggested-but-unconfirmed mappings, organization-to-contact mapping preview, default contact fallback, required confirmation count, preflight blocking, dry-run count preview, and live activation gating.

- [ ] **Step 2: Implement the credential and preflight sections**

Secret inputs remain blank after save. Show masks from the server and a replace action. Display human-readable missing permissions/options and never render raw API error payloads.

- [ ] **Step 3: Implement fast option setup**

Render required mappings first. Preselect strong label suggestions but mark them `Needs confirmation`. Provide one `Confirm suggested mappings` action that confirms only unambiguous suggestions, followed by explicit dropdown correction for the rest. Include `Inherit contact type from organization when possible` and show its fallback default.

- [ ] **Step 4: Implement state transitions**

Disable first dry run until credentials, preflight, start date, and mappings are valid. Call `estimateH2AActivities` when the admin requests a preview and show totals by activity type plus a large-range warning when `capped` is true. Explain that the first dry run fixes the initial date. After dry-run review, allow live activation. After activation, choosing an earlier date creates a backfill request and never changes the live cursor.

- [ ] **Step 5: Run tests and build**

Run: `node --test tests/h2a/settings-ui-contract.test.mjs && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/hubspotToAlbi tests/h2a/settings-ui-contract.test.mjs
git commit -m "feat: add guided H2A setup"
```

### Task 13: Overview and Conflict Review UI

**Files:**
- Create: `netlify/functions/h2a-overview.js`
- Create: `src/features/hubspotToAlbi/OverviewPage.jsx`
- Create: `src/features/hubspotToAlbi/ConflictsPage.jsx`
- Create: `src/features/hubspotToAlbi/ConflictDetail.jsx`
- Create: `tests/h2a/overview-api.test.mjs`
- Create: `tests/h2a/operations-ui-contract.test.mjs`

**Interfaces:**
- Produces: GET `h2a-overview`, Overview metrics/history/manual run, unresolved badge, keyset-paginated conflicts, and audited resolution forms.

- [ ] **Step 1: Write failing overview API tests**

Cover tenant selection, member read access, summary totals, active/recent run status, last successful run, unresolved count, recent keyset-paginated history, and sanitized errors.

- [ ] **Step 2: Implement overview endpoint**

Use company-scoped repository queries and return only fields needed by the UI. Do not return raw source snapshots in aggregate responses.

- [ ] **Step 3: Write failing operations UI contracts**

Cover loading/error/empty states, admin-only `Run now`, run totals, unresolved badge, side-by-side values, match evidence, HubSpot recommendation, all five resolution actions, field-selection controls, stale-conflict refresh, and read-only member rendering.

- [ ] **Step 4: Implement Overview and Conflicts pages**

Use keyset pagination for runs and conflicts. Require a confirmation summary before destructive choices such as `create_new`, `approve_fields`, or `skip_item`. Refresh only the affected conflict and badge after resolution.

- [ ] **Step 5: Run tests and build**

Run: `node --test tests/h2a/overview-api.test.mjs tests/h2a/operations-ui-contract.test.mjs && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/h2a-overview.js src/features/hubspotToAlbi tests/h2a
git commit -m "feat: add H2A operations and conflict UI"
```

### Task 14: End-to-End Verification and Pilot Runbook

**Files:**
- Create: `scripts/test-h2a-end-to-end.mjs`
- Create: `docs/hubspot-to-albi-pilot-runbook.md`
- Modify: `README.md` if present; otherwise create `README.md`

**Interfaces:**
- Consumes: all earlier tasks and sandbox credentials supplied through environment variables.
- Produces: repeatable sandbox smoke test and operator rollout/recovery documentation.

- [ ] **Step 1: Write the sandbox smoke script in read-only mode first**

Require `H2A_TEST_HUBSPOT_TOKEN`, `H2A_TEST_ALBI_KEY`, and explicit `H2A_ALLOW_SANDBOX_WRITES=true` before any write. Without the flag, validate credentials, options, direct-email retrieval, association traversal, and print the planned isolated test records.

- [ ] **Step 2: Add guarded write verification**

With the explicit flag, create one uniquely prefixed organization, associated contact, and activity; rerun the same delivery; assert exactly one Albi activity exists; and print record IDs for manual cleanup. Never target production credentials.

- [ ] **Step 3: Write the pilot runbook**

Document schema deployment, Netlify encryption-key setup and rotation, credential setup, option confirmation, start-date selection, count review, dry run, conflict sampling, live enablement, manual recovery, disabling, notification checks, and per-company onboarding. Include the verified HubSpot API version and Albi endpoints from Task 5.

- [ ] **Step 4: Run complete automated verification**

Run:

```bash
npm run test:h2a
npm run test:h2a:schema
npm run build
```

Expected: all tests pass and production build succeeds.

- [ ] **Step 5: Run local function checks**

Start `npm run dev:local` and verify unauthenticated H2A functions return `401`, member mutations return `403`, company-admin requests use their own company, and super-admin selected-company requests remain scoped.

- [ ] **Step 6: Run the sandbox smoke test**

Run first without writes, then with `H2A_ALLOW_SANDBOX_WRITES=true` only after confirming the credentials point to an Albi sandbox or explicitly isolated data.

Expected: one organization, one associated contact, one activity, and zero duplicates on rerun.

- [ ] **Step 7: Review Supabase security and performance**

Run the current Supabase advisors against the target project, inspect missing foreign-key/RLS indexes, and execute tenant-isolation queries for member, admin, unrelated member, super admin, and service role. Fix every security finding related to new H2A objects before pilot activation.

- [ ] **Step 8: Commit**

```bash
git add scripts/test-h2a-end-to-end.mjs docs/hubspot-to-albi-pilot-runbook.md README.md
git commit -m "docs: add H2A pilot verification runbook"
```

### Task 15: Final Regression and Rollout Gate

**Files:**
- Modify only files required by verified defects found in this task.

**Interfaces:**
- Produces: evidence that the new module and existing importer are both release-ready.

- [ ] **Step 1: Run all existing importer regressions**

Run every `scripts/test-*.mjs` script that does not require live production credentials, followed by `npm run build`. Expected: no behavior change in existing Albi-to-HubSpot imports, matching, held deals, or Google Sheet fingerprinting.

- [ ] **Step 2: Run all H2A tests again**

Run: `npm run test:h2a && npm run test:h2a:schema`

Expected: PASS.

- [ ] **Step 3: Exercise failure recovery**

In the sandbox, inject one `429`, one transient `500`, one Albi timeout after accepted write, one deterministic validation error, and one expired lease. Expected: bounded retry, reconciliation without duplicate, visible item failure, stale-lease recovery, and unrelated-item continuation.

- [ ] **Step 4: Verify deployment-disabled state**

Deploy schema and UI with every company `disabled`. Confirm no scheduled invocation dispatches a company until its preflight, option confirmations, dry run, and explicit live activation have completed.

- [ ] **Step 5: Commit final verified fixes**

Stage only files changed to correct verified defects and commit with a message describing those defects. If no fixes are needed, do not create an empty commit.
