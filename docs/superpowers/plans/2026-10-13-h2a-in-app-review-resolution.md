# HubSpot-to-Albi In-App Review Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators resolve Sample Review records one at a time with immediate supported HubSpot writes, safe Albi mapping/creation, linked manual Albi tasks, reviewed organization context, and auditable crash-safe execution.

**Architecture:** A shared catalog gives Overview and Sample Review one reason taxonomy. A pure planner turns server-reloaded evidence plus administrator choices into one allowlisted provider operation and/or manual Albi tasks; durable tenant-scoped intents and events fence retries around provider calls. New HubSpot mutation methods are exposed only to the resolution service, while existing Albi reads/creates remain the sole Albi mutations.

**Tech Stack:** React 18, React Router 6, Vite 5, Netlify Functions, Node.js ESM and `node:test`, Supabase/Postgres with RLS, HubSpot CRM v3 writes plus existing 2026-09 reads, Guardian Albi Wrapper reads/creates.

**Spec:** `docs/superpowers/specs/2026-10-13-h2a-in-app-review-resolution-design.md`

## Global Constraints

- The Guardian Albi Wrapper is unchanged; existing Albi contact/organization updates and reassociation remain manual.
- Provider credentials remain encrypted and server-side; browser payloads never contain or select credentials.
- Only company admins and shared-table super admins may create resolution intents; members remain read-only.
- Every database lookup and uniqueness rule includes the server-resolved application company.
- No automatic provider record deletion, merge, archive, HubSpot association removal, or live-sync activation.
- A browser request supplies decisions and expected versions, never trusted provider values or provider URLs.
- Only one provider mutation may execute per claimed intent step; database locks are never held during HTTP calls.
- Recheck and original sample totals retain their existing semantics; only a fresh version-one sample with zero captured underlying review rows unlocks the full dry run.
- Albi deep links use only `https://app.albiware.com/Relationships/Contact/{positiveId}` and `https://app.albiware.com/Relationships/Organization/{positiveId}`.
- The mutation rollout defaults to disabled and is controlled by `H2A_REVIEW_RESOLUTION_MODE=disabled|super_admin|admins`.
- Preserve the user-owned untracked `_reference/` directory.

## Review Focus

- Provider evidence changes after the page loads but before confirmation: reject before mutation, refresh evidence, and require a new decision (Task 6).
- A function stops after HubSpot accepted a write but before Supabase records success: read-after-write reconciliation completes the existing intent without a second PATCH (Task 6).
- A mixed field decision successfully updates HubSpot but still needs manual Albi changes: preserve the successful audit event and remain `waiting_on_albi` (Tasks 5 and 6).
- A reason appears in run totals but not in the queue taxonomy: the shared catalog must produce the same specific label and filter value on both surfaces (Task 1).
- A reviewed organization choice points to a deleted or no-longer-associated HubSpot company: ignore the choice and return the contact to review without removing any association (Task 7).

---

## File Structure

### New focused units

- `shared/h2aReviewReasons.js` — fixed shared reason metadata and filter helpers used by server and browser.
- `shared/h2aProviderLinks.js` — validated HubSpot/Albi deep-link construction with fixed origins.
- `netlify/functions/_h2a/reviewResolution.js` — decision validation, pure planning, safe projection, and decision hashing.
- `netlify/functions/_h2a/reviewResolutionService.js` — durable intent execution, provider reconciliation, manual task state, and recheck handoff.
- `netlify/functions/h2a-dry-run-review-resolutions.js` — authenticated GET/POST API and rollout-mode enforcement.
- `src/features/hubspotToAlbi/SampleReviewResolution.jsx` — field choices, identity actions, organization choice, confirmation, and manual Albi task UI.
- `supabase/h2a-review-resolutions.sql` — idempotent deployable migration for intents, events, reviewed organization choices, and RPCs.
- `tests/h2a/review-reasons.test.mjs`, `review-resolution.test.mjs`, `review-resolution-service.test.mjs`, `review-resolutions-api.test.mjs`, and `review-resolution-ui-contract.test.mjs` — focused contracts.

### Existing units changed

- `src/features/hubspotToAlbi/reviewBreakdown.js` and `sampleReview.js` consume the shared catalog.
- `OverviewPage.jsx`, `SampleReviewPage.jsx`, and `SampleReviewDetail.jsx` connect filtering and the resolution component.
- `src/lib/hubspotToAlbi.js` adds safe resolution API methods.
- `_h2a/hubspotClient.js` gains three allowlisted mutation methods.
- `_h2a/repository.js` gains resolution and organization-choice persistence methods.
- `_h2a/review.js`, `reviewService.js`, and `orchestrator.js` consume reviewed organization context.
- `h2a-settings.js`, `preflight.js`, and `preflightPresentation.js` expose truthful HubSpot write readiness.
- `supabase/h2a-schema.sql` remains the canonical complete schema and mirrors the deployable migration.
- `docs/hubspot-to-albi-pilot-runbook.md` documents rollout, scopes, pilot, and rollback.

---

### Task 1: Shared Reason Catalog and Provider Deep Links

**Files:**
- Create: `shared/h2aReviewReasons.js`
- Create: `shared/h2aProviderLinks.js`
- Modify: `netlify/functions/_h2a/review.js`
- Modify: `src/features/hubspotToAlbi/reviewBreakdown.js`
- Modify: `src/features/hubspotToAlbi/sampleReview.js`
- Modify: `src/features/hubspotToAlbi/OverviewPage.jsx`
- Test: `tests/h2a/review-reasons.test.mjs`
- Test: `tests/h2a/sample-review-presentation.test.mjs`
- Test: `tests/h2a/operations-ui-contract.test.mjs`

