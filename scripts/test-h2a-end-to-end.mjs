#!/usr/bin/env node
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { AlbiClient } from '../netlify/functions/_h2a/albiClient.js'
import { buildAlbiActivity } from '../netlify/functions/_h2a/activity.js'
import { HUBSPOT_ACTIVITY_TYPES } from '../netlify/functions/_h2a/constants.js'
import { completeDelivery, reserveDelivery } from '../netlify/functions/_h2a/deliveries.js'
import { HubSpotClient } from '../netlify/functions/_h2a/hubspotClient.js'
import { makeDeliveryKey, makeSourceMarker } from '../netlify/functions/_h2a/keys.js'

const ISOLATION_ACK = 'I_CONFIRM_THIS_IS_AN_ISOLATED_ALBI_SANDBOX'
const ACTIVITY_CONTRACT_ACK = 'I_VERIFIED_ALBI_ACTIVITY_MARKER_READBACK'
const REQUIRED_PROVIDER_CREDENTIALS = ['H2A_TEST_HUBSPOT_TOKEN', 'H2A_TEST_ALBI_KEY']
const OVERRIDE_VARS = ['H2A_TEST_HUBSPOT_BASE_URL', 'H2A_TEST_ALBI_BASE_URL']
const REQUIRED_WRITE_CAPABILITIES = [
  'contacts_create', 'organizations_create', 'activities_create',
  'contacts_update', 'organizations_update', 'contacts_associate_organization',
]
const cleanId = value => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-4).padStart(4, '*')
const output = message => process.stdout.write(`${message}\n`)

export function missingSmokeEnvironment(env = process.env) {
  return REQUIRED_PROVIDER_CREDENTIALS.filter(name => typeof env[name] !== 'string' || !env[name].trim())
}

export function smokeWriteBlockers(env = process.env, capabilities = null) {
  const blockers = []
  if (env.H2A_ALLOW_SANDBOX_WRITES !== 'true') blockers.push('H2A_ALLOW_SANDBOX_WRITES=true is required')
  if (env.H2A_SANDBOX_ISOLATION_ACK !== ISOLATION_ACK) blockers.push(`H2A_SANDBOX_ISOLATION_ACK=${ISOLATION_ACK} is required`)
  if (env.H2A_ALBI_ACTIVITY_CONTRACT_ACK !== ACTIVITY_CONTRACT_ACK) blockers.push(`H2A_ALBI_ACTIVITY_CONTRACT_ACK=${ACTIVITY_CONTRACT_ACK} is required after sandbox marker-readback verification`)
  if (!/^[A-Za-z0-9_-]{4,48}$/.test(env.H2A_SMOKE_RUN_ID ?? '')) blockers.push('H2A_SMOKE_RUN_ID with 4–48 letters, digits, underscores, or hyphens is required for repeatable records')
  for (const name of OVERRIDE_VARS) {
    if (env[name]) blockers.push(`${name} is unsupported; the production adapters use fixed official API hosts`)
  }
  if (capabilities) {
    for (const name of REQUIRED_WRITE_CAPABILITIES) {
      if (capabilities[name] !== true) blockers.push(`Albi capability is not verified: ${name}`)
    }
  }
  return blockers
}

function exactMarkerMatches(records, marker) {
  return records.filter(record => String(record?.notes ?? '').split(/\r?\n/u).some(line => line.trim() === marker))
}

async function collectPages(readPage, label, maximum = 100) {
  const records = []
  let cursor = '1'
  for (let pageCount = 0; pageCount < maximum; pageCount++) {
    const result = await readPage(cursor)
    if (!result || !Array.isArray(result.records)) throw new Error(`Invalid ${label} response shape.`)
    records.push(...result.records)
    if (result.cursor == null) return records
    if (!/^\d+$/.test(result.cursor) || Number(result.cursor) <= Number(cursor)) throw new Error(`Invalid ${label} pagination contract.`)
    cursor = result.cursor
  }
  throw new Error(`${label} exceeded the bounded page limit.`)
}

