import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const session = { access_token: 'supabase-session-token' }

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
  const { getH2ASettings, getH2AOverview, getH2AConflicts } = await import('../../src/lib/hubspotToAlbi.js')
  const calls = await captureRequests(async () => {
    await getH2ASettings(session, 'company/a & b')
    await getH2AOverview(session, null)
    await getH2AConflicts(session, 'company/a & b', { limit: 25, cursor: 'next/page==' })
  })

  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.options.method, 'GET')
    assert.equal(call.options.headers.Authorization, 'Bearer supabase-session-token')
    assert.equal(call.options.body, undefined)
  }
  assert.equal(calls[0].url, '/.netlify/functions/h2a-settings?companyId=company%2Fa+%26+b')
  assert.equal(calls[1].url, '/.netlify/functions/h2a-overview')
  assert.equal(calls[2].url, '/.netlify/functions/h2a-conflicts?companyId=company%2Fa+%26+b&limit=25&cursor=next%2Fpage%3D%3D')
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

test('client errors never echo response text and use only fixed status or code messages', async () => {
  const { getH2ASettings } = await import('../../src/lib/hubspotToAlbi.js')
  const originalFetch = globalThis.fetch
  const responses = [
    response({ error: 'secret-fragment=abc123' }, { status: 400 }),
    response({ error: 'Invalid conflict cursor.' }, { status: 400 }),
    response({ error: 'Invalid conflict page size.' }, { status: 400 }),
    response({ error: 'Invalid option mapping source.' }, { status: 400 }),
    response({ error: 'Invalid option mapping.' }, { status: 400 }),
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
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => error.message === 'Invalid conflict cursor.',
    )
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => error.message === 'Invalid conflict page size.',
    )
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => error.message === 'Invalid option mapping source.',
    )
    await assert.rejects(
      () => getH2ASettings(session, 'company-1'),
      error => error.message === 'Invalid option mapping.',
    )
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