**Interfaces:**
- Consumes: stored reason codes from `netlify/functions/_h2a/review.js`.
- Produces: `H2A_REVIEW_REASON_CATALOG`, `getH2AReviewReason(code)`, `listH2AReviewReasonOptions(codes?)`, `buildAlbiRecordUrl(objectType, id)`, and `buildHubSpotRecordUrl(portalId, objectType, id)`.

- [ ] **Step 1: Write failing shared-catalog tests**

```js
import { REVIEW_REASONS } from '../../netlify/functions/_h2a/review.js'
import { getH2AReviewReason, listH2AReviewReasonOptions } from '../../shared/h2aReviewReasons.js'
import { buildAlbiRecordUrl } from '../../shared/h2aProviderLinks.js'

for (const reason of REVIEW_REASONS) {
  assert.equal(getH2AReviewReason(reason).code, reason)
  assert.ok(getH2AReviewReason(reason).label)
}
assert.equal(getH2AReviewReason('missing_hubspot_company').label, 'HubSpot company is missing')
assert.ok(listH2AReviewReasonOptions(['missing_hubspot_company']).some(row => row.value === 'missing_hubspot_company'))
assert.equal(buildAlbiRecordUrl('contacts', '2590478'), 'https://app.albiware.com/Relationships/Contact/2590478')
assert.equal(buildAlbiRecordUrl('companies', 635650), 'https://app.albiware.com/Relationships/Organization/635650')
assert.equal(buildAlbiRecordUrl('contacts', 'javascript:alert(1)'), null)
```

Add a presentation test proving a reason previously collapsed by `reviewBreakdown.js` keeps the same specific label in the breakdown and queue. Add a UI contract proving Overview reason rows link to `/hubspot-to-albi/sample-review?objectType=contacts&reason=<encoded-code>`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test tests/h2a/review-reasons.test.mjs tests/h2a/sample-review-presentation.test.mjs tests/h2a/operations-ui-contract.test.mjs`

Expected: FAIL because the shared modules and reason-filter links do not exist.

- [ ] **Step 3: Implement the shared catalog and link builders**

```js
export const H2A_REVIEW_REASON_CATALOG = Object.freeze({
  email_phone_disagree: Object.freeze({ code: 'email_phone_disagree', label: 'Email and phone point to different records', category: 'identity', actions: ['link_existing'] }),
  nonblank_field_difference: Object.freeze({ code: 'nonblank_field_difference', label: 'HubSpot and Albi have different values', category: 'field', actions: ['resolve_fields'] }),
  missing_hubspot_company: Object.freeze({ code: 'missing_hubspot_company', label: 'HubSpot company is missing', category: 'association', actions: ['choose_organization'] }),
})

export function getH2AReviewReason(code) {
  return H2A_REVIEW_REASON_CATALOG[code] ?? Object.freeze({ code: 'other_review_reason', label: 'Other review reason', category: 'provider', actions: [] })
}
```

Populate the same object with these exact remaining fixed codes: `existing_mapping`, `unique_exact_match`, `unique_exact_domain`, `name_and_corroboration`, `no_match`, `target_already_mapped`, `duplicate_candidates`, `unsupported_phone_evidence`, `name_only_candidate`, `missing_required_name`, `contradictory_evidence`, `albi_organization_update_contract_unverified`, `albi_contact_update_contract_unverified`, `organization_fields_require_review`, `contact_fields_require_review`, `albi_contact_association_contract_unverified`, `association_contract_unverified`, `organization_type_confirmation_required`, `contact_type_confirmation_required`, `activity_type_confirmation_required`, `unsupported_international_format`, `invalid_phone_length`, `extension_not_supported`, `organization_unresolved`, `multiple_associated_organizations`, `missing_hubspot_contact`, `multiple_candidates`, `missing_target`, `unresolved_target`, `dry_run_preview`, `reviewer_skipped`, `not_verified_direct_crm_email`, `delivery_reconciled`, `already_delivered`, `delivered`, `reconciled`, `stale_attempt`, `retry_scheduled`, `failed`, `still_needs_review`, `safe_to_link`, `safe_to_create`, `source_missing`, and `recheck_failed`. Preserve the current `SAMPLE_REVIEW_GUIDANCE` guidance text; where `REASON_LABELS` has a more specific label, use that label on both surfaces. Generate the existing fixed category/code provider-error combinations from the exported error category and code arrays. Change `review.js` to derive `REVIEW_REASONS` from the shared catalog keys so there is only one allowlist.

Identity reasons expose only `link_existing|create_albi`; field reasons expose `resolve_fields`; association reasons expose `choose_organization`; configuration, preview, outcome, and provider-error reasons expose no mutation action. Build links only after `/^[1-9]\d*$/` validation, fixed object-type lookup, and `encodeURIComponent` of each path segment.

- [ ] **Step 4: Replace duplicate presentation maps and add filtered Overview links**

Make `presentReviewBreakdown()` and `presentSampleReviewItem()` call `getH2AReviewReason()`. Populate reason options from the codes present in the current sample when supplied, otherwise from the fixed catalog. Add `Link` targets on Overview items without changing their visible copy.

- [ ] **Step 5: Run focused and frontend contract tests**

Run: `node --test tests/h2a/review-reasons.test.mjs tests/h2a/sample-review-presentation.test.mjs tests/h2a/operations-ui-contract.test.mjs tests/h2a/frontend-contracts.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/h2aReviewReasons.js shared/h2aProviderLinks.js netlify/functions/_h2a/review.js src/features/hubspotToAlbi/reviewBreakdown.js src/features/hubspotToAlbi/sampleReview.js src/features/hubspotToAlbi/OverviewPage.jsx tests/h2a/review-reasons.test.mjs tests/h2a/sample-review-presentation.test.mjs tests/h2a/operations-ui-contract.test.mjs
git commit -m "Unify H2A review reasons and record links"
```

---

### Task 2: Tenant-Safe Resolution Schema and RPCs

**Files:**
- Create: `supabase/h2a-review-resolutions.sql`
- Modify: `supabase/h2a-schema.sql`
- Modify: `scripts/test-h2a-schema-contract.mjs`

**Interfaces:**
- Consumes: `h2a_companies`, `h2a_sync_runs`, `h2a_dry_run_reviews`, `auth.users`, and existing service-role RPC conventions.
- Produces: `h2a_dry_run_review_resolutions`, `h2a_dry_run_review_resolution_events`, `h2a_contact_organization_choices`, `h2a_create_review_resolution`, `h2a_claim_review_resolution`, `h2a_finish_review_resolution`, and `h2a_upsert_contact_organization_choice`.

- [ ] **Step 1: Recheck current Supabase guidance before schema work**

Fetch `https://supabase.com/changelog.md`, scan changes tagged `breaking-change` since 2026-10-13 for database, RLS, function, or migration behavior, then read `https://supabase.com/docs/guides/database/postgres/row-level-security.md` and `https://supabase.com/docs/guides/database/functions.md`. Record any contract change that affects this migration in the plan progress notes before editing SQL.

