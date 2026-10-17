# H2A Fast Review and Conflicts Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One fast, keyboard-driven review workspace shared by Sample review and Conflicts, running on one resolution engine. Live sync never auto-creates Albi records.

**Architecture:**
- Live contact and company conflicts become `review_kind = 'live'` rows in `h2a_dry_run_reviews`, one row per HubSpot record. A link table attaches that record's conflicts to the row, so the existing resolution engine, recheck and batch code serve both kinds.
- A new RPC closes linked conflicts and enqueues their resumes in the same transaction that finishes a live resolution.
- The UI is rebuilt as shared components driven by pure presentation helpers. `SampleReviewPage` and `ConflictsPage` mount it with `kind`.

**Tech Stack:** React 18 + Vite, Tailwind, Netlify functions (Node ESM), Supabase Postgres (SQL migration files the user runs), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-17-h2a-fast-review-and-conflicts-parity-design.md` (read it with this plan).

## Global Constraints

- **No auto-creates.** No live-sync code path calls `deps.albi.createContact` or `deps.albi.createOrganization`.
- **Create defaults.** Every Albi create comes from a reviewer action through the shared engine: Type = Referrer, Status = Active, owner-matched salesperson (`_h2a/createDefaults.js`), and a referral source chosen per record.
- **Referral dropdown.**
  - Each create has its own dropdown, filled from Albi's live list and starting blank. Nothing is remembered or preselected.
  - The create control stays disabled until a source is chosen.
  - "Create organization and contact" uses one choice for both records.
- **What bulk can do.** Bulk links exact matches and rechecks. It never creates, never writes fields, and never approves a link to an Albi record already linked elsewhere.
- **Dialogs.** Dialogs are only for: force-create despite candidates, many-to-one approval, any HubSpot field write, adding a HubSpot association, and every bulk action. Other actions use a 5000 ms deferred-commit undo window.
- **Keys.**
  - `j`/`k` move to the next/previous record, `Enter`/`a` accept the suggestion, `1`–`9` pick a candidate, `l` links, `n` creates, `s` skips (live only), `r` rechecks, `x` ticks for bulk, `t` opens the Albi to-do, `u` undoes, `?` shows help.
  - Shortcuts are ignored inside input/select/textarea, ignored for Enter/Space on a focused button or link, ignored on key repeat, and ignored with Meta, Ctrl or Alt held.
- **Strength.**
  - Strong = `same_email` or `same_other_email` (or `same_domain` for organizations) with no `different_email`.
  - Likely = phone or mobile match, or name + organization.
  - Weak = anything else.
  - No numeric score is shown.
- **Comparisons** are trimmed and normalized like `match.js`. Rows blank on both sides are hidden, and matching rows collapse.
- **Unchanged behavior.** Automatic link rules in `decideContactMatch` / `decideOrganizationMatch` do not change, and neither does the fresh-sample gate.
- **Write safety.** Every write is admin-only, tenant-scoped, checked against `expectedUpdatedAt`, idempotent by `clientRequestId`, and audited per row.
- **UI copy.** Tailwind brand palette, no emojis.
- **Deploys.** Migrations are files in `supabase/` with a deploy-order note in `docs/hubspot-to-albi-pilot-runbook.md`. Verification is local (`npm run dev:local`) before any push. Push once per milestone (end of Task 9, end of Task 15).

## Review Focus

1. **A key press arrives twice** (Enter on a focused button plus the shortcut, or key repeat). Expect exactly one action queued. Covered in Task 12 (`shortcutFor` ignores focused-button Enter/Space and `event.repeat`).
2. **The reviewer leaves or switches company with undo windows still open.** Expect pending actions to be sent immediately, not lost, plus a `beforeunload` prompt while any are pending. Covered in Task 12 (`createDeferredQueue.flushAll`) and Task 14 (workspace unmount and tenant change call `flushAll`).
3. **The record changed between viewing and the deferred send** (409). Expect it back in its bucket with "This record changed; review it again", and no write. Covered in Task 14.
4. **Two live runs capture the same HubSpot source at once.** Expect one open live row with both conflicts linked. Covered in Task 1 (partial unique index) and Task 4 (upsert test).
5. **The bulk link target became linked to another HubSpot record after the list loaded.** Expect that row skipped with the reason "linked elsewhere", never linked many-to-one. Covered in Task 8.

---

## File structure

**Server (new):**
- `supabase/h2a-live-review-workspace.sql` — migration.
- `netlify/functions/_h2a/ranking.js` — candidate reasons and strength.
- `netlify/functions/_h2a/triage.js` — bucket computation.
- `netlify/functions/_h2a/liveReview.js` — live capture, backfill, close.
- `netlify/functions/_h2a/bulkLink.js` — bulk link executor.

**Shared (new):** `shared/h2aBlockedReasons.js`.

**Server (modified):**
- `supabase/h2a-schema.sql` (mirror the migration)
- `_h2a/orchestrator.js`, `_h2a/repository.js`, `_h2a/review.js` (projection)
- `_h2a/reviewResolution.js` (new actions), `_h2a/reviewResolutionService.js` (kind-aware), `_h2a/reviewService.js` (kind-aware recheck and batch)
- `h2a-dry-run-reviews.js`, `h2a-dry-run-review-resolutions.js`, `h2a-dry-run-review-recheck-all.js`, `h2a-conflict-resolve.js`
- `shared/h2aReviewReasons.js`

**Client (new):**
- `src/features/hubspotToAlbi/reviewWorkspace.js` — pure helpers.
- `ReviewWorkspace.jsx`, `ReviewQueue.jsx`, `ReviewRecord.jsx`, `CandidateList.jsx`, `FieldDiff.jsx`, `ResolutionBar.jsx`, `AlbiTodo.jsx`, `ShortcutHelp.jsx`.

**Client (modified):** `src/lib/hubspotToAlbi.js`, `SampleReviewPage.jsx`, `ConflictsPage.jsx`.

**Client (deleted):** `SampleReviewDetail.jsx`, `SampleReviewResolution.jsx`, `ConflictDetail.jsx`, and `prototype/` once Task 15 lands.

**Tests (new):**
- `tests/h2a/ranking.test.mjs`, `triage.test.mjs`, `live-review.test.mjs`, `bulk-link.test.mjs`
- `review-workspace-presentation.test.mjs`, `review-workspace-ui-contract.test.mjs`

**Tests (modified):** existing review, orchestrator and conflicts tests where behavior changes, plus `scripts/test-h2a-schema-contract.mjs` and `scripts/test-h2a-end-to-end.mjs`.

---

### Task 1: Migration — live review kind, link table, close RPC

**Files:**
- Create: `supabase/h2a-live-review-workspace.sql`
- Modify: `supabase/h2a-schema.sql` (append the same objects), `scripts/test-h2a-schema-contract.mjs`, `docs/hubspot-to-albi-pilot-runbook.md` (deploy order: after `h2a-review-recheck-batches.sql`)

**Interfaces — Produces:**
- **`h2a_dry_run_reviews` new columns:**
  - `review_kind text not null default 'sample' check (review_kind in ('sample','live'))`
  - `triage_bucket text not null default 'decision' check (triage_bucket in ('quick','todo','decision','blocked','done'))`
  - `triage_details jsonb not null default '{}'` (object)
- **Unique index** `h2a_live_review_open_source_idx` on `(company_id, portal_id, object_type, source_id) where review_kind = 'live' and status = 'needs_review'`.
- **Table** `public.h2a_live_review_conflicts (id uuid pk, company_id uuid not null, review_id uuid not null, conflict_id uuid not null, created_at timestamptz default now(), unique (company_id, conflict_id))`.
  - FKs to `h2a_dry_run_reviews (company_id, id)` and `h2a_conflicts (company_id, id)`.
  - Service-role only, RLS enabled with no anon/auth policies, matching `serviceOnlyTables`.
- **`h2a_dry_run_reviews.run_id` FK:** replace `on delete cascade` with a trigger `h2a_block_run_delete_with_open_live_reviews` that raises when a run still has `review_kind='live' and status='needs_review'` rows. Sample rows keep cascading.
- **`h2a_review_recheck_batches` new columns:**
  - `review_kind text not null default 'sample'`
  - `review_ids uuid[]` (null = all open of that kind)
  - `run_id` nullable with `check (review_kind = 'live' or run_id is not null)`
  - The one-active-batch partial unique index becomes per `(company_id, review_kind)`.
- **RPC** `public.h2a_close_live_review(p_company_id uuid, p_review_id uuid, p_actor_id uuid, p_outcome text, p_resolution_action text) returns jsonb`. It runs `security definer` and is granted to `service_role` only.
  - `p_outcome` is one of `resolved` | `resolved_by_sync` | `skipped` | `source_missing`.
  - `p_resolution_action` is one of `link_existing` | `create_new` | `skip` (null allowed for `resolved_by_sync`).
  - In one transaction it:
    - sets the review `status` to `cleared` (resolved) or `no_longer_in_scope` (others), with `triage_bucket='done'`;
    - for each linked conflict with `status in ('open','resolving')`, sets `resolved`/`skipped`, `resolution_action`, `resolved_by`, `resolved_at`, and appends `h2a_conflict_events`;
    - for resolved outcomes, inserts one `h2a_conflict_resumes` row per conflict `on conflict (company_id, conflict_id) do nothing`;
    - for `skipped` / `source_missing`, inserts the skipped-item ledger row the existing `skip` path uses;
    - returns `{ closedConflictIds: uuid[], resumeIds: uuid[], replayed: boolean }`.
  - It is idempotent: a second call returns `replayed: true` and inserts nothing.

- [ ] **Step 1: Write failing schema-contract tests** in `scripts/test-h2a-schema-contract.mjs`:
  - `test('live review workspace migration exists and is mirrored in h2a-schema.sql')`
  - `test('live review rows are unique per open HubSpot source')` — asserts the index text includes `where review_kind = 'live' and status = 'needs_review'`.
  - `test('h2a_live_review_conflicts is service-only and unique per conflict')`
  - `test('h2a_close_live_review closes conflicts and inserts resumes in one function body')` — the function body contains `update public.h2a_conflicts`, `insert into public.h2a_conflict_resumes`, `on conflict (company_id, conflict_id) do nothing`, and `security definer`; the grant is to `service_role` only.
  - `test('recheck batches are scoped by review_kind and may list review_ids')`
- [ ] **Step 2: Run** `npm run test:h2a:schema`. Expected: the 5 new tests FAIL.
- [ ] **Step 3: Write the migration and mirror it into `h2a-schema.sql`.** Model the RPC on `h2a_resolve_conflict` in `h2a-mapping-target-ownership.sql` (same locking, `for update` on rows, and event shape).
- [ ] **Step 4: Run** `npm run test:h2a:schema`. Expected: all PASS.
- [ ] **Step 5: Add the runbook deploy-order note and commit.**

```bash
git add supabase/h2a-live-review-workspace.sql supabase/h2a-schema.sql scripts/test-h2a-schema-contract.mjs docs/hubspot-to-albi-pilot-runbook.md
git commit -m "Add live review kind, conflict link table and close RPC"
```

### Task 2: Shared catalogs — new reason and blocked reasons

**Files:**
- Create: `shared/h2aBlockedReasons.js`
- Modify: `shared/h2aReviewReasons.js`, `tests/h2a/review-reasons.test.mjs`

**Interfaces — Produces:**
- `H2A_REVIEW_REASON_CATALOG.new_record_needs_review` with label `"New in HubSpot, not in Albi yet"`, category `identity`, actions `["create_albi","link_existing"]`, guidance `"Choose a referral source and create it in Albi, or link it if it already exists."`
- `export const H2A_BLOCKED_REASONS` — a frozen map from code to copy. Codes: `referrer_type_missing`, `active_status_missing`, `owner_not_found`, `salesperson_not_found`, `source_already_mapped`, `multiple_organizations`, `organization_not_synced`. Copy for the first six is verbatim from `BLOCKED_COPY` in `SampleReviewResolution.jsx`. `organization_not_synced`: `"This contact’s HubSpot organization is not in Albi yet. Create or link the organization first."`
- `export function blockedReasonCopy(code: string): string | null`

- [ ] **Step 1: Failing tests.**
  - `test('new_record_needs_review is a create-capable identity reason')` — asserts the label and that `getH2AReviewActions('new_record_needs_review')` includes `create_albi`.
  - `test('blockedReasonCopy returns copy for every blocked code and null otherwise')`
- [ ] **Step 2: Run** `npm run test:h2a`. Expected: FAIL.
- [ ] **Step 3: Implement both.**
- [ ] **Step 4: Run** `npm run test:h2a`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Candidate ranking

**Files:**
- Create: `netlify/functions/_h2a/ranking.js`, `tests/h2a/ranking.test.mjs`
- Modify: `netlify/functions/_h2a/review.js` (`projectReviewRow(row, { detail: true, mappings })` adds `rankedCandidates` and `suggestedCandidateId`)

**Interfaces — Produces:**
- **`rankReviewCandidates({ objectType, source, candidates, mappings, portalId, sourceId })`**
  - Returns `{ candidates: Array<{ id, matchReasons: string[], warnings: string[], strength: 'Strong'|'Likely'|'Weak', linkedElsewhere: number }>, suggestedCandidateId: string|null }`.
  - Candidates are sorted by strength, then `matchReasons.length` descending, then id.
  - `matchReasons` come from `same_email`, `same_other_email` (HubSpot `hs_additional_emails` split on `;` vs the Albi email), `same_phone`, `phone_matches_mobile` (cross-compares phone and mobile both ways), `same_name`, `same_first_name`, `same_organization`, `same_domain`, `same_address`.
  - `warnings` come from `different_email` (both sides have an email and they differ) and `already_linked_elsewhere` (an Albi target mapped to a different HubSpot source).
  - `linkedElsewhere` counts those other mappings.
  - `suggestedCandidateId` is the id when exactly one candidate is Strong and its `linkedElsewhere === 0`. Otherwise it is null.
  - Use the normalizers already in `match.js` / `normalize.js` (export the ones needed; do not duplicate them).

- [ ] **Step 1: Failing tests** in `ranking.test.mjs`:
  - `'trimmed, case-insensitive email is same_email and Strong'` — source `' Lena@x.com'` vs `'LENA@x.com '`.
  - `'additional HubSpot email matching Albi email is same_other_email'`
  - `'HubSpot phone equal to Albi mobile is phone_matches_mobile and Likely'`
  - `'different emails add a warning and prevent Strong'`
  - `'a candidate mapped to another HubSpot source warns already_linked_elsewhere and is never suggested'`
  - `'two Strong candidates produce no suggestion'`
  - `'organization with same domain is Strong'`
  - `'ordering is strength, then reason count, then id'`
- [ ] **Step 2: Run** `node --test tests/h2a/ranking.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `ranking.js` and the projection fields.**
- [ ] **Step 4: Run** `npm run test:h2a`. Expected: PASS (including the existing `review.test.mjs`).
- [ ] **Step 5: Commit.**

