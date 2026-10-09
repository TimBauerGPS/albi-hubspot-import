# Guardian Albi Wrapper Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move HubSpot-to-Albi from the native Albi API to the Guardian company-scoped wrapper while preserving safe matching, conflict routing, idempotent delivery, and read-only setup checks.

**Architecture:** Keep the existing `AlbiClient` domain interface and replace its transport with lazy, exact-one-company wrapper discovery plus company-scoped requests. Model create permissions and unsupported existing-record mutations as explicit informational preflight states, while retaining strict failures for authentication, reads, options, and runtime writes. Persist only sanitized company identity in the existing JSONB preflight details; no schema migration is needed.

**Tech Stack:** Node.js ESM, Netlify Functions, React 18, `node:test`, Vite 5, existing Supabase-backed H2A configuration and run repositories.

**Spec:** `docs/superpowers/specs/2026-10-09-guardian-albi-wrapper-migration-design.md`

## Global Constraints

- Use `https://albi.guardianrestoration.com` and send the credential only as `X-API-Key`.
- Discover the authorized wrapper company with `GET /v1/companies`; accept exactly one company and never accept a browser-supplied wrapper company ID.
- Connection checks and dry runs must not create Albi records.
- Contact, organization, and activity creates are single-attempt operations; ambiguous activity outcomes continue through existing reconciliation.
- Existing-record field changes and reassociations go to Conflicts and do not block activation.
- Never expose API keys, authorization headers, raw provider bodies, encrypted envelopes, or database errors.
- Do not change the database schema, role model, scheduler, matching rules, or conflict-resolution authorization.
- Preserve `_reference/` as untouched user material.

## Review Focus

- A key that returns zero or multiple companies must fail closed before a company-scoped request; Task 1 pins both cases.
- A wrapper key missing one option scope must identify that read as denied and keep activation blocked without leaking provider text; Task 3 pins this case.
- A first-use create `403` must record the exact known scope, leave the run unresolved, and not advance its checkpoint; Task 2 pins this case.
- A timed-out or `5xx` activity create must remain single-attempt and enter reconciliation rather than create a duplicate; Tasks 1 and 2 retain this regression.
- A requested field update or reassociation on an existing contact must produce a Conflict without calling any wrapper mutation endpoint; Task 2 pins this case.

---

### Task 1: Replace the Native Albi Transport with the Guardian Wrapper

**Files:**
- Modify: `netlify/functions/_h2a/albiClient.js`
- Modify: `tests/h2a/api-clients.test.mjs`
- Modify: `tests/h2a/fixtures/albi/responses.json`
- Modify: `tests/h2a/fixtures/metadata.json`
- Modify: `scripts/test-h2a-end-to-end.mjs`

**Interfaces:**
- Consumes: `createHttpClient(options)` and existing `ApiError`, `invalid`, `malformed`, `responseId` helpers from `netlify/functions/_h2a/http.js`.
- Produces: `new AlbiClient({ apiKey, fetch?, sleep?, random?, timeoutMs? })`; `verifyCredentials(): Promise<{ authenticated: true, company: { id: string, name: string }, capabilities: Record<string, 'verified_on_first_use' | 'handled_through_conflicts'> }>`; unchanged domain methods `listContacts`, `listOrganizations`, `listActivities`, `listOptions`, `createContact`, `createOrganization`, and `createActivity`.

- [ ] **Step 1: Replace native-adapter expectations with failing wrapper discovery and read-route tests**

Update the Albi portions of `tests/h2a/api-clients.test.mjs` so the transport supplies company discovery before the first company-scoped operation and proves the native boundary is gone:

```js
const accessibleCompany = { data: [{ companyId: '1319', name: 'Allied Restoration Services Inc' }] }

test('Albi wrapper discovers exactly one company and scopes every read to it', async () => {
  const f = transport([
    accessibleCompany,
    al.contacts,
    al.organizations,
    al.relationshipTypes,
    al.referralSources,
    al.relationshipStatuses,
    al.activityTypes,
  ])
  const client = new AlbiClient({ apiKey: 'private-key', fetch: f.fetch })

  assert.deepEqual(await client.verifyCredentials(), {
    authenticated: true,
    company: { id: '1319', name: 'Allied Restoration Services Inc' },
    capabilities: {
      contacts_create: 'verified_on_first_use',
      organizations_create: 'verified_on_first_use',
      activities_create: 'verified_on_first_use',
      contacts_update: 'handled_through_conflicts',
      organizations_update: 'handled_through_conflicts',
      contacts_associate_organization: 'handled_through_conflicts',
    },
  })
  await client.listContacts({ cursor: '2', pageSize: 1 })
  await client.listOrganizations({ pageSize: 25 })
  await client.listOptions()

  assert.equal(f.calls[0].url.pathname, '/v1/companies')
  assert.equal(f.calls[0].headers['X-API-Key'], 'private-key')
  assert.equal(f.calls[0].headers.ApiKey, undefined)
  assert.ok(f.calls.slice(1).every(call => call.url.pathname.startsWith('/v1/companies/1319/')))
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/companies').length, 1)
})

test('Albi wrapper fails closed for zero or multiple authorized companies', async () => {
  for (const data of [[], [
    { companyId: '1319', name: 'Allied Restoration Services Inc' },
    { companyId: '1351', name: 'GPS - Sandbox' },
  ]]) {
    const f = transport([{ data }])
    const client = new AlbiClient({ apiKey: 'private-key', fetch: f.fetch })
    await assert.rejects(client.listContacts(), { category: 'permanent', code: 'company_access_invalid' })
    assert.equal(f.calls.length, 1)
  }
})
```

Also add cases for a malformed `data` collection, blank/unsafe `companyId`, overlong or control-character company names, and a discovery `401`. Update fixture metadata so every route uses the wrapper path and documented scope.

- [ ] **Step 2: Run the adapter tests and verify the native implementation fails**

Run:

```bash
node --test --test-name-pattern='Albi wrapper|Albi pages|Albi creates|Albi never retries|Albi payload' tests/h2a/api-clients.test.mjs
```

Expected: FAIL because `AlbiClient` still calls `api.albiware.com`, sends `ApiKey`, and has no wrapper company discovery.

- [ ] **Step 3: Implement lazy company discovery and company-scoped reads**

Refactor `AlbiClient` around these constants and private helpers:

```js
const WRAPPER_ORIGIN = 'https://albi.guardianrestoration.com'
const COMPANY_ROOT = '/v1/companies'
const CAPABILITIES = Object.freeze({
  contacts_create: 'verified_on_first_use',
  organizations_create: 'verified_on_first_use',
  activities_create: 'verified_on_first_use',
  contacts_update: 'handled_through_conflicts',
  organizations_update: 'handled_through_conflicts',
  contacts_associate_organization: 'handled_through_conflicts',
})

async #company() {
  if (!this.#companyPromise) this.#companyPromise = this.#discoverCompany()
  return this.#companyPromise
}

async #path(suffix) {
  const company = await this.#company()
  return `${COMPANY_ROOT}/${encodeURIComponent(company.id)}/${suffix}`
}
```

`#discoverCompany` must require an object shaped exactly enough to safely read `data`, require `data.length === 1`, validate `companyId` against `^[A-Za-z0-9_-]{1,64}$`, sanitize the display name to 1–200 printable characters, and throw `new ApiError('permanent', { operation: 'discoverCompany', code: 'company_access_invalid' })` for zero, multiple, or malformed companies. Construct the HTTP client with `headers: { 'X-API-Key': apiKey }`.

Use wrapper suffixes `contacts`, `organizations`, `activities`, and the four `options/...` routes. Preserve the current query allowlists, page bounds, input validation, record normalization, and relationship-type reuse for contact and organization types.

- [ ] **Step 4: Convert write routes and response normalization**

Make create methods post to the collection route rather than `/Create`:

```js
async #create(resource, payload, operation) {
  const path = await this.#path(resource)
  const data = await this.#request(path, {
    method: 'POST', body: payload, operation, retrySafe: false,
  })
  if (!isRecord(data) || data.status !== 1) {
    throw new ApiError('validation', { operation, code: 'application_error' })
  }
  return { id: responseId(data.data, operation) }
}
```

Retain the fixture-backed `{ status: 1, data: <positive integer ID> }` success shape already returned through the wrapper. Reject every other shape rather than loosening acceptance to arbitrary objects. `createContact` must continue allowing `organizationId`; all creates must retain field allowlists and numeric-ID normalization.

- [ ] **Step 5: Update the provider self-test contract**