- [ ] **Step 2: Extend schema-contract tests before writing SQL**

Assert all three tables have UUID primary keys, `company_id`, RLS enabled, no browser mutation grants, indexed foreign keys, and tenant-inclusive uniqueness. Assert the resolution status check contains exactly `pending|applying|waiting_on_albi|ready_to_recheck|completed|failed|superseded`. Assert each RPC pins `search_path`, rejects NULL required arguments, revokes `PUBLIC|anon|authenticated`, and grants only `service_role`.

Assert a partial index equivalent to this exists:

```sql
create index h2a_review_resolutions_active_idx
on public.h2a_dry_run_review_resolutions (company_id, status, created_at, id)
where status in ('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'failed');
```

- [ ] **Step 3: Run schema tests and verify failure**

Run: `npm run test:h2a:schema`

Expected: FAIL because the resolution schema is absent.

- [ ] **Step 4: Add constrained tables to the deployable migration**

Use this table contract in both SQL files:

```sql
create table if not exists public.h2a_dry_run_review_resolutions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.h2a_companies(id) on delete cascade,
  run_id uuid not null references public.h2a_sync_runs(id) on delete cascade,
  review_id uuid not null references public.h2a_dry_run_reviews(id) on delete cascade,
  portal_id text not null,
  object_type text not null check (object_type in ('contacts', 'companies')),
  source_id text not null,
  action text not null check (action in ('resolve_fields', 'link_existing', 'create_albi', 'choose_organization')),
  status text not null default 'pending' check (status in ('pending', 'applying', 'waiting_on_albi', 'ready_to_recheck', 'completed', 'failed', 'superseded')),
  expected_review_updated_at timestamptz not null,
  decision jsonb not null,
  decision_hash text not null check (decision_hash ~ '^[a-f0-9]{64}$'),
  client_request_id uuid not null,
  lease_owner uuid,
  lease_expires_at timestamptz,
  provider_outcome_code text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, review_id, expected_review_updated_at, decision_hash),
  unique (company_id, client_request_id)
);
```

Add append-only event and reviewed-choice tables with tenant-scoped foreign keys or composite verification inside RPCs. Event types are fixed to `planned|claimed|provider_applied|provider_reconciled|waiting_on_albi|recheck_requested|completed|failed|superseded`. Event details default to `{}` and must be a JSON object.

- [ ] **Step 5: Add short claim/finalize/upsert RPCs**

`h2a_create_review_resolution` locks the tenant review row, verifies run/review/company identity and exact `updated_at`, inserts idempotently, and appends `planned`. `h2a_claim_review_resolution` uses a transaction-scoped advisory lock keyed by company plus review and claims only an expired or unclaimed active row. `h2a_finish_review_resolution` requires the exact lease owner and transitions only through the allowed state graph. `h2a_upsert_contact_organization_choice` serializes on company, portal, and contact before an upsert.

No RPC accepts provider snapshots or performs HTTP work.

- [ ] **Step 6: Add RLS, grants, indexes, and idempotent constraint guards**

Enable RLS on every new public table. Revoke all browser access; service functions use the service role. Index `run_id`, `review_id`, `resolution_id`, `created_by`, and the organization-choice lookup `(company_id, portal_id, hubspot_contact_id)`. Use `pg_constraint` guards rather than unsupported `ADD CONSTRAINT IF NOT EXISTS`.

- [ ] **Step 7: Run schema tests**

