# HubSpot-to-Albi In-App Review Resolution Design

**Date:** 2026-10-13

**Status:** Draft for written review

**Application:** `albi-hubspot-import`

## Purpose

Turn Sample Review from a read-only diagnostic queue into an admin-controlled resolution workflow. An administrator should be able to resolve identity and field conflicts with the fewest practical trips to HubSpot or Albi while preserving the safety boundary of the dry run.

The approved product behavior is:

- decisions are made and applied one record at a time;
- each differing field can independently use the HubSpot value or the Albi value;
- choosing the Albi value updates HubSpot immediately when the field is supported;
- choosing the HubSpot value creates an explicit manual Albi task because the Guardian Albi Wrapper cannot update general contact or organization fields;
- identity mappings and safe Albi record creation can be completed in the app;
- organization context can be selected without automatically removing HubSpot associations;
- every attempted write and manual requirement is auditable;
- provider state is re-read and evaluated after a write or after the administrator reports completing an Albi edit;
- a new sample with zero captured underlying review rows is still required before a full dry run.

## Current Constraints and Verified Contracts

### Guardian Albi Wrapper

The app uses the company-scoped Guardian Albi Wrapper at `https://albi.guardianrestoration.com`, authenticated with `X-API-Key`. Its OpenAPI document was checked on 2026-10-13.

The wrapper currently exposes contact and organization reads and creates, plus lifecycle-status operations. It does not expose general existing-record field updates or contact-organization reassociation. The wrapper is outside this application's control and will not be changed by this project.

Supported app-side Albi mutations therefore remain:

- create a contact;
- create an organization;
- create the initial contact with an organization ID when available.

General Albi field corrections and reassociation remain manual. The Albi application uses stable numeric-ID links:

- contact: `https://app.albiware.com/Relationships/Contact/{albiContactId}`;
- organization: `https://app.albiware.com/Relationships/Organization/{albiOrganizationId}`.

The server constructs these URLs from validated positive numeric IDs. It never accepts an Albi URL or origin from the browser or database.

### HubSpot

HubSpot supports updating individual CRM records with `PATCH /crm/v3/objects/{objectType}/{recordId}` and supports contact-company association writes through its CRM association APIs. The official contact reference was checked on 2026-10-13: <https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide>.

The existing H2A HubSpot adapter is read-only. This project adds narrowly scoped contact, company, and association mutation methods. The expected private-app scopes are `crm.objects.contacts.write` and `crm.objects.companies.write`, in addition to the existing read scopes. The app does not perform a destructive write during preflight merely to prove a scope. Until a successful write verifies capability, Settings describes the capability as **Verified when first used** and reports a sanitized, actionable authorization failure if HubSpot rejects it.

## Goals

1. Make every review reason visible, consistently named, and filterable.
2. Allow per-field source-of-truth decisions with whole-record shortcuts.
3. Apply supported HubSpot writes immediately after explicit confirmation.
4. Turn unsupported Albi writes into clear, linked manual tasks.
5. Support reviewed identity mapping and safe Albi creation from Sample Review.
6. Support a reviewed organization context without deleting associations.
7. Reconcile ambiguous provider outcomes without repeating successful writes.
8. Preserve tenant isolation, admin authorization, immutable sample totals, and the fresh-sample gate.

## Non-Goals

- Changing the Guardian Albi Wrapper.
- Updating general fields on an existing Albi contact or organization.
- Changing an existing Albi contact's organization through an API.
- Automatically deleting, merging, archiving, or deduplicating provider records.
- Automatically removing HubSpot associations.
- Allowing browser clients to call HubSpot or Albi directly.
- Treating a resolved historical sample as sufficient evidence for a full dry run.
- Activating live sync as part of a resolution action.

## Shared Review Reason Catalog

Overview and Sample Review currently maintain separate label catalogs. Reasons known to Sample Review but absent from the Overview catalog collapse into **Other review reason**, while the queue displays their specific names. This makes the aggregate appear impossible to find.

Replace the two catalogs with one shared, fixed review-reason catalog containing:

- the stored reason code;
- user-facing label;
- guidance;
- allowed object types;
- category: identity, field, association, configuration, provider, or preview;
- whether an in-app resolution action is available;
- the supported resolution action kinds.

