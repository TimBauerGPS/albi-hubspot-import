# HubSpot-to-Albi Relationship and Activity Sync Design

Date: 2026-10-02
Status: Revised written specification; awaiting user review
Target application: Existing `albi-hubspot-import` React, Netlify, and Supabase application

## 1. Purpose

Add a new HubSpot-to-Albi sync module to the existing HubSpot Importer application. The module will ensure that people who are actively marketed to in HubSpot already exist in Albi as contacts and organizations before they refer a job. It will also copy selected HubSpot relationship activities into Albi so staff and corporate users can see relevant CRM activity from Albi.

HubSpot is the source of truth for this module. The module writes only from HubSpot to Albi. It must not update HubSpot from Albi or alter the existing Albi-to-HubSpot job and deal workflow.

The design must support the user's company first and be reusable by roughly fifteen restoration companies that use Albi and may also use HubSpot.

## 2. Goals

- Create or link Albi contacts for HubSpot contacts with new qualifying activity.
- Create or link Albi organizations for the companies associated with those contacts.
- Copy qualifying HubSpot activities to the correct Albi contact or organization.
- Avoid unsafe merges by routing uncertain matches and conflicting nonblank values to human review.
- Provide isolated navigation, configuration, sync history, conflicts, and operational status for this direction of sync.
- Support tenant-specific HubSpot and Albi credentials with a guided permission preflight.
- Run automatically overnight, with a manual run option for testing and recovery.
- Make every write idempotent and safely retryable.

## 3. Non-goals for Version One

- No Albi-to-HubSpot contact, organization, or activity updates.
- No real-time HubSpot webhook ingestion.
- No attachment transfer.
- No transfer of full email threads; only a concise activity description is copied.
- No bulk marketing campaign email events; only direct CRM email engagements are copied.
- No propagation of later edits or deletions after an activity has been copied successfully.
- No HubSpot OAuth flow. Company admins supply a HubSpot private-app token.
- No configurable nightly schedule. All companies run on the fixed schedule.
- No automatic overwrite of a different, nonblank Albi value.

## 4. Architectural Placement

Implement the feature as a separate module inside the existing `albi-hubspot-import` application.

Use an isolated module inside the current application rather than extending the existing deal-import flow or introducing a separate worker service. The new module may share:

- Supabase authentication and company membership
- app-level authorization and admin roles
- deployment and runtime infrastructure
- common server-side secret storage
- notification infrastructure
- existing HubSpot client utilities where their interfaces are suitable

The new module must have separate:

- backend entry points and orchestration code
- HubSpot-to-Albi service modules
- database tables and row-level security policies
- run history, cursors, mappings, and idempotency records
- conflict queue and resolution actions
- UI routes and top-level navigation group
- logging and failure reporting

This boundary prevents failures or logic changes in the new direction from affecting the current Albi-to-HubSpot workflow.

Netlify dispatches one resumable background job per company. Work is divided into durable batches so a company can continue in a later invocation without exceeding the platform's background-function execution limit. The module must keep its orchestration behind service interfaces so the worker can move to a dedicated queue service later without changing matching or UI contracts.

Keep HubSpot and Albi API details behind separate adapter modules. Pin the new HubSpot adapter to the current date-versioned API available when implementation begins rather than inheriting the existing importer's legacy `/crm/v3` paths. Record the selected API version centrally and verify required activity properties, associations, scopes, pagination, and search limits with contract tests. Treat the public Albi v5 documentation as a starting point, then verify every required read, create, update, association, option, and activity endpoint against a sandbox before live activation.

## 5. User Experience and Navigation

Add a distinct top-level navigation group named **HubSpot to Albi**. Do not mix these screens into the existing Import or Held Deals pages.

The group contains:

1. **Overview**
   - enabled or disabled state
   - last successful run
   - current or most recent run status
   - counts for contacts, organizations, activities, conflicts, skips, and failures
   - recent run history
   - a `Run now` action

2. **Conflicts**
   - badge showing unresolved conflict count
   - side-by-side HubSpot and Albi values
   - match evidence and reason for review
   - HubSpot value shown as the recommended value
   - actions to link an existing record, create a new record, approve selected field changes, or skip
   - status and audit history for resolved items

