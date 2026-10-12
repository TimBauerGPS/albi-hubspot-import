# HubSpot-to-Albi Sample Review Workflow Design

**Date:** 2026-10-11
**Status:** Approved in conversation; awaiting written-spec review

## Purpose

The completed bounded sample dry run correctly showed that 93 review findings were not 93 independent record problems: 43 were underlying contact or organization decisions, 31 were downstream activity findings, and 19 were expected dry-run dependencies. The current aggregate view cannot identify the 43 records or tell an administrator exactly what must be corrected.

This feature adds an admin-only, read-only sample review workflow. A fresh sample dry run captures the minimum comparison evidence needed to identify each underlying contact or organization. An administrator uses that evidence to correct HubSpot or Albi directly, then rechecks the individual record. Neither review nor recheck may mutate HubSpot, Albi, mappings, sync cursors, delivery ledgers, or live conflict state.

The workflow is a prerequisite to the full dry run. It makes the sample actionable without weakening the matching rules or turning dry-run review into a hidden write path.

## Confirmed Product Behavior

- Only company admins and super admins may access detailed sample review data.
- The review UI shows full contact names, direct email addresses, phone numbers, organization/domain information, relevant address fields, source IDs, and side-by-side HubSpot/Albi values.
- Corrections are made directly in HubSpot or Albi, outside this application.
- Each review item has an individual **Recheck this record** action.
- Recheck performs provider reads and the production matching logic only. It performs no provider or application data mutation other than updating the diagnostic review row and its audit event.
- A record clears only when the same matcher used by the sync concludes that the record is safe to link, safe to create, or no longer exists in the HubSpot source scope.
- One new sample dry run is required after deployment. Historical samples do not contain the evidence needed for reconstruction.
- A successfully completed new sample becomes the current review set. Older detailed review data is removed only after the new sample completes successfully.
- The full dry run is unavailable until the latest completed review-capable sample captured zero underlying review rows. Clearing every item by recheck enables the administrator to run a fresh sample; it does not unlock the full dry run from the old sample.
- The original sample run totals remain immutable audit facts. Rechecks update review progress, not the old run's `requires_review` total. After corrections are complete, the administrator runs a new sample to verify the corrections and generate fresh run totals before starting the full dry run.

## Goals

- Identify the actual contacts and organizations behind aggregate sample findings.
- Show enough current evidence for an administrator to correct either system confidently.
- Keep one underlying review row per HubSpot source record, even when multiple activities were blocked by it.
- Provide fixed, reason-specific correction guidance.
- Support safe individual rechecks with immediate results.
- Make review progress measurable and gate the full dry run on a fresh sample that verifies completed correction work.
- Preserve all current tenant isolation, credential handling, dry-run non-mutation, checkpoint, delivery, and conflict-resolution guarantees.

## Non-goals

- Editing HubSpot or Albi from this application.
- Creating, updating, associating, merging, or deleting provider records during review or recheck.
- Relaxing name, email, phone, domain, duplicate, field-difference, or association matching rules.
- Creating reviewed mappings from the sample review page.
- Reusing the live Conflicts queue or its targeted live-resume machinery.
- Persisting detailed activity bodies, email content, meeting notes, attachments, or thread text.
- Reconstructing detailed evidence for historical sample runs.
- Adding bulk recheck in the first release.
- Showing detailed review data to ordinary members, even if they somehow receive application access.

## Considered Approaches

### 1. Dedicated dry-run review queue — selected

Persist an isolated review row for each underlying sample contact or organization conflict. Add admin-only list, detail, and recheck endpoints. Recheck uses a shared pure evaluator and read-only provider adapters.

This approach creates a hard boundary between diagnostic work and the live Conflicts subsystem, supports stable pagination and audit history, and can prove that recheck has no provider write capability.

### 2. Reuse the live Conflicts queue