Run: `npm run test:h2a:schema`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add supabase/h2a-review-resolutions.sql supabase/h2a-schema.sql scripts/test-h2a-schema-contract.mjs
git commit -m "Add durable H2A review resolution storage"
```

---

### Task 3: Resolution Repository and Safe Projection

**Files:**
- Create: `netlify/functions/_h2a/reviewResolution.js`
- Modify: `netlify/functions/_h2a/repository.js`
- Test: `tests/h2a/repository.test.mjs`
- Test: `tests/h2a/review-resolution.test.mjs`

**Interfaces:**
- Consumes: Task 2 RPCs and tables; existing `projectReviewRow()` conventions.
- Produces: `normalizeResolutionDecision(input)`, `hashResolutionDecision(input)`, `projectReviewResolution(row, events)`, and repository methods `createReviewResolution`, `getReviewResolution`, `getCurrentReviewResolution`, `claimReviewResolution`, `finishReviewResolution`, `listReviewResolutionEvents`, `appendReviewResolutionEvent`, `getContactOrganizationChoice`, and `upsertContactOrganizationChoice`.

- [ ] **Step 1: Write failing normalization and projection tests**

```js
const decision = normalizeResolutionDecision({
  action: 'resolve_fields',
  fieldChoices: { email: 'albi', phoneNumber: 'hubspot' },
})
assert.deepEqual(decision, { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } })
assert.equal(hashResolutionDecision(decision), hashResolutionDecision({ ...decision }))
assert.throws(() => normalizeResolutionDecision({ action: 'resolve_fields', fieldChoices: { apiKey: 'hubspot' } }))
```

Projection tests must drop lease owners, raw database fields, unknown JSON keys, arbitrary provider messages, credentials, and unallowlisted snapshots while retaining fixed status, action, manual task field names, safe IDs, and event codes.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/h2a/review-resolution.test.mjs tests/h2a/repository.test.mjs`

Expected: FAIL because the module and repository methods do not exist.

- [ ] **Step 3: Implement fixed decision schemas and deterministic hashing**

Use sorted field-choice keys and `sha256` over canonical JSON. Accept only:

```js
const ACTION_FIELDS = Object.freeze({
  resolve_fields: new Set(['fieldChoices']),
  link_existing: new Set(['candidateId', 'approveManyToOne']),
  create_albi: new Set([]),
  choose_organization: new Set(['organizationSourceId', 'addHubSpotAssociation']),
})
```

Field winners are exactly `hubspot|albi`. IDs are nonempty bounded digit strings for Albi candidates and bounded HubSpot numeric strings for source organization IDs. Reject unknown keys.

- [ ] **Step 4: Implement tenant-scoped repository methods**