3. **Settings**
   - masked HubSpot private-app token
   - masked Albi API key
   - connection and permission status for each system
   - guided setup and missing-permission checklist
   - `Sync activities starting from` date picker, defaulting to the current date
   - quick-setup dropdowns populated from that company's Albi options
   - confirmed defaults for new contacts and organizations
   - confirmed HubSpot-to-Albi activity type mappings
   - `Inherit contact type from organization when possible` control and mapping preview
   - activation control, blocked until preflight succeeds

Only company admins may edit credentials, start dry runs, activate the sync, run it manually, or resolve conflicts. Read-only operational visibility may follow the app's existing member permissions.

Super admins receive a company selector within the HubSpot-to-Albi module. Company admins and members are locked to their own company. Every backend request must resolve and authorize the selected company independently of the browser-provided identifier.

## 6. Credentials and Preflight

Credentials are submitted only to admin-authorized server-side functions and never returned to the browser. Encrypt each secret with authenticated AES-256-GCM using a versioned master key stored in the Netlify environment. Store only ciphertext, initialization vector, authentication tag, and key version in a server-only table outside the browser-exposed schema. The stored format must support master-key rotation. The UI displays only masked values and validation state.

Before activation, preflight must:

- authenticate the HubSpot private-app token
- verify access to contacts and companies
- verify read access to calls, meetings, direct CRM email engagements, messages or communications, and notes
- authenticate the Albi API key
- verify Albi contact and organization reads
- verify the endpoints required to create contacts and organizations
- verify the endpoints required to update contacts and organizations and associate contacts with organizations
- verify activity creation capability
- load the company's available Albi contact types, organization types, relationship types, referral sources, relationship statuses, and activity types
- identify missing permissions or unavailable required options by human-readable name

Preflight must not create production records. The separate rollout smoke test uses an Albi sandbox or explicitly isolated test data.

Settings presents required Albi choices as dropdowns instead of raw identifiers. It may preselect strong normalized-name matches, but an admin must confirm the tenant default contact type, required organization defaults, and every activity-type mapping before activation. Optional defaults remain collapsed during quick setup.

When creating a contact, the module first uses the confirmed mapping from the associated organization's Albi type to an Albi contact type. If no confirmed mapping applies, it uses the company's confirmed default contact type. It creates a configuration conflict only when neither is available. Organization and contact type identifiers must never be treated as interchangeable merely because their labels match.

## 7. Schedule, Backfill, and Activation

- Run once per America/Los_Angeles calendar day on the first scheduler tick at or after 2:00 a.m. This is normally 2:00 a.m.; on the daylight-saving spring-forward date it may be approximately 3:00 a.m.
- Provide a manual `Run now` action.
- Use an atomic per-company daily claim so repeated scheduler invocations cannot queue the same company twice for one local date.
- Let an admin choose `Sync activities starting from`, defaulting to the current date. Interpret the selected calendar date from midnight in America/Los_Angeles.
- Apply the selected start date to the activity's HubSpot occurrence timestamp, not the date on which a user entered the record into HubSpot.
- Before the first dry run, show an estimated eligible activity count and warn when the selected range is large.
- Model setup states explicitly as `disabled`, `ready`, `dry_run`, and `live`.
- Starting the first dry run fixes the initial synchronization start date. Dry runs do not create Albi records, consume idempotency keys, or advance live cursors.
- When live mode is enabled, process eligible activity from the selected start date, including activity created while dry-run results were under review.
- If an admin later selects an earlier date, create a separate controlled backfill job rather than rewinding the ongoing nightly cursor.
- Partition backfills into resumable date windows with their own durable checkpoints.
- Process only enabled companies whose preflight status remains valid.

Maintain a durable cursor per company and HubSpot activity object type rather than one cursor for the whole company. Each cursor represents the last durably processed activity boundary, not merely the last attempted run. Use a stable timestamp-plus-object-ID boundary and a small overlap to protect against delayed indexing and pagination edges. A failed run must not silently advance past unrecorded work.

## 8. Qualifying HubSpot Activities

Version one copies:

- meetings
- calls
- direct CRM email engagements, including logged one-to-one sales or inbox emails
- text messages or the applicable HubSpot communications records
- notes

Each Albi activity contains:

- mapped Albi activity type
- original HubSpot activity date and time
- HubSpot owner name when available
- subject or title when available
- outcome when available
- concise description or body excerpt
- HubSpot activity identifier as the external source identifier
- a source label indicating HubSpot

Attachments and full email threads are excluded.

Bulk marketing campaign sends are excluded. Later edits or deletions of an already copied HubSpot activity do not change the Albi activity in version one; the module may retain the latest source metadata in its audit data.

Targeting rules are:

- For each associated HubSpot contact that resolves safely, create one Albi activity on its resolved Albi contact. Route any unresolved or ambiguous associated contact separately to review without suppressing safe targets.
- Do not also create an organization activity for those contact-targeted copies; Albi rolls associated contact activity into the organization timeline.
- When there is no associated contact and exactly one company resolves safely, create one organization-level activity.
- Route missing or ambiguous target associations to review.

The activity idempotency key is company, HubSpot portal, HubSpot activity object type, HubSpot activity identifier, and Albi target identifier. Prefer a native Albi external-source or idempotency field when one exists. Otherwise append a short visible source footer, such as `Source: HubSpot email 123456`, and reconcile uncertain retries by querying recent activities for that marker before creating another record.

Activity type IDs must not be hard-coded globally. Load the available options from each company's Albi account, use normalized names only to suggest mappings, require admin confirmation, and store the confirmed tenant-specific mapping. A missing or ambiguous required activity type blocks that item and creates an actionable configuration conflict.

## 9. Data Flow

For each enabled company:

1. Acquire a per-company execution lock so scheduled and manual runs cannot overlap.
2. Read the selected synchronization start date, per-object-type durable cursors or backfill checkpoint, credentials, and tenant mappings.
3. Query each qualifying HubSpot activity object type from its own durable cursor, or from a backfill window, using a small overlap before the cursor.
4. Remove already-recorded target copies using the complete activity idempotency key.
5. Resolve all associated HubSpot contacts and companies according to the targeting rules.
6. Normalize contact and organization fields for comparison.
7. Resolve or create the Albi organization first.
8. Resolve or create the Albi contact and associate it with the organization when applicable.
9. Fill safe blank fields or create a conflict for unsafe differences.
10. Create one Albi activity for each resolved contact target, or one organization activity when the organization-only fallback applies.
11. Record each outcome durably.
12. Advance only the affected object-type cursor or backfill checkpoint through its durable processing boundary.
13. Release the lock and publish run totals and notifications.

One record's conflict must not prevent unrelated records in the same run from being processed. If a background invocation approaches its execution limit, it must finish the current durable item boundary, record that more work remains, and enqueue or expose the next resumable batch.

## 10. Normalization

Normalize only for comparison and for values with an explicit Albi format requirement. Preserve the source value in audit data.

### Phone numbers

- Compare phone numbers by normalized digits.
- For a standard ten-digit United States number, write `###-###-####` to Albi.
- Strip common punctuation and a leading United States country code before formatting.
- Do not invent or truncate digits.
- Preserve extensions when Albi supports them; otherwise place the extension in review rather than silently dropping it.
- Route unsupported or ambiguous international formats to review.

### Email addresses

- Trim whitespace and compare case-insensitively.
- Preserve the HubSpot spelling when writing a new or blank Albi field.

### Names and domains

- Trim and collapse repeated whitespace.
- Compare names case-insensitively and punctuation-insensitively.
- Normalize website domains by removing protocol, `www`, path, trailing slash, and case differences.
- A normalized name alone is never sufficient to auto-link a contact or organization.

### Addresses

- Normalize case, whitespace, and common punctuation for corroboration.
- Address normalization is supporting evidence, not a reason to overwrite a different nonblank address automatically.

## 11. Contact Matching and Updates

Auto-link a HubSpot contact only when exactly one Albi contact matches either:

- normalized email, or
- normalized phone number

If email and phone point to different Albi contacts, create a conflict. If multiple records share the matching email or phone, create a conflict. A name-only candidate always goes to review.

After a contact is linked:

- fill a blank Albi field automatically from HubSpot
- leave equal normalized values unchanged
- place different, nonblank values in review
- show HubSpot as the recommended value without applying it automatically