Add a preview flag to `h2a_conflicts` and conditionally suppress resolution dispatch. This would reuse substantial UI, but the existing resolver can create mappings and dispatch targeted live processing. A missed condition could turn a dry-run decision into an Albi write. The shared status and resolution model would also make preview cleanup and activation gating harder to reason about.

### 3. Reconstruct evidence on every page load

Read item-result source IDs, rescan HubSpot and Albi, and rebuild comparisons without persistence. This avoids a table but produces slow, inconsistent pages, repeatedly consumes provider rate limits, cannot represent clean samples with zero reviews, and provides no stable recheck history.

## Data Model

### Sample run capability marker

Add `review_capture_version smallint` to `h2a_sync_runs` with a positive-value check. New bounded sample runs are queued with version `1`. Historical runs remain `NULL`. Full dry runs and live runs remain `NULL`.

A review-capable sample is valid only when all of the following are true:

- `mode = 'dry_run'`;
- `sample_limit_per_type = 10`;
- `review_capture_version = 1`;
- `status = 'completed'`; and
- it was created after the tenant's initial start-date lock.

This marker distinguishes a new sample with zero review rows from an old sample that never captured details.

### `h2a_dry_run_reviews`

Create a public-schema table accessed only through service-role Netlify functions:

- `id uuid` primary key;
- `company_id uuid` required, referencing `companies`;
- `run_id uuid` required, with a composite foreign key to `(company_id, id)` on `h2a_sync_runs`;
- `portal_id text` required;
- `object_type text` restricted to `contacts` or `companies`;
- `source_id text` required;
- `reason text` restricted by the server allowlist at write and read boundaries;
- `conflict_type text` restricted by the server allowlist;
- `source_snapshot jsonb` object;
- `candidate_snapshots jsonb` array with at most ten candidates;
- `match_evidence jsonb` object;
- `proposed_changes jsonb` object;
- `status text` restricted to `needs_review`, `cleared`, or `no_longer_in_scope`;
- `recheck_outcome text`, nullable and restricted to fixed values such as `still_needs_review`, `safe_to_link`, `safe_to_create`, and `source_missing`;
- `last_rechecked_at timestamptz`, nullable;
- `last_rechecked_by uuid`, nullable, referencing `auth.users` with `on delete set null`;
- `created_at` and `updated_at` timestamps; and
- a unique constraint on `(company_id, id)` for tenant-safe composite references; and
- a unique constraint on `(company_id, run_id, portal_id, object_type, source_id)`.

Indexes support current-run pagination and status filters:

- `(company_id, run_id, status, object_type, created_at, id)`;
- `(company_id, run_id, reason, created_at, id)`; and
- `last_rechecked_by` for the user foreign key.

Snapshots use explicit field allowlists. Contact snapshots may contain IDs, first/last/full name, direct email, phone/mobile phone, organization identity, and relevant address fields. Organization snapshots may contain IDs, name, domain, phone, and relevant address fields. Unknown properties, email bodies, activity text, provider responses, credentials, error messages, and secret-like keys are discarded before persistence.

### `h2a_dry_run_review_events`

Create an immutable audit table:

- `id uuid` primary key;
- `company_id uuid` required;
- `review_id uuid` required, with a composite foreign key to the review row and `on delete cascade`;
- `actor_id uuid`, retained as an audit identifier without deletion cascade;
- `event_type text` restricted to `captured`, `recheck_started`, `still_needs_review`, `cleared`, `no_longer_in_scope`, or `recheck_failed`;
- `reason text`, nullable and allowlisted;
- `sanitized_details jsonb` object containing fixed diagnostic keys only; and
- `created_at timestamptz`.

Index `(company_id, review_id, created_at, id)` supports a stable audit read.

### Database access

Both review tables:

- enable RLS;
- revoke all privileges from `public`, `anon`, and `authenticated`;
- grant required CRUD privileges only to `service_role`;
- have no browser-readable policy; and
- are never queried by a frontend Supabase client.