Every method begins with company scope and calls the Task 2 RPC or uses `.eq('company_id', companyId)`. `getCurrentReviewResolution` orders by `created_at DESC, id DESC` and returns one safe row. Event listing orders by `created_at ASC, id ASC` and is capped.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/h2a/review-resolution.test.mjs tests/h2a/repository.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/_h2a/reviewResolution.js netlify/functions/_h2a/repository.js tests/h2a/review-resolution.test.mjs tests/h2a/repository.test.mjs
git commit -m "Add H2A review resolution repository"
```

---

### Task 4: Allowlisted HubSpot Mutation Adapter

**Files:**
- Modify: `netlify/functions/_h2a/hubspotClient.js`
- Modify: `tests/h2a/fixtures/hubspot/responses.json`
- Modify: `tests/h2a/fixtures/metadata.json`
- Modify: `tests/h2a/api-clients.test.mjs`

**Interfaces:**
- Consumes: existing `createHttpClient`, `ApiError`, ID validation, and HubSpot credential handling.
- Produces: `HubSpotClient.updateContact(id, properties)`, `updateCompany(id, properties)`, and `addContactCompanyAssociation(contactId, companyId)`.

- [ ] **Step 1: Write failing exact-request tests**

Assert:

```js
await client.updateContact('123', { email: 'person@example.com', phone: '5551112222' })
assert.equal(request.method, 'PATCH')
assert.equal(request.url, 'https://api.hubapi.com/crm/v3/objects/contacts/123')
assert.deepEqual(request.body, { properties: { email: 'person@example.com', phone: '5551112222' } })
```

Add the company equivalent and association request:

```text
PUT /crm/v3/objects/contacts/123/associations/companies/456/1
```

Pin the verified default contact-to-company association type in one named constant and test it. Reject unknown fields, non-scalar values, empty update objects, invalid IDs, overlong strings, and any delete/remove operation. Assert mutation requests are not automatically retried.

- [ ] **Step 2: Run client tests and verify failure**

Run: `node --test tests/h2a/api-clients.test.mjs`

Expected: FAIL because mutation methods are absent.

- [ ] **Step 3: Implement allowlisted write methods**

```js
const WRITE_ROOT = '/crm/v3/objects'
const WRITABLE = Object.freeze({
  contacts: new Set(['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'jobtitle', 'address', 'address2', 'city', 'state', 'zip', 'country']),
  companies: new Set(['name', 'domain', 'phone', 'address', 'address2', 'city', 'state', 'zip', 'country']),
})
```

Validate and sort property keys, allow an explicit empty string for a confirmed clear, and reject all other non-string values. Use `retrySafe: false`. Normalize only the returned ID and allowlisted properties; never surface raw response bodies.

- [ ] **Step 4: Run client and HTTP regression tests**

Run: `node --test tests/h2a/api-clients.test.mjs tests/h2a/domain-contracts.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_h2a/hubspotClient.js tests/h2a/fixtures/hubspot/responses.json tests/h2a/fixtures/metadata.json tests/h2a/api-clients.test.mjs
git commit -m "Add guarded HubSpot review mutations"
```

---

### Task 5: Pure Record-Level Resolution Planner

**Files:**
- Modify: `netlify/functions/_h2a/reviewResolution.js`
- Test: `tests/h2a/review-resolution.test.mjs`

**Interfaces:**
- Consumes: normalized Task 3 decisions, current projected review evidence, current HubSpot record, current selected Albi record, and existing option mappings.
- Produces: `buildReviewResolutionPlan(input)` returning `{ decisionHash, action, providerOperation, manualTasks, mapping, organizationChoice, verification }`.

- [ ] **Step 1: Write failing plan-partition tests**

Pin these cases:

```js
const plan = buildReviewResolutionPlan({
  review, hubspot: { email: 'hs@example.com', phoneNumber: '111' },
  albi: { id: '2590478', email: 'albi@example.com', phoneNumber: '222' },
  decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } },
})
assert.deepEqual(plan.providerOperation, {
  provider: 'hubspot', operation: 'updateContact', id: review.sourceId,
  properties: { email: 'albi@example.com' },
})
assert.deepEqual(plan.manualTasks, [{ provider: 'albi', objectType: 'contacts', targetId: '2590478', fields: [{ field: 'phoneNumber', value: '111' }] }])
```

Also test whole-record-equivalent field choices, explicit blank clears, equal values omitted, unsupported fields rejected, mixed success state, link candidate identity, create payload prerequisites, and organization selection. A plan may contain at most one provider operation.

- [ ] **Step 2: Run planner tests and verify failure**

Run: `node --test tests/h2a/review-resolution.test.mjs`

Expected: FAIL because `buildReviewResolutionPlan` is absent.

- [ ] **Step 3: Implement canonical field mappings and plan construction**

Define explicit bidirectional field metadata, for example:

```js
const CONTACT_FIELDS = Object.freeze({
  firstName: { hubspot: 'firstname', albi: 'firstName' },
  lastName: { hubspot: 'lastname', albi: 'lastName' },
  email: { hubspot: 'email', albi: 'email' },
  phoneNumber: { hubspot: 'phone', albi: 'phoneNumber' },
  mobileNumber: { hubspot: 'mobilephone', albi: 'mobileNumber' },
  jobTitle: { hubspot: 'jobtitle', albi: 'jobTitle' },
  address1: { hubspot: 'address', albi: 'address1' },
  address2: { hubspot: 'address2', albi: 'address2' },
  city: { hubspot: 'city', albi: 'city' },
  state: { hubspot: 'state', albi: 'state' },
  zipcode: { hubspot: 'zip', albi: 'zipcode' },
  country: { hubspot: 'country', albi: 'country' },
})
const ORGANIZATION_FIELDS = Object.freeze({
  name: { hubspot: 'name', albi: 'name' },
  domain: { hubspot: 'domain', albi: 'domain' },
  phoneNumber: { hubspot: 'phone', albi: 'phoneNumber' },
  address1: { hubspot: 'address', albi: 'address1' },
  address2: { hubspot: 'address2', albi: 'address2' },
  city: { hubspot: 'city', albi: 'city' },
  state: { hubspot: 'state', albi: 'state' },
  zipcode: { hubspot: 'zip', albi: 'zipcode' },
  country: { hubspot: 'country', albi: 'country' },
})
```

Read values only from server-reloaded records. Manual tasks carry fixed field names and scalar target values plus a link generated by Task 1; they never carry arbitrary HTML or provider messages.

- [ ] **Step 4: Run planner tests**

Run: `node --test tests/h2a/review-resolution.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_h2a/reviewResolution.js tests/h2a/review-resolution.test.mjs
git commit -m "Plan H2A record-level resolutions"
```

---

### Task 6: Crash-Safe Resolution Service

**Files:**
- Create: `netlify/functions/_h2a/reviewResolutionService.js`
- Modify: `netlify/functions/_h2a/providerClients.js`
- Modify: `netlify/functions/_h2a/reviewService.js`
- Test: `tests/h2a/review-resolution-service.test.mjs`

**Interfaces:**
- Consumes: Task 3 repository methods, Task 4 HubSpot methods, Task 5 planner, existing Albi reads/creates, `recheckDryRunReview()`, and server-resolved credentials.
- Produces: `createReviewResolutionCapabilities(repository)`, `executeReviewResolution(deps, input)`, and `reconcileReviewResolution(deps, input)`.

- [ ] **Step 1: Write failing service tests for the complete state machine**

Cover:

- stale review rejected before any provider method is read;
- intent created before provider mutation;
- exact HubSpot PATCH followed by read-after-write;
- crash-after-write retry sees matching provider state and records `provider_reconciled` without a second PATCH;
- mixed decision records successful HubSpot write then remains `waiting_on_albi`;
- manual-only plan performs zero provider mutations and becomes `waiting_on_albi`;
- link saves only the reviewed mapping and performs zero live dispatch;
- Albi create reconciles an ambiguous response through the existing source marker;
- missing HubSpot scope stores fixed `authorization_rejected` without raw response content;
- provider validation, transient, rate-limit, timeout, and malformed responses preserve the intent;
- only one provider mutation per claim;
- a newer completed sample supersedes the intent;
- recheck completes only when production evaluation clears the row.

Use getters for forbidden methods (`updateAlbiContact`, `updateAlbiOrganization`, `removeAssociation`, `dispatch`, `saveCursor`) that throw if accessed.

- [ ] **Step 2: Run service tests and verify failure**

Run: `node --test tests/h2a/review-resolution-service.test.mjs`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement restricted capability construction**

```js
export function createReviewResolutionCapabilities(repository) {
  return Object.freeze({
    createReviewResolution: repository.createReviewResolution.bind(repository),
    claimReviewResolution: repository.claimReviewResolution.bind(repository),
    finishReviewResolution: repository.finishReviewResolution.bind(repository),
    appendReviewResolutionEvent: repository.appendReviewResolutionEvent.bind(repository),
    saveContactMapping: repository.saveContactMapping.bind(repository),
    saveOrganizationMapping: repository.saveOrganizationMapping.bind(repository),
    upsertContactOrganizationChoice: repository.upsertContactOrganizationChoice.bind(repository),
  })
}
```

Do not pass the full repository or full provider clients into pure planning code.

- [ ] **Step 4: Implement create, claim, execute, reconcile, and finalize flow**

Reload the current sample and review, reload provider evidence, build the plan, persist/reuse the intent, claim with a UUID owner and bounded lease, perform one operation, verify through a read, and finalize with fixed outcome codes. Make a stale page revision and a changed provider comparison require reconfirmation.

If a plan still contains manual tasks after an automatic write, store only the allowlisted tasks and finalize `waiting_on_albi`. On recheck, rebuild evidence and complete verified tasks instead of trusting a user checkbox.

- [ ] **Step 5: Integrate resolution reconciliation with recheck**

`recheckDryRunReview()` reads the current intent after evaluation. A cleared or no-longer-in-scope result finalizes it `completed`; a still-different manual task remains `waiting_on_albi`; a provider read failure preserves its state.

- [ ] **Step 6: Run service and review regressions**

Run: `node --test tests/h2a/review-resolution-service.test.mjs tests/h2a/review-service.test.mjs tests/h2a/review.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/_h2a/reviewResolutionService.js netlify/functions/_h2a/providerClients.js netlify/functions/_h2a/reviewService.js tests/h2a/review-resolution-service.test.mjs tests/h2a/review-service.test.mjs
git commit -m "Execute durable H2A review resolutions"
```

---

### Task 7: Reviewed Organization Context in Matching and Sync

**Files:**
- Modify: `netlify/functions/_h2a/review.js`
- Modify: `netlify/functions/_h2a/reviewService.js`
- Modify: `netlify/functions/_h2a/orchestrator.js`
- Modify: `netlify/functions/_h2a/repository.js`
- Test: `tests/h2a/review.test.mjs`
- Test: `tests/h2a/review-service.test.mjs`
- Test: `tests/h2a/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `repository.getContactOrganizationChoice(companyId, portalId, hubspotContactId)` from Task 3.
- Produces: `selectReviewedOrganizationContext({ associatedCompanyIds, choice, availableCompanies })` and consistent evaluator/orchestrator behavior.

