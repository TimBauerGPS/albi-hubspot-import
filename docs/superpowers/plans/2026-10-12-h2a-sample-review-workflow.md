# HubSpot-to-Albi Sample Review Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only, read-only review queue that identifies the contact and organization problems found by a bounded sample, supports safe individual rechecks, and unlocks a full dry run only after a fresh sample captures zero underlying review rows.

**Architecture:** Persist bounded, allowlisted contact/organization review evidence in service-only Supabase tables, and use one shared pure evaluator from both sample processing and recheck. A dedicated admin Netlify endpoint lists, details, and rechecks the current completed sample; the React route provides a responsive master/detail workflow. The full dry-run endpoint remains the enforcement boundary and accepts only the latest completed review-capable sample with zero captured review rows.

**Tech Stack:** Vite 5, React 18, React Router 6, Netlify Functions on Node ESM, Supabase/PostgreSQL, Tailwind CSS, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-11-h2a-sample-review-workflow-design.md`

## Global Constraints

- Detailed review capture is limited to `mode = 'dry_run'`, `sample_limit_per_type = 10`, and `review_capture_version = 1`.
- Only `contacts` and `companies` create detailed review rows; activity content and activity bodies are never persisted in this subsystem.
- Contact and organization snapshots use positive field allowlists and retain at most ten Albi candidates.
- Review list, detail, and recheck endpoints require a company admin or super admin through `requireH2ARequest(..., { requireAdmin: true })`.
- Company membership and `super_admins` remain the role source of truth; `user_app_access` remains only the application-entry gate.
- The browser never reads either review table directly; `public`, `anon`, and `authenticated` receive no table privileges or RLS policy.
- Recheck may read HubSpot and Albi, but it may not create, update, associate, map, reserve delivery, move a cursor, dispatch work, or alter live conflicts.
- Existing run totals remain immutable; recheck status never rewrites `h2a_sync_runs.totals` or `h2a_item_results`.
- Rechecking all rows does not unlock a full dry run. The latest completed review-capable sample must itself have captured zero review rows.
- Historical samples with `review_capture_version IS NULL` cannot be reconstructed and never satisfy the new full dry-run gate.
- Responses containing detailed review data use `Cache-Control: no-store`, fixed error messages, tenant predicates, and safe projections.
- Preserve the untracked `_reference/` directory unchanged and stage only files named by the active task.

## Review Focus

- A later failed sample must not replace or erase the prior completed review set; Task 4 adds a continuation/failure test proving current-set publication occurs only after completion.
- A sample whose items were all individually cleared must still fail the full-run gate until a fresh zero-row sample completes; Task 3 adds the repository test and Task 8 adds the HTTP enforcement test.
- A super admin changing companies while list, detail, or recheck requests are in flight must never render the prior tenant's PII; Task 7 adds abort/revision contract tests.
- A HubSpot batch read that returns no record may mean deletion, but authentication, permission, timeout, malformed, and transient failures must not clear the row; Task 5 tests each result class.
- Duplicate clicks or stale `updated_at` values must produce one winning recheck event and a fixed `409`, not contradictory statuses; Tasks 1 and 5 test database CAS and endpoint behavior.

---

### Task 1: Add the service-only review schema and atomic recheck transaction

**Files:**
- Create: `supabase/h2a-dry-run-review-workflow.sql`
- Modify: `supabase/h2a-schema.sql`
- Modify: `scripts/test-h2a-schema-contract.mjs`

**Interfaces:**
- Consumes: existing tenant-safe `(company_id, id)` key on `h2a_sync_runs` and `companies`/`auth.users` identifiers.
- Produces: `h2a_sync_runs.review_capture_version`, `h2a_dry_run_reviews`, `h2a_dry_run_review_events`, and service-role RPC `h2a_apply_dry_run_recheck(...) returns jsonb`.

- [ ] **Step 1: Extend the static schema test with the new deployment contract**

Add the migration URL and both tables to `requiredTables`, but exclude these two tables from the existing authenticated-read policy expectation because they are service-only:

```js
const reviewMigrationUrl = new URL('../supabase/h2a-dry-run-review-workflow.sql', import.meta.url)
const readReviewMigration = () => readFileSync(reviewMigrationUrl, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()

// requiredTables additions
'h2a_dry_run_reviews', 'h2a_dry_run_review_events',

const serviceOnlyTables = ['h2a_dry_run_reviews', 'h2a_dry_run_review_events']
```

Add a focused test that asserts:

```js
test('dry-run review storage is tenant-safe, bounded, service-only, and CAS-updated', () => {
  const sql = readSchema()
  const migration = readReviewMigration()
  const reviews = tableBody(sql, 'public.h2a_dry_run_reviews')
  const events = tableBody(sql, 'public.h2a_dry_run_review_events')

  assert.match(tableBody(sql, 'public.h2a_sync_runs'), /review_capture_version smallint/)
  assert.match(reviews, /object_type text not null check \(object_type in \('contacts', 'companies'\)\)/)
  assert.match(reviews, /unique \(company_id, id\)/)
  assert.match(reviews, /unique \(company_id, run_id, portal_id, object_type, source_id\)/)
  assert.match(reviews, /foreign key \(company_id, run_id\) references public\.h2a_sync_runs \(company_id, id\)/)
  assert.match(events, /foreign key \(company_id, review_id\) references public\.h2a_dry_run_reviews \(company_id, id\) on delete cascade/)
  for (const table of serviceOnlyTables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`))
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`))
    assert.doesNotMatch(sql, new RegExp(`grant [^;]*public\\.${table} to authenticated`))
    assert.doesNotMatch(sql, new RegExp(`create policy[^;]+public\\.${table}`))
  }
  const rpc = functionBody(sql, 'h2a_apply_dry_run_recheck')
  assert.match(rpc, /where r\.company_id = p_company_id and r\.id = p_review_id[\s\S]*for update/)
  assert.match(rpc, /review_capture_version = 1[\s\S]*v_current_run_id is distinct from v_review\.run_id[\s\S]*'superseded'/)
  assert.match(rpc, /v_review\.updated_at <> p_expected_updated_at/)
  assert.match(rpc, /insert into public\.h2a_dry_run_review_events/)
  assert.match(migration, /add column if not exists review_capture_version smallint/)
})
```

- [ ] **Step 2: Run the schema test and verify the new assertions fail**

Run: `npm run test:h2a:schema`

Expected: FAIL because the column, tables, migration, and RPC do not exist.

- [ ] **Step 3: Add the canonical schema definitions**

Add `review_capture_version` inside the existing `create table public.h2a_sync_runs` definition, then add the two new tables after the run/item tables so every referenced tenant key already exists:

```sql
review_capture_version smallint check (review_capture_version is null or (
    mode = 'dry_run' and sample_limit_per_type = 10 and review_capture_version = 1
  )),

create table public.h2a_dry_run_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  run_id uuid not null,
  portal_id text not null check (length(btrim(portal_id)) > 0),
  object_type text not null check (object_type in ('contacts', 'companies')),
  source_id text not null check (length(btrim(source_id)) > 0),
  reason text not null check (length(btrim(reason)) > 0),
  conflict_type text not null check (length(btrim(conflict_type)) > 0),
  source_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(source_snapshot) = 'object'),
  candidate_snapshots jsonb not null default '[]'::jsonb check (
    jsonb_typeof(candidate_snapshots) = 'array' and jsonb_array_length(candidate_snapshots) <= 10
  ),
  match_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(match_evidence) = 'object'),
  proposed_changes jsonb not null default '{}'::jsonb check (jsonb_typeof(proposed_changes) = 'object'),
  status text not null default 'needs_review' check (status in ('needs_review', 'cleared', 'no_longer_in_scope')),
  recheck_outcome text check (recheck_outcome in ('still_needs_review', 'safe_to_link', 'safe_to_create', 'source_missing')),
  last_rechecked_at timestamptz,
  last_rechecked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, run_id) references public.h2a_sync_runs (company_id, id) on delete cascade,
  unique (company_id, id),
  unique (company_id, run_id, portal_id, object_type, source_id)
);