In `scripts/test-h2a-end-to-end.mjs`, update read-only Albi expectations so the first Albi request is company discovery and all subsequent requests remain under the discovered company. Keep write mode opt-in, isolation guards, marker readback, and secret redaction unchanged. Change any native-host or `ApiKey` assertions to wrapper-host and `X-API-Key` assertions.

- [ ] **Step 6: Run the adapter tests and self-test**

Run:

```bash
node --test tests/h2a/api-clients.test.mjs
npm run test:h2a:e2e
```

Expected: PASS. The ambiguous-create test must still assert exactly one POST attempt for `503`, malformed success, and application-error responses.

- [ ] **Step 7: Commit the transport migration**

```bash
git add netlify/functions/_h2a/albiClient.js tests/h2a/api-clients.test.mjs tests/h2a/fixtures/albi/responses.json tests/h2a/fixtures/metadata.json scripts/test-h2a-end-to-end.mjs
git commit -m "feat: use Guardian wrapper for Albi sync"
```

---

### Task 2: Preserve Conflict Routing and Expose Safe First-Use Scope Failures

**Files:**
- Modify: `netlify/functions/_h2a/http.js`
- Modify: `netlify/functions/_h2a/albiClient.js`
- Modify: `netlify/functions/_h2a/orchestrator.js`
- Modify: `tests/h2a/api-clients.test.mjs`
- Modify: `tests/h2a/orchestrator.test.mjs`

**Interfaces:**
- Consumes: Task 1's company-scoped `AlbiClient` and existing orchestrator repository methods.
- Produces: `ApiError.requiredScope: string | null` for allowlisted wrapper operations; run item `sanitized_details` shaped as `{ reason: string, requiredScope?: string }`; no change to public function response types.

- [ ] **Step 1: Write failing tests for known-scope `403` failures**

Add an adapter assertion that a denied create remains secret-free and names only the static documented scope:

```js
test('Albi wrapper attaches only the known required scope to permission failures', async () => {
  const f = transport([accessibleCompany, { statusCode: 403, body: { detail: 'private-key raw provider text' } }])
  const client = new AlbiClient({ apiKey: 'private-key', fetch: f.fetch })
  await assert.rejects(
    client.createContact({ firstName: 'A', lastName: 'B', contactTypeIds: [1] }),
    error => error.category === 'permission' &&
      error.requiredScope === 'contacts:create' &&
      !JSON.stringify(error).includes('private-key'),
  )
  assert.equal(f.calls.length, 2)
})
```

Add an orchestrator regression using a one-activity live fixture whose contact create throws:

```js
test('first-use create scope denial fails the item and holds the checkpoint', async () => {
  const deps = liveFixture({ companyIds: [] })
  deps.albi.createContact = async () => {
    throw new ApiError('permission', {
      operation: 'createContact', status: 403, requiredScope: 'contacts:create',
    })
  }

  const result = await runCompanySync(deps, { companyId: 'c1', mode: 'live', trigger: 'manual' })

  assert.equal(result.status, 'partially_failed')
  assert.equal(deps.cursors.length, 0)
  assert.ok(deps.items.some(item =>
    item.outcome === 'failed' &&
    item.sanitized_details.requiredScope === 'contacts:create'))
})
```

- [ ] **Step 2: Run focused tests and verify scope metadata is absent**

Run:

```bash
node --test --test-name-pattern='required scope|scope denial' tests/h2a/api-clients.test.mjs tests/h2a/orchestrator.test.mjs
```

Expected: FAIL because `ApiError` drops `requiredScope` and the orchestrator stores only its generic safe reason.

- [ ] **Step 3: Add allowlisted required-scope metadata**

Extend `ApiError` with a nullable `requiredScope`, without accepting provider-derived text:

```js
export class ApiError extends Error {
  constructor(category, {
    operation = 'request', status = null, code = category,
    retryAfterMs = null, requiredScope = null,
  } = {}) {
    super(`Provider request failed (${category}).`)
    this.name = 'ApiError'
    Object.assign(this, { category, operation, status, code, retryAfterMs, requiredScope })
  }
}
```

In `albiClient.js`, define one frozen operation-to-scope map containing only the ten scopes in the approved spec. Wrap an `ApiError` from a scoped request with the statically selected scope while copying only `category`, `operation`, `status`, `code`, and `retryAfterMs`. Never read the provider error body or use provider text as a scope.

- [ ] **Step 4: Record safe scope details without weakening checkpoint behavior**

Replace the string-only helper with a structured allowlisted projection:

```js
const WRAPPER_SCOPES = new Set([
  'contacts:list', 'contacts:create',
  'organizations:list', 'organizations:create',
  'activities:list', 'activities:create',
  'options.relationship-types:list', 'options.referral-sources:list',
  'options.relationship-statuses:list', 'options.activity-types:list',
])

function safeFailure(error) {
  return {
    reason: `${ERROR_CATEGORIES.has(error?.category) ? error.category : 'error'}:${ERROR_CODES.has(error?.code) ? error.code : 'operation_failed'}`,
    ...(WRAPPER_SCOPES.has(error?.requiredScope) ? { requiredScope: error.requiredScope } : {}),
  }
}
```

Use `safeFailure(error)` when recording failed run items. When `resolveOrganization` or `resolveContact` throws during a create, record one failed item for that organization/contact source with the safe failure projection before returning an unresolved target to `processActivity`. Continue creating the existing activity-target Conflict so the administrator has a review path. For activity delivery failures, merge the safe projection into the existing failed delivery item. Keep conflict reasons as the stable `reason` string where repository contracts require a string. Do not add provider bodies or exception messages.

- [ ] **Step 5: Pin unsupported existing-record mutations to Conflicts**

Add an orchestrator test with an existing contact whose nonblank organization differs from HubSpot. Make `updateContact`, `updateOrganization`, and `associateContact` throw if called. Assert one contact Conflict is recorded, no mutation method runs, and the activity checkpoint remains held until review.

```js
deps.albi.updateContact = async () => { throw new Error('must not mutate') }
deps.albi.associateContact = async () => { throw new Error('must not mutate') }
assert.ok(deps.events.some(value => value.startsWith('conflict:')))
assert.equal(deps.cursors.length, 0)
```

- [ ] **Step 6: Run adapter, orchestrator, and delivery regression tests**

Run:

```bash
node --test tests/h2a/api-clients.test.mjs tests/h2a/orchestrator.test.mjs tests/h2a/deliveries.test.mjs
```

Expected: PASS, including ambiguous activity reconciliation and no checkpoint advancement for unresolved targets.

- [ ] **Step 7: Commit runtime safety behavior**

```bash
git add netlify/functions/_h2a/http.js netlify/functions/_h2a/albiClient.js netlify/functions/_h2a/orchestrator.js tests/h2a/api-clients.test.mjs tests/h2a/orchestrator.test.mjs
git commit -m "fix: preserve H2A wrapper scope failures"
```

---

### Task 3: Make Preflight Informational States Explicit and Activation-Safe

**Files:**
- Modify: `netlify/functions/_h2a/preflight.js`
- Modify: `tests/h2a/preflight.test.mjs`
- Modify: `src/features/hubspotToAlbi/PreflightChecklist.jsx`
- Modify: `src/features/hubspotToAlbi/CredentialFields.jsx`
- Modify: `tests/h2a/frontend-contracts.test.mjs`

**Interfaces:**
- Consumes: Task 1's `verifyCredentials()` result and static wrapper scopes.
- Produces: sanitized `preflight.details.albi.company: { id: string, name: string }`; checks with status `'valid' | 'invalid' | 'informational'`; reasons `'verified_on_first_use' | 'handled_through_conflicts'` for informational checks; optional allowlisted `requiredScope`.

- [ ] **Step 1: Rewrite the blocking preflight test as a failing readiness test**

Update the test fixture's `verifyCredentials` response to include company identity and Task 1's capability states. Replace the current test that expects unsupported contracts to block activation:

```js
test('preflight allows activation when required reads pass and writes are informational', async () => {
  const result = await runPreflight(clients())

  assert.equal(result.status, 'valid')
  assert.deepEqual(result.details.albi.company, {
    id: '1319', name: 'Allied Restoration Services Inc',
  })
  for (const capability of ['contacts_create', 'organizations_create', 'activities_create']) {
    const check = result.details.albi.checks.find(item => item.capability === capability)
    assert.equal(check.status, 'informational')
    assert.equal(check.reason, 'verified_on_first_use')
    assert.match(check.requiredScope, /:create$/)
  }
  for (const capability of unsupportedWrites) {
    const check = result.details.albi.checks.find(item => item.capability === capability)
    assert.equal(check.status, 'informational')
    assert.equal(check.reason, 'handled_through_conflicts')
  }
  assert.ok(!result.details.missing.includes('Albi contact updates'))
})
```