Overview grouping, Sample Review filters, queue labels, detail guidance, and API validation all derive from this catalog. `other_review_reason` remains a real fallback only for an unrecognized or deliberately generic stored reason. It is included in the filter list when it actually occurs.

Each Overview breakdown row links to Sample Review with validated query parameters for object type and reason. Invalid query values are discarded rather than sent to the API.

## User Experience

### Queue

The Sample Review queue retains status history and adds a resolution-state badge:

- **Needs decision**;
- **Ready to apply**;
- **Applying**;
- **Waiting on Albi**;
- **Ready to recheck**;
- **Cleared**;
- **Action failed**.

The list remains paginated. Filters are server-backed and include status, object type, and every current reason in the shared catalog.

### Record detail

The detail page reloads current provider evidence before enabling mutation controls. It displays:

- HubSpot source values;
- the selected Albi candidate values;
- match evidence and candidate IDs;
- exact field differences;
- current HubSpot associations and the reviewed organization context;
- audit and resolution history;
- validated **Open in HubSpot** and **Open in Albi** links when IDs are available.

Each differing field offers:

- **Use HubSpot** — the administrator is asserting that Albi should be changed manually;
- **Use Albi** — the administrator is authorizing the app to update HubSpot.

The page also offers **Use all HubSpot values** and **Use all Albi values** shortcuts. These shortcuts select only eligible differing fields and do not select identity, mapping, or association actions implicitly.

### Confirmation

Before applying, a confirmation dialog groups the plan by consequence:

- fields that will be written to HubSpot now;
- fields that will become manual Albi tasks;
- mapping to be saved;
- Albi record to be created;
- organization context to be saved or HubSpot association to be added.

The confirmation names the provider, record, and fields. There is no generic confirmation that hides the write destination.

### Manual Albi tasks

When a HubSpot value wins for an existing Albi record, the app records a manual task and shows:

- the exact field names and target values to apply;
- the Albi record name and numeric ID;
- **Open contact in Albi** or **Open organization in Albi**;
- **Recheck after updating Albi**.

The administrator does not manually mark a task complete. Recheck reads the provider and clears the task only when the production matcher confirms the result. A mismatch remains visible with refreshed evidence.

## Resolution Actions

### Per-field resolution

The browser submits only field choices and an expected review version. It does not submit provider payloads or trusted values.

The server reloads the HubSpot source and selected Albi candidate, reconstructs the comparison, and partitions the allowlisted fields:

- fields whose winner is Albi become a HubSpot PATCH payload;
- fields whose winner is HubSpot become manual Albi tasks;
- equal or no-longer-different fields are omitted;
- unsupported, immutable, or unknown fields reject the request.

Allowed contact fields are initially limited to first name, last name, email, direct phone, mobile phone, job title, address lines, city, state, postal code, and country. Allowed organization fields are initially limited to name, domain, direct phone, address lines, city, state, postal code, and country. Provider-specific aliases are mapped server-side.

Blank-value decisions are explicit. A selected blank can clear a supported HubSpot property only when the confirmation dialog displays that consequence. The app never infers that a blank should overwrite a nonblank value.

### Link existing Albi record

The administrator selects one current candidate. The server reloads that candidate, validates tenant and object type, applies the existing many-to-one safeguard, and saves the reviewed source-to-target mapping. It then rechecks the review row. No live activity is dispatched from Sample Review.

### Create new Albi record

The server rebuilds the create payload from current HubSpot data and confirmed type mappings. It uses the existing deterministic source marker and reconciliation behavior. A retry after an ambiguous provider response reads Albi and adopts the already-created record rather than issuing another create. After creation, the reviewed mapping is saved and the row is rechecked.

### Organization context

For a contact with multiple HubSpot company associations, the administrator selects the intended company context.

- If it is already associated, the app records a reviewed organization choice and does not remove other associations.
- If it is not associated, the confirmation explicitly authorizes adding the HubSpot association before saving the choice.
- If the current Albi contact points to another organization, the app creates a manual Albi reassociation task with direct contact and organization links.

The reviewed choice is tenant- and portal-scoped and is honored by both the review evaluator and later H2A matching while the selected HubSpot company still exists. If the choice becomes invalid, matching fails closed into review again.

## Server API

Extend the existing dry-run review API surface with explicit mutations rather than turning the read-only recheck endpoint into a generic writer.

### `POST /.netlify/functions/h2a-dry-run-review-resolutions`