create table public.h2a_dry_run_review_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  review_id uuid not null,
  actor_id uuid,
  event_type text not null check (event_type in (
    'captured', 'recheck_started', 'still_needs_review', 'cleared',
    'no_longer_in_scope', 'recheck_failed'
  )),
  reason text,
  sanitized_details jsonb not null default '{}'::jsonb check (jsonb_typeof(sanitized_details) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (company_id, review_id)
    references public.h2a_dry_run_reviews (company_id, id) on delete cascade
);
```

Add company-leading indexes exactly matching the access paths:

```sql
create index h2a_dry_reviews_company_run_status_idx
  on public.h2a_dry_run_reviews (company_id, run_id, status, object_type, created_at desc, id desc);
create index h2a_dry_reviews_company_run_reason_idx
  on public.h2a_dry_run_reviews (company_id, run_id, reason, created_at desc, id desc);
create index h2a_dry_reviews_last_rechecked_by_idx
  on public.h2a_dry_run_reviews (last_rechecked_by);
create index h2a_dry_review_events_company_review_idx
  on public.h2a_dry_run_review_events (company_id, review_id, created_at, id);
```

Enable RLS, revoke browser roles, and grant only the minimum service-role privileges:

```sql
alter table public.h2a_dry_run_reviews enable row level security;
revoke all on table public.h2a_dry_run_reviews from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.h2a_dry_run_reviews to service_role;

