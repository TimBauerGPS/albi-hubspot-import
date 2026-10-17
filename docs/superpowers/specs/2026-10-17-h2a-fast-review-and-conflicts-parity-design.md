# HubSpot-to-Albi Fast Review and Conflicts Parity Design

**Date:** 2026-10-17

**Status:** Approved 2026-10-17. The user asked for the design to be drafted from the reviewer's own calls, so every decision below is a design call unless marked *User decided*.

**Application:** `albi-hubspot-import`

## Purpose

An admin reviews many HubSpot-to-Albi records every day. Today each record costs a queue click, a detail load, a long scroll, a dropdown, a confirmation dialog, a save wait, and a manual click to the next record. Records waiting on manual Albi edits are scattered across the queue and each needs its own 20–40s recheck. After go-live, the live Conflicts page has none of the Sample review improvements, and live creates are rejected by Albi because they lack a referral source.

This project makes the daily review fast, and it brings Conflicts to parity before go-live by running both pages on one review workspace and one resolution engine.

## Friction found (2026-10-17 code review)

| Moment | Today |
|---|---|
| Exact-email contact | ~4 clicks, 2 waits, then a manual hunt for the next record |
| Create a contact | ~5 clicks. The referral source starts blank every time |
| Contact whose organization is not in Albi | ~10+ clicks across two screens, with the referral source chosen twice |
| Waiting on Albi | Edits are only visible inside each record. One recheck per record, or a full "Recheck all" |
| Candidate choice | The dropdown shows "Albi ID 48213": no name, no reason |
| Noise | A ~18-row field grid per candidate (mostly "Blank"), a second duplicate differences grid, capability copy, HubSpot ID and last recheck on every queue row, audit history with UUIDs |
| Queue | Pages of 25, no keyboard, no "easy ones first" |
| Conflicts | Raw snapshots. "Create new target" has no referral source. Many-to-one only after a failed 409. No email-match shortcut, provider links, org-first gate, merge following or named blocked reasons |
| Live sync | `orchestrator.js` `createContact` / `createOrganization` auto-create with no `referralSourceId`, relationship status or salesperson (types come from the mapped defaults, not Referrer), so Albi rejects them. Contacts can be created without a mapped organization |

## Goals

1. A typical "quick win" record takes one keystroke and no wait before the next record is on screen.
2. Low-risk work (exact-match links and rechecks) can be done in bulk with one confirmation.
3. All pending manual Albi edits are in one to-do list, followed by one targeted recheck.
4. A record shows only what matters for the decision. Everything else is one click away.
5. Candidates are ranked with visible reasons, and the top suggestion can be accepted in one action.
6. Conflicts (live) has every Sample review capability through the same component and engine.
7. Live sync never creates Albi records on its own. New HubSpot records wait in Conflicts, where a reviewer creates them with their own referral source plus the Referrer type, Active status and owner-matched salesperson, organization first.
8. Every write stays audited, admin-only, tenant-isolated, version-checked and duplicate-safe.

## Non-goals

- Changing the Guardian Albi Wrapper. Existing Albi records still cannot be edited by API.
- Changing **automatic** link rules in the sync. Ranking and reasons only change what the reviewer sees and the suggested default. Nothing links automatically that does not link today.
- Any bulk create, bulk field resolution, or bulk many-to-one approval of an Albi record already linked elsewhere. These stay one record at a time.
- Deleting, merging or deduplicating provider records.
- Changing the fresh-sample gate before the full dry run.

## Anti-goals (it fails if…)

- …a shortcut or bulk action creates an Albi record the reviewer did not mean to create. Albi creates cannot be undone by API.
- …speed hides why a record needs review.
- …Conflicts and Sample review drift apart again (two copies of the UI or the decision logic).

## Constraints (known)

- Albi requires a referral source on create. Creates default to Type = Referrer, Status = Active, and the salesperson matching the HubSpot owner (`_h2a/createDefaults.js`).
- Albi has no update or search API. A recheck walks the full Albi list (20–40s). "Recheck all" exists as a one-pass background batch (`h2a-dry-run-review-recheck-all[-background]`).
- HubSpot merges change record IDs. Follow `getMergedInto` to the survivor.
- An organization must be linked or created before its contact.
- Deploy is a push to main, and Netlify deploys are scarce. **All verification happens locally first** (`npm run dev:local`, or the mock prototype below) before any push.
- The user runs SQL migrations themselves. Every migration ships as a file in `supabase/` with a deploy-order note.