### Task 4: Triage buckets

**Files:**
- Create: `netlify/functions/_h2a/triage.js`, `tests/h2a/triage.test.mjs`
- Modify: `_h2a/repository.js` (`setReviewTriage(companyId, reviewId, { bucket, details })`; `listDryRunReviews` accepts `kind` and `bucket` filters and returns `bucketCounts`), `_h2a/review.js` (projects `triageBucket`, `triageDetails`)

**Interfaces — Produces:**
- **`computeTriage({ row, ranking, createReadiness, resolutionStatus })`**
  - Returns `{ bucket: 'quick'|'todo'|'decision'|'blocked'|'done', details: { blockedReason?: string, quickKind?: 'link'|'create' } }`.
  - **done:** `row.status !== 'needs_review'` or `resolutionStatus === 'completed'`.
  - **todo:** `resolutionStatus === 'waiting_on_albi'`.
  - **blocked:** `row.merged_into` is set, or `createReadiness?.blockedReason` has copy in `H2A_BLOCKED_REASONS` and there are no candidates.
  - **quick (link):** `ranking.suggestedCandidateId` is set, there is exactly one candidate, and the reason is not field/association category.
  - **quick (create):** zero candidates and `createReadiness?.ready === true`.
  - **decision:** everything else. `createReadiness` undefined means not known yet; then only the link rule can produce `quick`.