alter table public.h2a_dry_run_review_events enable row level security;
revoke all on table public.h2a_dry_run_review_events from public, anon, authenticated, service_role;
grant select, insert on table public.h2a_dry_run_review_events to service_role;
```

Do not attach the existing immutable-event trigger to the new event table: old review sets must be deletable with cascading events. Append-only behavior is enforced by withholding update/delete privileges on the event table; deletion is possible only through deletion of the parent review set.

- [ ] **Step 4: Add the atomic compare-and-swap RPC**

Add `public.h2a_apply_dry_run_recheck` with this exact public signature:

```sql
create function public.h2a_apply_dry_run_recheck(
  p_company_id uuid,
  p_review_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid,
  p_status text,
  p_recheck_outcome text,
  p_reason text,
  p_conflict_type text,
  p_source_snapshot jsonb,
  p_candidate_snapshots jsonb,
  p_match_evidence jsonb,
  p_proposed_changes jsonb,
  p_event_type text,
  p_event_details jsonb,
  p_now timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_review public.h2a_dry_run_reviews%rowtype;
  v_current_run_id uuid;
begin
  select * into v_review
    from public.h2a_dry_run_reviews r
    where r.company_id = p_company_id and r.id = p_review_id
    for update;
  if not found then return pg_catalog.jsonb_build_object('error', 'not_found'); end if;
  select r.id into v_current_run_id
    from public.h2a_sync_runs r
    where r.company_id = p_company_id
      and r.mode = 'dry_run'
      and r.status = 'completed'
      and r.sample_limit_per_type = 10
      and r.review_capture_version = 1
    order by r.created_at desc, r.id desc
    limit 1;
  if v_current_run_id is distinct from v_review.run_id then
    return pg_catalog.jsonb_build_object('error', 'superseded');
  end if;
  if v_review.updated_at <> p_expected_updated_at then
    return pg_catalog.jsonb_build_object('error', 'stale');
  end if;
  if p_status not in ('needs_review', 'cleared', 'no_longer_in_scope')
    or p_recheck_outcome not in ('still_needs_review', 'safe_to_link', 'safe_to_create', 'source_missing')
    or p_event_type not in ('still_needs_review', 'cleared', 'no_longer_in_scope')
    or p_now is null or p_actor_id is null
    or pg_catalog.jsonb_typeof(p_source_snapshot) <> 'object'
    or pg_catalog.jsonb_typeof(p_candidate_snapshots) <> 'array'
    or pg_catalog.jsonb_array_length(p_candidate_snapshots) > 10
    or pg_catalog.jsonb_typeof(p_match_evidence) <> 'object'
    or pg_catalog.jsonb_typeof(p_proposed_changes) <> 'object'
    or pg_catalog.jsonb_typeof(p_event_details) <> 'object' then
    return pg_catalog.jsonb_build_object('error', 'invalid_recheck');
  end if;

  update public.h2a_dry_run_reviews set
    status = p_status,
    recheck_outcome = p_recheck_outcome,
    reason = p_reason,
    conflict_type = p_conflict_type,
    source_snapshot = p_source_snapshot,
    candidate_snapshots = p_candidate_snapshots,
    match_evidence = p_match_evidence,
    proposed_changes = p_proposed_changes,
    last_rechecked_at = p_now,
    last_rechecked_by = p_actor_id,
    updated_at = p_now
  where company_id = p_company_id and id = p_review_id
  returning * into v_review;

  insert into public.h2a_dry_run_review_events (
    company_id, review_id, actor_id, event_type, reason, sanitized_details, created_at
  ) values (
    p_company_id, p_review_id, p_actor_id, p_event_type, p_reason, p_event_details, p_now
  );
  return pg_catalog.jsonb_build_object('review', pg_catalog.to_jsonb(v_review));
end;
$$;
```

Revoke execution from browser roles and grant it only to `service_role`. Add a separate schema assertion for `SECURITY INVOKER`, the pinned `search_path`, and the service-only execute grant. Do not add this RPC to the existing `SECURITY DEFINER` list: the service role already has the required table privileges, and the approved design does not require privilege elevation.

- [ ] **Step 5: Add the idempotent deployment migration**

Mirror the canonical definitions in `supabase/h2a-dry-run-review-workflow.sql` inside `begin; ... commit;`. Use `add column if not exists`, named constraints with `drop constraint if exists` followed by `add constraint ... not valid` and `validate constraint`, `create table if not exists`, and `create index if not exists`. Use `create or replace function` for the RPC and reapply its revoke/grant statements.

- [ ] **Step 6: Run the schema contract test**

Run: `npm run test:h2a:schema`

Expected: PASS, including service-only table and CAS RPC assertions.

- [ ] **Step 7: Commit the schema slice**

```bash
git add supabase/h2a-schema.sql supabase/h2a-dry-run-review-workflow.sql scripts/test-h2a-schema-contract.mjs
git commit -m "Add H2A sample review storage"
```

### Task 2: Build the shared pure review evaluator and safe projections

**Files:**
- Create: `netlify/functions/_h2a/review.js`
- Create: `tests/h2a/review.test.mjs`
- Modify: `netlify/functions/_h2a/match.js`
- Modify: `tests/h2a/match.test.mjs`

**Interfaces:**
- Consumes: `decideContactMatch`, `decideOrganizationMatch`, `decideFieldChanges`, `normalizePhone`, and confirmed option mappings.
- Produces: `evaluateOrganizationReview(input)`, `evaluateContactReview(input)`, `safeReviewSnapshot(record, objectType)`, `safeReviewCandidates(records, objectType)`, `projectReviewRow(row, { detail })`, `REVIEW_REASONS`, and `REVIEW_CONFLICT_TYPES`.

- [ ] **Step 1: Write evaluator tests for every terminal result**

Create table-driven tests with the stable result shape:

```js
{
  outcome: 'needs_review' | 'safe_to_link' | 'safe_to_create',
  reason: string,
  conflictType: string,
  targetId: string | null,
  evidence: string[],
  proposedChanges: { updates: object, conflicts: object, unchanged: string[] },
  candidates: object[],
}
```

At minimum pin these cases:

```js
test('contact evaluation preserves ambiguous identity and candidate evidence', () => {
  const result = evaluateContactReview({
    source: { id: 'hs-1', properties: { firstname: 'A', lastname: 'Person', email: 'a@example.com', phone: '5551112222' } },
    candidates: [
      { id: 'albi-email', firstName: 'A', lastName: 'Person', email: 'a@example.com' },
      { id: 'albi-phone', firstName: 'A', lastName: 'Person', phoneNumber: '5551112222' },
    ],
    mappings: [], optionMappings: [], organization: null,
  })
  assert.equal(result.outcome, 'needs_review')
  assert.equal(result.reason, 'email_phone_disagree')
  assert.deepEqual(result.candidates.map(item => item.id), ['albi-email', 'albi-phone'])
})

test('organization evaluation treats an exact clean match as safe to link', () => {
  const result = evaluateOrganizationReview({
    source: { id: 'hs-2', properties: { name: 'Allied', domain: 'allied.example' } },
    candidates: [{ id: 'albi-2', name: 'Allied', domain: 'allied.example' }],
    mappings: [], optionMappings: [],
  })
  assert.equal(result.outcome, 'safe_to_link')
  assert.equal(result.targetId, 'albi-2')
})
```

Also test name-only, duplicates, unsupported phone evidence, missing required name, nonblank field difference, unverified Albi update contract, organization association mismatch, multiple HubSpot organizations, missing type configuration, and clean create.

- [ ] **Step 2: Write serializer tests that attempt to inject forbidden data**

Use records containing `apiKey`, `authorization`, arbitrary nested values, activity `notes`, and email body fields. Assert that only these canonical keys survive:

```js
const CONTACT_SNAPSHOT_FIELDS = [
  'id', 'firstName', 'lastName', 'fullName', 'email', 'phoneNumber', 'mobileNumber',
  'organizationId', 'organizationName', 'jobTitle', 'address1', 'address2',
  'city', 'state', 'zipcode', 'country',
]
const ORGANIZATION_SNAPSHOT_FIELDS = [
  'id', 'name', 'domain', 'email', 'phoneNumber', 'organizationTypeIds',
  'parentOrganizationId', 'address1', 'address2', 'city', 'state', 'zipcode', 'country',
]
```

Assert candidates are capped at ten and every scalar string is capped at 500 characters.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `node --test tests/h2a/review.test.mjs tests/h2a/match.test.mjs`

Expected: FAIL because `review.js` and the candidate-selection helper do not exist.

- [ ] **Step 4: Expose deterministic candidate selection from the matcher**

Add and test `selectReviewCandidates(input, decision, entityType)` in `match.js`. It must return only candidates relevant to the match decision, falling back to the decision target when present and then to normalized name candidates, with stable ID ordering and a hard cap of ten. It must not change the existing decision result.

```js
export function selectReviewCandidates(input = {}, decision = {}, entityType = 'contact') {
  const candidates = [...(input.candidates ?? input.albiCandidates ?? [])]
  const target = decision.targetId == null ? [] : candidates.filter(item => idOf(item) === String(decision.targetId))
  const related = entityType === 'organization'
    ? organizationReviewCandidates(sourceOf(input, 'organization'), candidates)
    : contactReviewCandidates(sourceOf(input, 'contact'), candidates)
  return [...new Map([...target, ...related].map(item => [idOf(item), item])).values()]
    .filter(item => idOf(item))
    .sort((left, right) => idOf(left).localeCompare(idOf(right)))
    .slice(0, 10)
}
```

- [ ] **Step 5: Implement `review.js` as a pure module**

Keep all provider and repository access out of this file. Implement the exported evaluators by applying the existing matcher first, then the existing orchestration rules in the same order:

```js
export function evaluateOrganizationReview({ source, candidates = [], mappings = [], optionMappings = [] } = {}) {
  const sourceId = reviewId(source)
  const decision = decideOrganizationMatch({
    source, sourceId, candidates,
    existingMapping: mappingForReview(mappings, sourceId), mappings,
  })
  const related = selectReviewCandidates({ source, sourceId, candidates }, decision, 'organization')
  if (decision.action === 'conflict') return reviewConflict('organization_match', decision, related)
  if (decision.action === 'link' && hasChanges(decision.proposedChanges)) {
    return reviewConflict('organization_fields', {
      ...decision,
      reason: Object.keys(decision.proposedChanges.updates).length
        ? 'albi_organization_update_contract_unverified'
        : 'nonblank_field_difference',
    }, related)
  }
  if (decision.action === 'link') return safeResult('safe_to_link', decision, related)
  if (!defaultOption(optionMappings, 'default_organization_type')) {
    return reviewConflict('configuration', { reason: 'organization_type_confirmation_required' }, [])
  }
  const phone = sourcePhone(source)
  if (phone?.conflictReason) return reviewConflict('organization_phone', { reason: phone.conflictReason }, [])
  return safeResult('safe_to_create', decision, [])
}
```

`evaluateContactReview` follows the same pattern and additionally receives:

```js
{
  associatedCompanyIds: string[],
  organization: { outcome, targetId, organizationTypeId } | null,
}
```

It returns `multiple_associated_organizations` before matching when more than one company ID is present, verifies linked target organization identity, resolves inherited/fallback contact type, validates a create phone, and never mutates its inputs.

- [ ] **Step 6: Implement allowlisted storage and response projections**

`safeReviewSnapshot` normalizes HubSpot aliases and Albi canonical names into the field lists from Step 2. `safeReviewCandidates` maps, filters, and caps. `projectReviewRow` constructs a new camel-case object from fixed columns and calls the snapshot projectors again; it never spreads stored JSON into an API response. Its stable detail shape is:

```js
{
  id, runId, objectType, sourceId, reason, conflictType, status,
  recheckOutcome, sourceSnapshot, candidateSnapshots, matchEvidence,
  proposedChanges, lastRecheckedAt, lastRecheckedBy, createdAt, updatedAt,
}
```

The list projection omits `sourceSnapshot`, `candidateSnapshots`, `matchEvidence`, and `proposedChanges`. It returns exactly:

```js
{
  id, runId, objectType, sourceId, reason, conflictType, status, recheckOutcome,
  displayName,
  identity: { email, phone, organizationName, domain },
  lastRecheckedAt, createdAt, updatedAt,
}
```

Every identity value is derived from the allowlisted source snapshot. The event projector returns exactly `{ id, eventType, reason, actorId, details, createdAt }`, where `details` contains only fixed outcome/category/code keys.

Define `REVIEW_REASONS` and `REVIEW_CONFLICT_TYPES` as frozen sets containing every reason/type currently emitted by the orchestrator plus the fixed review-only outcomes. Unknown values are projected as `other_review_reason` for display and are rejected on capture.

- [ ] **Step 7: Run evaluator and matcher tests**

Run: `node --test tests/h2a/review.test.mjs tests/h2a/match.test.mjs`

Expected: PASS with no change to existing matching decisions.

- [ ] **Step 8: Commit the pure decision slice**

```bash
git add netlify/functions/_h2a/review.js netlify/functions/_h2a/match.js tests/h2a/review.test.mjs tests/h2a/match.test.mjs
git commit -m "Add shared H2A review evaluator"
```

### Task 3: Add tenant-scoped review repository operations and the clean-sample gate

**Files:**
- Modify: `netlify/functions/_h2a/repository.js`
- Modify: `tests/h2a/repository.test.mjs`

**Interfaces:**
- Consumes: tables and RPC from Task 1; projected, allowlisted row payloads from Task 2.
- Produces: repository methods `recordDryRunReview`, `getCurrentReviewSample`, `listDryRunReviews`, `getDryRunReview`, `listDryRunReviewEvents`, `appendDryRunReviewEvent`, `countDryRunReviews`, `applyDryRunRecheck`, `pruneSupersededDryRunReviews`, and `hasCleanReviewSampleDryRun`.

- [ ] **Step 1: Write repository query-contract tests**

Add Supabase-double tests that assert every review query includes both company and current run predicates. Pin the full-run gate with these cases:

```js
test('full dry-run readiness requires a fresh review-capable sample with no captured rows', async () => {
  const { repository, calls } = reviewRepositoryFixture({
    latestRun: { id: 'sample-2', review_capture_version: 1 },
    reviewCount: 0,
  })
  assert.equal(await repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), true)
  assert.deepEqual(calls.sampleFilters, [
    ['company_id', 'company-1'], ['mode', 'dry_run'], ['status', 'completed'],
    ['sample_limit_per_type', 10], ['review_capture_version', 1],
  ])
  assert.deepEqual(calls.countFilters, [['company_id', 'company-1'], ['run_id', 'sample-2']])
})