function makeEphemeralDeliveryStore(existing = null) {
  const rows = new Map()
  if (existing) rows.set(existing.key, { id: 'local-smoke-delivery', state: 'reserved', attempt_count: 1,
    last_attempt_at: new Date(0).toISOString(), next_attempt_at: null })
  return {
    async reserve({ key, now }) {
      let row = rows.get(key)
      if (!row) {
        row = { id: `local-${rows.size + 1}`, state: 'reserved', attempt_count: 1, last_attempt_at: now, next_attempt_at: null }
        rows.set(key, row)
        return { acquired: true, isNew: true, row }
      }
      if (row.state === 'reserved' && row.last_attempt_at === new Date(0).toISOString()) {
        row = { ...row, attempt_count: row.attempt_count + 1, last_attempt_at: now }
        rows.set(key, row)
        return { acquired: true, isNew: false, previous: { state: 'reserved', last_attempt_at: new Date(0).toISOString(), next_attempt_at: null }, row }
      }
      return { acquired: false, row }
    },
    async transition({ id, expectedVersion, patch }) {
      const entry = [...rows.entries()].find(([, row]) => row.id === id)
      if (!entry || entry[1].state !== 'reserved' || entry[1].attempt_count !== expectedVersion) return { updated: false, row: entry?.[1] }
      const row = { ...entry[1], ...patch }
      rows.set(entry[0], row)
      return { updated: true, row }
    },
  }
}

async function runSelfTest() {
  assert.deepEqual(missingSmokeEnvironment({}), REQUIRED_PROVIDER_CREDENTIALS)
  assert.ok(smokeWriteBlockers({}).some(value => value.startsWith('H2A_ALLOW_SANDBOX_WRITES=')))
  const authorized = {
    H2A_ALLOW_SANDBOX_WRITES: 'true',
    H2A_SANDBOX_ISOLATION_ACK: ISOLATION_ACK,
    H2A_ALBI_ACTIVITY_CONTRACT_ACK: ACTIVITY_CONTRACT_ACK,
    H2A_SMOKE_RUN_ID: 'self-test-01',
  }
  assert.deepEqual(smokeWriteBlockers(authorized, Object.fromEntries(REQUIRED_WRITE_CAPABILITIES.map(name => [name, true]))), [])
  assert.ok(smokeWriteBlockers({ ...authorized, H2A_TEST_ALBI_BASE_URL: 'https://api.albiware.com' }).length)
  assert.equal(cleanId('123456789'), '6789')
  const marker = makeSourceMarker({ objectType: 'meeting', activityId: 'self-test-01' })
  assert.equal(exactMarkerMatches([{ notes: `Subject: Smoke\n${marker}` }, { notes: `prefix ${marker}` }], marker).length, 1)

  let creates = 0
  const activities = []
  const identity = { companyId: 'sandbox-smoke', portalId: 'portal-test', objectType: 'meetings', activityId: 'self-test-01', albiTargetType: 'contact', albiTargetId: '9001' }
  const store = makeEphemeralDeliveryStore()
  const albi = { async listActivities() { return { records: activities, cursor: null } } }
  const first = await reserveDelivery({ identity, store, albi })
  assert.equal(first.safeToCreate, true)
  activities.push({ id: 'activity-1', notes: marker })
  creates += 1
  await completeDelivery({ reservation: first, store, result: { id: 'activity-1' } })
  const repeat = await reserveDelivery({ identity, store, albi })
  assert.equal(repeat.disposition, 'delivered')
  assert.equal(creates, 1)
  assert.equal(exactMarkerMatches(activities, marker).length, 1)
  const nextInvocationStore = makeEphemeralDeliveryStore({ key: makeDeliveryKey(identity) })
  const crossInvocationRetry = await reserveDelivery({ identity, store: nextInvocationStore, albi })
  assert.equal(crossInvocationRetry.disposition, 'reconciled')
  assert.equal(creates, 1)
  assert.equal(exactMarkerMatches(activities, marker).length, 1)
  output('H2A end-to-end self-test passed: write guards, safe identifier output, exact marker matching, and one-delivery retry behavior.')
}

