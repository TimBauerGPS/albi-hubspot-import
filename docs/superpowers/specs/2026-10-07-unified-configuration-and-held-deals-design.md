# Unified Configuration and Held Deals Design

Date: 2026-10-07
Status: Approved in conversation; awaiting written-spec review

## Summary

The HubSpot Importer is an admin-only operations application. Its existing Albi-to-HubSpot importer and new HubSpot-to-Albi sync must share one company-scoped HubSpot private-app credential, expose configuration through one coherent admin experience, and keep operational exception handling separate from setup.

The existing Held Deals workflow remains necessary because HubSpot-to-Albi synchronization reduces, but does not eliminate, cases where an Albi job names a referrer that cannot be matched safely in HubSpot. Held Deals becomes an admin exception queue. A manager sends reviewed instructions to the assigned salesperson, the salesperson corrects the job in Albi and notifies the manager, and the manager may retry selected jobs immediately or allow the next full import to resolve them.

## Goals

- Present one company-scoped Configuration area for both synchronization directions.
- Use one company-scoped set of importer rules regardless of which admin operates the app.
- Use one encrypted HubSpot credential as the source of truth for both directions.
- Keep the Albi API key independently managed because only HubSpot-to-Albi requires it.
- Remove HubSpot credential plaintext and masking work from the browser.
- Preserve explicit preflight, mapping confirmation, dry-run, and live-activation gates for HubSpot-to-Albi.
- Keep Held Deals useful under two-way synchronization, with accurate instructions for salespeople who do not have app access.
- Add a safe direct retry that reads fresh source data rather than replaying stale held-row data.
- Preserve automatic held-deal reprocessing during every normal full import.

## Non-goals

- Giving salespeople access to this application.
- Automatically sending Held Deals email without manager review.
- Making a Held Deals retry time-sensitive or replacing the normal full import.
- Guessing an undocumented Albi project-read endpoint.
- Making HubSpot-to-Albi live activation possible while required Albi update and association contracts remain unverified.
- Combining setup with the HubSpot-to-Albi Overview or Conflicts operational screens.

## Access model

Only company admins and super admins will be granted `user_app_access` for this app. The access row remains the application door; `company_members.role` and the shared `super_admins` table remain the authorization sources inside the app.

All configuration reads and mutations are company-scoped. Company admins operate only on their assigned company. Super admins must select a company explicitly and every server endpoint independently validates that selection. Configuration mutations, credential changes, Held Deals email preparation, blacklisting, and direct retry require company-admin or super-admin authorization.

The UI does not need a member editing mode for normal operation. Server authorization remains defensive: an authenticated non-admin who somehow receives app access may not mutate configuration or operate Held Deals.

## Information architecture

`/configuration` becomes the unified setup surface with three URL-addressable tabs:

1. **Connections** — shared HubSpot connection and the H2A-only Albi connection.
2. **Albi to HubSpot** — pipeline mappings, exclusions, sales team, Google Sheet source, and existing importer checks.
3. **HubSpot to Albi** — preflight results, start date, Albi option mappings, notification recipients, dry-run readiness, and activation.

The super-admin company selector appears once at the Configuration level and controls every tab. Company admins see their fixed company context.

The HubSpot-to-Albi Overview and Conflicts pages remain separate operational destinations. Existing `/hubspot-to-albi/settings` links redirect to the HubSpot-to-Albi tab in Configuration while preserving an authorized selected-company context. Existing `/configuration` links continue to work and default to Connections or the last valid tab.

## Shared provider credential model

### Canonical storage

Introduce a private company-provider credential store with one encrypted envelope per `(company_id, provider)`. Providers initially are `hubspot` and `albi`. Each row stores ciphertext, IV, authentication tag, key version, updater, and timestamps. Encryption and decryption stay inside Netlify functions using the configured H2A keyring; plaintext never enters SQL, logs, browser responses, or frontend state.

The provider-row design allows a HubSpot credential to exist before an Albi credential and avoids making the existing H2A two-envelope row the long-term credential abstraction. Public RPCs accept and return ciphertext envelopes only, are executable only by the service role, use fixed search paths, and preserve tenant-scoped authorization in the calling functions.

### Server consumption

A shared server utility resolves the authorized company, loads the requested provider envelope, decrypts it, and returns the secret only to the calling function. Both the legacy importer functions and H2A functions use this utility.

During migration, legacy `hs_user_config` rows may remain available to the server for rollback. The unified browser stops reading or mutating them after company cutover. Frontend responses expose only non-secret company configuration, server-generated credential masks, and verification status.

### Company importer configuration