test('cleared rows still block the old sample from unlocking full history', async () => {
  const { repository } = reviewRepositoryFixture({
    latestRun: { id: 'sample-1', review_capture_version: 1 },
    reviewCount: 3,
    reviewStatuses: ['cleared', 'cleared', 'no_longer_in_scope'],
  })
  assert.equal(await repository.hasCleanReviewSampleDryRun('company-1', '2026-10-01T00:00:00Z'), false)
})
```

Also test keyset cursor filters, status/object/reason filters, candidate count preservation, conflict-on-upsert idempotency, fixed audit-event insertion, exact `updated_at` forwarding to the RPC, `superseded` RPC mapping, and old-run pruning that excludes the newly completed run.

- [ ] **Step 2: Run the repository tests and verify failure**

Run: `node --test tests/h2a/repository.test.mjs`

Expected: FAIL because the review methods are absent.

- [ ] **Step 3: Add review run and count helpers**

Use one fixed run select and never accept a browser-provided run ID:

```js
async getCurrentReviewSample(companyId, after) {
  return checked(await scoped(supabase, 'h2a_sync_runs', companyId)
    .eq('mode', 'dry_run')
    .eq('status', 'completed')
    .eq('sample_limit_per_type', SAMPLE_LIMIT_PER_TYPE)
    .gt('created_at', after)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle())
},
async countDryRunReviews(companyId, runId, status = null) {
  let query = supabase.from('h2a_dry_run_reviews').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).eq('run_id', runId)
  if (status) query = query.eq('status', status)
  const result = await query
  if (result?.error) throw result.error
  return Number.isSafeInteger(result.count) ? result.count : 0
},
async hasCleanReviewSampleDryRun(companyId, after) {
  const run = await this.getCurrentReviewSample(companyId, after)
  if (run?.review_capture_version !== 1) return false
  return await this.countDryRunReviews(companyId, run.id) === 0
},
```

- [ ] **Step 4: Add idempotent capture, list, detail, events, recheck, and cleanup methods**

`recordDryRunReview` upserts on `company_id,run_id,portal_id,object_type,source_id`, sets `status = 'needs_review'`, and writes a `captured` event only when a row is first inserted. To distinguish insert from conflict without a race, first try an insert and on PostgreSQL unique violation reload and update the same source identity; reject every other error.

`listDryRunReviews` orders by `created_at DESC, id DESC`, returns `limit + 1`, and applies validated filters. `getDryRunReview` and `listDryRunReviewEvents` always require `company_id` plus `run_id`/`review_id`. `appendDryRunReviewEvent` accepts only the fixed event type, allowlisted reason, actor UUID, and sanitized detail object. `applyDryRunRecheck` calls `h2a_apply_dry_run_recheck` with the exact CAS timestamp and maps `not_found`, `stale`, `superseded`, and `invalid_recheck` into stable repository results.

`pruneSupersededDryRunReviews(companyId, keepRunId)` performs:

```js
return checked(await supabase.from('h2a_dry_run_reviews')
  .delete()
  .eq('company_id', companyId)
  .neq('run_id', keepRunId)
  .select('id'))
```

- [ ] **Step 5: Run repository tests**

Run: `node --test tests/h2a/repository.test.mjs`

Expected: PASS, including the rule that cleared rows still count against the old sample.

- [ ] **Step 6: Commit the repository slice**

```bash
git add netlify/functions/_h2a/repository.js tests/h2a/repository.test.mjs
git commit -m "Add H2A review repository operations"
```

### Task 4: Capture review rows during bounded samples and publish only completed sets

**Files:**
- Modify: `netlify/functions/_h2a/orchestrator.js`
- Modify: `netlify/functions/h2a-run.js`
- Modify: `tests/h2a/orchestrator.test.mjs`
- Modify: `tests/h2a/run-api.test.mjs`

**Interfaces:**
- Consumes: Task 2 evaluators/projections and Task 3 repository methods.
- Produces: queued sample runs with `reviewCaptureVersion: 1`, idempotent underlying review capture, and post-completion pruning.

- [ ] **Step 1: Add failing run-queue and orchestrator capture tests**

Update the sample queue expectation to include the capability marker:

```js
assert.deepEqual(queued, [{
  mode: 'dry_run', trigger: 'manual', requestedBy: 'u1',
  sampleLimitPerType: 10, reviewCaptureVersion: 1,
}])
```

Add orchestrator tests proving:

- a contact conflict and an organization conflict each call `recordDryRunReview` once even when multiple activities encounter them;
- activity-object conflicts never call `recordDryRunReview`;
- full dry runs and historical sample runs with no capture version never call it;
- a continuation of the same sample reuses the same source identity;
- capture failure fails the sample rather than completing with a false zero-row result;
- a failed/paused sample never calls `pruneSupersededDryRunReviews`;
- a completed version-1 sample calls prune only after `finishRun(..., 'completed', ...)`;
- prune failure is logged with a fixed cleanup category but does not change the completed result.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test tests/h2a/orchestrator.test.mjs tests/h2a/run-api.test.mjs`

Expected: FAIL on the new marker, capture, and publication expectations.

- [ ] **Step 3: Persist the capture version when queueing the sample**

Extend `queueRun` to validate and persist `reviewCaptureVersion` only for the fixed bounded sample:

```js
async queueRun(companyId, {
  mode, trigger, requestedBy = null, runId = null, businessDate = null,
  sampleLimitPerType = null, reviewCaptureVersion = null,
}) {
  if (reviewCaptureVersion !== null &&
    !(mode === 'dry_run' && sampleLimitPerType === SAMPLE_LIMIT_PER_TYPE && reviewCaptureVersion === 1)) {
    throw new TypeError('Invalid review capture version')
  }
  // include review_capture_version only when non-null
}
```

Pass `reviewCaptureVersion: body.dryRunScope === 'sample' ? 1 : null` from `h2a-run.js`.

- [ ] **Step 4: Replace duplicated orchestration decisions with the shared evaluators**