Add a denied option-read case using `new ApiError('permission', { operation: 'listOptions', status: 403, requiredScope: 'options.activity-types:list' })`. Assert the overall result is invalid, the exact allowlisted scope survives, and arbitrary provider text does not.

- [ ] **Step 2: Run preflight tests and verify the old readiness rule fails**

Run:

```bash
node --test tests/h2a/preflight.test.mjs
```

Expected: FAIL because informational states and sanitized company identity are not yet supported and unsupported contracts still invalidate Albi readiness.

- [ ] **Step 3: Implement the safe preflight projection and readiness rule**

In `preflight.js`:

- Add `company_access: 'Authorized Albi company'` to the Albi capability labels.
- Permit `informational` in check statuses.
- Permit only `verified_on_first_use` and `handled_through_conflicts` as new diagnostic reasons.
- Permit only the ten static wrapper scopes as `requiredScope` values.
- Sanitize `albi.company.id` with `^[A-Za-z0-9_-]{1,64}$` and its name with the existing printable-text rules.
- Add invalid checks to `missing`; never add informational checks.
- Calculate provider validity as authenticated, no invalid checks, and complete required options. Informational checks neither prove a write nor block readiness.

Build the six write checks directly from `verifyCredentials().capabilities`; do not call any create or `OPTIONS` endpoint. Required read failures and incomplete options must continue blocking activation.

- [ ] **Step 4: Add failing frontend contract assertions for the new operator language**

Extend `tests/h2a/frontend-contracts.test.mjs` to read both components and assert:

```js
assert.match(credentials, /Guardian Albi API key/)
assert.match(credentials, /company-scoped/)
assert.match(checklist, /Verified when first used/)
assert.match(checklist, /Handled through Conflicts/)
assert.match(checklist, /Authorized Albi company/)
assert.doesNotMatch(checklist, /Write probe inconclusive/)
```

Also assert the checklist prints an allowlisted `requiredScope` only when present and keeps the read-only connection-check statement.

- [ ] **Step 5: Run the frontend contract test and verify the old labels fail**

Run:

```bash
node --test --test-name-pattern='Guardian Albi|operator language|frontend' tests/h2a/frontend-contracts.test.mjs
```

Expected: FAIL because the credential and checklist still describe a generic Albi key and binary capability availability.

- [ ] **Step 6: Render informational diagnostics and company identity**

Update `PreflightChecklist.jsx` with explicit copy:

```js
const DIAGNOSTIC_LABELS = Object.freeze({
  authentication_rejected: 'Authentication rejected',
  permission_denied: 'Permission denied',
  unexpected_response: 'Unexpected response',
  provider_unavailable: 'Provider unavailable',
  verified_on_first_use: 'Verified when first used',
  handled_through_conflicts: 'Handled through Conflicts',
})
```

Use a neutral blue/gray marker for `informational`, green only for `valid`, and amber only for `invalid`. Show `Authorized company: {name} ({id})` above the Albi checks when present. Show `Required scope: {requiredScope}` only from sanitized preflight data. Keep the missing-items alert limited to actual blockers.

In `CredentialFields.jsx`, change the label to **Guardian Albi API key**, the empty placeholder to **Enter Guardian Albi API key**, and add concise help that the key is company-scoped.

- [ ] **Step 7: Run preflight and frontend tests**

Run:

```bash
node --test tests/h2a/preflight.test.mjs tests/h2a/frontend-contracts.test.mjs
```

Expected: PASS. The persisted preflight-details key assertion must include `company` only under `albi`, and secret-redaction assertions must remain green.

- [ ] **Step 8: Commit activation and diagnostic changes**

```bash
git add netlify/functions/_h2a/preflight.js tests/h2a/preflight.test.mjs src/features/hubspotToAlbi/PreflightChecklist.jsx src/features/hubspotToAlbi/CredentialFields.jsx tests/h2a/frontend-contracts.test.mjs
git commit -m "feat: make H2A wrapper readiness explicit"
```

---

### Task 4: Update Operational Documentation and Verify the Complete Migration

**Files:**
- Modify: `docs/hubspot-to-albi-pilot-runbook.md`
- Modify: `README.md`
- Modify: `tests/h2a/fixtures/metadata.json`
- Test: `tests/h2a/*.test.mjs`
- Test: `scripts/test-h2a-schema-contract.mjs`
- Test: `scripts/test-h2a-end-to-end.mjs`