## Design

### 1. One review workspace, two queues

Build a single `ReviewWorkspace` component, used by both pages:

- **Sample review** = `ReviewWorkspace kind="sample"` (dry-run rows, fresh-sample gate messaging).
- **Conflicts** = `ReviewWorkspace kind="live"`.

Both pages read and write the same review row shape and call the same resolution engine (`reviewResolutionService.js`, `reviewResolutionOptions.js`, `reviewService.js` recheck). `SampleReviewResolution.jsx` and `ConflictDetail.jsx` are replaced by shared pieces: `ReviewQueue`, `ReviewRecord`, `CandidateList`, `FieldDiff`, `ResolutionBar`, `AlbiTodo`.

**Live conflicts become review rows.** Every point below is a design call settled after the builder check.

- **Columns.** Add `review_kind text not null default 'sample' check (review_kind in ('sample','live'))` to `h2a_dry_run_reviews`.
- **One live row per HubSpot record, never one per conflict.**
  - Conflicts are deduplicated per held activity, so one contact can have many open conflicts. Creates can't be undone, so the record must have exactly one place where it can be created.
  - A partial unique index on `(company_id, portal_id, object_type, source_id) where review_kind = 'live' and status = 'needs_review'` enforces this.
  - A new link table `h2a_live_review_conflicts (company_id, review_id, conflict_id, unique (company_id, conflict_id))` attaches every open contact or company conflict for that source to its live row.
- **Run ownership.**
  - `run_id` stays not null and holds the live run that first captured the row. Later runs refresh the row's evidence in place instead of capturing a new row.
  - Runs that still have open live rows are not pruned. Change the live-row FK path so a run delete is restricted while open live rows exist, rather than cascading.
  - The per-run unique key keeps applying to sample rows. Live rows rely on the partial index above.
- **Currency rule.**
  - `stillCurrent()` (`reviewResolutionService.js`) becomes kind-aware. A sample row is current under today's rule (latest completed sample dry run, capture version 1).
  - A live row is current while it is `needs_review` and its `updated_at` matches the expected version.
  - `getDryRunReview` and the recheck batch stop requiring a matching sample `run_id` for live rows. Batches gain `review_kind`, with `run_id` nullable for live batches, and the Albi to-do batch may span both kinds.
- **Capture.**
  - Live capture is a new path beside `conflict()` → `recordDryRunReview`, because that path only runs when `capturesReview(ctx)` is true and is keyed per run.
  - Both paths share the snapshot, candidate, evidence and readiness builders. Only the upsert differs: live capture upserts on the live partial key and links the conflict.
- **Backfill.**
  - A one-off server task, run on demand from the Conflicts page ("Prepare open conflicts for review"), captures existing open contact and company conflicts.
  - It is idempotent on the link table's `(company_id, conflict_id)` and the live partial key.
- **Closing, in one transaction.**
  - When a live row's resolution completes, a new RPC does all of the following in a single transaction: saves the mapping, marks every linked open conflict `resolved` (with the matching `resolution_action`), and inserts one `h2a_conflict_resumes` intent per conflict (existing `unique (company_id, conflict_id)`).
  - It extends the pattern of the existing conflict-resolve RPC in `h2a-mapping-target-ownership.sql`. Resume dispatch then uses the existing path.
- **Clears without a reviewer.**
  - A later sync run, or a recheck, may find the record now auto-links or is already mapped. The same RPC then closes the row (`no_longer_in_scope`, outcome `resolved_by_sync`) and resolves and resumes its conflicts.
- **Source gone.**
  - When the HubSpot source was merged, the row shows the merge banner and the reviewer follows the survivor. Resolving the survivor's row closes this one the same way.
  - When the source was deleted (recheck outcome `source_missing` with no `mergedInto`), the row becomes `no_longer_in_scope`. Its conflicts are marked `skipped` and added to the existing skipped-item ledger, audited.