In `resolveOrganization` and `resolveContact`, call the Task 2 evaluator once, then translate its result into the existing live/dry-run actions. Preserve existing mapping/create behavior for safe outcomes. For `needs_review`, pass the evaluator result to `conflict`:

```js
await conflict(deps, ctx, {
  objectType: 'contacts',
  sourceId,
  type: evaluation.conflictType,
  reason: evaluation.reason,
  evidence: evaluation.evidence,
  proposedChanges: evaluation.proposedChanges,
  source,
  candidates: evaluation.candidates,
})
```

Keep the evaluator pure: only the orchestrator saves mappings or calls Albi create methods after `safe_to_link`/`safe_to_create`.

- [ ] **Step 5: Capture only underlying review records for a review-capable sample**

Inside `conflict`, before `recordOnce`, add:

```js
const capturesReview = ctx.mode === 'dry_run' &&
  ctx.sampleLimitPerType === SAMPLE_LIMIT_PER_TYPE &&
  ctx.reviewCaptureVersion === 1 &&
  ['contacts', 'companies'].includes(data.objectType)

if (capturesReview) {
  await deps.repository.recordDryRunReview(companyId, {
    run_id: runId,
    portal_id: portalId,
    object_type: data.objectType,
    source_id: data.sourceId,
    reason: data.reason,
    conflict_type: data.type,
    source_snapshot: safeReviewSnapshot(data.source ?? { id: data.sourceId }, data.objectType),
    candidate_snapshots: safeReviewCandidates(data.candidates ?? [], data.objectType),
    match_evidence: { evidence: allowReviewEvidence(data.evidence) },
    proposed_changes: safeProposedChanges(data.proposedChanges),
  })
}
```

Populate `ctx.sampleLimitPerType` and `ctx.reviewCaptureVersion` from the persisted run, never from the background request body.

- [ ] **Step 6: Publish a completed set and prune older details**

After a completed review-capable sample has been durably finished, call:

```js
try {
  await repo.pruneSupersededDryRunReviews(companyId, run.id)
} catch (error) {
  logCleanupFailure(deps, 'dry_run_review_cleanup', error)
}
```

Do not call it for `paused`, `failed`, `partially_failed`, or `cancelled`. The review API will independently select only the latest completed version-1 sample, so an old set remains current throughout a failed replacement.

- [ ] **Step 7: Run the orchestrator and run API tests**

Run: `node --test tests/h2a/orchestrator.test.mjs tests/h2a/run-api.test.mjs`

Expected: PASS with unchanged live-sync mutation behavior and idempotent continuations.

- [ ] **Step 8: Commit the capture slice**

```bash
git add netlify/functions/_h2a/orchestrator.js netlify/functions/_h2a/repository.js netlify/functions/h2a-run.js tests/h2a/orchestrator.test.mjs tests/h2a/run-api.test.mjs
git commit -m "Capture bounded H2A sample reviews"
```

### Task 5: Add the admin review API and zero-mutation individual recheck service

**Files:**
- Create: `netlify/functions/_h2a/providerClients.js`
- Create: `netlify/functions/_h2a/reviewService.js`
- Create: `netlify/functions/h2a-dry-run-reviews.js`
- Create: `tests/h2a/dry-run-reviews-api.test.mjs`
- Create: `tests/h2a/review-service.test.mjs`
- Modify: `netlify/functions/h2a-run.js`
- Modify: `tests/h2a/run-api.test.mjs`

**Interfaces:**
- Consumes: Task 2 evaluator/projection and Task 3 repository operations.
- Produces: `createDryRunReviewHandler(options)`, `recheckDryRunReview(deps, input)`, and shared `createH2AProviderClients(...)`.

- [ ] **Step 1: Write HTTP validation, authorization, and projection tests**

Pin these list/detail behaviors in `dry-run-reviews-api.test.mjs`:

```js
test('review list is admin-only and resolves the selected company server-side', async () => {
  const calls = []
  const handler = createDryRunReviewHandler({
    requireRequest: async (_event, options) => {
      calls.push(options)
      return { companyId: 'tenant-1', userId: 'admin-1', supabase: {} }
    },
    repository: reviewRepositoryWithCurrentSample(),
  })
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { companyId: 'tenant-1', limit: '25' } })
  assert.equal(response.statusCode, 200)
  assert.equal(calls[0].requireAdmin, true)
  assert.equal(calls[0].requestedCompanyId, 'tenant-1')
})
```

Test malformed/oversized cursor, limit outside 1–100, unsupported status/object/reason, conflicting company selectors, member `403`, cross-tenant review `404`, detail constrained to current run, and safe `500` text. Assert response rows contain no arbitrary snapshot keys.

- [ ] **Step 2: Write zero-mutation recheck service tests**

Construct the dependency object with read-only functions only:

```js
const deps = {
  repository,
  hubspotRead: { getContacts, getCompanies, getAssociations },
  albiRead: { listContacts, listOrganizations },
  now: () => new Date('2026-10-12T12:00:00Z'),
}
```

Do not pass client objects that contain mutation methods. Test `safe_to_link`, `safe_to_create`, `still_needs_review`, exact confirmed source absence, and each provider failure category. Add getters named `createContact`, `createOrganization`, `updateContact`, `updateOrganization`, `associateContact`, `saveMapping`, `saveCursor`, and `dispatch` that throw if accessed; the test passes only if none are touched.

For source absence, assert only an empty successful `getContacts([sourceId])`/`getCompanies([sourceId])` result yields `source_missing`. Thrown auth, permission, validation, transient, rate-limit, malformed, timeout, and network errors must reject without calling `applyDryRunRecheck`, must preserve the review row, and must append one `recheck_failed` event containing only fixed `{ category, code }` values. A valid request appends `recheck_started` before provider reads; stale input appends no event and makes no provider call.

- [ ] **Step 3: Run the new tests and verify failure**

Run: `node --test tests/h2a/dry-run-reviews-api.test.mjs tests/h2a/review-service.test.mjs tests/h2a/run-api.test.mjs`

Expected: FAIL because the handler, service, and shared provider-client factory do not exist.

- [ ] **Step 4: Extract server-side provider client creation**

Move the credential retrieval/decryption/client construction currently in `h2a-run.js` into:

```js
export async function createH2AProviderClients({ companyId, repository, keyring, env = process.env, fetch }) {
  const credentials = await repository.getCredentials(companyId)
  if (!credentials?.hubspot_envelope || !credentials?.albi_envelope) {
    throw new Error('H2A credentials are missing')
  }
  const resolvedKeyring = keyring ?? loadCredentialKeyring(env)
  return {
    hubspot: new HubSpotClient({
      token: decryptSecret(fromRpc(credentials.hubspot_envelope), resolvedKeyring), fetch,
    }),
    albi: new AlbiClient({
      apiKey: decryptSecret(fromRpc(credentials.albi_envelope), resolvedKeyring), fetch,
    }),
  }
}
```

Keep `options.makeClients` injection in `h2a-run.js`; otherwise delegate to this factory. Existing credential and run API tests must remain green.

- [ ] **Step 5: Implement the read-only recheck service**

`recheckDryRunReview` must:

1. Load the current completed review-capable sample after the config lock.
2. Load the requested row by `companyId + currentRunId + reviewId`.
3. Compare the row's `updated_at` to `expectedUpdatedAt`; reject stale input before provider access or event insertion.
4. Append a fixed `recheck_started` event for the authenticated actor.
5. Read the exact HubSpot source ID and, for contacts, current company associations.
6. Page the relevant Albi collection with the existing maximum of 1,000 pages, a repeated-cursor guard, bounded retries, and a deadline no greater than 60 seconds.
7. Load current mappings/options from the repository.
8. Call the Task 2 evaluator.
9. Send only allowlisted snapshots/evidence/change keys to `applyDryRunRecheck` with the request's `expectedUpdatedAt`.