- **Triage is recomputed and stored** at:
  - capture (Task 5)
  - recheck (`applyDryRunRecheck` callers in `reviewService.js`)
  - resolution status changes (`finishReviewResolution` callers)
  - detail load (`h2a-dry-run-reviews.js` detail branch, after `loadReviewResolutionOptions`; write only when it changed)

- [ ] **Step 1: Failing tests** — one per rule above, plus `'unknown readiness never yields quick create'` and `'merged record is blocked even with a strong candidate'`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Wire the four recompute points. Add a repository test in `repository.test.mjs`: `'listDryRunReviews filters by kind and bucket and returns bucketCounts'`.
- [ ] **Step 4: Run** `npm run test:h2a`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 5: Live capture; live sync never auto-creates

**Files:**
- Create: `netlify/functions/_h2a/liveReview.js`, `tests/h2a/live-review.test.mjs`
- Modify: `_h2a/orchestrator.js` (`conflict()`, `resolveOrganization` create branch ~l.177, `resolveContact` create branch ~l.226), `_h2a/repository.js`, `tests/h2a/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `rankReviewCandidates` (Task 3), `computeTriage` (Task 4), `safeReviewSnapshot` / `safeReviewCandidates` / `safeReviewEvidence` / `safeReviewChanges` (existing, `review.js`).
- **Produces — `captureLiveReview(deps, { companyId, runId, portalId, objectType, sourceId, reason, conflictType, source, candidates, evidence, proposedChanges, conflictId })`**
  - Returns `{ reviewId: string, inserted: boolean }`.
  - Upserts on the live partial key: insert, or refresh snapshots, evidence and triage on the existing open row.
  - Then inserts the link row `on conflict do nothing`.
- **Produces — repository methods:**
  - `upsertLiveReview(companyId, row): { id, inserted }`
  - `linkLiveReviewConflict(companyId, reviewId, conflictId): boolean`
  - `getReview(companyId, reviewId)`: no run filter; returns `review_kind`.
- **`recordConflict` must return the conflict `id`.** Verify the current return shape in `repository.js:746`. If it lacks the id, return `{ id, inserted }`.
- **Orchestrator changes:**
  - In `ctx.mode === 'live'`, `conflict()` calls `captureLiveReview` for `contacts` / `companies` after `recordConflict`.
  - The live create branches no longer call Albi. Instead they call `conflict()` with `type: 'identity'`, `reason: 'new_record_needs_review'`, the source, `candidates: []`, and return `{ action: 'conflict', reason: 'new_record_needs_review' }`. Item results record outcome `conflict`.
  - Dry-run behavior is unchanged (`dry_run_preview` stays).

- [ ] **Step 1: Failing tests.**
  - `orchestrator.test.mjs`:
    - `'live sync never calls albi.createContact or albi.createOrganization'` — the fake Albi throws if either is called; a run with a new contact and a new organization completes.
    - `'a new live contact is held as new_record_needs_review with a live review row'`
    - `'a new contact behind a new organization is held, and the organization is held too'`
  - `live-review.test.mjs`:
    - `'two captures of the same source make one open row with both conflicts linked'`
    - `'capture refreshes evidence on the existing open row'`
    - `'a source whose previous live row is cleared gets a new row'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:h2a && npm run test:h2a:e2e`. Expected: PASS. Update e2e fixtures that asserted live creates: they now assert held reviews.
- [ ] **Step 5: Commit.**

### Task 6: Kind-aware engine, closing, skip, and source-gone

**Files:**
- Modify:
  - `_h2a/reviewResolutionService.js` (`currentReview`, `stillCurrent`, completion hook)
  - `_h2a/reviewResolution.js` (`ACTION_FIELDS.skip_live = new Set([])`; `normalizeResolutionDecision` accepts it)
  - `_h2a/reviewService.js` (recheck: live clear → close)
  - `_h2a/liveReview.js`, `_h2a/repository.js`, `h2a-dry-run-reviews.js`, `h2a-dry-run-review-resolutions.js`
- Test: `tests/h2a/review-resolution-service.test.mjs`, `tests/h2a/review-service.test.mjs`, `tests/h2a/live-review.test.mjs`

**Interfaces — Produces:**
- **`closeLiveReview(deps, { companyId, reviewId, actorId, outcome, resolutionAction })`**
  - Calls repository `closeLiveReview` → RPC `h2a_close_live_review`.
  - Then dispatches each returned `resumeId` through the existing `deliverResume` path. Export `dispatchConflictResumes(deps, companyId, resumeIds)` from `conflicts.js` for this.
  - Returns the RPC result plus `{ dispatched: number, pending: number }`.
- **`currentReview(deps, companyId, reviewId)`**
  - Loads via `getReview`.
  - Sample rows keep today's sample and portal checks.
  - Live rows require `status === 'needs_review'` (or a completed resolution being finalized) and a matching portal.
- **`stillCurrent(deps, row, config)`**
  - Sample: unchanged.
  - Live: `row.review_kind === 'live' && row.status === 'needs_review'`.
- **Completion hook:** when a live row's resolution finishes `completed` (link or create), call `closeLiveReview` with `outcome: 'resolved'` and `resolutionAction: 'link_existing' | 'create_new'`.
- **`skip_live`** (live rows only; 400 on sample) → `closeLiveReview` with `outcome: 'skipped'`, `resolutionAction: 'skip'`. Audited as a resolution event.
- **Recheck on a live row:**
  - Outcome `safe_to_link` or an existing mapping → `outcome: 'resolved_by_sync'`.
  - `source_missing` with no `mergedInto` → `outcome: 'source_missing'`.
  - With `mergedInto` → stays open (the merge banner shows).
- **API:**
  - `h2a-dry-run-reviews.js` GET accepts `kind` (`sample` default | `live`) and `bucket`. Sample-only responses (`sample`, the `progress.fullDryRunReady` gate) are omitted for live.
  - The resolutions endpoint derives kind from the row.

- [ ] **Step 1: Failing tests.**
  - `'live link completion closes every linked conflict and enqueues one resume each'`
  - `'replaying close inserts no second resume'`
  - `'skip_live is rejected on sample rows'`
  - `'skip_live closes conflicts as skipped and writes the skipped ledger'`
  - `'live recheck that now auto-links closes as resolved_by_sync'`
  - `'deleted HubSpot source closes as source_missing; merged source stays open'`
  - `'sample rows still supersede when a newer sample exists'` (regression)
  - `'live rows are not superseded by a newer sample'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:h2a`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 7: Org-first in one step

**Files:**
- Modify: `_h2a/reviewResolutionService.js`, `_h2a/reviewResolution.js`, `h2a-dry-run-review-resolutions.js`
- Test: `tests/h2a/review-resolution-service.test.mjs`, `tests/h2a/review-resolutions-api.test.mjs`

**Interfaces — Produces:**
- **`executeOrganizationThenContactCreate(deps, { companyId, actorId, contactReviewId, contactExpectedUpdatedAt, organizationReviewId, organizationExpectedUpdatedAt, referralSourceId, clientRequestId })`**
  - Returns `{ organization: { resolution }, contact: { resolution } | null }`.
  - Runs `executeReviewResolution` for the organization with `{ action: 'create_albi', referralSourceId }` and request id `${clientRequestId}:org`.
  - Only if that finishes `completed` with a saved mapping, it runs the contact create with request id `${clientRequestId}:contact`.
  - If the organization step fails, `contact` is null and the error is returned on `organization`.
- **Eligibility** (server-checked):
  - The contact's readiness `blockedReason === 'organization_not_synced'`.
  - The organization review exists (prepare it via the existing `prepareOrganizationReview` path when absent), has zero candidates, and has `createReadiness.ready === true`.
  - Both rows are the same kind.
- **API:** POST `h2a-dry-run-review-resolutions` with `{ op: 'create_with_organization', ... }`.
- **Projection:** the detail exposes `orgFirstCreate: { eligible: boolean, organizationReviewId?: string, organizationName?: string }`.

- [ ] **Step 1: Failing tests.**
  - `'creates organization then contact against the new organization id'`
  - `'organization failure never attempts the contact'`
  - `'replay with the same clientRequestId creates nothing twice'`
  - `'ineligible when the organization has candidates'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 8: Bulk link

