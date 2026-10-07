# HubSpot-to-Albi pilot runbook

Status: implementation and local contracts are ready for controlled pilot verification. Live activation is blocked until the Albi and Supabase gates in this document are closed. No live HubSpot, Albi, or database verification is claimed by this runbook.

| Gate | Current evidence | Status |
|---|---|---|
| Local automation | H2A unit/contracts, static schema contract, fake-adapter smoke orchestration, build, and non-live importer regression scripts | Verified locally |
| Provider documentation | Official HubSpot 2026.09 rollup and current meeting reference; official Albi public read/create pages, with limits called out below (checked 2026-10-07) | Documentation reviewed; sandbox behavior unverified |
| Provider runtime | HubSpot/Albi test credentials and explicit isolated-tenant/activity acknowledgements are unset | Blocked |
| Database/security | No disposable Postgres/Supabase, Docker daemon, Supabase CLI, or `psql`; live grants/RLS/advisors/races not run | Blocked |
| Authenticated UI | No approved disposable member/admin/super-admin sessions; local dev server cannot bind/write Netlify config in this environment | Blocked |
| Pilot readiness | Albi update and standalone contact-association contracts remain unsupported; activity marker persistence also needs sandbox confirmation | Blocked; do not activate live sync |

## Current provider contracts and limits

### HubSpot