Pipeline mappings, excluded suffixes, sales team, blacklist, Google Sheet source, and importer verification status move to one company-scoped importer configuration row. Server endpoints become the only browser-facing read/write path for this configuration. An admin's user ID remains audit metadata, not the ownership key.

Migration inventories all legacy `hs_user_config` rows associated with a company. Identical values collapse safely. Different nonempty values for the same setting produce an explicit admin migration conflict; the migration does not silently choose the most recent user row. The existing importer switches to the company row only after required conflicts are resolved and its Google Sheet and HubSpot checks pass.

### HubSpot credential lifecycle

The Connections tab is the single management surface for the shared HubSpot token. Saving or replacing it:

- validates a nonempty input server-side;
- encrypts it with the active credential key version;
- verifies the HubSpot portal identity and required scopes;
- records the company and authorized actor;
- marks the Albi-to-HubSpot connection check as unchecked;
- disables H2A and invalidates its preflight and option confirmation;
- never returns the plaintext token.

The same private-app token may serve both directions only if it has the union of required scopes. The UI reports missing capabilities through the relevant connection checks rather than requiring a second token.

Changing the Albi API key invalidates only H2A readiness, because the existing importer does not use that API credential.

### Legacy credential migration

Migration is additive and fail-closed:

1. Inventory company-associated `hs_user_config.hubspot_api_key` values server-side.
2. If a company has exactly one distinct nonblank token, validate its portal identity and encrypt it into the canonical provider store.
3. If multiple distinct tokens exist for one company, do not choose silently. Show an admin migration conflict requiring an explicit canonical token.
4. Switch both importer directions to the canonical provider store only after the encrypted value verifies successfully.
5. Stop selecting or updating `hubspot_api_key` from the browser immediately after cutover.
6. Retain the legacy column temporarily for rollback, with browser grants removed. Clear legacy values only in a separately approved, audited cleanup after every company is verified on the new store.

No credential is copied between companies, and no migration emits plaintext or encrypted envelopes in logs.

## Unified Configuration behavior

The Connections tab shows safe masks, portal identity, last verification time, and status for HubSpot and Albi. It clearly labels HubSpot as shared by both directions and Albi as required only for HubSpot-to-Albi.

The Albi-to-HubSpot tab preserves existing pipeline, blacklist/exclusion, sales-team, Google Sheet, and importer checks using the one company importer configuration row. It no longer contains a separate HubSpot key editor.

The HubSpot-to-Albi tab reuses the existing guided setup runway. It consumes the shared HubSpot connection status and retains all existing gates:

- both required provider credentials;
- valid provider preflight;
- selected Pacific start date;
- confirmed tenant-specific option mappings and inheritance choices;
- completed dry run after the date lock;
- explicit live activation.

Credential replacement always leaves H2A disabled until those gates are repeated. Consolidating the page does not weaken activation safety.

## Held Deals under two-way synchronization

### Why Held Deals remains

A held deal means an Albi job's referrer cannot be matched safely to a HubSpot contact or company. HubSpot-to-Albi synchronization lowers the frequency when the referrer originated in HubSpot, but a hold may still occur when a referrer was created directly in Albi, identity fields changed, duplicates exist, a record was deleted or merged, or synchronization was disabled or delayed.

The correct resolution is for the salesperson to update the job in Albi to use the correct contact or organization. The manager/admin controls all application actions.

### Company-scoped queue

Held Deals becomes company-scoped rather than browser-managed through user-owned rows. Existing creator/user identifiers may be retained for provenance, but listing, blacklisting, email preparation, and retries use authenticated server endpoints and company authorization. The active uniqueness rule is company plus job ID so multiple admins do not create parallel queues for the same company job.

New held records store the Albi project URL already available from CSV or Google Sheet parsing. Only a syntactically valid HTTPS URL is rendered as a link; other values are treated as absent. Existing rows without a valid URL continue to render without a direct link.

### Manager-reviewed email

Email remains a draft prepared for the manager; it is not sent automatically. Drafts remain grouped by configured salesperson. They contain no link to this application and no instruction to use HubSpot, run a sync, or perform an import.

Recommended copy:

> Subject: Action needed in Albi: correct referrer for held job(s)
>
> Hi [name],
>
> The jobs below cannot be sent to HubSpot because the selected referrer in Albi does not match a HubSpot contact or company.
>
> For each job, open it in Albi, select the correct existing referrer contact or organization, and save the job. Please avoid creating a duplicate record. When finished, let your manager know so the jobs can be retried.
>
> [Job ID — Job name — Current referrer — Open job in Albi]
>
> Thank you.