Use this return mapping:

```js
const terminal = {
  needs_review: { status: 'needs_review', outcome: 'still_needs_review', eventType: 'still_needs_review' },
  safe_to_link: { status: 'cleared', outcome: 'safe_to_link', eventType: 'cleared' },
  safe_to_create: { status: 'cleared', outcome: 'safe_to_create', eventType: 'cleared' },
  source_missing: { status: 'no_longer_in_scope', outcome: 'source_missing', eventType: 'no_longer_in_scope' },
}
```

Map repository `stale` and `superseded` to typed `409` results and `not_found` to `404`. On every provider failure, preserve the old row and append a `recheck_failed` event containing only `{ category, code }` values from existing fixed allowlists; never store `error.message`. The database RPC repeats the current-run check under its row lock, so a replacement sample completing during provider reads cannot update the superseded row.

- [ ] **Step 6: Implement the admin-only Netlify handler**

Use one function with:

- `GET` list: `companyId`, `limit`, `cursor`, `status`, `objectType`, `reason`;
- `GET` detail: `companyId`, `reviewId` only;
- `POST` recheck body: `companyId`, `reviewId`, `expectedUpdatedAt` only.

For every operation, load `h2a_company_config.initial_start_locked_at` server-side and resolve the latest completed bounded sample from that lock. Never accept a run ID, portal ID, source ID, object type, provider company ID, or candidate ID from the browser.

The list response is:

```js
{
  sample: null | { id, createdAt, finishedAt, reviewCaptureVersion, historical },
  progress: { total, needsReview, cleared, noLongerInScope, fullDryRunReady },
  items: [],
  nextCursor: null,
}
```

The detail response is `{ item }`. The recheck response is `{ item, progress }` so the UI can refresh the queue counters without a second provider call. `item` comes through `projectReviewRow(..., { detail: true })` and events through a fixed event projector. Use `Cache-Control: no-store` and fixed messages:

- `Invalid sample review cursor.`
- `Sample review page size must be between 1 and 100.`
- `Sample review item not found.`
- `This sample review changed. Refresh it before rechecking.`
- `This sample review is no longer current. Refresh before rechecking.`
- `Run a new sample to create detailed review data.`
- `Unable to load sample reviews.`
- `Unable to recheck this sample review.`

- [ ] **Step 7: Run API, service, and run regression tests**

Run: `node --test tests/h2a/dry-run-reviews-api.test.mjs tests/h2a/review-service.test.mjs tests/h2a/run-api.test.mjs`

Expected: PASS, including admin-only authorization, tenant isolation, fixed errors, source-missing semantics, and zero mutation access.

- [ ] **Step 8: Commit the API slice**

```bash
git add netlify/functions/_h2a/providerClients.js netlify/functions/_h2a/reviewService.js netlify/functions/h2a-dry-run-reviews.js netlify/functions/h2a-run.js tests/h2a/dry-run-reviews-api.test.mjs tests/h2a/review-service.test.mjs tests/h2a/run-api.test.mjs
git commit -m "Add admin H2A sample review API"
```

### Task 6: Add the authenticated browser client and fixed review presentation model

**Files:**
- Modify: `src/lib/hubspotToAlbi.js`
- Create: `src/features/hubspotToAlbi/sampleReview.js`
- Create: `tests/h2a/sample-review-presentation.test.mjs`
- Modify: `tests/h2a/frontend-contracts.test.mjs`

**Interfaces:**
- Consumes: Task 5 endpoint shapes and fixed errors.
- Produces: `getH2ADryRunReviews`, `getH2ADryRunReview`, `recheckH2ADryRunReview`, `SAMPLE_REVIEW_GUIDANCE`, `presentSampleReviewItem`, and `presentSampleReviewProgress`.

- [ ] **Step 1: Write browser request-shape tests**

Use the existing fetch capture helper to assert:

```js
await getH2ADryRunReviews(session, 'company-1', {
  limit: 25, status: 'needs_review', objectType: 'contacts', reason: 'name_only_candidate',
})
// GET /.netlify/functions/h2a-dry-run-reviews?... with bearer token

await recheckH2ADryRunReview(session, 'company-1', {
  reviewId: '00000000-0000-4000-8000-000000000001',
  expectedUpdatedAt: '2026-10-12T12:00:00.000Z',
})
// POST body contains exactly companyId, reviewId, expectedUpdatedAt
```

Add every Task 5 fixed 4xx message to `SAFE_SERVER_MESSAGES`; verify unknown provider/DB text still collapses to the generic status message.

- [ ] **Step 2: Write fixed presentation and guidance tests**

Test each known reason maps to fixed copy, and an unknown reason maps to generic copy without including the raw reason. Test malformed snapshots/arrays/statuses are reduced to safe empty/default values. Pin the directly approved display fields, including full name, direct email, phone/mobile, organization/domain, address, IDs, and side-by-side field comparisons.

```js
assert.deepEqual(presentSampleReviewProgress({
  total: 4, needsReview: 2, cleared: 1, noLongerInScope: 1, fullDryRunReady: false,
}), [
  { key: 'needsReview', label: 'Needs review', value: 2 },
  { key: 'cleared', label: 'Cleared', value: 1 },
  { key: 'noLongerInScope', label: 'No longer in scope', value: 1 },
])
```

- [ ] **Step 3: Run client/presentation tests and verify failure**

Run: `node --test tests/h2a/sample-review-presentation.test.mjs tests/h2a/frontend-contracts.test.mjs`

Expected: FAIL because the new functions and presentation module are absent.

- [ ] **Step 4: Add centralized client functions**

Implement:

```js
export function getH2ADryRunReviews(session, companyId, filters = {}) {
  const { signal, ...query } = filters
  return request(session, 'h2a-dry-run-reviews', { companyId, query, signal })
}

export function getH2ADryRunReview(session, companyId, reviewId, { signal } = {}) {
  return request(session, 'h2a-dry-run-reviews', { companyId, query: { reviewId }, signal })
}

export function recheckH2ADryRunReview(session, companyId, input, { signal } = {}) {
  return request(session, 'h2a-dry-run-reviews', {
    method: 'POST', companyId, body: input, signal,
  })
}
```

- [ ] **Step 5: Implement fixed presentation helpers**

Keep human-readable guidance solely in `sampleReview.js`; do not render raw reason text. Export reason options for the filter from the same map so the queue and detail cannot drift. Return arrays of `{ key, label, hubspot, albi }` comparisons in a fixed field order and normalize missing values to `Not provided`.

- [ ] **Step 6: Run client/presentation tests**

Run: `node --test tests/h2a/sample-review-presentation.test.mjs tests/h2a/frontend-contracts.test.mjs`

Expected: PASS with centralized authenticated calls and no raw error/reason leakage.

- [ ] **Step 7: Commit the client/presentation slice**

```bash
git add src/lib/hubspotToAlbi.js src/features/hubspotToAlbi/sampleReview.js tests/h2a/sample-review-presentation.test.mjs tests/h2a/frontend-contracts.test.mjs
git commit -m "Add H2A sample review client model"
```

### Task 7: Build the protected Sample Review master/detail page

