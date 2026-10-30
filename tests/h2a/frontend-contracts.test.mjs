import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const session = { access_token: 'supabase-session-token' }

test('resolution client sends the exact tenant decision body and preserves request ID across retries', async () => {
  const { getH2ADryRunReviewResolution, resolveH2ADryRunReview } = await import('../../src/lib/hubspotToAlbi.js')
  const input = { reviewId: '00000000-0000-4000-8000-000000000001', expectedUpdatedAt: '2026-10-12T12:00:00Z',
    clientRequestId: '00000000-0000-4000-8000-000000000002', action: 'link_existing', candidateId: '2590478', approveManyToOne: false }
  const signal = new AbortController().signal
  const calls = await captureRequests(async () => {
    await getH2ADryRunReviewResolution(session, 'company-1', input.reviewId, { signal })
    await resolveH2ADryRunReview(session, 'company-1', input, { signal })
    await resolveH2ADryRunReview(session, 'company-1', input, { signal })
    for (const extra of [{ sourceSnapshot: { email: 'SECRET' } }, { url: 'https://evil.test' }, { sourceId: '34' }, { companyId: 'attacker' }]) {
      await assert.rejects(async () => resolveH2ADryRunReview(session, 'company-1', { ...input, ...extra }), TypeError)
    }
  })
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, '/.netlify/functions/h2a-dry-run-review-resolutions?companyId=company-1&reviewId=00000000-0000-4000-8000-000000000001')
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer supabase-session-token')
    assert.equal(call.options.signal, signal)
  }
  for (const call of calls.slice(1)) {
    assert.equal(call.url, '/.netlify/functions/h2a-dry-run-review-resolutions')
    assert.deepEqual(JSON.parse(call.options.body), { ...input, companyId: 'company-1' })
  }
})

test('resolution errors expose fixed actionable copy and never expose provider details', async () => {
  const { getH2ADryRunReviewResolution } = await import('../../src/lib/hubspotToAlbi.js')
  const originalFetch = globalThis.fetch
  try {
    for (const message of ['Invalid resolution request.', 'Invalid resolution decision.', 'Review resolution is unavailable.',
      'Super administrator access is required.', 'This sample review changed. Refresh and confirm the resolution again.', 'Unable to resolve this sample review.',
      'This record changed. Refresh and confirm the resolution again.']) {
      globalThis.fetch = async () => response({ error: message }, { status: 409 })
      await assert.rejects(() => getH2ADryRunReviewResolution(session, 'company-1', '00000000-0000-4000-8000-000000000001'), error => error.message === message)
    }
    globalThis.fetch = async () => response({ error: 'provider credential SECRET' }, { status: 500 })
    await assert.rejects(() => getH2ADryRunReviewResolution(session, 'company-1', '00000000-0000-4000-8000-000000000001'),
      error => error.message === 'HubSpot to Albi is temporarily unavailable. Try again.')
  } finally { globalThis.fetch = originalFetch }
})

test('a gateway timeout page becomes plain copy that says the work may still finish', async () => {
  const { recheckH2ADryRunReview } = await import('../../src/lib/hubspotToAlbi.js')
  const originalFetch = globalThis.fetch
  try {
    for (const status of [200, 500, 502, 504]) {
      globalThis.fetch = async () => response('<HTML><HEAD><TITLE>Inactivity Timeout</TITLE></HEAD><BODY>Too much time</BODY>', { status, contentType: 'text/html' })
      await assert.rejects(() => recheckH2ADryRunReview(session, 'company-1', { reviewId: '00000000-0000-4000-8000-000000000001', expectedUpdatedAt: '2026-10-12T12:00:00Z' }),
        error => error.message === 'This took too long to answer, but it may still finish. Wait a moment, then reload the record.' && error.timedOut === true)
    }
  } finally { globalThis.fetch = originalFetch }
})

function response(body, { status = 200, contentType = 'application/json' } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  })
}