function makeRunId(env) {
  return env.H2A_SMOKE_RUN_ID || `read-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
}

async function readAndReport(hubspot, albi, runId) {
  const account = await hubspot.getAccountInfo()
  const options = await albi.listOptions()
  const [contacts, organizations, albiActivities] = await Promise.all([
    albi.listContacts({ pageSize: 1 }), albi.listOrganizations({ pageSize: 1 }), albi.listActivities({ page: 1 }),
  ])
  output(`HubSpot account authenticated (portal ending ${cleanId(account.portalId)}).`)
  output(`Albi options loaded: contacts=${options.contactTypes.length}, organizations=${options.organizationTypes.length}, activities=${options.activityTypes.length}.`)
  output(`Albi read shapes passed: contacts=${contacts.records.length ? 'sample available' : 'empty'}, organizations=${organizations.records.length ? 'sample available' : 'empty'}, activities=${albiActivities.records.length ? 'sample available' : 'empty'}.`)

  const lower = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const activityCounts = {}
  const associationChecks = {}
  for (const objectType of HUBSPOT_ACTIVITY_TYPES) {
    const page = await hubspot.listActivities({ objectType, occurredAtGte: lower, limit: 20 })
    activityCounts[objectType] = page.records.length
    const sampleIds = page.records.slice(0, 5).map(record => record.id)
    if (sampleIds.length) {
      const associations = await hubspot.getAssociations({ objectType, objectIds: sampleIds, toObjectTypes: ['contacts', 'companies'] })
      associationChecks[objectType] = associations.length
    } else associationChecks[objectType] = 0
    if (objectType === 'emails') {
      const allowed = page.records.filter(record => record.properties.hs_email_direction === 'EMAIL').length
      const excluded = page.records.length - allowed
      output(`HubSpot direct CRM email contract: records=${page.records.length}, direction EMAIL=${allowed}, other/unknown direction excluded=${excluded}.`)
    }
  }
  output(`HubSpot date-versioned activity reads passed: ${Object.entries(activityCounts).map(([type, count]) => `${type}=${count}`).join(', ')}.`)
  output(`HubSpot association traversal samples: ${Object.entries(associationChecks).map(([type, count]) => `${type}=${count}`).join(', ')}.`)
  output(`Planned isolated record prefix: H2A-SMOKE-${runId}. No provider response bodies or full record identifiers were printed.`)
  return { options, account, activityCounts, associationChecks }
}

async function findUnique(records, predicate, label) {
  const matches = records.filter(predicate)
  if (matches.length > 1) throw new Error(`More than one matching smoke ${label} exists; refusing to guess.`)
  return matches[0] ?? null
}

async function runGuardedWrite(albi, hubspotAccount, options, env, runId) {
  const verification = await albi.verifyCredentials()
  const blockers = smokeWriteBlockers(env, verification.capabilities)
  if (blockers.length) {
    throw new Error(`Sandbox write stopped before the first POST. ${blockers.join('; ')}.`)
  }
  const contractBlockers = []
  if (!options.organizationTypes.length || !options.contactTypes.length || !options.activityTypes.length) contractBlockers.push('required Albi option lists are empty')
  if (!verification.authenticated) contractBlockers.push('Albi read authentication is not valid')
  if (contractBlockers.length) throw new Error(`Sandbox write stopped before the first POST. ${contractBlockers.join('; ')}.`)

  const prefix = `H2A-SMOKE-${runId}`
  const organizationName = `${prefix} Organization`
  const contacts = await collectPages(cursor => albi.listContacts({ cursor, pageSize: 100 }), 'contact list')
  const organizations = await collectPages(cursor => albi.listOrganizations({ cursor, pageSize: 100 }), 'organization list')
  let organization = await findUnique(organizations, record => record?.name === organizationName, 'organization')
  if (!organization) organization = await albi.createOrganization({ name: organizationName, organizationTypeIds: [options.organizationTypes[0].id] })
  const firstName = 'H2A'
  const lastName = `Smoke ${runId}`
  let contact = await findUnique(contacts, record => record?.firstName === firstName && record?.lastName === lastName, 'contact')
  if (contact && String(contact.organizationId ?? '') !== String(organization.id)) {
    throw new Error('The matching smoke contact is linked to a different organization; refusing to change it.')
  }
  if (!contact) contact = await albi.createContact({ firstName, lastName, contactTypeIds: [options.contactTypes[0].id], organizationId: organization.id })
  if (!contact?.id || !organization?.id) throw new Error('Albi create response did not return a record ID; stop and inspect the isolated tenant manually.')

  const activityMarker = makeSourceMarker({ objectType: 'meeting', activityId: `smoke-${runId}` })
  const existingActivities = await collectPages(cursor => albi.listActivities({ contactId: contact.id, page: Number(cursor) }), 'activity list')
  const existing = exactMarkerMatches(existingActivities, activityMarker)
  if (existing.length > 1) throw new Error('Duplicate smoke activity markers already exist; no further write was attempted.')
  const identity = { companyId: `sandbox-${runId}`, portalId: hubspotAccount.portalId, objectType: 'meetings', activityId: `smoke-${runId}`, albiTargetType: 'contact', albiTargetId: contact.id }
  const store = makeEphemeralDeliveryStore(existing[0] ? { key: makeDeliveryKey(identity) } : null)
  const reservation = await reserveDelivery({ identity, store, albi })
  let activityResult = null
  let disposition = reservation.disposition
  if (reservation.safeToCreate === true) {
    const payload = buildAlbiActivity({ objectType: 'meetings', activityId: identity.activityId, occurredAt: new Date().toISOString(),
      activityTypeId: options.activityTypes[0].id, target: { type: 'contact', id: contact.id }, subject: `${prefix} one-time activity` })
    activityResult = await albi.createActivity(payload)
    const completed = await completeDelivery({ reservation, store, result: activityResult })
    disposition = completed.disposition
  }
  const retry = await reserveDelivery({ identity, store, albi })
  if (!['delivered', 'reconciled'].includes(retry.disposition)) throw new Error('Retry did not resolve to one terminal activity delivery.')
  const after = await collectPages(cursor => albi.listActivities({ contactId: contact.id, page: Number(cursor) }), 'activity readback')
  const markerMatches = exactMarkerMatches(after, activityMarker)
  if (markerMatches.length !== 1) throw new Error(`Expected exactly one marker-matched activity after retry; found ${markerMatches.length}.`)
  output(`Guarded Albi smoke write passed: organization …${cleanId(organization.id)}, contact …${cleanId(contact.id)}, activity …${cleanId(activityResult?.id ?? markerMatches[0].id)} (${disposition}; retry=${retry.disposition}; marker matches=${markerMatches.length}).`)
  output('No records were deleted. Manually remove the H2A-SMOKE record set from the isolated Albi tenant after review.')
}

async function main(env = process.env) {
  if (process.argv.includes('--self-test')) return runSelfTest()
  const missing = missingSmokeEnvironment(env)
  if (missing.length) {
    output(`H2A sandbox smoke skipped safely; missing environment variables: ${missing.join(', ')}.`)
    return
  }
  const overrides = OVERRIDE_VARS.filter(name => env[name])
  if (overrides.length) throw new Error(`Refusing unsupported provider URL overrides: ${overrides.join(', ')}.`)
  const runId = makeRunId(env)
  const hubspot = new HubSpotClient({ token: env.H2A_TEST_HUBSPOT_TOKEN })
  const albi = new AlbiClient({ apiKey: env.H2A_TEST_ALBI_KEY })
  const result = await readAndReport(hubspot, albi, runId)
  if (env.H2A_ALLOW_SANDBOX_WRITES !== 'true') {
    output('Read-only mode complete. No provider writes were attempted. Set both documented sandbox acknowledgements and rerun with an isolated Albi sandbox to enable the guarded write path.')
    return
  }
  const blockers = smokeWriteBlockers(env)
  if (blockers.length) throw new Error(`Sandbox write stopped before the first POST. ${blockers.join('; ')}.`)
  await runGuardedWrite(albi, result.account, result.options, env, runId)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    // Only fixed gate messages and adapter-safe errors are allowed here.
    output(`H2A sandbox smoke stopped safely: ${error?.message?.slice(0, 500) ?? 'unknown local failure'}`)
    process.exitCode = 1
  })
}