**Files:**
- Create: `netlify/functions/_h2a/bulkLink.js`, `tests/h2a/bulk-link.test.mjs`
- Modify: `h2a-dry-run-review-resolutions.js` (`op: 'bulk_link'`)

**Interfaces — Produces:**
- **`executeBulkLink(deps, { companyId, actorId, items: Array<{ reviewId, candidateId, expectedUpdatedAt, clientRequestId }> })`**
  - Accepts 1–25 items (400 otherwise). Returns `{ results: Array<{ reviewId, status: 'done'|'skipped'|'failed', reason?: 'changed'|'not_eligible'|'linked_elsewhere'|'error' }> }`.
  - Items are processed sequentially, and each is re-evaluated server-side before writing: current version, `triage_bucket === 'quick'`, `quickKind === 'link'`, `suggestedCandidateId === candidateId`, and `linkedElsewhere === 0` from a fresh mapping read.
  - Each item calls `executeReviewResolution` with `{ action: 'link_existing', candidateId, approveManyToOne: false, ...(same_email ? { ignoreContactDifferences: true } : {}) }`. Each is audited on its own.
  - A 409 → `skipped`/`changed`. Never forced.

- [ ] **Step 1: Failing tests.**
  - `'links eligible items one by one with their own request ids'`
  - `'item whose target became linked elsewhere is skipped linked_elsewhere'`
  - `'changed item is skipped changed and others continue'`
  - `'rejects more than 25 items'`
  - `'never sends approveManyToOne true'`
  - `'non-quick item is skipped not_eligible'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 9: Targeted recheck, backfill, old-endpoint retirement, client API

**Files:**
- Modify:
  - `_h2a/reviewService.js` (`openReviews` and `runReviewRecheckBatch` honor `review_kind` and `review_ids`)
  - `_h2a/repository.js` (`createReviewRecheckBatch(companyId, { kind, runId, reviewIds, actorId })`)
  - `h2a-dry-run-review-recheck-all.js` (POST body `{ companyId, kind?, reviewIds? }`, max 200 ids; GET `?kind=`)
  - `_h2a/liveReview.js` (`backfillLiveReviews(deps, { companyId, limit = 50, cursor })` → `{ captured: number, linked: number, nextCursor }`, idempotent)
  - `h2a-conflicts.js` (POST `{ op: 'prepare_live_reviews' }` admin-only → backfill)
  - `h2a-conflict-resolve.js` (409 `"Resolve this in the review workspace."` when the conflict has a link row)
  - `src/lib/hubspotToAlbi.js`
- Test: `tests/h2a/review-recheck-batch.test.mjs`, `recheck-all-api.test.mjs`, `live-review.test.mjs`, `conflicts.test.mjs`, `frontend-contracts.test.mjs`

**Interfaces — Produces (client lib):**
- `getH2AReviews(session, companyId, { kind, bucket, status, objectType, reason, cursor, limit = 100, signal })`. Rename `getH2ADryRunReviews` and keep the old name as an alias until Task 15.
- `startH2ARecheckAll(session, companyId, { kind = 'sample', reviewIds } = {})`, `getH2ARecheckAll(session, companyId, { kind, signal })`
- `bulkLinkH2AReviews(session, companyId, items, { signal })`
- `createH2AOrganizationThenContact(session, companyId, input, { signal })`
- `skipH2ALiveReview(session, companyId, { reviewId, expectedUpdatedAt, clientRequestId }, { signal })` — a resolution with `action: 'skip_live'`.
- `prepareH2ALiveReviews(session, companyId, { cursor, signal })`

- [ ] **Step 1: Failing tests.**
  - `'batch with reviewIds rechecks only those rows with one Albi walk'`
  - `'live and sample batches can run at the same time'`
  - `'backfill links all open conflicts for a source to one row and is idempotent'`
  - `'legacy conflict resolve is refused for conflicts with a live review'`
  - `'activity-only conflicts still resolve through the legacy endpoint'`
  - frontend contract: each new client function hits the right path and method.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:h2a && npm run test:h2a:schema && npm run test:h2a:e2e && npm run build`. Expected: all PASS.