async function captureRequests(run, reply = {}) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return response(reply)
  }
  try {
    await run()
    return calls
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('read requests authenticate and strictly encode optional tenant query values', async () => {
  const { getH2ASettings, getH2AOverview, getH2AConflicts, getH2AConflict } = await import('../../src/lib/hubspotToAlbi.js')
  const calls = await captureRequests(async () => {
    await getH2ASettings(session, 'company/a & b')
    await getH2AOverview(session, null)
    await getH2AConflicts(session, 'company/a & b', { limit: 25, cursor: 'next/page==' })
    await getH2AConflict(session, 'company/a & b', 'conflict/7')
  })

  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(call.options.method, 'GET')
    assert.equal(call.options.headers.Authorization, 'Bearer supabase-session-token')
    assert.equal(call.options.body, undefined)
  }
  assert.equal(calls[0].url, '/.netlify/functions/h2a-settings?companyId=company%2Fa+%26+b')
  assert.equal(calls[1].url, '/.netlify/functions/h2a-overview')
  assert.equal(calls[2].url, '/.netlify/functions/h2a-conflicts?companyId=company%2Fa+%26+b&limit=25&cursor=next%2Fpage%3D%3D')
  assert.equal(calls[3].url, '/.netlify/functions/h2a-conflicts?companyId=company%2Fa+%26+b&conflictId=conflict%2F7')
})

test('mutating requests carry the bearer token and selected company in JSON only', async () => {
  const {
    saveH2ASettings,
    runH2APreflight,
    runH2ASync,
    resolveH2AConflict,
  } = await import('../../src/lib/hubspotToAlbi.js')
  const calls = await captureRequests(async () => {
    await saveH2ASettings(session, 'company-1', { action: 'save_start_date', startDate: '2026-10-01' })
    await runH2APreflight(session, 'company-1')
    await runH2ASync(session, 'company-1', 'dry_run')
    await resolveH2AConflict(session, 'company-1', {
      conflictId: 'conflict-1', expectedUpdatedAt: '2026-10-05T12:00:00.000Z', action: 'skip_item',
    })
  })

  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [
    ['/.netlify/functions/h2a-settings', 'PUT'],
    ['/.netlify/functions/h2a-preflight', 'POST'],
    ['/.netlify/functions/h2a-run', 'POST'],
    ['/.netlify/functions/h2a-conflict-resolve', 'POST'],
  ])
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer supabase-session-token')
    assert.equal(call.options.headers['Content-Type'], 'application/json')
    assert.equal(call.url.includes('company-1'), false)
    assert.equal(JSON.parse(call.options.body).companyId, 'company-1')
  }
})

test('activity estimate is an authenticated read-only operation with no credential surface', async () => {
  const { estimateH2AActivities } = await import('../../src/lib/hubspotToAlbi.js')
  const [call] = await captureRequests(() => estimateH2AActivities(session, 'company-1', '2026-09-01'))

  assert.equal(call.url, '/.netlify/functions/h2a-estimate')
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.headers.Authorization, 'Bearer supabase-session-token')
  assert.deepEqual(JSON.parse(call.options.body), { companyId: 'company-1', startDate: '2026-09-01' })
  assert.equal(call.options.body.includes('credential'), false)
  assert.equal(call.options.body.includes('token'), false)
})

test('client sends an explicit bounded sample scope without exposing a record-count override', async () => {
  const { runH2ASync } = await import('../../src/lib/hubspotToAlbi.js')
  const [call] = await captureRequests(() => runH2ASync(session, 'company-1', 'dry_run', { dryRunScope: 'sample' }))

  assert.deepEqual(JSON.parse(call.options.body), {
    companyId: 'company-1', mode: 'dry_run', dryRunScope: 'sample',
  })
  assert.equal(call.options.body.includes('limit'), false)
})