**Files:**
- Create: `src/features/hubspotToAlbi/SampleReviewPage.jsx`
- Create: `src/features/hubspotToAlbi/SampleReviewDetail.jsx`
- Modify: `src/App.jsx`
- Modify: `src/features/hubspotToAlbi/HubSpotToAlbiLayout.jsx`
- Modify: `tests/h2a/frontend-contracts.test.mjs`
- Create: `tests/h2a/sample-review-ui-contract.test.mjs`

**Interfaces:**
- Consumes: Task 6 browser client and presentation helpers; existing outlet context `{ session, companyId, companyName, isAdmin, tenantRevision, completeTenantTransition }`.
- Produces: `/hubspot-to-albi/sample-review`, visible and reachable only to admins/super admins.

- [ ] **Step 1: Write route, admin-gate, accessibility, and transition contract tests**

Assert the app imports/renders the page inside `AdminRoute`, the layout shows the tab only when `isAdmin`, and the page:

- uses only centralized client functions, never direct `fetch` or browser Supabase;
- uses `AbortController` for list, detail, load-more, and recheck requests;
- keys tenant state by `companyId + tenantRevision` and discards stale responses;
- exposes status/object/reason labels;
- renders full approved PII with wrapping classes such as `break-words`/`break-all` rather than truncating detail;
- has `aria-live` progress/notices and `role="alert"` errors;
- contains exactly one mutation-looking control, **Recheck this record**, and no link/create/approve/retain/skip buttons.

- [ ] **Step 2: Run the UI contract tests and verify failure**

Run: `node --test tests/h2a/sample-review-ui-contract.test.mjs tests/h2a/frontend-contracts.test.mjs`

Expected: FAIL because the route and components do not exist.

- [ ] **Step 3: Add the nested admin route and conditional tab**

In `App.jsx`:

```jsx
<Route
  path="sample-review"
  element={
    <AdminRoute session={session} isAdmin={isAdmin} hasAppAccess={hasAppAccess}>
      <SampleReviewPage />
    </AdminRoute>
  }
/>
```

In `HubSpotToAlbiLayout.jsx`, include `{ to: '/hubspot-to-albi/sample-review', label: 'Sample Review', adminOnly: true }` and filter tabs with `!tab.adminOnly || isAdmin`.

- [ ] **Step 4: Implement list state, filters, pagination, and tenant cancellation**

Follow `ConflictsPage` request-revision patterns. On every tenant/filter reset:

```js
const request = ++requestRevision.current
const startedFor = tenantKey
setItems([])
setSelectedId(null)
setNextCursor(null)
setLoading(true)
```

Apply results only when both the revision and tenant key still match. `completeTenantTransition(tenantRevision)` runs after the current request settles. Filters reset the cursor and selection; load-more appends without duplicating IDs.

Render explicit states:

- historical/no-capability sample: “Run a new sample to create detailed review data”;
- sample running/none completed: direct the admin to Settings;
- current clean sample: “No underlying records need correction” and explain full dry run is now available;
- failed recheck: keep the selected item and offer retry;
- zero matches for filters: preserve progress and offer Clear filters.

- [ ] **Step 5: Implement the responsive queue and detail panel**

Use the existing conflicts layout proportions and Tailwind language. The queue shows fixed title, record type, reason, status, identity evidence, and last recheck time. The detail component renders:

```jsx
<dl className="grid gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 sm:grid-cols-2">
  {comparisons.map(field => (
    <div key={field.key} className="contents">
      <div className="min-w-0 bg-white px-3 py-3">
        <dt className="text-xs font-medium text-gray-500">HubSpot · {field.label}</dt>
        <dd className="mt-1 break-words text-sm text-gray-900">{field.hubspot}</dd>
      </div>
      <div className="min-w-0 bg-white px-3 py-3">
        <dt className="text-xs font-medium text-gray-500">Albi · {field.label}</dt>
        <dd className="mt-1 break-words text-sm text-gray-900">{field.albi}</dd>
      </div>
    </div>
  ))}
</dl>
```

Show all candidates separately when there is more than one. IDs use `break-all`. Render audit events from fixed labels only.

- [ ] **Step 6: Implement single-record recheck behavior**

Disable only the selected record's button while submitting, send its current `updatedAt`, and replace the row/detail from the successful response. On `409`, reload the current detail and announce that it changed. On tenant switch/unmount, abort the recheck and ignore its result.

When the progress response reaches zero `needsReview`, display: “Corrections are clear for this sample. Run a fresh sample to verify them; this sample does not unlock the full dry run.”

- [ ] **Step 7: Run UI contract tests and the production build**

Run: `node --test tests/h2a/sample-review-ui-contract.test.mjs tests/h2a/frontend-contracts.test.mjs`

Expected: PASS.

Run: `npm run build`

Expected: PASS with no Vite import or JSX errors.

- [ ] **Step 8: Commit the UI slice**

```bash
git add src/App.jsx src/features/hubspotToAlbi/HubSpotToAlbiLayout.jsx src/features/hubspotToAlbi/SampleReviewPage.jsx src/features/hubspotToAlbi/SampleReviewDetail.jsx tests/h2a/frontend-contracts.test.mjs tests/h2a/sample-review-ui-contract.test.mjs
git commit -m "Add H2A sample review page"
```

### Task 8: Enforce the fresh-clean-sample gate and update Settings/Overview guidance

**Files:**
- Modify: `netlify/functions/h2a-run.js`
- Modify: `netlify/functions/h2a-settings.js`
- Modify: `netlify/functions/h2a-overview.js`
- Modify: `src/lib/hubspotToAlbi.js`
- Modify: `src/features/hubspotToAlbi/dryRunFlow.js`
- Modify: `src/features/hubspotToAlbi/SettingsPage.jsx`
- Modify: `src/features/hubspotToAlbi/OverviewPage.jsx`
- Modify: `tests/h2a/run-api.test.mjs`
- Modify: `tests/h2a/settings-api.test.mjs`
- Modify: `tests/h2a/overview-api.test.mjs`
- Modify: `tests/h2a/settings-ui-contract.test.mjs`
- Modify: `tests/h2a/operations-ui-contract.test.mjs`

**Interfaces:**
- Consumes: Task 3 `hasCleanReviewSampleDryRun` and review counts; Task 7 route.
- Produces: server-enforced full-run readiness, settings `sampleReview` projection, and actionable navigation from Settings and Overview.

- [ ] **Step 1: Replace the old run-gate test with explicit safety cases**

For `dryRunScope: 'full'`, assert rejection for:

1. no completed sample;
2. historical completed sample;
3. failed version-1 sample;
4. version-1 sample with `needs_review` rows;
5. version-1 sample whose rows are all `cleared`/`no_longer_in_scope`;

and acceptance only for a latest completed version-1 sample with zero total rows. The handler must call `hasCleanReviewSampleDryRun`, not `hasCompletedSampleDryRun`.

Expected fixed error:

```js
'Run a fresh sample with no underlying review items before running the full dry run.'
```

- [ ] **Step 2: Add settings and overview API projection tests**

The settings response adds:

```js
sampleReview: {
  reviewCapable: true,
  total: 3,
  needsReview: 0,
  cleared: 2,
  noLongerInScope: 1,
  fullDryRunReady: false,
}
```

For a fresh clean sample, all counts are zero and `fullDryRunReady` is true. For a historical sample, `reviewCapable` is false and the full flag is false.

The overview run sanitizer includes `reviewCaptureVersion: 1` only for valid bounded values and never exposes the raw snake-case column. A completed review-capable sample provides the Sample Review link without exposing detailed PII through the overview endpoint.

- [ ] **Step 3: Run the server tests and verify failure**

Run: `node --test tests/h2a/run-api.test.mjs tests/h2a/settings-api.test.mjs tests/h2a/overview-api.test.mjs`