When no safe match exists, the review queue allows the user to link an existing Albi contact or create a new one. A reviewer may explicitly choose to create a new person even when a same-name Albi record exists.

Albi requires both first and last name for contact creation. If either is missing in HubSpot, do not invent a placeholder. Create a conflict that allows the reviewer to link an existing record, correct the source data, or explicitly supply the missing value.

Persist the approved HubSpot-to-Albi record mapping so later runs do not repeat identity matching. Field conflicts may still recur when source data changes.

If an Albi contact is already mapped to a different HubSpot contact, do not create a second mapping automatically even when other match evidence is exact. Route it to review. A reviewer may explicitly approve a many-HubSpot-to-one-Albi mapping, and the audit trail must retain that decision.

## 12. Organization Matching and Updates

Auto-link a HubSpot company to an Albi organization when either:

- exactly one organization has the same normalized website domain, or
- exactly one organization has the same normalized name and at least one corroborating field matches: normalized phone number or normalized street address

A company-name-only candidate goes to review. Multiple candidate organizations or contradictory evidence also go to review.

Apply the same field-update policy as contacts: blank Albi fields may be filled, while different nonblank values require review. Persist approved company-to-organization mappings.

If an Albi organization is already mapped to a different HubSpot company, route a proposed second mapping to review. A reviewer may explicitly approve a many-HubSpot-to-one-Albi mapping.

## 13. Conflict Resolution

Every conflict record includes:

- tenant and source record identifiers
- conflict type and reason
- normalized match evidence
- source snapshot and candidate Albi snapshots
- proposed field changes
- originating run and activity
- status, resolver, resolution action, and timestamps

Supported actions are:

- link to an existing Albi record
- create a new Albi record
- approve selected HubSpot field values
- retain selected Albi field values
- skip the current item

Resolution actions must be idempotent. After a successful resolution, the pending activity resumes without waiting for the next full nightly scan. All decisions remain auditable.

Reviewers may approve a many-to-one identity mapping, but the system must never infer one automatically.

## 14. Reliability and Error Handling

- Use bounded retries with backoff for rate limits, timeouts, and transient server errors.
- Do not retry authentication, permission, validation, or deterministic data errors indefinitely.
- Store item-level outcomes so a partial run can resume safely.
- Use company, HubSpot portal, HubSpot activity object type, HubSpot activity identifier, and Albi target identifier as the activity idempotency key.
- Use durable HubSpot-to-Albi mappings for contacts and organizations.
- Prevent overlapping runs with an atomic per-company lease, heartbeat, and stale-lease recovery. A select-then-update lock is not sufficient.
- Keep unresolved failures visible with a manual retry action.
- Redact tokens and sensitive payload fields from logs.
- Record enough structured context to diagnose an error without storing full email threads.

## 15. Notifications

Do not email on successful clean runs.

Email that company's admins when:

- a run creates new unresolved conflicts, or
- a run fails or remains partially failed after retries

Resolve recipients from current `company_members.role = 'admin'` users in the affected company. Super admins are not included merely because they are global super admins; they receive a tenant's notifications only when explicitly configured or also assigned as that company's admin. Reuse the existing Resend transport where suitable, but keep notification templates and tenant recipient resolution separate from the current import-alert implementation.

The app also displays:

- an unresolved-conflict badge in the HubSpot-to-Albi navigation group
- most recent run status on the Overview page
- per-run totals and error summaries

Notifications must be tenant-scoped and must not expose one company's data to another company.

## 16. Data Model Boundaries

Use new, tenant-scoped tables or equivalent isolated storage for:

- HubSpot-to-Albi company configuration and activation state
- encrypted credential references and preflight results
- per-company cursors and execution locks
- contact mappings
- organization mappings
- activity idempotency and outcome records
- sync runs and aggregate counts
- item-level processing results
- conflicts and resolution audit events
- tenant-specific Albi activity type mappings
- confirmed tenant defaults and organization-type-to-contact-type mappings
- per-object-type live cursors and separately checkpointed backfill windows
- per-company daily schedule claims

Every table containing company data must include company ownership and enforce row-level security consistent with the existing app's `company_members` and `super_admins` model. Server-side service-role operations must explicitly scope every query by company.