test('sample review client allowlists list filters and sends exact detail and recheck shapes', async () => {
  const { getH2AReviews, getH2ADryRunReview, recheckH2ADryRunReview } = await import('../../src/lib/hubspotToAlbi.js')
  const signal = new AbortController().signal
  const calls = await captureRequests(async () => {
    await getH2AReviews(session, 'company-1', {
      limit: 25, status: 'needs_review', objectType: 'contacts', reason: 'name_only_candidate',
      signal, unknown: 'must-not-serialize', companyId: 'attacker-company',
    })
    await getH2ADryRunReview(session, 'company-1', '00000000-0000-4000-8000-000000000001', { signal })
    await recheckH2ADryRunReview(session, 'company-1', {
      reviewId: '00000000-0000-4000-8000-000000000001',
      expectedUpdatedAt: '2026-10-12T12:00:00.000Z',
      unexpected: 'must-not-send', companyId: 'attacker-company',
    }, { signal })
  })

  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, '/.netlify/functions/h2a-dry-run-reviews?companyId=company-1&limit=25&status=needs_review&objectType=contacts&reason=name_only_candidate')
  assert.equal(calls[1].url, '/.netlify/functions/h2a-dry-run-reviews?companyId=company-1&reviewId=00000000-0000-4000-8000-000000000001')
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer supabase-session-token')
    assert.equal(call.options.signal, signal)
  }
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    companyId: 'company-1', reviewId: '00000000-0000-4000-8000-000000000001',
    expectedUpdatedAt: '2026-10-12T12:00:00.000Z',
  })
})