Expected: FAIL on the new gate and projections.

- [ ] **Step 4: Enforce the gate in `h2a-run.js`**

Replace the completed-sample predicate with:

```js
if (body.mode === 'dry_run' && body.dryRunScope === 'full' &&
  (!config.initial_start_locked_at ||
    !await repository.hasCleanReviewSampleDryRun(companyId, config.initial_start_locked_at))) {
  fail(409, 'Run a fresh sample with no underlying review items before running the full dry run.')
}
```

Add the exact message to the browser safe-message allowlist.

- [ ] **Step 5: Add settings review readiness without granting browser table access**

After loading the latest completed sample, use the server-side Supabase client to count all/status rows by `company_id + run_id`. Return only integers and booleans in `sampleReview`. Do not return snapshots, reasons, IDs, or events from settings.

Keep `dryRunReviewReady` tied to a completed full dry run for live activation; `sampleReview.fullDryRunReady` controls only whether the full dry-run button is enabled.

- [ ] **Step 6: Replace the dry-run control state model**

Change `dryRunActions` to:

```js
export function dryRunActions({ state, live, fullDryRunCompleted, sample }) {
  const inDryRun = state === 'dry_run' && !live
  const clean = sample?.reviewCapable === true && sample?.fullDryRunReady === true
  const rechecksComplete = sample?.reviewCapable === true && sample.total > 0 && sample.needsReview === 0
  return {
    showStartSample: !inDryRun && !live,
    showRetrySample: inDryRun && !fullDryRunCompleted && !sample,
    showReview: inDryRun && !fullDryRunCompleted && sample?.reviewCapable === true && sample.needsReview > 0,
    showVerifySample: inDryRun && !fullDryRunCompleted && (rechecksComplete || sample?.reviewCapable === false),
    showFull: inDryRun && !fullDryRunCompleted && clean,
  }
}
```

Update tests so **Run full dry run** never appears for a historical, unresolved, or all-rechecked old sample.

- [ ] **Step 7: Update Settings and Overview copy/actions**

Settings sequence:

1. Run sample.
2. Open Sample Review and correct records directly in HubSpot/Albi.
3. Individually recheck.
4. Run a fresh verification sample.
5. Show **Run full dry run** only after that sample captured zero rows.

Remove “Detailed per-record review is not available yet.” Add links to `/hubspot-to-albi/sample-review` when the sample is review-capable and unresolved/rechecked. Keep the full dry-run completion and live activation flow unchanged.

In `OverviewPage`, add **Review underlying records** beside the breakdown for review-capable completed samples. Historical samples retain aggregate breakdown only and explain that a new sample is required for details.

- [ ] **Step 8: Run server and UI workflow tests**

Run: `node --test tests/h2a/run-api.test.mjs tests/h2a/settings-api.test.mjs tests/h2a/overview-api.test.mjs tests/h2a/settings-ui-contract.test.mjs tests/h2a/operations-ui-contract.test.mjs`

Expected: PASS with no route that can queue a full dry run from an old or merely rechecked sample.

- [ ] **Step 9: Commit the enforcement and guidance slice**

```bash
git add netlify/functions/h2a-run.js netlify/functions/h2a-settings.js netlify/functions/h2a-overview.js src/lib/hubspotToAlbi.js src/features/hubspotToAlbi/dryRunFlow.js src/features/hubspotToAlbi/SettingsPage.jsx src/features/hubspotToAlbi/OverviewPage.jsx tests/h2a/run-api.test.mjs tests/h2a/settings-api.test.mjs tests/h2a/overview-api.test.mjs tests/h2a/settings-ui-contract.test.mjs tests/h2a/operations-ui-contract.test.mjs
git commit -m "Gate full H2A dry runs on a clean sample"
```

### Task 9: Complete regression, security, and pilot verification

**Files:**
- Modify: `scripts/test-h2a-end-to-end.mjs`
- Modify: `docs/hubspot-to-albi-pilot-runbook.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a self-test covering the new endpoint contract and an operator runbook for migration, fresh sample, correction/recheck, verification sample, and full dry run.

- [ ] **Step 1: Extend the end-to-end self-test before changing documentation**

Add self-test fixtures proving:

- the review list/detail endpoint rejects a member and accepts an admin;
- no response contains injected `authorization`, `apiKey`, activity notes, or provider error text;
- recheck does not invoke any provider write fixture;
- a cleared old sample still cannot queue full;
- a fresh zero-row sample can queue full.

Keep the self-test local and deterministic; do not require production credentials.

- [ ] **Step 2: Run the self-test and verify the new fixture initially fails**

Run: `npm run test:h2a:e2e`

Expected: FAIL until the fixture is wired to the new handler/service contracts.

- [ ] **Step 3: Complete the self-test wiring and update operator documentation**

Document this exact rollout order in `docs/hubspot-to-albi-pilot-runbook.md`:

1. Apply `supabase/h2a-dry-run-review-workflow.sql` in Supabase.
2. Deploy the application while live sync remains disabled.
3. Run one new sample for Allied; historical samples do not have details.
4. Compare the detailed queue count with the underlying record subtotal, not the 93 aggregate total.
5. Correct each item directly in HubSpot or Albi and use individual recheck.
6. After zero items remain open, run a fresh sample.
7. Proceed to the full dry run only if the fresh sample captured zero review rows.
8. Review full totals before activating live sync.

Add a short README pointer to the new migration and runbook. Do not include credentials, production record values, or PII in docs.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
npm run test:h2a
npm run test:h2a:schema
npm run test:h2a:e2e
npm run build
```

Expected: all commands exit 0. Record the exact test count and build result in the implementation handoff.

- [ ] **Step 5: Perform a focused secret/PII and mutation scan**

Run:

```bash
rg -n "apiKey|authorization|hs_email_text|hs_note_body|createContact|createOrganization|updateContact|updateOrganization|associateContact|saveMapping|saveCursor|dispatch" netlify/functions/_h2a/review.js netlify/functions/_h2a/reviewService.js netlify/functions/h2a-dry-run-reviews.js src/features/hubspotToAlbi/SampleReviewPage.jsx src/features/hubspotToAlbi/SampleReviewDetail.jsx
```

Expected: secret/activity-body names appear only in negative allowlist tests or are absent; mutation method names appear only in zero-mutation tests, never in review production code.

- [ ] **Step 6: Review the final diff for tenant predicates and scoped staging**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; `_reference/` remains untracked and unstaged; only plan-listed implementation files are changed.

- [ ] **Step 7: Commit the verification and runbook slice**

```bash
git add scripts/test-h2a-end-to-end.mjs docs/hubspot-to-albi-pilot-runbook.md README.md
git commit -m "Document H2A sample review rollout"
```

- [ ] **Step 8: Apply the migration and perform authenticated browser smoke testing only after deployment approval**

After the implementation branch is reviewed and the user authorizes deployment:

- apply `supabase/h2a-dry-run-review-workflow.sql` once;
- deploy the reviewed commit;
- sign in as the Allied super admin;
- verify the historical-sample empty state;
- run one new bounded sample;
- inspect filters, full approved PII, side-by-side values, and fixed guidance;
- recheck one intentionally unresolved item and confirm it remains open;
- correct one safe test record directly in the provider, recheck it, and confirm it clears without a provider write from this app;
- switch company context during a request and confirm no prior-tenant data flashes;
- confirm the full dry-run button remains hidden/disabled until a subsequent fresh sample captures zero rows.

Do not queue the production full dry run or activate live sync as part of smoke testing unless the user separately authorizes those operational actions.
