import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { DRY_RUN_REVIEW_TOTAL_FIELDS } from '../../netlify/functions/_h2a/constants.js'
import { DRY_RUN_TOTAL_LABELS, presentDryRunTotals } from '../../src/features/hubspotToAlbi/dryRunTotals.js'

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

test('preflight checklist delegates safe presentation and keeps blockers actionable', async () => {
  const checklist = await source('PreflightChecklist.jsx')
  assert.match(checklist, /details\?\.missing/)
  assert.match(checklist, /details\?\.hubspot\?\.checks/)
  assert.match(checklist, /details\?\.albi\?\.checks/)
  assert.match(checklist, /Run connection check/)
  assert.match(checklist, /role="alert"/)
  assert.match(checklist, /presentPreflightCheck/)
  assert.match(checklist, /presentAuthorizedCompany/)
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

test('confirmed fallback and unsaved mapping drafts remain semantically distinct', async () => {
  const mappings = await source('OptionMappingForm.jsx')
  assert.match(mappings, /confirmationStatus === 'confirmed'/)
  assert.match(mappings, /Confirmed fallback/)
  assert.match(mappings, /Proposed fallback \(not saved\)/)
  assert.match(mappings, /Unsaved mapping changes/)
  assert.match(mappings, /confirmationStatus === 'confirmed'[^?]*\? 'Unsaved mapping changes/)
  assert.match(mappings, /Complete every required mapping and save to confirm this setup/)
  assert.match(mappings, /resetKey/)
  assert.match(mappings, /\}, \[resetKey\]\)/)
  assert.doesNotMatch(mappings, /Fallback contact type:[\s\S]{0,180}border-green-500/)
})

test('mapping confirmation status is associated and announced for keyboard and screen-reader users', async () => {
  const mappings = await source('OptionMappingForm.jsx')
  assert.match(mappings, /id=\{`h2a-map-\$\{row\.key\}-status`\}/)
  assert.match(mappings, /aria-describedby=\{`h2a-map-\$\{row\.key\}-help h2a-map-\$\{row\.key\}-status`\}/)
  assert.match(mappings, /aria-live="polite"/)
  assert.match(mappings, /suggestions confirmed/)
  assert.match(mappings, /Contact type for \{organization\.label\}/)
  assert.match(mappings, /Organization type/)
  assert.match(mappings, /Contact type/)
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
  assert.match(page, /Open Overview/)
  assert.match(page, /to="\/hubspot-to-albi"/)
  assert.match(page, /aria-live="polite"/)
  assert.match(page, /role="alert"/)
})

test('completed dry-run review renders only fixed, validated outcome totals', async () => {
  const [page, totals] = await Promise.all([source('SettingsPage.jsx'), source('dryRunTotals.js')])
  assert.match(page, /presentDryRunTotals\(settings\?\.lastCompletedDryRun\?\.totals\)/)
  assert.match(totals, /DRY_RUN_TOTAL_LABELS/)
  assert.match(totals, /Number\.isSafeInteger/)
  assert.match(totals, /value > 0/)
  assert.match(page, /completed dry-run totals shown/)
  assert.doesNotMatch(page, /\['dry_run', 'Items previewed'\]/)
  assert.doesNotMatch(page, /\['created', 'Would create'\]/)
  assert.doesNotMatch(page, /Object\.entries\(settings\?\.lastCompletedDryRun\?\.totals/)
})

test('review labels match the server projection and preserve nonzero proposed-action counts', () => {
  assert.deepEqual(DRY_RUN_TOTAL_LABELS.map(([field]) => field), DRY_RUN_REVIEW_TOTAL_FIELDS)
  assert.deepEqual(presentDryRunTotals({
    would_create_organizations: 2,
    would_create_contacts: 3,
    would_link: 4,
    would_deliver_activities: 5,
    requires_review: 1,
    skipped: 0,
    provider_error: 'private detail',
  }), [
    { key: 'would_create_organizations', label: 'Would create organizations', value: 2 },
    { key: 'would_create_contacts', label: 'Would create contacts', value: 3 },
    { key: 'would_link', label: 'Would link existing records', value: 4 },
    { key: 'would_deliver_activities', label: 'Would deliver activities', value: 5 },
    { key: 'requires_review', label: 'Needs review', value: 1 },
  ])
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

test('readiness refresh preserves the mounted form and activation explicitly confirms review', async () => {
  const page = await source('SettingsPage.jsx')
  assert.match(page, /refreshReadiness/)
  assert.match(page, /busyAction === 'readiness-refresh'/)
  assert.match(page, /aria-busy=/)
  assert.doesNotMatch(page, /setReloadToken/)
  assert.match(page, /I reviewed this completed dry run/)
  assert.match(page, /activating confirms/i)
  assert.match(page, /detailed per-record review is not available yet/i)
})