No `SECURITY DEFINER` function is required. Netlify functions use the existing service-role client after independently authorizing the request.

## Capture During a Sample Dry Run

Detailed capture runs only when `mode = 'dry_run'`, `sample_limit_per_type = 10`, and `review_capture_version = 1`. Full dry runs continue to record aggregate item results only, preventing an unbounded PII review table.

When the orchestrator produces an underlying contact or organization conflict, it also calls an idempotent `recordDryRunReview` repository method. The method upserts by the unique source identity and records:

- the fixed reason and conflict type;
- the allowlisted HubSpot source snapshot;
- at most ten allowlisted Albi candidate snapshots;
- safe match evidence; and
- safe proposed field comparisons.

Activity-level review findings never create detailed review rows. They remain in `h2a_item_results` for aggregate reporting. Repeated encounters with the same underlying record update the same review row rather than inflating the workload.

The review row is diagnostic only. Capturing it cannot save a mapping, reserve a delivery, advance a live cursor, or call a provider mutation.

Rows for an in-progress or failed sample remain invisible because the API selects only the latest completed review-capable sample. Once a new sample completes successfully, it becomes current. A cleanup operation removes detailed rows and cascading events for older sample runs in the same company. Cleanup failure does not publish partial data or erase the new set; it is retryable maintenance and older rows remain inaccessible through the current-set API.

## Shared Read-only Evaluation

The sample orchestrator and individual recheck must not maintain separate matching interpretations. Refactor the existing matching path into pure evaluators with no repository or provider writes:

- `evaluateOrganizationReview` accepts the current HubSpot organization, current Albi organization index, existing tenant mappings, and option configuration. It returns `safe_to_link`, `safe_to_create`, or a fixed review result with evidence and proposed comparisons.
- `evaluateContactReview` accepts the current HubSpot contact, current Albi contact index, current HubSpot company associations, evaluated organization context, mappings, and option configuration. It returns the same fixed result shape.

The live/dry-run orchestrator consumes these decisions and performs the mode-appropriate persistence. The recheck endpoint consumes the same decisions and updates only diagnostic review state.

This extraction preserves current rules:

- exact normalized email or supported phone identity;
- disagreement when email and phone point to different records;
- duplicate candidates;
- name-only candidates requiring review;
- domain and corroborated organization matching;
- nonblank field differences;
- phone validation;
- contact/organization type confirmation;
- existing mapping ownership; and
- HubSpot contact-company association ambiguity.

## Admin API

Add dedicated Netlify functions or one strictly routed function for list, detail, and recheck operations. Every request uses `requireH2ARequest` with `requireAdmin: true` and the server-authorized selected company.

### List

The list endpoint accepts only:

- authorized company selector;
- bounded page size from 1 to 100;
- opaque `(created_at, id)` cursor;
- fixed `status`, `objectType`, and `reason` filters; and
- optional fixed sort order, newest first by default.

It first resolves the latest completed review-capable sample after the start-date lock, then selects only rows with the same `company_id` and `run_id`. It returns safe summary fields, fixed labels/keys, progress totals, and an opaque cursor. It never returns arbitrary stored keys.

### Detail

The detail endpoint requires one review UUID and selects it by `company_id`, current `run_id`, and `id`. It returns:

- allowlisted source and candidate snapshots;
- fixed evidence and proposed-comparison structures;
- fixed correction guidance key;
- current status and recheck result;
- timestamps; and
- sanitized review events.

### Recheck

The recheck endpoint accepts only company ID, review ID, and the current `updated_at` value for optimistic concurrency. It rejects stale, noncurrent, non-admin, cross-tenant, activity-type, and unsupported-reason requests before decrypting credentials or calling providers.

The endpoint:

1. Reloads the current review row and tenant configuration.
2. Loads and decrypts the selected company's provider credentials server-side.
3. Creates read-only HubSpot and Albi capabilities. The dependency object supplied to recheck exposes no create, update, associate, mapping-save, cursor, delivery, or dispatch method.
4. Reads the exact HubSpot contact or company by stored source ID.
5. Reads the current required HubSpot associations for a contact.
6. Loads the current relevant Albi contact or organization index through bounded pagination.
7. Runs the shared pure evaluator.
8. Atomically updates the diagnostic row only if its version is unchanged and appends one audit event.

Outcomes:

- `still_needs_review`: refresh snapshots, reason, evidence, and proposed changes; retain `needs_review`.
- `safe_to_link`: mark `cleared`.
- `safe_to_create`: mark `cleared` because a later dry/live run can safely create it; do not create it during recheck.
- `source_missing`: mark `no_longer_in_scope` only when the exact HubSpot batch read confirms the source record is absent. Authentication, permission, malformed response, timeout, or transient failures do not imply source deletion.

Provider failures leave the prior status and evidence unchanged. They append a fixed `recheck_failed` event only when the safe failure can be durably recorded without leaking provider text.

Recheck has a bounded deadline and the existing safe read retry policy. The UI allows one recheck at a time for the selected tenant and prevents duplicate submission. A stale response after company switching is discarded.

## Correction Guidance

The server returns a fixed guidance key derived from the allowlisted reason. The frontend owns the human-readable copy:

- `name_only_candidate`: add or correct reliable email, supported phone, or organization domain evidence; avoid creating a duplicate.
- `email_phone_disagree`: determine which system has the incorrect email or phone and make the identities agree.
- `duplicate_candidates` or `multiple_candidates`: merge, archive, or correct duplicate Albi records until one candidate remains.
- `multiple_associated_organizations`: correct HubSpot company associations so the contact has one intended organization context.
- `nonblank_field_difference`: choose the correct source of truth and make the conflicting values agree.
- `albi_contact_update_contract_unverified` or `contact_fields_require_review`: update the existing Albi contact or HubSpot source directly so no unsupported write is required.
- `albi_organization_update_contract_unverified` or `organization_fields_require_review`: update the existing Albi organization or HubSpot source directly.
- `albi_contact_association_contract_unverified` or `association_contract_unverified`: correct the contact-organization relationship directly in Albi or the HubSpot association source.
- phone-format reasons: replace the value with a supported direct phone format or remove unusable identity evidence.
- missing required source/name reasons: restore the required HubSpot source fields or remove the record from the intended sync scope.
- unknown future reasons: show generic guidance without interpolating the raw value.

Guidance does not tell the administrator which value is factually correct; it keeps HubSpot and Albi side by side so the administrator can make that business decision.

## User Experience

Add a protected **Sample Review** route within the HubSpot-to-Albi module. It is visible only to admins and super admins. The Overview completed-sample disclosure and Settings readiness area link to it when a current review-capable sample exists.

The desktop layout uses a responsive master-detail pattern:

- queue and filters on the left;
- selected record detail on the right;
- stacked queue then detail on small screens.

The queue shows record type, display name, fixed reason label, status, last recheck time, and concise identity evidence. It supports status, object type, and reason filters with keyset pagination.

The detail shows:

- why the record needs review;
- correction guidance;
- HubSpot source and Albi candidate values side by side;
- match evidence and proposed field differences;
- source and candidate IDs with copy-friendly wrapping;
- **Recheck this record**;
- current recheck result; and
- audit history.

The page never offers link, create, approve-fields, retain-fields, skip, or provider-edit actions. It may show external provider links only when a URL can be constructed from a fixed trusted application origin and validated identifiers; otherwise it shows copyable IDs.

Progress summarizes `needs_review`, `cleared`, and `no_longer_in_scope`. When no items remain in `needs_review`, the UI instructs the administrator to run a new sample. The old sample totals remain unchanged and are labeled as the original run result. Only a new sample that captures zero underlying review rows enables the full dry run; a reduced-but-nonzero result returns the administrator to the review loop.