- **Skip.** "Skip" on a live row marks all its linked conflicts skipped through the existing `skip_item` semantics and ledger.
- **Kind filters.** All sample queries (progress, fresh-sample gate, recheck-all batch) filter `review_kind = 'sample'`. Live queries filter `review_kind = 'live'`.
- **Retiring the old endpoint.** After cutover, `h2a-conflict-resolve` rejects contact and company conflicts that have a live row (409 with "Resolve this in the review workspace"). It stays only for activity-only conflict types. Those keep a minimal read-only legacy view inside the live queue until inventoried (see Left to the builder).

### 2. Triage queue

The queue groups records into buckets, computed server-side from evidence already on the row and its resolution options:

| Bucket | Rule |
|---|---|
| **Quick wins** | Exactly one candidate with the same trimmed, case-insensitive email (contact), or the same normalized domain/name (organization) and no other candidates. Or zero candidates and create-ready. Or recheck outcome `safe_to_link` / `safe_to_create` |
| **Albi to-do** | Resolution `waiting_on_albi` |
| **Needs decision** | Everything else that is actionable |
| **Blocked** | A named blocked reason (see §8). Shows the reason in the queue row |
| **Done** | Cleared, completed, skipped, no longer in scope (hidden by default) |

- Header counters: Quick wins · Albi to-do · Needs decision · Blocked · Done today.
- Queue rows show the name, organization, a one-line reason and a bucket badge. HubSpot ID and last recheck move into the record header.
- The queue loads 100 rows per page with infinite scroll. Filters (status, object type, reason) remain under a "Filters" disclosure.

### 3. Record view: show fewer fields

- **Header:** name, object type, reason in plain words, HubSpot organization (live name), links (Open in HubSpot, Open in Albi), HubSpot ID, last recheck.
- **Merged-in-HubSpot banner** (when `mergedInto`) with "Review the surviving record" (existing `prepareH2AMergedSurvivorReview`).
- **Field diff:** one compact HubSpot | Albi table for the selected candidate.
  - Rows where values differ come first, highlighted.
  - Rows where only one side has a value come next.
  - Matching rows collapse under "N matching fields".
  - Blank-on-both-sides rows are hidden.
  - Values are compared trimmed (and normalized the same way the server compares), so whitespace-only differences never show as differences.