Place credential ciphertext in server-only storage that is not exposed through the browser Data API. Browser-readable operational tables must have RLS enabled and separate `SELECT`, `INSERT`, `UPDATE`, and `DELETE` policies appropriate to company members, company admins, and super admins. Do not copy the existing browser-writable `hs_user_config.hubspot_api_key` pattern into this module.

## 17. Testing Strategy

### Unit tests

- United States phone normalization and Albi formatting
- country-code, extension, malformed, and international phone cases
- email, domain, name, and address normalization
- contact and organization match decision tables
- conflicting evidence and multiple-candidate behavior
- blank-field fill versus nonblank conflict behavior
- HubSpot-to-Albi activity type mapping
- activity payload summarization
- cursor overlap and advancement
- independent activity-type cursors and timestamp-plus-ID boundaries
- date-window backfill partitioning and resume
- daylight-saving schedule behavior and daily claim idempotency
- idempotency and retry behavior
- uncertain Albi write reconciliation using native external IDs or source markers
- conflict resolution actions
- confirmed option selection, contact-type inheritance, and default fallback
- direct-email inclusion and marketing-email exclusion
- multi-contact activity fan-out without duplicate organization activity
- many-to-one mapping review behavior
- tenant isolation helpers

### Integration tests

- paginated HubSpot activity reads
- activity-to-contact and company association traversal
- Albi contact, organization, and activity creation
- permission and credential preflight failures
- transient retry and permanent failure classification
- partially successful runs and safe resume
- background execution-limit continuation
- dry-run behavior that performs no writes and advances no live cursors
- notification triggers and suppression on clean runs

Use recorded or synthetic fixtures with secrets removed. Do not depend on live production data in automated tests.

### Live smoke test

Using an Albi sandbox or explicitly isolated test records:

1. validate both credentials
2. retrieve tenant activity types
3. create one test organization
4. create one associated test contact
5. create one test activity
6. verify idempotent rerun behavior
7. confirm the records display correctly in Albi

## 18. Rollout

1. Deploy schema and UI with the module disabled.
2. Configure credentials, select the synchronization start date, confirm tenant-specific option mappings, and pass preflight for the user's company.
3. Start the first dry run, fixing the initial start date, and inspect proposed matches, creations, field fills, activity fan-out, and conflicts.
4. Resolve unexpected mapping or normalization behavior.
5. Enable writes for a short single-company pilot.
6. Verify nightly execution, notifications, deduplication, and manual recovery.
7. Onboard additional companies individually only after each company's preflight and dry run pass.

## 19. Acceptance Criteria

The module is ready for broader rollout when:

- the existing Albi-to-HubSpot workflow remains behaviorally unchanged
- a company cannot activate without valid credentials and required permissions
- a company cannot activate until required Albi defaults and activity mappings are explicitly confirmed
- only activities whose occurrence timestamps are on or after the selected synchronization start date are eligible
- a dry run creates no Albi data, consumes no idempotency keys, and advances no live cursor
- an earlier post-activation start date launches a controlled backfill without rewinding nightly cursors
- qualifying new activity causes safe organization-first contact synchronization
- exact safe matches link automatically according to the approved rules
- name-only and conflicting matches never write without review
- blank fields fill automatically and different nonblank values wait for review
- United States phone numbers are written to Albi in `###-###-####` format
- HubSpot activities create the correct tenant-specific Albi activity types
- direct CRM email engagements are included and bulk marketing campaign sends are excluded
- multi-contact activity creates one idempotent target copy per safely resolved contact and no duplicate organization copy
- rerunning the same live or backfill window does not duplicate contacts, organizations, or activities
- one conflict or failed item does not block unrelated items
- admins receive only the approved exception notifications
- tenant data, credentials, conflicts, and notifications remain isolated
- super admins can select a company, while company admins and members remain locked to their own tenant
- the nightly job runs once per Pacific calendar day even across daylight-saving transitions
- the pilot company completes dry-run and live smoke-test checklists successfully

## 20. Implementation Planning Boundary

The implementation plan should decompose this design into small, testable phases: schema and security, credential preflight, API clients, normalization and matching, durable orchestration, conflict resolution UI, navigation and overview, notifications, and staged rollout. It must preserve the isolation boundary from the existing reverse sync and use test-driven development for matching, idempotency, and conflict behavior.
