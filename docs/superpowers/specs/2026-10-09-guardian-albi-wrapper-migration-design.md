# Guardian Albi Wrapper Migration Design

**Date:** 2026-10-09  
**Status:** Draft for written review

## Purpose

The HubSpot-to-Albi (H2A) module currently sends its saved Albi credential directly to `https://api.albiware.com` using Albi's native `ApiKey` header. The credential already used successfully by Allied's other applications is instead a Guardian Albi Wrapper key. It must be sent to `https://albi.guardianrestoration.com` in the `X-API-Key` header and used through company-scoped `/v1/companies/{companyId}/...` routes.

H2A will migrate to the Guardian wrapper so Allied can reuse its existing company-scoped credential. The migration must preserve tenant isolation, read-only connection checks, dry-run guarantees, conflict review, delivery idempotency, and checkpoint safety.

## Confirmed Product Behavior

- Administrators save one Guardian Albi API key for the selected application company.
- The wrapper identifies which Albi company that key can access. Allied is currently wrapper company `1319`.
- H2A creates missing organizations, contacts, and activities.
- A new contact may be associated with an organization in the contact-create request.
- H2A does not modify general fields on existing Albi contacts or organizations.
- H2A does not change an existing contact's organization association.
- Proposed unsupported changes become administrator-review Conflicts and do not block activation.
- Connection checks and dry runs never create Albi records.

## Considered Approaches

### 1. Use the Guardian wrapper and defer unsupported mutations — selected

Replace the native Albi adapter contract with the wrapper contract. Continue all supported reads and creates, and route existing-record updates or association changes to Conflicts.

This reuses the known working credential, exposes exact scope failures, and makes the useful portion of the sync available without pretending that unsupported operations succeeded.

### 2. Keep the native Albi API

Acquire and manage a second, native Albi Integrations API key. This retains the current adapter boundary but defeats the requirement to share the established company credential and still does not establish verified generic update contracts.

### 3. Extend the wrapper before enabling H2A

Add generic contact update, organization update, and association endpoints to the wrapper first. This delays the primary workflow for rare mutation cases and expands the security surface before the need is demonstrated.

## Wrapper Contract

The adapter uses:

- Base URL: `https://albi.guardianrestoration.com`
- Authentication header: `X-API-Key`
- Company discovery: `GET /v1/companies`
- Company-scoped root: `/v1/companies/{companyId}`

The key must authorize exactly one company. Zero companies is a configuration failure. More than one company is treated as ambiguous and fails closed rather than selecting one silently. The adapter validates `companyId` as a nonempty wrapper identifier and company name as display-only text.

Each `AlbiClient` lazily discovers and caches the authorized company for its process lifetime. Preflight also returns the sanitized company ID and name for display and persistence in the existing JSONB preflight details. Workers rediscover the company from the current key rather than trusting stale stored identity. No database migration is required.

### Supported endpoints and required scopes

| Capability | Wrapper endpoint | Required scope |
|---|---|---|
| List contacts | `GET /contacts` | `contacts:list` |
| Create contact | `POST /contacts` | `contacts:create` |
| List organizations | `GET /organizations` | `organizations:list` |
| Create organization | `POST /organizations` | `organizations:create` |
| List activities | `GET /activities` | `activities:list` |
| Create activity | `POST /activities` | `activities:create` |
| Relationship types | `GET /options/relationship-types` | `options.relationship-types:list` |
| Referral sources | `GET /options/referral-sources` | `options.referral-sources:list` |
| Relationship statuses | `GET /options/relationship-statuses` | `options.relationship-statuses:list` |
| Activity types | `GET /options/activity-types` | `options.activity-types:list` |

The option routes are appended to the company-scoped root. Relationship types continue to supply the contact-type and organization-type choices because the wrapper does not expose separate contact-type or organization-type option routes and the existing Albi contract uses these IDs for both create payloads.

The wrapper's generic contact and organization status-update endpoints are out of scope. H2A synchronizes relationship fields and activity history, not Albi lifecycle status.

## Adapter Behavior

`AlbiClient` keeps the domain-facing methods used by the orchestrator so provider details do not leak into sync logic:

- `verifyCredentials`
- `listContacts`
- `listOrganizations`
- `listActivities`
- `listOptions`
- `createContact`
- `createOrganization`
- `createActivity`

List responses are normalized into the existing records-and-cursor shape. Pagination validation remains strict: page numbers advance monotonically, page sizes remain bounded, response collections must have the expected structure, and malformed provider data stops the run safely.

Create payload allowlists and required-field validation remain in place. The adapter changes only the transport route and response normalization required by the wrapper. Non-idempotent creates remain single-attempt operations.

The existing `updateContact`, `updateOrganization`, and `associateContact` methods remain explicit unsupported-contract operations if retained for interface compatibility. The orchestrator must not call them during automatic processing.

## Connection Check and Activation Readiness

The connection check is strictly read-only. It performs:

1. Wrapper authentication and exact-one-company discovery.
2. One bounded contact-list request.
3. One bounded organization-list request.
4. One bounded activity-list request.
5. All four required option-list requests.

Create permissions cannot be proven safely through the wrapper without creating real records. The connection check therefore reports contact, organization, and activity creation as **Verified when first used**. These checks are informational and do not appear as missing permissions.

Generic existing-record updates and association changes are reported as **Handled through Conflicts**. They are not activation requirements.

Activation requires:

- valid HubSpot checks;
- valid Guardian wrapper authentication;
- exactly one authorized Albi company;
- successful required Albi reads;
- complete, nonempty required option lists; and
- confirmed tenant option mappings.

The connection check no longer uses native Albi `OPTIONS` probes. It does not claim that write scopes were runtime-verified.

## Sync Data Flow

### Organizations

- A safely matched, compatible organization is linked and mapped without mutation.
- A missing organization is created through `POST /organizations`, then mapped.
- Blank-field fills or conflicting nonblank values on an existing organization become an `organization_fields` Conflict.

### Contacts

- A safely matched, compatible contact is linked and mapped without mutation.
- A missing contact is created through `POST /contacts`.
- When one resolved organization is available, its Albi ID is included as `organizationId` in the contact-create payload.
- Blank-field fills, conflicting nonblank values, or a requested association change on an existing contact become a Conflict.

### Activities

- Activities are created through `POST /activities` for each resolved contact or organization target.
- The existing reservation, deterministic source marker, reconciliation, and delivery ledger behavior remains unchanged.
- An ambiguous activity-create result is reconciled before any retry, preventing duplicate activities.

### Dry runs

Dry runs perform reads, matching, option resolution, and proposed-action recording only. They do not create records, consume delivery reservations, or advance live checkpoints.

## Settings and Diagnostics

The credential field is labeled **Guardian Albi API key** and explains that the key is company-scoped.

The Albi checklist displays:

- wrapper authentication;
- authorized Albi company;
- contact, organization, activity, and option reads;
- record creation as **Verified when first used**; and
- unsupported existing-record mutations as **Handled through Conflicts**.

Diagnostic responses remain allowlisted and secret-safe. They may include a sanitized wrapper company ID/name and known required scope names, but never the API key, request headers, raw provider bodies, database errors, or encrypted credential material.

## Error Handling

- `401` means the Guardian wrapper key is invalid, revoked, or otherwise rejected.
- `403` means the authenticated key lacks the scope required by the requested wrapper endpoint. When the operation is known, the UI names the exact required scope.
- `404` from a company-scoped route is treated as inaccessible or invalid company context, not as a reason to try another company.
- `429` remains rate-limited and honors a safe bounded retry delay for read operations.
- Transient network and `5xx` failures use the existing bounded read retry policy.
- Malformed responses fail closed as unexpected provider responses.
- Non-idempotent create requests are never automatically replayed by the HTTP client.
- A create authorization failure records a failed item and prevents unresolved work from being represented as completed.
- Credential or preflight changes continue to disable sync until the connection check and mapping confirmation are repeated.

## Security and Isolation

- The Guardian key remains encrypted server-side with the existing H2A credential envelope and keyring.
- The raw key is never returned to the browser or written to logs.
- Company discovery is performed using the selected tenant's decrypted credential only.
- The adapter never accepts a browser-supplied wrapper company ID.
- Exact-one-company discovery prevents a key from silently crossing company boundaries.
- Super-admin and company-admin authorization remains unchanged.

## Test Strategy

Implementation follows test-driven development. Coverage must include:

- wrapper base URL, `X-API-Key`, and absence of the native `ApiKey` header;
- company discovery with exactly one, zero, multiple, malformed, and unauthorized results;
- company-scoped URL construction for every supported operation;
- contact, organization, and activity pagination and normalization;
- exact validated create payloads and wrapper create-response normalization;
- all required option routes and relationship-type reuse;
- connection-check readiness rules and user-facing diagnostic labels;
- exact known-scope reporting for `403` failures;
- `401`, `404`, `429`, transient, malformed-response, and timeout classification;
- automatic creation and initial contact-organization association;
- existing-record update and reassociation proposals becoming Conflicts;
- dry-run non-mutation guarantees;
- activity delivery reservation and reconciliation regressions; and
- credential-change invalidation, tenant isolation, and safe response projection.

Before deployment, run the complete H2A test suite, schema tests, end-to-end self-test, and production build.

## Rollout

1. Deploy the adapter and UI changes without activating live sync.
2. Rerun the connection check using Allied's existing Guardian wrapper key.
3. Confirm the wrapper returns Allied Restoration Services Inc with company ID `1319`.
4. Confirm all required option lists load and save the tenant mappings.
5. Run a dry run from the selected backfill date.
6. Review dry-run totals and a sample of generated Conflicts.
7. Activate live sync only after the dry-run review passes.
8. Monitor the first live create of each record type. A missing create scope should produce an exact scope diagnostic without advancing unresolved work.

## Out of Scope

- Adding generic contact or organization update endpoints to the Guardian wrapper.
- Changing organization associations on existing contacts.
- Synchronizing Albi contact or organization lifecycle statuses.
- Supporting wrapper keys authorized for multiple companies.
- Changing the encryption schema, role model, scheduler, matching rules, or conflict-resolution authorization.

## Success Criteria

- The existing Guardian wrapper key authenticates successfully in H2A.
- Connection checking identifies Allied company `1319` without creating records.
- Required option mappings can be loaded and confirmed.
- Dry runs complete using wrapper reads only.
- Missing contacts, organizations, and activities can be created through the wrapper when the key has the documented scopes.
- Existing-record changes that the wrapper cannot perform are visible as actionable Conflicts rather than blocking activation or being silently discarded.
- No secret, cross-tenant identifier, duplicate activity, or false-success state is introduced.