Empty and transition states are explicit:

- historical sample: “Run a new sample to create detailed review data”;
- sample running: progress link disabled;
- sample failed: keep the prior completed review set available and show the failed run separately;
- zero-review sample: “No underlying records need correction”;
- provider recheck failure: retain current item and offer retry;
- tenant switch: abort list, detail, and recheck requests before rendering the next company.

## Full Dry-run Gate

The manual full dry-run endpoint strengthens its existing sample prerequisite. It requires:

- the latest completed sample after the date lock;
- `review_capture_version = 1`; and
- zero detailed review rows captured for that sample.

Rechecking all rows to `cleared` or `no_longer_in_scope` is progress evidence, but it does not satisfy the gate for that run because those rows were present at capture time. The administrator must run a fresh sample, and that fresh sample must complete without capturing an underlying review row. Historical samples without capture version 1 never satisfy the gate. The endpoint returns an actionable fixed error directing the administrator to Sample Review or to run a new sample.

The Settings readiness copy becomes:

1. Run a sample dry run.
2. Correct and recheck underlying records.
3. Run a fresh sample to verify the corrections and refresh aggregate totals.
4. Run the full dry run.
5. Review the full totals and explicitly activate live sync.

## Security and Privacy

- Detailed contact and organization data is returned only by admin-authorized Netlify functions.
- Direct Supabase browser access to both review tables is revoked.
- Company admins may access only their own company. Super admins must select an existing company, and every query repeats the company predicate.
- Browser-supplied run IDs, source IDs, portal IDs, object types, provider company IDs, candidate IDs, or statuses never determine authorization or provider scope.
- Credentials and encrypted envelopes remain server-only.
- Snapshot and response serializers use positive field allowlists. Secret-like key filtering is defense in depth, not the primary policy.
- Raw provider bodies, headers, request URLs with secrets, arbitrary error messages, activity content, and email bodies are never persisted or returned.
- Responses use `Cache-Control: no-store`.
- Recheck events retain actor identity and safe outcome metadata without provider payloads.
- Old detailed rows are deleted after a new sample is successfully published, limiting PII retention while preserving the current actionable set.

## Error Handling and Concurrency

- Invalid authentication returns `401`; insufficient admin authority returns `403`.
- Missing or cross-tenant review IDs return a non-enumerating `404`.
- Stale `updated_at` versions return `409` and require refresh.
- A recheck against a superseded sample returns `409` and never calls providers.
- Rate limits and transient read failures use bounded retry/defer behavior; no provider text reaches the UI.
- Permanent validation, permission, and authentication failures use fixed actionable categories.
- Concurrent rechecks use optimistic row versioning; only one result wins, and duplicate submissions do not append contradictory terminal events.
- Sample capture upserts are idempotent across continuation workers.
- A failed sample cannot replace or delete the current completed review set.
- Cleanup of older detailed sets is retryable and never gates visibility of the newly completed set.

## Testing Strategy

Implementation follows test-driven development.

### Schema and access

- review tables use UUID keys, composite tenant/run foreign keys, JSON type checks, constrained statuses, uniqueness, and company-leading indexes;
- RLS is enabled;
- `public`, `anon`, and `authenticated` have no privileges;
- only `service_role` has the required privileges;
- review capture version distinguishes historical, failed, clean, sample, and full runs; and
- cleanup cascades review events without affecting sync runs or item results.

### Capture

- each underlying contact or organization creates at most one review row per sample;
- repeated activity encounters update/reuse the same source review;
- activity conflicts never create detailed review rows;
- full dry runs never persist detailed rows;
- snapshots persist only allowed fields and cap candidate count;
- failed/partial samples never become the current review set;
- a completed clean sample is representable with zero rows; and
- publishing a new completed sample makes old details inaccessible before cleanup.