If a salesperson cannot be matched to the configured sales team, the manager receives a catch-all draft that asks the manager to identify the responsible salesperson. It does not suggest that an unassigned salesperson use the app.

### Direct retry

The manager may select unresolved rows and choose **Retry selected**. This is additive; every normal full import still rechecks all unresolved held deals.

A direct retry must not replay the stored referrer because that value predates the salesperson's correction. The server:

1. authorizes the company admin or super admin and validates every selected held ID belongs to that company;
2. requires the company's configured Google Sheet source;
3. fetches and parses the latest sheet using the existing import parser;
4. selects the exact requested job IDs from the fresh source;
5. reuses the importer matching and deal-creation path for those rows;
6. returns a per-job result: resolved, still held, missing from source, already resolved, blacklisted, or failed;
7. refreshes the Held Deals list without affecting unrelated jobs.

The request accepts at most 50 selected rows. It uses an atomic company import lease shared with full Google Sheet imports, so a direct retry and a full import cannot process the same company's jobs concurrently. A duplicate retry reports that import work is already in progress rather than starting a second worker. It preserves existing HubSpot idempotency and association behavior. If no Google Sheet is configured, the UI explains that a fresh CSV/full import is required; it never claims a stale held row was rechecked against Albi.

## Error handling and auditability

- Credential and provider errors are sanitized before reaching the browser.
- Credential changes record company, actor, provider, key version, and timestamp without secret material.
- Migration conflicts remain visible and block cutover for that company.
- Direct retry returns item-level outcomes so one bad job does not block unrelated selected jobs.
- A missing job in the latest sheet remains held and is reported; it is not silently resolved.
- Repeated retry of a resolved row is a harmless no-op.
- Blacklisting remains explicit, admin-only, and separate from retry.
- Existing full-import history remains the source of import totals; direct retries create an attributable import/retry record rather than mutating history invisibly.

## Testing requirements

### Credentials and configuration

- One encrypted company HubSpot credential is consumed by both directions.
- One company importer configuration is consumed by every admin and background import for that company.
- Browser payloads and direct Supabase browser queries never contain the token or encrypted envelope.
- Company admins cannot select another company; super-admin selection remains tenant-scoped.
- Replacing HubSpot invalidates both direction-specific checks and disables H2A.
- Replacing Albi invalidates H2A only.
- Legacy migration handles zero, one, and multiple distinct company tokens without guessing.
- Legacy non-secret settings migrate only when identical or explicitly resolved by an admin.
- Old Configuration and H2A Settings URLs resolve to the correct unified tab.

### Held Deals

- Held creation stores company scope and an optional validated Albi project URL.
- Email copy contains only Albi correction instructions and no app or HubSpot action for the salesperson.
- Retry reads the latest Google Sheet row and never relies on the stale stored referrer.
- Selected IDs are tenant-scoped, bounded, and isolated item by item.
- The company import lease prevents overlap between direct retries and full imports.
- Missing source rows, still-unmatched referrers, already-resolved rows, and successful resolutions are distinguishable.
- Successful retry creates or updates the HubSpot deal once, associates the corrected referrer, and resolves the held row once.
- A normal full import continues to resolve held deals without using the direct retry.
- Companies without a configured sheet receive an actionable fresh-import requirement.

### Regression and security

- Existing CSV and Google Sheet imports, blacklisting, matching, association replacement, and fingerprinting regressions remain green.
- H2A preflight, dry-run, activation, conflict, scheduler, and idempotency suites remain green.
- RLS and RPC grants are verified on a disposable database before production migration.
- Production build and authenticated admin/super-admin browser flows pass before rollout.

## Rollout sequence

1. Add the generic private provider credential schema, company importer configuration, company import lease, and service-role RPCs without switching readers.
2. Add server credential/configuration utilities and migration diagnostics.
3. Migrate and verify one test company; block on ambiguous legacy tokens or conflicting importer settings.
4. Switch both directions and background imports for that company to the shared credential/configuration and rerun their checks.
5. Ship the unified Configuration UI and compatibility redirects.
6. Add company-scoped Held Deals endpoints, project URLs, revised drafts, and bounded fresh-source retry.
7. Run full regression, disposable-database security checks, lease races, and authenticated browser QA.
8. Expand company by company.
9. Remove browser access to the legacy token and user configuration immediately after cutover; defer plaintext cleanup until every company is verified and rollback is no longer needed.

At no point does this rollout enable H2A live writes for a company that has not independently passed its existing preflight, mapping, dry-run, and explicit activation gates.