- [ ] **Step 1: Write failing organization-choice tests**

Assert a contact with two associated companies and a valid reviewed choice uses the selected company without removing the other. Assert a missing, deleted, cross-tenant, wrong-portal, or no-longer-associated choice is ignored and returns `multiple_associated_organizations`. Assert an explicitly added association becomes eligible only after the follow-up association read includes it.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/h2a/review.test.mjs tests/h2a/review-service.test.mjs tests/h2a/orchestrator.test.mjs`

Expected: FAIL because matching does not consume reviewed organization context.

- [ ] **Step 3: Implement the pure selector and repository preload**

```js
export function selectReviewedOrganizationContext({ associatedCompanyIds, choice, availableCompanies }) {
  const ids = new Set(associatedCompanyIds.map(String))
  const selected = choice && ids.has(String(choice.hubspot_company_id))
    && availableCompanies.some(company => String(company.id) === String(choice.hubspot_company_id))
    ? String(choice.hubspot_company_id) : null
  return selected ? { status: 'selected', companyId: selected } : { status: ids.size === 1 ? 'single' : 'ambiguous', companyId: ids.size === 1 ? [...ids][0] : null }
}
```

Load choices tenant-first and pass only the applicable contact choice into evaluation.

- [ ] **Step 4: Apply the selector consistently**

Use the same selector in individual recheck and orchestrator contact processing. Never let a reviewed choice bypass organization existence, mapping, or field review. Never call an association removal method.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/h2a/review.test.mjs tests/h2a/review-service.test.mjs tests/h2a/orchestrator.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/_h2a/review.js netlify/functions/_h2a/reviewService.js netlify/functions/_h2a/orchestrator.js netlify/functions/_h2a/repository.js tests/h2a/review.test.mjs tests/h2a/review-service.test.mjs tests/h2a/orchestrator.test.mjs
git commit -m "Honor reviewed H2A organization context"
```

---

### Task 8: Admin Resolution API and Rollout Gate

**Files:**
- Create: `netlify/functions/h2a-dry-run-review-resolutions.js`
- Modify: `netlify/functions/h2a-dry-run-reviews.js`
- Modify: `netlify/functions/h2a-settings.js`
- Modify: `netlify/functions/_h2a/preflight.js`
- Test: `tests/h2a/review-resolutions-api.test.mjs`
- Modify: `tests/h2a/dry-run-reviews-api.test.mjs`
- Modify: `tests/h2a/settings-api.test.mjs`

**Interfaces:**
- Consumes: Task 6 execution service, existing H2A auth, credential loading, safe JSON response helpers, and `H2A_REVIEW_RESOLUTION_MODE`.
- Produces: GET/POST resolution API plus safe `resolutionCapability` and current-resolution projections on review detail.