### API and isolation

- member, signed-out, cross-company, unsupported-filter, and malformed-cursor requests fail safely;
- company admins and super admins receive only the authorized current sample;
- list, detail, events, counts, and filters are tenant- and run-scoped;
- pagination is deterministic; and
- no arbitrary stored keys or provider error text survive the response projection.

### Recheck

- source/candidate reads use the selected company's credentials and verified provider company;
- recheck dependencies expose no provider mutation or application mutation methods;
- tests fail if create, update, association, mapping, cursor, delivery, or dispatch behavior is invoked;
- the shared evaluator produces the same decision in sample processing and recheck;
- still-blocked records refresh evidence and remain open;
- safe links and safe creates clear without performing the action;
- confirmed missing HubSpot sources become `no_longer_in_scope`;
- ambiguous missing/error responses do not clear;
- stale, duplicate, superseded, and concurrent requests are safe; and
- events record fixed actor/outcome metadata only.

### UI

- admin route protection and tenant transitions are preserved;
- queue filters, pagination, selection, detail, progress, and empty states work;
- full direct emails and phones render with safe wrapping and no HTML injection;
- comparisons remain adjacent on desktop and readable on mobile;
- recheck is keyboard accessible, single-submit, abortable, and announced with `aria-live`/alerts;
- correction guidance is fixed for every known reason and generic for unknown keys;
- the UI contains no mutation controls; and
- old run totals are not presented as if recheck changed them.

### Regression and release

- current overview breakdowns still reconcile to immutable run totals;
- live Conflicts behavior and resolution dispatch remain unchanged;
- sample continuation, cancellation, and retry remain idempotent;
- the full dry-run gate rejects a historical sample, a failed sample, a sample with open rows, and an old sample whose rows were all cleared by recheck;
- the full dry-run gate accepts only a fresh completed review-capable sample that captured zero review rows;
- the live activation gate continues to require a successful full dry run;
- complete H2A tests, schema contract tests, end-to-end self-test, production build, and authenticated browser smoke tests pass before deployment.

## Rollout

1. Add schema, indexes, grants, and the sample review-capture version marker.
2. Add repository methods, allowlisted serializers, and pure review evaluators behind tests.
3. Capture review rows during new bounded samples without exposing UI routes.
4. Add admin list/detail endpoints and confirm tenant/privacy behavior.
5. Add read-only individual recheck and audit events with zero-mutation contract tests.
6. Add Sample Review UI, navigation, progress, correction guidance, and historical-sample messaging.
7. Strengthen the full dry-run gate.
8. Deploy while live sync remains disabled.
9. Run one new sample for Allied and confirm the detailed queue reconciles with the underlying-record subtotal.
10. Correct and individually recheck the sample records.
11. Run a fresh sample, then proceed to the full dry run only when that sample completes with zero captured underlying review rows.

## Success Criteria

- A fresh sample produces one actionable row per underlying contact or organization problem without storing activity content.
- The administrator can identify each source and candidate using full approved contact/organization fields.
- Every known reason has safe correction guidance.
- Individual recheck uses current provider data and the same matcher as sync processing.
- Recheck performs zero HubSpot writes, zero Albi writes, zero mapping writes, zero cursor changes, zero delivery changes, and zero live conflict dispatches.
- Corrected records move to `cleared`; deleted/out-of-scope HubSpot sources move to `no_longer_in_scope`; unresolved records remain visible with refreshed evidence.
- Failed samples and failed rechecks do not erase or falsely clear work.
- Historical samples do not masquerade as review-capable.
- The full dry run can start only after the latest review-capable sample captured zero underlying review rows; changing old review statuses alone is insufficient.
- Detailed PII remains admin-only, tenant-scoped, service-only at the database layer, bounded, and removed when superseded.
- Existing live conflict resolution, delivery idempotency, and sync safety remain unchanged.
