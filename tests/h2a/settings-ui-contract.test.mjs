import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../src/features/hubspotToAlbi/', import.meta.url)
const source = name => readFile(new URL(name, root), 'utf8')

test('Settings route renders the guided page through the existing protected module layout', async () => {
  const [app, page] = await Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    source('SettingsPage.jsx'),
  ])
  assert.match(app, /import SettingsPage from ['"].\/features\/hubspotToAlbi\/SettingsPage['"]/)
  assert.match(app, /path=["']settings["'][\s\S]*element=\{<SettingsPage\s*\/>\}/)
  assert.match(page, /useOutletContext/)
  for (const client of ['getH2ASettings', 'saveH2ASettings', 'runH2APreflight', 'estimateH2AActivities', 'runH2ASync']) {
    assert.match(page, new RegExp(`\\b${client}\\b`))
  }
  assert.doesNotMatch(page, /\bfetch\s*\(/)
  assert.match(page, /AbortController/)
  assert.match(page, /completeTenantTransition/)
})

test('credential fields keep secrets blank, masked-only, and admin gated', async () => {
  const fields = await source('CredentialFields.jsx')
  assert.match(fields, /type="password"/)
  assert.match(fields, /autoComplete="new-password"/)
  assert.match(fields, /hubspotTokenMask/)
  assert.match(fields, /albiApiKeyMask/)
  assert.match(fields, /Replace credentials/)
  assert.match(fields, /disables sync/i)
  assert.match(fields, /requires another connection check/i)
  assert.match(fields, /disabled=\{[^}]*!isAdmin/)
  assert.doesNotMatch(fields, /value=\{\s*hubspotTokenMask\s*\}|value=\{\s*albiApiKeyMask\s*\}/)
})

test('preflight checklist renders only safe capabilities and actionable missing labels', async () => {
  const checklist = await source('PreflightChecklist.jsx')
  assert.match(checklist, /details\?\.missing/)
  assert.match(checklist, /details\?\.hubspot\?\.checks/)
  assert.match(checklist, /details\?\.albi\?\.checks/)
  assert.match(checklist, /Run connection check/)
  assert.match(checklist, /role="alert"/)
  assert.doesNotMatch(checklist, /JSON\.stringify|\.error\b|raw/i)
})

test('mapping flow preserves the seven required and optional inheritance ID namespaces', async () => {
  const mappings = await source('OptionMappingForm.jsx')
  for (const key of ['default_contact_type', 'default_organization_type', 'meetings', 'calls', 'emails', 'communications', 'notes']) {
    assert.match(mappings, new RegExp(`['"]${key}['"]`))
  }
  assert.match(mappings, /Confirm suggested mappings/)
  assert.match(mappings, /Needs confirmation/)
  assert.match(mappings, /organization_to_contact_type/)
  assert.match(mappings, /organizationTypes/)
  assert.match(mappings, /contactTypes/)
  assert.match(mappings, /Inherit contact type from organization when possible/)
  assert.match(mappings, /fallback/i)
  assert.match(mappings, /7 required mappings/)
})

test('settings runway covers Pacific dates, estimates, notifications, backfill, and completed dry-run activation', async () => {
  const page = await source('SettingsPage.jsx')
  assert.match(page, /midnight America\/Los_Angeles/)
  assert.match(page, /occurrence time/i)
  for (const type of ['meetings', 'calls', 'emails', 'communications', 'notes']) {
    assert.match(page, new RegExp(`['"]${type}['"]`))
  }
  assert.match(page, /Lower-bound estimate/)
  assert.match(page, /notificationRecipients/)
  assert.match(page, /20/)
  assert.match(page, /Company admins are always notified/)
  assert.match(page, /request_earlier_backfill/)
  assert.match(page, /does not move the live cursor/)
  assert.match(page, /dryRunReviewReady/)
  assert.match(page, /Review on Overview/)
  assert.match(page, /to="\/hubspot-to-albi"/)
  assert.match(page, /aria-live="polite"/)
  assert.match(page, /role="alert"/)
})

test('readiness summary states the next safe action and members remain read-only', async () => {
  const page = await source('SettingsPage.jsx')
  for (const label of ['Credentials', 'Connection', 'Start date', 'Mappings', 'Dry run', 'Live']) {
    assert.match(page, new RegExp(`['"]${label}['"]`))
  }
  assert.match(page, /Next safe action/)
  assert.match(page, /read-only/i)
  assert.match(page, /isAdmin/)
  assert.match(page, /disabledReason/)
})