test('sample review server errors are fixed-copy allowlisted and unknown text stays generic', async () => {
  const { getH2AReviews } = await import('../../src/lib/hubspotToAlbi.js')
  const safeEndpointErrors = [
    'Invalid sample review cursor.',
    'Invalid sample review request.',
    'Sample review page size must be between 1 and 100.',
    'Unsupported sample review filters.',
    'Sample review item not found.',
    'This sample review changed. Refresh it before rechecking.',
    'This sample review is no longer current. Refresh before rechecking.',
    'Run a new sample to create detailed review data.',
    'Unable to recheck this sample review.',
    'Unable to load sample reviews.',
    'Authentication required.',
    'Invalid authentication token.',
    'Administrator access is required.',
    'You are not authorized to access H2A.',
    'You are not authorized to access the requested company.',
    'A company must be selected.',
    'Company not found.',
  ]
  const originalFetch = globalThis.fetch
  const responses = [
    ...safeEndpointErrors.map(error => response({ error }, { status: error === 'Company not found.' || error === 'Sample review item not found.' ? 404 : 400 })),
    response({ error: 'database secret details' }, { status: 400 }),
    response({ error: 'provider secret details' }, { status: 500 }),
  ]
  globalThis.fetch = async () => responses.shift()
  try {
    for (const message of safeEndpointErrors) {
      await assert.rejects(() => getH2AReviews(session, 'company-1'), error => error.message === message)
    }
    await assert.rejects(() => getH2AReviews(session, 'company-1'), error =>
      error.message === 'HubSpot to Albi request could not be completed.')
    await assert.rejects(() => getH2AReviews(session, 'company-1'), error =>
      error.message === 'HubSpot to Albi is temporarily unavailable. Try again.')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('client exposes actionable fixed endpoint errors and keeps unknown text generic', async () => {
  const { getH2ASettings } = await import('../../src/lib/hubspotToAlbi.js')
  const originalFetch = globalThis.fetch
  const safeEndpointErrors = [
    ['Invalid conflict cursor.', 'Invalid conflict cursor.', 400],
    ['A completed dry run is required before live activation.', 'A completed dry run is required before live activation.', 409],
    ['Run a fresh sample with no underlying review items before running the full dry run.', 'Run a fresh sample with no underlying review items before running the full dry run.', 409],
    ['Invalid conflict page size.', 'Invalid conflict page size.'],
    ['Invalid overview cursor.', 'Invalid overview cursor.'],
    ['Invalid overview page size.', 'Invalid overview page size.'],
    ['Overview page size must be between 1 and 100.', 'Overview page size must be between 1 and 100.'],
    ['Conflict page size must be between 1 and 100.', 'Conflict page size must be between 1 and 100.'],
    ['Invalid option mapping.', 'Invalid option mapping.'],
    ['Invalid conflict resolution payload.', 'Invalid conflict resolution payload.'],
    ['Unsupported conflict action.', 'Unsupported conflict action.'],
    ['Linking requires an explicit target ID.', 'Linking requires an explicit target ID.'],
    ['Invalid sync mode.', 'Invalid sync mode.'],
    ['Unsupported settings action.', 'Unsupported settings action.'],
    ['Unsupported request fields.', 'Unsupported request fields.'],
    ['Resolution was saved; its targeted resume remains pending for retry.', 'Resolution was saved; its targeted resume remains pending for retry.', 502],
    ['Invalid option mapping source.', 'Invalid option mapping source.'],
    ['Complete option mappings are required.', 'Complete option mappings are required.'],
    ['Confirm contact and organization defaults and every activity type.', 'Confirm contact and organization defaults and every activity type.'],
    ['Option mappings must use IDs from the latest tenant preflight options.', 'Option mappings must use IDs from the latest tenant preflight options.'],
    ['The initial start date is fixed and cannot move forward.', 'The initial start date is fixed and cannot move forward.', 409],
    ['Use request_earlier_backfill for an earlier date.', 'Use request_earlier_backfill for an earlier date.', 409],
    ['This conflict changed or is no longer open. Refresh it before resolving.', 'This conflict changed or is no longer open. Refresh it before resolving.', 409],
    ['This conflict is no longer open.', 'This conflict is no longer open.', 409],
    ['Conflict not found.', 'Conflict not found.', 404],
    ['This target is already mapped. Explicit many-to-one approval is required.', 'This target is already mapped. Explicit many-to-one approval is required.', 409],
    ['This source is already mapped to a different target.', 'This source is already mapped to a different target.', 409],
    ['This conflict cannot use that resolution action.', 'This conflict cannot use that resolution action.', 409],
    ['Unsupported conflict resolution fields.', 'Unsupported conflict resolution fields.'],
    ['Select valid fields for this conflict action.', 'Select valid fields for this conflict action.'],
    ['A conflict resolution is required.', 'A conflict resolution is required.'],
    ['A conflict ID is required.', 'A conflict ID is required.'],
    ['Invalid request body.', 'Invalid request body.'],
    ['Unsupported query parameters.', 'Unsupported query parameters.'],
    ['A settings action is required.', 'A settings action is required.'],
    ['A valid company is required.', 'A valid company is required.'],
    ['Unsupported settings fields.', 'Unsupported settings fields.'],
    ['Start date must be a valid YYYY-MM-DD date no later than today.', 'Start date must be a valid YYYY-MM-DD date no later than today.'],
    ['H2A settings are changing. Run preflight again shortly.', 'H2A settings are changing. Run preflight again shortly.', 409],
    ['Save H2A credentials in Settings before running preflight.', 'Save H2A credentials in Settings before running preflight.', 409],
  ]
  const responses = [
    response({ error: 'secret-fragment=abc123' }, { status: 400 }),
    ...safeEndpointErrors.map(([error, , status = 400]) => response({ error }, { status })),
    response({ error: 'Invalid conflict cursor. secret-fragment=abc123' }, { status: 400 }),
    response({ error: 'db error details', code: 'INVALID_CONFLICT_CURSOR' }, { status: 400 }),
    response({ error: 'leaked error text', code: 'secret-fragment=abc123' }, { status: 400 }),
    response({ error: 'secret-fragment=abc123' }, { status: 403 }),
  ]
  globalThis.fetch = async () => responses.shift()
  try {
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => {
        assert.equal(error.status, 400)
        assert.ok(error.message.length <= 240)
        assert.equal(error.message, 'HubSpot to Albi request could not be completed.')
        assert.equal(error.message.includes('abc123'), false)
        return true
      },
    )
    for (const [serverMessage, expectedMessage] of safeEndpointErrors) {
      await assert.rejects(
        () => getH2ASettings(session, 'company-1'),
        error => error.message === expectedMessage,
        `expected exact allowlist match for ${serverMessage}`,
      )
    }
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => error.message === 'HubSpot to Albi request could not be completed.',
    )
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => error.message === 'Invalid conflict cursor.',
    )
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => error.message === 'HubSpot to Albi request could not be completed.',
    )
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => error.message === 'You do not have permission to perform this action.',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('super-admin company options use the narrow authenticated H2A endpoint', async () => {
  const { getH2ACompanyOptions } = await import('../../src/lib/hubspotToAlbi.js')
  const calls = await captureRequests(async () => {
    const companies = await getH2ACompanyOptions(session)
    assert.deepEqual(companies, [
      { id: 'company-a', name: 'Alpha' },
      { id: 'company-b', name: 'Beta' },
    ])
  }, { companies: [
    { id: 'company-a', name: 'Alpha', email: 'must-not-escape@example.com' },
    { id: 'company-b', name: 'Beta' },
  ] })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/.netlify/functions/h2a-companies')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer supabase-session-token')
})

test('all module routes stay under ProtectedRoute and pass role context through the outlet', async () => {
  const [app, layout, selector, shell] = await Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/features/hubspotToAlbi/HubSpotToAlbiLayout.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/features/hubspotToAlbi/CompanySelector.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/AppShell.jsx', import.meta.url), 'utf8'),
  ])

  assert.match(app, /path=["']\/hubspot-to-albi["']/)
  assert.match(app, /<ProtectedRoute[^>]*>[\s\S]*?<HubSpotToAlbiLayout/)
  assert.match(app, /<Route\s+index/)
  assert.match(app, /path=["']conflicts["']/)
  assert.match(app, /path=["']settings["']/)
  assert.match(app, /import SampleReviewPage from '.\/features\/hubspotToAlbi\/SampleReviewPage'/)
  assert.match(app, /path="sample-review"[\s\S]*?<AdminRoute[^>]*>[\s\S]*?<SampleReviewPage\s*\/>[\s\S]*?<\/AdminRoute>/)
  assert.match(layout, /to: '\/hubspot-to-albi\/sample-review', label: 'Sample Review', adminOnly: true/)
  assert.match(layout, /TABS\.filter\(tab => \(!tab\.adminOnly \|\| isAdmin\) && !\(tab\.setupOnly && syncLive\)\)/)
  assert.match(layout, /label: 'Sample Review', adminOnly: true, setupOnly: true/)
  assert.match(layout, /<Outlet[\s\S]*context=/)
  assert.match(layout, /isAdmin/)
  assert.match(layout, /isSuperAdmin/)
  assert.match(layout, /<CompanySelector[\s\S]*isSuperAdmin=/)
  assert.match(selector, /if \(!isSuperAdmin\) return null/)
  assert.match(shell, /<NavLink/)
  assert.match(shell, /HubSpot to Albi/)
  assert.match(layout, /focus-visible:ring-inset/)
  assert.doesNotMatch(layout, /focus-visible:ring-offset/)
  assert.match(shell, /className="[^"]*text-gray-500[^"]*" title=\{companyName\}/)
})

test('ProtectedRoute redirects a signed-out session before waiting for app access', async () => {
  const app = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8')
  const protectedRoute = app.match(/function ProtectedRoute[\s\S]*?\n}/)?.[0]
  assert.ok(protectedRoute)
  assert.ok(
    protectedRoute.indexOf('if (!session)') < protectedRoute.indexOf('hasAppAccess === null'),
    'signed-out users must not wait forever for an app-access query that will never run',
  )
})

test('H2A endpoint paths are centralized in the authenticated client', async () => {
  const client = await readFile(new URL('../../src/lib/hubspotToAlbi.js', import.meta.url), 'utf8')
  assert.equal(client.includes('admin-list-users'), false)
  assert.match(client, /h2a-companies/)

  const companiesEndpoint = await readFile(new URL('../../netlify/functions/h2a-companies.js', import.meta.url), 'utf8')
  assert.match(companiesEndpoint, /from\('super_admins'\)/)
  assert.match(companiesEndpoint, /if \(!superAdmin\) return response\(403/)
  assert.match(companiesEndpoint, /from\('companies'\)[\s\S]*?select\('id, name'\)/)
  assert.doesNotMatch(companiesEndpoint, /auth\.admin\.listUsers|from\('company_members'\)/)

  const sources = await Promise.all([
    '../../src/App.jsx',
    '../../src/components/AppShell.jsx',
    '../../src/features/hubspotToAlbi/HubSpotToAlbiLayout.jsx',
    '../../src/features/hubspotToAlbi/CompanySelector.jsx',
  ].map(async path => [path, await readFile(new URL(path, import.meta.url), 'utf8')]))

  for (const [path, source] of sources) {
    assert.equal(source.includes('/.netlify/functions/h2a-'), false, `${path} bypasses the centralized H2A client`)
  }
})

test('review workspace client functions hit the right path and method with allowlisted bodies', async () => {
  const lib = await import('../../src/lib/hubspotToAlbi.js')
  const signal = new AbortController().signal
  const reviewId = '00000000-0000-4000-8000-000000000001'
  const otherId = '00000000-0000-4000-8000-000000000003'
  const clientRequestId = '00000000-0000-4000-8000-000000000002'
  const expectedUpdatedAt = '2026-10-12T12:00:00.000Z'
  assert.equal(lib['getH2ADryRun' + 'Reviews'], undefined, 'the old alias is gone')
  const calls = await captureRequests(async () => {
    await lib.getH2AReviews(session, 'company-1', { kind: 'live', bucket: 'quick', status: 'needs_review', objectType: 'contacts',
      reason: 'no_match', cursor: 'abc', signal, unknown: 'nope', companyId: 'attacker' })
    await lib.getH2AReviews(session, 'company-1')
    await lib.startH2ARecheckAll(session, 'company-1')
    await lib.startH2ARecheckAll(session, 'company-1', { kind: 'live', reviewIds: [reviewId, otherId], signal })
    await lib.getH2ARecheckAll(session, 'company-1', { kind: 'live', signal })
    await lib.bulkLinkH2AReviews(session, 'company-1', [{ reviewId, candidateId: '20', expectedUpdatedAt, clientRequestId, extra: 'drop' }], { signal })
    await lib.createH2AOrganizationThenContact(session, 'company-1', { reviewId, expectedUpdatedAt, clientRequestId, referralSourceId: '5',
      organizationReviewId: otherId, organizationExpectedUpdatedAt: expectedUpdatedAt, sneaky: 'drop' }, { signal })
    await lib.skipH2ALiveReview(session, 'company-1', { reviewId, expectedUpdatedAt, clientRequestId }, { signal })
    await lib.prepareH2ALiveReviews(session, 'company-1', { cursor: 'next', signal })
  })
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [
    ['/.netlify/functions/h2a-dry-run-reviews?companyId=company-1&limit=100&cursor=abc&status=needs_review&objectType=contacts&reason=no_match&kind=live&bucket=quick', 'GET'],
    ['/.netlify/functions/h2a-dry-run-reviews?companyId=company-1&limit=100', 'GET'],
    ['/.netlify/functions/h2a-dry-run-review-recheck-all', 'POST'],
    ['/.netlify/functions/h2a-dry-run-review-recheck-all', 'POST'],
    ['/.netlify/functions/h2a-dry-run-review-recheck-all?companyId=company-1&kind=live', 'GET'],
    ['/.netlify/functions/h2a-dry-run-review-resolutions', 'POST'],
    ['/.netlify/functions/h2a-dry-run-review-resolutions', 'POST'],
    ['/.netlify/functions/h2a-dry-run-review-resolutions', 'POST'],
    ['/.netlify/functions/h2a-conflicts', 'POST'],
  ])
  const bodies = calls.map(call => call.options.body === undefined ? undefined : JSON.parse(call.options.body))
  assert.deepEqual(bodies[2], { kind: 'sample', companyId: 'company-1' })
  assert.deepEqual(bodies[3], { kind: 'live', reviewIds: [reviewId, otherId], companyId: 'company-1' })
  assert.deepEqual(bodies[5], { op: 'bulk_link', items: [{ reviewId, candidateId: '20', expectedUpdatedAt, clientRequestId }], companyId: 'company-1' })
  assert.deepEqual(bodies[6], { op: 'create_with_organization', reviewId, expectedUpdatedAt, clientRequestId, referralSourceId: '5',
    organizationReviewId: otherId, organizationExpectedUpdatedAt: expectedUpdatedAt, companyId: 'company-1' })
  assert.deepEqual(bodies[7], { reviewId, expectedUpdatedAt, clientRequestId, action: 'skip_live', companyId: 'company-1' })
  assert.deepEqual(bodies[8], { op: 'prepare_live_reviews', cursor: 'next', companyId: 'company-1' })
  for (const call of calls) assert.equal(call.options.headers.Authorization, 'Bearer supabase-session-token')
  for (const index of [0, 3, 4, 5, 6, 7, 8]) assert.equal(calls[index].options.signal, signal)
  assert.throws(() => lib.skipH2ALiveReview(session, 'company-1', { reviewId: 'nope', expectedUpdatedAt, clientRequestId }), TypeError)
})

test('review workspace server copy is allowlisted for display', async () => {
  const { prepareH2ALiveReviews, resolveH2AConflict } = await import('../../src/lib/hubspotToAlbi.js')
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => response({ error: 'Resolve this in the review workspace.' }, { status: 409 })
    await assert.rejects(() => resolveH2AConflict(session, 'company-1', { conflictId: 'c' }), error => error.message === 'Resolve this in the review workspace.')
    globalThis.fetch = async () => response({ error: 'Unable to prepare open conflicts for review.' }, { status: 500 })
    await assert.rejects(() => prepareH2ALiveReviews(session, 'company-1'), error => error.message === 'Unable to prepare open conflicts for review.')
  } finally { globalThis.fetch = originalFetch }
})

test('create batch requests use one well-formed query and send only the selection', async () => {
  const lib = await import('../../src/lib/hubspotToAlbi.js')
  const session = { access_token: 'token' }
  const reviewId = '00000000-0000-4000-8000-000000000001'
  const calls = await captureRequests(async () => {
    await lib.getH2ACreateBatch(session, 'company-1', 'live')
    await lib.getH2ACreateBatch(session, 'company-1')
    await lib.startH2ACreateBatch(session, 'company-1', { kind: 'sample', referralSourceId: '5', items: [{ reviewId, expectedUpdatedAt: '2026-10-12T12:00:00.000Z', extra: 'drop' }] })
  })
  assert.deepEqual(calls.map(call => call.url), ['/.netlify/functions/h2a-review-create-batch?companyId=company-1&kind=live',
    '/.netlify/functions/h2a-review-create-batch?companyId=company-1&kind=sample', '/.netlify/functions/h2a-review-create-batch'])
  assert.deepEqual(JSON.parse(calls[2].options.body), { kind: 'sample', referralSourceId: '5',
    items: [{ reviewId, expectedUpdatedAt: '2026-10-12T12:00:00.000Z' }], companyId: 'company-1' })
})