- [ ] **Step 1: Write failing endpoint authorization and payload tests**

Cover invalid session, member POST, admin mode, super-admin-only mode, disabled mode, cross-company selectors, unknown fields, malformed UUID/timestamp/decision/action, stale response, idempotent replay, sanitized provider failures, and GET projection.

Assert mode behavior exactly:

```js
assert.equal(canResolve({ mode: 'disabled', isAdmin: true, isSuperAdmin: true }), false)
assert.equal(canResolve({ mode: 'super_admin', isAdmin: true, isSuperAdmin: false }), false)
assert.equal(canResolve({ mode: 'super_admin', isSuperAdmin: true }), true)
assert.equal(canResolve({ mode: 'admins', isAdmin: true }), true)
```

- [ ] **Step 2: Run API tests and verify failure**

Run: `node --test tests/h2a/review-resolutions-api.test.mjs tests/h2a/dry-run-reviews-api.test.mjs tests/h2a/settings-api.test.mjs`

Expected: FAIL because the endpoint and rollout projection are absent.

- [ ] **Step 3: Implement strict GET/POST routing**

GET accepts only company and review IDs and returns a safe current resolution with capped events. POST accepts only the fields named in the spec, resolves auth/company/role before credentials, and calls `executeReviewResolution`. Map stale to 409, validation to 400, authorization to 403, unavailable mode to 409, and unexpected failures to a fixed 500 response.

- [ ] **Step 4: Expose truthful capability state**

Review detail returns `{ enabled, mode, canResolve, hubspotWrites: 'verified_when_first_used'|'available'|'rejected' }` without exposing environment values or raw scope data. Settings and preflight do not claim HubSpot write availability until a successful mutation has been durably recorded; a fixed authorization code becomes **Authentication or write scope rejected**.

- [ ] **Step 5: Run API tests**

Run: `node --test tests/h2a/review-resolutions-api.test.mjs tests/h2a/dry-run-reviews-api.test.mjs tests/h2a/settings-api.test.mjs tests/h2a/preflight.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/h2a-dry-run-review-resolutions.js netlify/functions/h2a-dry-run-reviews.js netlify/functions/h2a-settings.js netlify/functions/_h2a/preflight.js tests/h2a/review-resolutions-api.test.mjs tests/h2a/dry-run-reviews-api.test.mjs tests/h2a/settings-api.test.mjs tests/h2a/preflight.test.mjs
git commit -m "Add admin H2A review resolution API"
```

---

### Task 9: Browser Client and Resolution Presentation Model

**Files:**
- Modify: `src/lib/hubspotToAlbi.js`
- Create: `src/features/hubspotToAlbi/sampleReviewResolution.js`
- Modify: `src/features/hubspotToAlbi/sampleReview.js`
- Test: `tests/h2a/sample-review-presentation.test.mjs`
- Test: `tests/h2a/frontend-contracts.test.mjs`

**Interfaces:**
- Consumes: Task 8 API shapes and Task 1 shared catalog/link builders.
- Produces: `getH2ADryRunReviewResolution`, `resolveH2ADryRunReview`, `presentReviewResolution(item)`, `buildResolutionRequest(input)`, and `buildResolutionConfirmation(input)`.

- [ ] **Step 1: Write failing request and presentation tests**

Assert browser requests send only `reviewId`, `expectedUpdatedAt`, action-specific decisions, and `clientRequestId`. Assert values from HubSpot/Albi snapshots are absent. Assert unknown server fields, provider messages, credentials, and arbitrary URLs are dropped.

Test a mixed confirmation:

```js
assert.deepEqual(buildResolutionConfirmation(model), {
  hubspotWrites: [{ field: 'Email', value: 'albi@example.com' }],
  albiTasks: [{ field: 'Phone', value: '5551112222', url: 'https://app.albiware.com/Relationships/Contact/2590478' }],
  mapping: null,
  association: null,
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/h2a/sample-review-presentation.test.mjs tests/h2a/frontend-contracts.test.mjs`

Expected: FAIL because the client and model are absent.

- [ ] **Step 3: Implement strict API methods and presentation model**