Creates or reuses a durable intent. Accepted fields are limited to:

- `companyId` for normal existing authorization routing;
- `reviewId`;
- `expectedUpdatedAt`;
- `action` from `resolve_fields`, `link_existing`, `create_albi`, or `choose_organization`;
- the action-specific field-choice keys, candidate ID, or organization source ID;
- a client-generated request ID used only as an idempotency input.

The endpoint authorizes the user, resolves the selected company server-side, validates the current sample, checks the review row with compare-and-swap semantics, creates the intent, and attempts immediate execution.

### `GET /.netlify/functions/h2a-dry-run-review-resolutions`

Returns the safe projected current intent and event history for one tenant-scoped review ID. It never returns credentials, raw provider bodies, arbitrary error messages, or unbounded snapshots.

### Recheck

The existing individual recheck remains a provider-read operation. It also reconciles any current resolution intent:

- verified provider state completes relevant actions;
- remaining manual Albi differences keep the intent waiting;
- provider errors preserve the prior state and append a sanitized failure event;
- a new completed sample supersedes the old queue under the existing rules.

## Provider Clients

### HubSpot client additions

Add narrowly validated methods:

- `updateContact(id, properties)`;
- `updateCompany(id, properties)`;
- `addContactCompanyAssociation(contactId, companyId)`.

Each method accepts only positive provider IDs and fixed allowlisted properties. Mutation requests are single-attempt unless the exact operation is proven idempotent. An ambiguous timeout is reconciled with a read before any retry.

No delete-association, merge, archive, or delete method is exposed to the review-resolution capability object.

### Albi client usage

Continue using only the existing verified reads and creates. `updateContact`, `updateOrganization`, and `associateContact` remain explicit unsupported-contract operations and are not exposed to resolution code.

## Persistence

Add service-only, tenant-scoped resolution storage. The migration follows the project's existing imperative SQL pattern and remains idempotent.

### `h2a_dry_run_review_resolutions`

Core columns:

- UUID primary key;
- `company_id`, `run_id`, and `review_id` foreign keys;
- portal ID, object type, and source ID copied as constrained identity context;
- action and lifecycle status as text with check constraints;
- expected review timestamp;
- normalized decision JSON containing only field names, winners, and selected IDs;
- deterministic decision hash and client request ID;
- lease owner and expiration for crash-safe execution;
- safe provider outcome code;
- creator and timestamps.

Lifecycle statuses are `pending`, `applying`, `waiting_on_albi`, `ready_to_recheck`, `completed`, `failed`, and `superseded`.

A unique constraint on `(company_id, review_id, expected_review_updated_at, decision_hash)` makes semantic retries idempotent. A partial index supports current work by `(company_id, status, created_at)` for active statuses. Every foreign-key access path is indexed.

### `h2a_dry_run_review_resolution_events`

Append-only events contain resolution ID, company ID, fixed event type, actor ID, sanitized details, and `timestamptz` creation time. Details may include allowlisted field names, destinations, fixed provider outcome codes, and truncated provider IDs. They may not include credentials, authorization headers, raw response bodies, or arbitrary exception messages.

### `h2a_contact_organization_choices`

Store one reviewed organization context per company, portal, and HubSpot contact. The row contains the selected HubSpot company ID, actor, review timestamp, and update timestamp. It does not imply that other HubSpot associations were removed.

### Database access and concurrency

- Enable RLS on all new public tables.
- Revoke browser writes and keep mutation access service-role only.
- If authenticated read policies are unnecessary because projection occurs through Netlify functions, do not grant browser table access.
- Use short database transactions for claim/finalize operations; never hold a database lock during an HTTP request.
- Use conditional updates and transaction-scoped advisory locks keyed by tenant and review ID where cross-table serialization is required.
- Pin function `search_path`, revoke default `PUBLIC` execution, and grant RPC execution only to `service_role`.
- Keep tenant ID in every uniqueness constraint and lookup index.

## Durable Execution and Idempotency

1. Authorize and reload the current review evidence.
2. Normalize the decision and compute its deterministic hash.
3. In a short transaction, create or return the existing intent and claim an execution lease.
4. Release all database locks.
5. Perform at most one provider mutation.
6. Read the provider record to verify or reconcile the requested state.
7. In a second short transaction, append the safe event and finalize the intent.
8. Recheck the review row when no manual Albi work remains.