**Interfaces:**
- Consumes: Tasks 1–3 and the approved design specification.
- Produces: an operator runbook whose credential, scopes, connection-check meaning, dry-run sequence, and first-live-write monitoring match the shipped wrapper behavior.

- [ ] **Step 1: Write documentation contract assertions before changing the runbook**

Add a small contract test to `tests/h2a/frontend-contracts.test.mjs` that reads the runbook and README:

```js
test('operator documentation names the Guardian wrapper boundary and rollout gates', async () => {
  const runbook = await readFile(new URL('../../docs/hubspot-to-albi-pilot-runbook.md', import.meta.url), 'utf8')
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
  for (const text of [runbook, readme]) {
    assert.match(text, /albi\.guardianrestoration\.com/)
    assert.match(text, /X-API-Key/)
  }
  assert.match(runbook, /contacts:create/)
  assert.match(runbook, /organizations:create/)
  assert.match(runbook, /activities:create/)
  assert.match(runbook, /Verified when first used/)
  assert.match(runbook, /Handled through Conflicts/)
  assert.doesNotMatch(runbook, /base host is `https:\/\/api\.albiware\.com`/)
})
```

- [ ] **Step 2: Run the documentation contract and verify stale native instructions fail**

Run:

```bash
node --test --test-name-pattern='operator documentation' tests/h2a/frontend-contracts.test.mjs
```

Expected: FAIL because the current pilot runbook still instructs operators to use the native Albi host and header.

- [ ] **Step 3: Rewrite the wrapper setup and pilot gates**

Update `docs/hubspot-to-albi-pilot-runbook.md` to include:

- wrapper base URL, `X-API-Key`, and exact-one-company discovery;
- Allied's expected company ID `1319` as a confirmation, not a caller-supplied setting;
- all ten required read/create/option scopes from the approved spec;
- the meaning of **Verified when first used** and **Handled through Conflicts**;
- connection check, mapping confirmation, selected start date, dry run, conflict sample, live activation, and first-write monitoring order;
- `401` as invalid/revoked key and `403` as a missing named scope;
- the fact that dry run and connection check do not verify create permissions by creating test records; and
- recovery guidance: add the missing wrapper scope, rerun the connection check if a read/option scope changed, and rerun unresolved live work without manually advancing checkpoints.

Update `README.md` to name the wrapper boundary and link the same pilot runbook. Remove the stale statement that activation is blocked on unverified Albi update and association contracts.

- [ ] **Step 4: Reconcile fixture metadata with the final implementation**

Check every `contractMetadata.albi.methods` entry against the final client. For each supported operation, record exact wrapper method, company-scoped path, pagination, fixture reference, required static scope, and whether it is safe to retry. Keep unsupported update/association entries explicit with `handledThrough: "conflict_review"`.

- [ ] **Step 5: Run the full verification matrix**

Run:

```bash
npm run test:h2a
npm run test:h2a:schema
npm run test:h2a:e2e
npm run build
git diff --check
```

Expected:

- all H2A tests pass;
- all schema contract tests pass without a migration;
- the end-to-end self-test passes without external writes;
- the Vite production build succeeds;
- `git diff --check` prints no errors.

- [ ] **Step 6: Inspect the final diff for security and scope regressions**

Run:

```bash
rg -n "api\.albiware\.com|headers: \{ ApiKey|Write probe inconclusive" netlify/functions/_h2a src/features/hubspotToAlbi docs/hubspot-to-albi-pilot-runbook.md README.md
git status --short
git diff --stat HEAD
```

Expected: the first command returns no stale production, UI, or operator instructions; test fixtures may mention the native boundary only when asserting its absence. `git status` must show only intended task files plus the untouched untracked `_reference/` directory.

- [ ] **Step 7: Commit the runbook and verification contracts**

```bash
git add README.md docs/hubspot-to-albi-pilot-runbook.md tests/h2a/fixtures/metadata.json tests/h2a/frontend-contracts.test.mjs
git commit -m "docs: document Guardian wrapper rollout"
```

- [ ] **Step 8: Review before push and production test**

Review all commits since `aaaecd9`, confirm `_reference/` remains untracked and untouched, and inspect `git diff aaaecd9..HEAD`. Do not push until the implementation review is clean. After push and Netlify deployment, rerun the connection check, confirm Allied company `1319`, confirm mappings, perform a dry run, review Conflicts, and only then activate live sync.