- The duplicate "Fields with different values" grid, the capability sentence and the guidance paragraph are removed. Guidance becomes the one-line reason. Audit history moves into a collapsed "History" disclosure without raw reviewer UUIDs (show "You" or the reviewer's email when known).

### 4. Ranked candidates with reasons

The server adds, per candidate, `matchReasons` (ordered) and `strength`:

- Reasons: `same_email`, `same_other_email` (HubSpot additional emails vs Albi email), `same_phone`, `phone_matches_mobile` (cross-compare phone and mobile), `same_name`, `same_organization`, `same_domain`, `same_address`. Plus warnings: `already_linked_elsewhere` (with a count), `different_email`.
- Strength: **Strong** (`same_email` or `same_other_email`, and no `different_email`), **Likely** (phone, or name + organization), **Weak** (name only). No numeric score is shown.
- Candidates are sorted by strength, then reason count. Each candidate card shows name, email, phone, organization, reason chips and warnings. The dropdown labelled "Albi ID 48213" is gone.
- The top candidate is preselected as the **suggestion** when it is Strong and the only Strong one. "Accept suggestion" links it. When the emails match, that link uses the existing "emails match (ignore phone/address)" semantics.
- The target list keeps "Add new contact/organization in Albi" as the last option.
- Ranking uses the same normalization as `match.js` and is computed during capture and recheck. Automatic link rules in `decideContactMatch` / `decideOrganizationMatch` are unchanged.

### 5. Resolution bar and keyboard flow

A sticky bar at the bottom of the record shows the actions that are valid for this record, in order: **Accept suggestion** · Link selected · Create in Albi · Choose fields · Skip · Recheck.

Keyboard shortcuts (shown in a "?" overlay, active only when focus is not in a text field):

| Key | Action |
|---|---|
| `j` / `k` | Next / previous record in the current bucket |
| `Enter` or `a` | Accept suggestion |
| `1`–`9` | Select candidate N |
| `l` | Link selected candidate |
| `n` | Create new in Albi |
| `s` | Skip (live only. Sample review has no skip) |
| `r` | Recheck this record |
| `t` | Open Albi to-do |
| `u` | Undo the pending action |

**Auto-advance:** after an action is queued, the next record in the same bucket opens immediately. The next record's detail is **prefetched** while the current one is on screen.

**Confirmation only for risky actions:**

- No dialog (undo window instead): link to a Strong single candidate, link with emails matching, create with zero candidates, create organization + contact together.
- Dialog: force-create despite candidates, many-to-one onto an Albi record already linked elsewhere, any HubSpot field write, choosing an organization that adds a HubSpot association, every bulk action.

**Undo window (deferred commit):** a no-dialog action is held client-side for 5 seconds with a toast ("Linking Jane Doe → Albi Jane Doe · Undo"). It is sent to the server when the timer expires. Undo cancels it before anything is written. Leaving the page flushes pending actions immediately, with a `beforeunload` guard while any are pending. A failed send puts the record back in its bucket with the error on it. The server-side request is unchanged: same `clientRequestId` and `expectedUpdatedAt`, so retries stay idempotent.

**Referral source per record** (*User decided*: referral sources rarely repeat between records):
- Every create has its own **Referral source** dropdown, filled from Albi's live referral source list. In Allied's Albi that list is currently: Contractor, Employee, Fire Chasing, Insurance, Network, Online Marketing, Other, Plumber, Property Management, Real Estate, Returning Customer, TPA, Vehicle Wraps.
- The dropdown starts blank on every record, with nothing preselected and nothing remembered, and the create button stays disabled until a source is chosen.
- Pressing `n` focuses the dropdown when it is blank. Type-ahead picks an option, and `n` again creates.
- "Create organization and contact" uses one choice for both records.

### 6. Org-first in one step

When a contact's create is blocked only by `organization_not_synced`, and the organization's own review is create-ready with no candidates, the record offers **Create organization and contact**. The engine runs two audited resolutions in order: create the organization (and save its mapping), then create the contact against it. If the organization step fails, the contact step is not attempted. If the organization has candidates, the existing "Open organization review" path stays, and the contact record shows a "Back to contact" bar.

Contacts are never created without a mapped organization when HubSpot has one associated. A contact with no HubSpot organization may still be created without one (unchanged behavior).

### 7. Live sync never auto-creates (go-live fix)

*User decided:* live sync never creates Albi records itself. A new record waits in Conflicts until a reviewer creates it with a referral source chosen from the dropdown.

- In `orchestrator.js`, the live paths that call `deps.albi.createContact` and `deps.albi.createOrganization` are replaced by capturing a `live` review row with reason `new_record_needs_review` (one new reason in the shared catalog, plain copy: "New in HubSpot, not in Albi yet"). No live-sync code path calls an Albi create.
  - The row carries the same create readiness the dry run computes (`createReadiness`, `organization_not_synced`, named blocked reasons).
  - The item result is recorded as held, not created.
  - Held activities that depend on the record wait on its conflict and resume through the existing `h2a_conflict_resumes` path once the review creates or links it.
- Create-ready new records with zero candidates land in the **Quick wins** bucket. They are still one-at-a-time creates with a blank referral dropdown (§5), never bulk.
- Creates made from a live review use the shared engine and `createDefaults.js` (Referrer, Active, owner-matched salesperson, chosen referral source), exactly like Sample review creates.
- Org-first applies: a new contact whose HubSpot organization is also new waits behind the organization. Its record offers "Create organization and contact" (§6).
- Repeat runs are duplicate-safe: a source that already has an open `live` review row or open conflict is not captured again. That row's evidence is refreshed instead.
- No referral-source company setting and no Preflight item are needed.

### 8. Named blocked reasons everywhere

One catalog (extending `BLOCKED_COPY` into `shared/`) with plain copy for: `referrer_type_missing`, `active_status_missing`, `owner_not_found`, `salesperson_not_found`, `source_already_mapped`, `multiple_organizations`, `organization_not_synced`. It is used by the queue badge, the record view and Preflight.

### 9. Bulk actions

Each bucket header offers the bulk actions valid for every selected record:

- **Link all exact email matches (N)**: Quick-win contacts with one same-email candidate.
- **Link all single strong organization matches (N)**.
- **Recheck selected (N)**: queues the existing recheck batch for just those rows.

Records can be selected with checkboxes, "Select all in bucket", or `x` on the focused row.

- The confirmation lists the count, a sample of names, and exactly what will be written.
- The server receives one request per chunk of 25 rows and processes each row through the normal engine with that row's `expectedUpdatedAt` and its own `clientRequestId`. Each row is audited individually.
- Rows that changed (409) or no longer qualify are skipped and reported, never forced.
- A bulk run shows progress and ends with a summary: done / skipped (why) / failed.
- Bulk actions never create Albi records (*User decided*: each create needs its own referral source), and never include field writes or approval of an Albi record linked elsewhere.

### 10. Albi to-do

A dedicated view (tab beside the queue, key `t`) aggregating every manual Albi task from `waiting_on_albi` resolutions, across both kinds:

- Grouped by Albi record: name, **Open in Albi** link, each field to set with its value and a **Copy** button.
- A **Done** checkbox per task. Ticks are kept per viewer in browser storage, keyed by resolution ID and task fingerprint. A tick is only a reminder: the server still verifies by recheck.
- **Recheck done (N)** queues one recheck batch for exactly the ticked records (one Albi walk). Results update in place. Tasks that still differ come back unticked with the field still listed.
- The amber per-record reminder ("Update this contact in Albi") stays on the record itself.

Requires extending the recheck batch to accept an optional list of review IDs (default: all open, as today).

### 11. Conflicts parity checklist

All of these must work on `kind="live"`, covered by tests:

- Referral source dropdown on every single create, starting blank.
- Many-to-one shown up front as a warning chip and pre-checked approval in the single-record flow (not discovered by a 409).
- "Link, emails match (ignore phone/address)".
- "Add new contact/organization in Albi" in the target list.
- The "Update this contact in Albi" reminder and the Albi to-do.
- The live HubSpot organization name.
- HubSpot merge following (`getMergedInto` → survivor review).
- Named blocked reasons.
- Trimmed comparisons.
- Recheck (single and batch).
- Audit history.
- Org-first.

## Local prototype (before any build)

A throwaway, clickable prototype of the workspace runs locally on mock data so the flow can be felt without a deploy:

- A separate Vite page `prototype/review.html` (dev server only; not in the production build), opened at `http://localhost:5180/prototype/review.html` via `npm run dev`.
- Mock records cover: exact-email quick wins, ranked candidates, a zero-candidate create, an org-first contact, a waiting-on-Albi record, a merged record, a blocked record, and a many-to-one warning.
- It demonstrates: buckets and counters, keyboard flow, auto-advance, undo toast, trimmed field diff, candidate reasons, bulk link with confirmation, Albi to-do with copy and done checkboxes, and the per-record referral dropdown.
- It writes nothing anywhere. Feedback from trying it updates this spec before planning. The prototype is deleted once Phase 2 starts.

## Testing and verification

Test-first throughout:

- `npm run test:h2a` for engine, ranking, buckets, bulk eligibility, live capture, close-and-resume, live sync never calling an Albi create, live capture of new records, org-first.
- `npm run test:h2a:schema` for new columns, constraints, `review_kind` filters.
- `npm run test:h2a:e2e` for one live conflict → review → resolve → resume path.
- `npm run build`.

Before any push, the real app is exercised locally with `npm run dev:local` (Vite + `netlify functions:serve`) against the real Supabase project. Deploys are batched: one push per approved milestone, not per fix.

## Left to the builder

- Exact component split and file names inside `src/features/hubspotToAlbi/`.
- Chunk size and timeouts for bulk requests (25 is a starting point).
- How the backfill task is triggered and paginated.
- Inventory of activity-only conflict types and whether any need more than a read-only view.
- Visual styling, within the existing Tailwind brand palette, without emojis.