The adapter pins CRM calls to API version `2026-09`. Its three object operations are distinct: bare collection reads use `GET /crm/objects/2026-09/{objectType}?limit=...`; activity queries use `POST /crm/objects/2026-09/{objectType}/search`; batch record reads use `POST /crm/objects/2026-09/{objectType}/batch/read`. Association traversal uses `GET /crm/objects/2026-09/{objectType}/{id}/associations/{toObjectType}`, and portal identity uses `GET /account-info/2026-09/details`. The official [Fall 2026 developer rollup](https://developers.hubspot.com/changelog/fall-2026-spotlight) (checked 2026-10-07) states that version 2026.09 updated Meetings, CRM objects, and Associations, and that nearly all listed API updates are version-parity releases. It establishes the 2026-09 release/meeting inclusion, not these three meeting endpoint shapes. The current official [meeting retrieval reference](https://developers.hubspot.com/docs/api-reference/latest/crm/activities/meetings/get-meetings), checked 2026-10-07, still displays the bare `GET /crm/objects/2026-03/{objectType}` list path and cursor/properties/associations/scope details. The official [2026-03 API reference overview](https://developers.hubspot.com/docs/overview?Tag=Events) likewise documents the date-version path pattern and a bare contact list example. Neither page, as checked, proves the adapter's `2026-09` `/search` or `/batch/read` meeting request/response contract. Those exact paths below describe what this adapter sends; their current versioned behavior remains an isolated-portal verification gate. HubSpot's [date-based versioning announcement](https://developers.hubspot.com/changelog/introducing-date-based-api-versioning) documents the `/YYYY-MM/` scheme and release cadence.

The adapter requests these properties from `hs_timestamp` plus object-specific fields: meetings (`hs_meeting_start_time`, `hs_meeting_title`, `hs_meeting_body`, `hs_meeting_outcome`, `hubspot_owner_id`); calls (`hs_call_title`, `hs_call_body`, `hs_call_status`, `hs_call_disposition`, `hs_call_direction`, owner); emails (`hs_email_subject`, `hs_email_text`, `hs_email_direction`, `hs_email_status`, owner); communications (`hs_communication_channel_type`, `hs_communication_logged_from`, `hs_communication_body`, owner); and notes (`hs_note_body`, owner). The adapter's `/search` POST uses a `hs_timestamp` GTE/LT filter, a stable timestamp sort, a maximum page size of 200, and HubSpot's returned `after` cursor. `/batch/read` POST requests are grouped at no more than 100 IDs. These are implementation limits, not independently verified 2026-09 meeting guarantees. Association traversal requests contact/company IDs and follows returned cursors.

Email eligibility is deliberately narrow: only CRM `emails` objects whose `hs_email_direction` is exactly `EMAIL` are eligible. Other or absent directions are excluded. HubSpot's older official [email-engagement scope notice](https://developers.hubspot.com/changelog/announcement-new-scope-required-to-get-the-content-of-email-engagements) says email engagement content can be redacted without `sales-email-read` for app/OAuth access; this does not establish the current behavior for every private-app/service-key setup. Verify the token's exact scopes and a redacted direct-email fixture in the pilot portal before enabling email copies. The current docs reviewed here do not establish the `hs_email_direction` value taxonomy or the exact 2026-09 email search response shape.

Do not treat the CRM communications object as proof that SMS is readable: verify the tenant's communications channels, properties, and scopes separately. HubSpot's 2026-09 write-validation change also applies admin-configured required-field and association rules to CRM API writes; see its [official notice](https://developers.hubspot.com/changelog/crm-api-write-validation-enforcement). H2A reads from HubSpot and does not write there.

### Albi

The adapter's base host is `https://api.albiware.com`; requests use the `ApiKey` header and `/v5/Integrations` root. The public [Get All Activities reference](https://albi.readme.io/reference/get-all-projects-copy-1) documents `GET /v5/Integrations/Activities` with optional `contactId`, `organizationId`, `startDate`, `endDate`, numeric `page` (default 1), `pageSize` (default 25), and an `ApiKey` header. The public [Create a Contact reference](https://albi.readme.io/reference/update-an-equipment-copy) documents `POST /v5/Integrations/Contacts/Create`, requires `firstName`, `lastName`, and `contactTypeIds`, and exposes `organizationId` for an association at contact creation time.

The current application adapter also calls these paths: `GET Contacts`, `GET Organizations`, `GET Options/GetRelationshipTypeOptions`, `GetReferralSourceOptions`, `GetRelationshipStatusOptions`, `GetActivityTypeOptions`; and POST `Organizations/Create`, `Activities/Create`. These exact endpoint paths and response envelopes are based on the implemented adapter's contract fixtures. The public docs available during this task did not establish their complete request, pagination, and response contracts. The adapter's activity request uses `typeId`, `date`, `notes`, contact or organization target, and `source: 'hubspot'` / `sourceId`; the public docs reviewed did not establish those field semantics, persisted visibility, or idempotency behavior. The activity list response includes marker candidates in the adapter's shape, but read-after-write marker visibility must be proven in the isolated Albi sandbox.

Albi contact/organization updates and a standalone contact-organization association call are intentionally unsupported by the adapter. No endpoint or payload is guessed. Their absence keeps H2A preflight invalid and therefore blocks live activation. The guarded smoke creates only an organization, a contact associated at contact creation, and an activity; its runtime capability check is limited to those three create endpoints and it requires the marker-readback contract to have been verified and acknowledged. A failed or absent capability check must be recorded as a blocker; do not bypass it. Passing this narrower smoke does not satisfy H2A live-sync preflight.

## Guarded smoke script

Credential-free deterministic check:

```sh
npm run test:h2a:e2e
```

Provider read-only mode requires `H2A_TEST_HUBSPOT_TOKEN` and `H2A_TEST_ALBI_KEY`. It performs authenticated reads only: HubSpot portal identity, seven-day activity searches for all five supported object types, up to five sample association traversals per type, and Albi option/contact/organization/activity reads. It reports only capability names, counts, safe short ID suffixes, and a planned prefix; it never prints credentials, headers, raw provider bodies, activity bodies, or full provider IDs. Without either credential, it exits successfully and lists only the missing variable names.

The write path requires all of the following:

- Both test credentials above, connected to an explicitly isolated pilot portal and Albi sandbox/test tenant.
- `H2A_ALLOW_SANDBOX_WRITES=true`.
- `H2A_SANDBOX_ISOLATION_ACK=I_CONFIRM_THIS_IS_AN_ISOLATED_ALBI_SANDBOX` after the operator has checked the Albi tenant and credentials.
- `H2A_ALBI_ACTIVITY_CONTRACT_ACK=I_VERIFIED_ALBI_ACTIVITY_MARKER_READBACK` only after the operator has verified `source`/`sourceId` and the exact `Source: HubSpot meeting <id>` marker readback in that sandbox.
- A stable `H2A_SMOKE_RUN_ID` (4–48 letters, digits, underscores, or hyphens). Reuse the same value for retry verification. Never set provider URL overrides; adapters use fixed official hosts.
- Albi `OPTIONS` checks that explicitly report `POST` for the three create endpoints used by this smoke, plus nonempty tenant option lists. The script checks only these create capabilities because it performs no updates or standalone association request. This smoke does not clear H2A preflight: contact/organization updates and standalone contact-organization association remain unsupported by the adapter and continue to block live sync activation.

When all gates are satisfied, it creates or reuses one uniquely prefixed organization and contact, associating the contact with the organization in the create request, then uses the production `buildAlbiActivity`, `reserveDelivery`, `completeDelivery`, and reconciliation code for one marked activity. It reruns the delivery claim and verifies exactly one matching activity marker. IDs are printed only as four-character suffixes. It never deletes records; operators manually remove the `H2A-SMOKE-<run id>` records after review. Credential-free self-test invokes this same smoke orchestration with fake adapters and checks read-only planning, create-plus-rerun exactly-once behavior, and that every missing write acknowledgement results in zero transport calls. It is a local orchestration test, not provider evidence.

As of this runbook revision, the test credentials and acknowledgements are absent, and the public Albi activity/source-marker contract is not verified. The script must stop before provider writes until all gates pass. The implementation's ephemeral smoke delivery store proves only the in-script retry path; it does not replace the durable Supabase delivery RPC race test below.

## Supabase deployment and secret setup

1. Use a disposable Supabase project for pre-pilot database checks. Review `supabase/h2a-schema.sql`; do not apply it directly to production as part of this runbook. Use the project's approved SQL migration/deployment workflow and record the resulting revision.
2. Ensure the project has the existing `companies`, `company_members`, and `super_admins` tables described in `AGENTS.md`. Apply the schema only after validating its prerequisites and SQL in a disposable database.
3. Generate a fresh 32-byte key, base64 encode it, and configure it only as the Netlify function environment variable `H2A_CREDENTIAL_KEY_V1`. Never add it to Vite-prefixed variables, source control, logs, or browser settings. `H2A_CREDENTIAL_KEY_V2` is the rotation form.
4. Rotate credentials using this supported manual workflow; no automatic re-encryption job exists. Add `H2A_CREDENTIAL_KEY_V2` while retaining V1, then deploy the current compatible functions. The keyring selects the highest configured version for encryption and retains older configured versions for decryption. For every tenant, have an authorized company admin open H2A Settings and replace both provider credentials (HubSpot token and Albi API key) with their current values. The `replace_credentials` action encrypts both envelopes with the active key, disables H2A, invalidates preflight, and resets mapping confirmation; after each replacement, repeat preflight and confirm option mappings before any reactivation. Track the complete tenant inventory and verify using authorized service-role SQL that every credential row has both version columns at 2, for example:

   ```sql
   select count(*) as total,
          count(*) filter (where hubspot_key_version = 2 and albi_key_version = 2) as migrated,
          count(*) filter (where hubspot_key_version <> 2 or albi_key_version <> 2) as not_migrated
   from private.h2a_credentials;
   ```

   Compare `total` with the expected set of tenants and require `not_migrated = 0`; verify the version columns directly without selecting ciphertext, IVs, tags, or plaintext. Keep V1 configured until all expected tenants are migrated and V2 read/decryption has been checked. If a tenant or deployment step fails, pause rotation, keep both keys configured, keep affected tenants disabled, and repair/re-save through Settings. Roll back only to a deployed function build that understands the versioned keyring; never remove a key while any stored envelope references it. Remove V1 only after the inventory and version checks pass. Do not export plaintext or envelopes.
5. Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `INTERNAL_CRON_SECRET` only in the server/function environment. Keep the service-role key server-side. For local function checks, use non-production values.
6. Apply neither production schema changes nor provider writes during preflight. Check the current [Supabase Row Level Security guide](https://supabase.com/docs/guides/database/postgres/row-level-security) and [database security guidance](https://supabase.com/docs/guides/security) before deployment.

## Per-company onboarding and activation

1. A super admin confirms the target company; a company admin is restricted to its own company. Confirm `user_app_access` and app membership independently.
2. Save that company's HubSpot private-app token and Albi API key through H2A Settings. Confirm the returned masks, then verify that credential changes disable H2A and invalidate old preflight state.
3. Run preflight and inspect every capability. Resolve missing HubSpot read scopes and Albi unsupported capabilities before continuing. Preflight must be `valid`; no direct SQL or UI state edit can substitute.
4. Review the tenant's Albi contact types, organization types, and activity types. Confirm the default mappings and each activity mapping. Confirm any organization-to-contact type inheritance explicitly.
5. Select the Pacific calendar start date and review the estimated counts. Confirm the date means occurrence time, not HubSpot creation time.
6. Enter dry run. Review the completed summary, sample conflicts, safe proposed actions, and skipped categories. Dry run must not create Albi records, claim live deliveries, or advance live cursors.
7. Keep the company disabled if required update/association capabilities or other preflight checks remain unavailable. Only a completed dry run with current valid preflight and confirmed mappings can unlock the Settings activation control.
8. For the eventual first live pilot, use one explicitly approved company. Monitor the first run and the tenant's configured email recipients. Check `h2a_sync_runs`, item results, deliveries, conflicts, audit events, and cursor boundaries through the authorized application path.
9. Add later companies independently. Repeat credential, preflight, mapping, date, dry-run, and sign-off steps per company; never copy credentials or option IDs between tenants.

## Manual recovery and disablement

- A failed or paused run is resumed through the existing admin Run now / retry path after reviewing its sanitized status and item outcomes. Do not reset cursors or delete delivery rows to force a retry.
- Delivery states `delivered` and `reconciled` are terminal. A stale `reserved` or due retryable `failed` claim must reconcile against Albi before another create. If Albi activity listing or exact marker matching fails, stop retries and investigate the tenant manually.
- Conflict resolution is idempotent and schedules a targeted resume. If it reports saved-but-resume-pending, use the authorized retry path; do not create a duplicate mapping manually.
- Disable the company in Settings before rotating credentials, changing mappings, or investigating. Disabling prevents new scheduled work but does not roll back records already created in Albi.
- Check `H2A` run alert delivery and tenant-specific configured recipients after failures. Notifications omit provider errors and activity contents; troubleshoot from sanitized run status and provider dashboards.
- There is no automatic cleanup. Preserve audit and delivery state unless an approved retention procedure says otherwise.

## Required disposable-database and concurrency checks

Use at least two independent SQL sessions against a disposable Supabase database with the actual schema and roles. Capture sanitized SQL, role, expected/actual counts, and query plans. These are not proven by the static contract suite.

1. **Lease claim/heartbeat/release race:** synchronize two `h2a_claim_lease` calls for one company. Exactly one wins. Let its lease expire, let a successor claim with another token, then confirm the stale owner's heartbeat and release cannot change/delete the successor lease. Confirm service-role access only.
2. **Delivery reserve/transition race:** synchronize identical six-part delivery identities. Exactly one active attempt wins. Reclaim only stale `reserved` or due retryable `failed` rows, increment `attempt_count`, and prove an old generation cannot transition after a newer claim. Delivered/reconciled rows never become create-eligible.
3. **Daily claim retry:** race duplicate `(company_id, business_date)` claims. Exactly one owner claims; duplicate dispatched claims no-op. Expire a pending claim and verify a new token can retry without changing the stable scheduled run identity.
4. **Conflict resolution, same source/different target:** race two resolutions selecting different Albi target IDs for the same `(company, portal, object kind, HubSpot ID)`. Exactly one target persists; the loser receives `mapping_conflict`; no mapping replacement occurs.
5. **Resolver vs generic mapping writer:** race `h2a_resolve_conflict` against `h2a_save_mapping` in both target orderings for the same source. Exactly one different target wins, and the other receives `mapping_conflict`. Verify identical-target replay retains review metadata and emits no duplicate event or resume intent.
6. **Resume intent claim/finish:** race claims for a single pending resume. Only one lease token wins. A stale owner cannot finish/release a successor's claim. A failed dispatch returns to pending; only accepted dispatch is terminal; retries preserve the stable resume ID.
7. **Keyset pagination under insertion:** for both started and queued run query branches, insert new rows between pages and check tuple cursor `(effective timestamp, id)` ordering has no gaps or duplicates relative to the documented descending order. Verify each branch contains the caller's authorized `company_id`, returns at most `limit + 1`, and never uses offsets. Capture `EXPLAIN (ANALYZE, BUFFERS)` for supported/representative page queries.
8. **RLS matrix:** test authenticated member, company admin, unrelated member, super admin, anon, and service role. Tenant members read only their company's non-secret rows; unrelated users and anon read none; super admins can read tenant rows; browser roles cannot write; private credentials, execution leases, daily claims, and conflict-resume fencing tokens are not browser-readable; service-role Netlify paths and RPC grants work. Explicitly verify `h2a_execution_leases.owner_token` is not selectable by `authenticated`.
9. **Run current Supabase advisors** after applying schema to the disposable database, review every finding on the new H2A objects, and fix security issues before pilot. Record Postgres/Supabase versions and advisor output. Advisor and live SQL checks were not run in this environment.

## Local function and browser gates

Start `npm run dev:local` only with a local disposable database and non-production environment values. Check each H2A route without Authorization and expect `401` for user endpoints; authorized member reads should succeed while member mutations return `403`. Use a company-admin test user to prove requested alternate company IDs return `403`; use a super-admin test user to prove selected-company results remain scoped. Run a production authenticated browser pass for member/admin/super-admin views, tenant changes, polling success/failure/manual refresh, conflict stale refresh, many-to-one consent, keyboard focus, modal busy behavior, and narrow/short viewports. Never add an auth bypass to make these checks pass.

## Verification record for this checkout

Safe local gates are `npm run test:h2a`, `npm run test:h2a:schema`, `npm run test:h2a:e2e`, `npm run build`, and all non-live `node scripts/test-*.mjs` regressions. The checkout's current secrets/credentials are unset. The following remain unverified: provider-authenticated reads, isolated provider writes, actual API response/pagination semantics, disposable SQL parsing, RLS/grants, Supabase advisors, transaction/concurrency races, local unauthenticated function responses, and authenticated browser interaction. Record exact commands and outputs in the task report; do not describe static tests as live evidence.