If the function stops after step 5, the lease eventually expires. A retry reads provider state before repeating a write. Matching state becomes `reconciled`; differing state may retry only when the operation is safely repeatable. Albi creates use existing marker reconciliation and never blindly repeat after an ambiguous response.

Only one mutation is performed per execution claim. A mixed field plan may therefore require multiple immediately chained claims, but the UI treats them as one record-level resolution and displays progress. This bounds partial failure and keeps reconciliation precise.

## Authorization and Tenant Isolation

- Existing application access remains enforced by `ProtectedRoute` and the server's `user_app_access` checks.
- Only `company_members.role = 'admin'` or a row in the shared `super_admins` table may create resolution intents.
- Super-admin company selection remains server-authorized.
- Every database and provider operation is scoped by the resolved application company.
- The browser cannot choose the Albi company. The wrapper key must still resolve to exactly one authorized Albi company.
- Member users remain read-only.

## Error Handling

- **Stale review:** return conflict, reload current evidence, and require reconfirmation.
- **Missing HubSpot write scope:** keep the intent failed with a fixed authorization code and show which write capability is required.
- **Provider validation failure:** preserve the decision, show a sanitized actionable status, and do not mark the review clear.
- **Transient or rate-limit failure:** retain the intent for explicit retry with bounded backoff information.
- **Ambiguous timeout:** reconcile by reading before retrying.
- **Manual Albi task still differs:** remain `waiting_on_albi` with refreshed evidence and links.
- **Candidate disappeared:** fail closed and return the review to identity selection.
- **Newer completed sample:** mark the old intent superseded and do not write.
- **Partial success:** retain completed audit events and expose only unfinished work; never roll back a correct provider write by guessing.

## Testing

### Domain and provider contracts

- shared reason catalog covers every stored reason and both UI surfaces;
- per-field partitioning creates correct HubSpot writes and Albi manual tasks;
- unsupported fields and client-supplied values are rejected;
- HubSpot contact/company updates use exact allowlisted payloads;
- association additions are explicit and no removal call exists;
- Albi deep links are constructed only from positive numeric IDs;
- Albi update and reassociation methods remain unreachable.

### API and persistence

- admin and super-admin authorization; member rejection;
- cross-tenant review, candidate, mapping, and organization IDs rejected;
- stale expected timestamps rejected before provider calls;
- repeated request and decision hashes are idempotent;
- lease expiry and crash-after-write reconciliation;
- one-provider-mutation-per-claim behavior;
- append-only sanitized audit events;
- RLS, grants, indexes, constraints, and RPC execution privileges;
- newer samples supersede old intents;
- fresh zero-review sample remains the only full-dry-run gate.

### UI

- clicking an Overview reason opens the correctly filtered queue;
- every stored reason is selectable and labeled consistently;
- per-field and whole-record controls produce the exact confirmation plan;
- mixed automatic/manual outcomes remain understandable;
- Albi links use the correct contact or organization path;
- keyboard focus, dialog behavior, busy states, and screen-reader announcements remain accessible;
- duplicate submissions are disabled while an intent is active.

### Controlled provider pilot

After local and schema tests pass:

1. verify HubSpot write scopes without changing a production record where possible;
2. use one explicitly selected test contact to update a reversible HubSpot field and verify read-after-write;
3. use one test organization for the same flow;
4. add one non-destructive contact-company association or validate an existing selection;
5. create one isolated Albi test record through the existing guarded smoke path;
6. verify a manual Albi task opens the correct record and clears only after recheck;
7. run a new sample and confirm the full dry run remains gated until it captures zero underlying review rows.

No provider pilot, SQL application, live activation, or production data mutation is part of implementing the code unless separately authorized.

## Rollout

1. Ship the shared reason catalog and deep links first; these are non-mutating improvements.
2. Apply the Supabase migration for durable intents, events, and reviewed organization choices.
3. Deploy the server API and HubSpot mutation adapter with UI actions feature-gated off.
4. Verify credentials and run the controlled one-contact/one-organization pilot.
5. Enable in-app resolution for super admins first.
6. Review audit events and repeat a fresh sample.
7. Enable company-admin resolution only after the pilot is clean.

Rollback disables the mutation feature flag while leaving review, recheck, deep links, and audit history readable. It does not delete intents or attempt to reverse provider writes.