- [ ] **Step 5: Commit.** **Milestone A:** the user applies `supabase/h2a-live-review-workspace.sql`. Verify locally with `npm run dev:local`: the existing Sample review still works, and a live dry run against a test company holds new records. Then one push.

### Task 10: Presentation helpers — field diff, strength labels, buckets

**Files:**
- Create: `src/features/hubspotToAlbi/reviewWorkspace.js`, `tests/h2a/review-workspace-presentation.test.mjs`

**Interfaces — Produces:**
- **`fieldDiffRows({ objectType, source, candidate })`**
  - Returns `Array<{ key, label, hubspot, albi, kind: 'differs'|'one_side'|'hubspot_only'|'same' }>`.
  - Sorted in that kind order. Rows blank on both sides are dropped.
  - Values are trimmed. Email and domain are compared case-insensitively. Phone compares the last 10 digits. Text collapses whitespace.
  - Contacts drop `name`. Organizations drop `firstName` and `lastName`.
  - Field list and labels: the `SOURCE_FIELDS` order in `sampleReview.js` (import it, don't copy).
- `REASON_LABELS`, `WARNING_LABELS` — copy verbatim from `prototype/review.jsx` `REASON_LABEL` / `WARNING_LABEL`, plus `same_domain: 'Same domain'`.
- `BUCKETS = [['quick','Quick wins'],['decision','Needs decision'],['blocked','Blocked'],['todo','Albi to-do'],['done','Done']]`
- **`nextRecordId(order: string[], currentId: string, excluded: Set<string>)`** returns `string|null`. It wraps around and skips excluded ids.

- [ ] **Step 1: Failing tests.**
  - `'whitespace and case differences in email are same'`
  - `'phone formats compare by digits'`
  - `'blank on both sides is hidden'`
  - `'differs sorts before one_side before same'`
  - `'contact rows omit name'`
  - `'nextRecordId wraps and skips pending'`
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS** (`npm run test:h2a`).
- [ ] **Step 5: Commit.**

### Task 11: Deferred-commit queue

**Files:**
- Modify: `src/features/hubspotToAlbi/reviewWorkspace.js`, `tests/h2a/review-workspace-presentation.test.mjs`

**Interfaces — Produces:**
- **`createDeferredQueue({ delayMs = 5000, send, onChange, setTimer = setTimeout, clearTimer = clearTimeout })`**
  - Returns `{ enqueue(item: { id, recordId, label, payload }): void, undo(id?: string): item|null, sendNow(id): Promise<void>, flushAll(): Promise<void>, pending(): item[] }`.
  - `undo()` with no id undoes the most recent item.
  - `send(item)` is called exactly once per item, after the delay or on `sendNow` / `flushAll`, and never after `undo`.
  - `onChange(pending)` fires on every change.
  - A rejected `send` reports through `onChange` with an `{ error }` entry: the item is removed and the error is surfaced to the caller via `item.onError`.

- [ ] **Step 1: Failing tests** (fake timers):
  - `'sends once after the delay'`
  - `'undo before the delay sends nothing'`
  - `'sendNow sends immediately and the timer does not resend'`
  - `'flushAll sends every pending item once'`
  - `'undo without id undoes the most recent'`
  - `'send rejection calls onError and removes the item'`
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS.**
- [ ] **Step 5: Commit.**

### Task 12: Keyboard map

**Files:**
- Modify: `src/features/hubspotToAlbi/reviewWorkspace.js`, `tests/h2a/review-workspace-presentation.test.mjs`

**Interfaces — Produces:**
- **`shortcutFor(event, { kind, dialogOpen })`**
  - Returns `null` or one of `'next'|'prev'|'accept'|'link'|'create'|'skip'|'recheck'|'toggle'|'todo'|'undo'|'help'|'escape'|{ pick: number }|'dialogConfirm'|'dialogCancel'`.
  - Returns `null` when any of these hold:
    - `event.repeat`;
    - Meta, Ctrl or Alt is held;
    - the target is inside an input, select or textarea;
    - Enter or Space with the target inside a button or link;
    - `s` when `kind !== 'live'`.
  - With `dialogOpen`, only Enter → `dialogConfirm` and Escape → `dialogCancel`.
  - `ArrowDown`/`ArrowUp` alias `j`/`k`.

- [ ] **Step 1: Failing tests:**
  - one per key in Global Constraints;
  - `'Enter on a focused button returns null'` (Review Focus 1);
  - `'repeat returns null'`;
  - `'s is null on sample'`;
  - `'dialog mode only confirms or cancels'`.
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS.**
- [ ] **Step 5: Commit.**

### Task 13: Record components

**Files:**
- Create: `FieldDiff.jsx`, `CandidateList.jsx`, `ResolutionBar.jsx`, `ReviewRecord.jsx`, `ShortcutHelp.jsx` in `src/features/hubspotToAlbi/`
- Test: `tests/h2a/review-workspace-ui-contract.test.mjs` (use the `render()` + `vm` pattern from `review-resolution-ui-contract.test.mjs`, or extend `ui-render-fixture.mjs`)

**Interfaces:**
- Consumes: Task 10 helpers. Detail projection fields: `rankedCandidates`, `suggestedCandidateId`, `triageBucket`, `triageDetails`, `createReadiness`, `forceCreateReadiness`, `orgFirstCreate`, `mergedInto`, `hubspotOrganizations`, `resolution`, `resolutionCapability`, `hubspotUrl`, `candidateLinks`.
- **Produces — `ReviewRecord`** props: `{ item, kind, candidateIndex, onPickCandidate, referralSourceId, onReferral, referralRef, pending, busy, onAccept, onLink, onCreate, onForceCreate, onCreateWithOrganization, onApplyFields, onChooseOrganization, onSkip, onRecheck, onOpenOrganization, onOpenMergedSurvivor }`.
- **Rendered content, as in the prototype:**
  - header (name, plain reason, live HubSpot organization name, HubSpot/Albi links, HubSpot ID, last recheck);
  - merged banner;
  - blocked copy via `blockedReasonCopy`;
  - the amber "Update this {contact|organization} in Albi" reminder with Copy buttons;
  - ranked candidate cards with strength and reason chips;
  - `FieldDiff` with "Show N matching fields";
  - the per-field HubSpot/Albi choice for field-category reasons, with "All HubSpot" / "All Albi";
  - organization-context choice for association reasons, keeping today's copy;
  - collapsed "History" without raw UUIDs.
- **`ResolutionBar`:**
  - Shows Accept suggestion (with " (emails match)" when `same_email`), Link selected, the referral `<select>` (blank first option `"Referral source…"`, options from readiness `referralSources`), Create in Albi / Add new in Albi instead / Create organization and contact, Skip (live only), and Recheck.
  - Create stays disabled until `referralSourceId` is set. Linking a candidate with `linkedElsewhere > 0` opens the many-to-one dialog ("Albi {name} ({id}) is already linked to {n} other HubSpot record…") with approval pre-checked, never a 409 discovery.
  - The select blurs after a change, so the next `n` creates.

- [ ] **Step 1: Failing UI-contract tests:**
  - `'referral select starts blank and create is disabled'`
  - `'accept suggestion shows emails-match wording for same_email'`
  - `'candidate cards show strength and reason chips, not bare ids'`
  - `'skip is rendered only for live'`
  - `'merged record shows survivor action and no create'`
  - `'blocked record shows named blocked copy'`
  - `'waiting_on_albi shows the update-in-Albi reminder with copy buttons'`
  - `'read-only capability renders no mutation controls'` (regression from the existing suite)
  - `'org-first eligible record offers create organization and contact'`
  - `'linking a candidate with linkedElsewhere > 0 opens the many-to-one dialog with approval pre-checked and sends approveManyToOne true'`
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS.**
- [ ] **Step 5: Commit.**

### Task 14: Workspace, queue, Albi to-do, bulk, and pages

**Files:**
- Create: `ReviewWorkspace.jsx`, `ReviewQueue.jsx`, `AlbiTodo.jsx`
- Modify: `SampleReviewPage.jsx` (keeps its sample header, fresh-sample messaging and Recheck-all section; renders `<ReviewWorkspace kind="sample" …/>`), `ConflictsPage.jsx` (renders `<ReviewWorkspace kind="live" …/>`, plus a "Prepare open conflicts for review" admin button that loops `prepareH2ALiveReviews` until `nextCursor` is null, and the legacy read-only list for activity-only conflicts)
- Test: `tests/h2a/review-workspace-ui-contract.test.mjs`, `sample-review-ui-contract.test.mjs`, `operations-ui-contract.test.mjs` (update to the new structure)

**Interfaces — Produces (`ReviewWorkspace` behavior):**
- **Data loading:**
  - Bucket tabs with counts from `bucketCounts`.
  - The list loads with `limit: 100` per bucket and infinite scroll.
  - Filters (status, object type, reason) sit under a "Filters" disclosure.
  - The next record's detail is prefetched with the same AbortController and tenant-key discipline as today's `SampleReviewPage`.
- **Actions:**
  - Low-risk actions (accept or link to a Strong single candidate, link with emails matching, zero-candidate create, create organization and contact) go through `createDeferredQueue`.
  - Toasts show the label with Undo and Send now. Auto-advance uses `nextRecordId` within the bucket, skipping pending ids.
  - Risky actions open the existing confirmation dialog pattern (focus trap).
  - A send that fails with 409 puts the record back with "This record changed; review it again." (Review Focus 3).
  - Unmount, tenant change and `beforeunload` call `flushAll` (Review Focus 2).
- **Bulk (Quick wins tab only):**
  - Tick boxes, `x`, and "Select all in bucket".
  - "Link all exact matches (N)" opens a dialog listing up to 6 names plus "…and N more" and "Each record is rechecked on the server first. Any that changed are skipped, never forced."
  - Sends chunks of 25 to `bulkLinkH2AReviews`, shows progress, and ends with a done / skipped (reason) / failed summary.
  - "Recheck selected (N)" → `startH2ARecheckAll({ kind, reviewIds })`.
- **`AlbiTodo`:**
  - Lists `triage_bucket = 'todo'` rows across both kinds (two list calls, merged), grouped by Albi record, each with "Open in Albi", field/value rows and Copy buttons.
  - Done checkboxes are kept in `localStorage` under `h2a.albiTodo.${companyId}` as `resolutionId:fingerprint`, wrapped in try/catch. Ticks whose resolution is no longer waiting are dropped.
  - "Recheck done (N)" queues one batch per kind with those `reviewIds`, then reloads.

- [ ] **Step 1: Failing UI-contract tests:**
  - `'quick wins tab shows bulk link and no bulk create'`
  - `'bulk dialog lists names and the skip-never-force sentence'`
  - `'albi to-do groups tasks with copy buttons and a recheck-done count'`
  - `'conflicts page renders the same workspace with kind live'`
  - `'sample page keeps fresh-sample messaging'`
  - `'409 on deferred send returns the record with the changed message'`
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS** (`npm run test:h2a && npm run build`).
- [ ] **Step 5: Commit.**

### Task 15: Remove old components and prototype, end-to-end, local verification

**Files:**
- Delete: `SampleReviewDetail.jsx`, `SampleReviewResolution.jsx`, `ConflictDetail.jsx`, `prototype/`, and the `review-prototype` entry in `.claude/launch.json`
- Modify: tests that imported the deleted files (move still-valid assertions to `review-workspace-ui-contract.test.mjs`), `scripts/test-h2a-end-to-end.mjs`, `src/lib/hubspotToAlbi.js` (drop the `getH2ADryRunReviews` alias), `docs/hubspot-to-albi-pilot-runbook.md` (how to review a day's queue: buckets, keys, Albi to-do)

- [ ] **Step 1: Add the e2e scenario** `'live new contact → held → reviewer creates with referral → conflict closed → activity resumed'` to `scripts/test-h2a-end-to-end.mjs` self-test.
- [ ] **Step 2: Run** `npm run test:h2a:e2e`. Expected: FAIL until it is wired, then PASS.
- [ ] **Step 3: Delete the old files and fix imports.** Run `npm run test:h2a && npm run test:h2a:schema && npm run test:h2a:e2e && npm run build`. Expected: all PASS, and `grep -r "SampleReviewResolution\|ConflictDetail" src tests` is empty.
- [ ] **Step 4: Local verification.**
  - Run `npm run dev:local` and sign in on localhost.
  - On Sample review, check: Enter-accept and undo, the per-record referral create, an org-first create, bulk link, and the Albi to-do with recheck done.
  - On Conflicts, check: prepare open conflicts, then link, create and skip, and confirm the linked conflicts closed and the resumes dispatched.
  - Check no console errors.
- [ ] **Step 5: Commit.** **Milestone B:** one push.