Reuse the existing request sanitizer and stable public error mapping. Generate `crypto.randomUUID()` in the click handler, retain it for retries of the same confirmation, and generate a new one only after the user changes the decision.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/h2a/sample-review-presentation.test.mjs tests/h2a/frontend-contracts.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hubspotToAlbi.js src/features/hubspotToAlbi/sampleReviewResolution.js src/features/hubspotToAlbi/sampleReview.js tests/h2a/sample-review-presentation.test.mjs tests/h2a/frontend-contracts.test.mjs
git commit -m "Add H2A review resolution client model"
```

---

### Task 10: Sample Review Resolution UI

**Files:**
- Create: `src/features/hubspotToAlbi/SampleReviewResolution.jsx`
- Modify: `src/features/hubspotToAlbi/SampleReviewDetail.jsx`
- Modify: `src/features/hubspotToAlbi/SampleReviewPage.jsx`
- Modify: `src/features/hubspotToAlbi/preflightPresentation.js`
- Test: `tests/h2a/review-resolution-ui-contract.test.mjs`
- Modify: `tests/h2a/sample-review-ui-contract.test.mjs`
- Modify: `tests/h2a/preflight-presentation.test.mjs`
- Modify: `tests/h2a/ui-render-fixture.mjs`

**Interfaces:**
- Consumes: Task 9 presentation model/client and Task 8 capability projection.
- Produces: per-field choices, shortcuts, candidate/create/context actions, exact confirmation dialog, manual Albi task cards, retry/recheck states, and accessible audit/status presentation.

- [ ] **Step 1: Write failing rendered UI tests**

Render fixtures for:

- mode disabled and member read-only states contain no mutation controls;
- per-field **Use HubSpot** and **Use Albi** choices;
- whole-record shortcuts affect only eligible differing fields;
- confirmation groups HubSpot writes and Albi manual tasks separately;
- link/create controls require candidate/type readiness;
- organization selection states that no existing association will be removed;
- **Open contact in Albi** and **Open organization in Albi** use exact safe URLs with `target="_blank"` and `rel="noreferrer"`;
- mixed success displays **Waiting on Albi** and preserves the successful HubSpot audit entry;
- duplicate submission is disabled;
- 409 refreshes detail and requires reconfirmation;
- provider failure retains the decision and offers retry;
- reason query parameters initialize the filter and invalid values are cleared.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `node --test tests/h2a/review-resolution-ui-contract.test.mjs tests/h2a/sample-review-ui-contract.test.mjs tests/h2a/preflight-presentation.test.mjs`

Expected: FAIL because the resolution component and states do not exist.

- [ ] **Step 3: Implement the focused resolution component**

Keep provider choice state inside `SampleReviewResolution.jsx`. Require an explicit choice for every submitted differing field. Show destination copy beside each choice. The parent page owns request cancellation, tenant/review generation guards, busy ID, and refreshing the selected detail after a result.

- [ ] **Step 4: Implement confirmation, manual tasks, and accessible state changes**

Use a focus-trapped confirmation dialog consistent with `ConflictDetail.jsx`. Announce applying, waiting, reconciled, failed, and stale-refresh states through `role="status"` or `role="alert"`. Never infer completion from clicking an Albi link; only recheck changes review status.

- [ ] **Step 5: Run UI and frontend regressions**

Run: `node --test tests/h2a/review-resolution-ui-contract.test.mjs tests/h2a/sample-review-ui-contract.test.mjs tests/h2a/preflight-presentation.test.mjs tests/h2a/frontend-contracts.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/hubspotToAlbi/SampleReviewResolution.jsx src/features/hubspotToAlbi/SampleReviewDetail.jsx src/features/hubspotToAlbi/SampleReviewPage.jsx src/features/hubspotToAlbi/preflightPresentation.js tests/h2a/review-resolution-ui-contract.test.mjs tests/h2a/sample-review-ui-contract.test.mjs tests/h2a/preflight-presentation.test.mjs tests/h2a/ui-render-fixture.mjs
git commit -m "Add in-app H2A sample resolution UI"
```

---

### Task 11: Runbook, Smoke Contracts, and Full Verification

**Files:**
- Modify: `docs/hubspot-to-albi-pilot-runbook.md`
- Modify: `scripts/test-h2a-end-to-end.mjs`
- Modify: `tests/h2a/smoke-script.test.mjs`
- Modify: `package.json` only if the new focused tests are not already included by the existing `test:h2a` glob.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: operator instructions, guarded read/write smoke coverage, rollback instructions, and release evidence.

- [ ] **Step 1: Write failing smoke contract tests**

Assert the self-test exercises:

- one HubSpot field update plan and read-after-write reconciliation using fixtures;
- one ambiguous HubSpot response reconciled without a repeated write;
- Albi manual task deep links without an Albi update call;
- one reviewed mapping and organization choice without live dispatch;
- write mode remains blocked unless both existing sandbox acknowledgements and a new `H2A_ALLOW_HUBSPOT_REVIEW_WRITES=true` acknowledgement are present.

- [ ] **Step 2: Run smoke tests and verify failure**

Run: `node --test tests/h2a/smoke-script.test.mjs`

Expected: FAIL because the resolution smoke path and acknowledgement are absent.

- [ ] **Step 3: Extend the self-test and runbook**

Document exact Supabase file order, `H2A_REVIEW_RESOLUTION_MODE`, required HubSpot write scopes, super-admin-first enablement, one-contact/one-organization pilot, direct Albi links, fresh-sample verification, disabling the mode for rollback, and the fact that rollback does not reverse provider writes.

Keep live provider writes behind explicit sandbox acknowledgements. The normal self-test uses fixtures and performs no network mutation.

- [ ] **Step 4: Run focused smoke tests**

Run: `node --test tests/h2a/smoke-script.test.mjs && npm run test:h2a:e2e`

Expected: PASS with self-test output proving guarded ordering and zero unacknowledged provider writes.

- [ ] **Step 5: Run complete verification**

Run each command separately and require exit code 0:

```bash
npm run test:h2a
npm run test:h2a:schema
npm run test:h2a:e2e
npm run build
git diff --check
```

Expected: all tests pass; build may retain the existing Browserslist-age and chunk-size warnings but adds no new error.

- [ ] **Step 6: Commit**

```bash
git add docs/hubspot-to-albi-pilot-runbook.md scripts/test-h2a-end-to-end.mjs tests/h2a/smoke-script.test.mjs package.json
git commit -m "Document H2A review resolution rollout"
```

---

## Execution Boundaries

Implementation may create and commit code, tests, migration files, and documentation. It must not:

- apply Supabase SQL;
- change Netlify environment variables;
- deploy or push;
- perform a live provider mutation;
- activate live sync;
- enable `H2A_REVIEW_RESOLUTION_MODE` outside local fixtures;
- remove or modify `_reference/`.

Those actions require separate, explicit approval after implementation and verification.
