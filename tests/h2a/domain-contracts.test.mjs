import assert from 'node:assert/strict'
import test from 'node:test'

import { H2A_STATES, HUBSPOT_ACTIVITY_TYPES } from '../../netlify/functions/_h2a/constants.js'
import { makeDeliveryKey, makeSourceMarker } from '../../netlify/functions/_h2a/keys.js'
import { isDailyRunDue, pacificBusinessDate, pacificStartOfDate } from '../../netlify/functions/_h2a/time.js'

test('exports the supported sync states and HubSpot activity types', () => {
  assert.deepEqual(H2A_STATES, ['disabled', 'ready', 'dry_run', 'live'])
  assert.deepEqual(HUBSPOT_ACTIVITY_TYPES, ['meetings', 'calls', 'emails', 'communications', 'notes'])
})

test('builds a delivery key from all six identity components', () => {
  assert.equal(makeDeliveryKey({
    companyId: 'company-1', portalId: 'portal-1', objectType: 'emails',
    activityId: '42', albiTargetType: 'contact', albiTargetId: '99',
  }), 'company-1:portal-1:emails:42:contact:99')
})

test('rejects a delivery key with a missing identity component', () => {
  assert.throws(() => makeDeliveryKey({
    companyId: 'company-1', portalId: 'portal-1', objectType: 'emails',
    activityId: '42', albiTargetType: 'contact',
  }), /missing/i)
})

test('marks a source activity with its HubSpot type and identifier', () => {
  assert.equal(makeSourceMarker({ objectType: 'email', activityId: '42' }), 'Source: HubSpot email 42')
})

test('resolves Pacific midnight with the correct daylight saving offset', () => {
  assert.equal(pacificStartOfDate('2026-03-08'), '2026-03-08T08:00:00.000Z')
  assert.equal(pacificStartOfDate('2026-11-01'), '2026-11-01T07:00:00.000Z')
})

test('rejects malformed and impossible calendar dates', () => {
  assert.throws(() => pacificStartOfDate('2026-2-08'), /YYYY-MM-DD/)
  assert.throws(() => pacificStartOfDate('2026-02-29'), /invalid/i)
  assert.throws(() => pacificStartOfDate('2026-13-01'), /invalid/i)
})

test('derives the Pacific business date on both sides of UTC midnight', () => {
  assert.equal(pacificBusinessDate('2026-04-15T06:59:00.000Z'), '2026-04-14')
  assert.equal(pacificBusinessDate('2026-04-15T07:00:00.000Z'), '2026-04-15')
})

test('runs at the normal Pacific 2:00 a.m. tick, but not before it', () => {
  assert.deepEqual(isDailyRunDue({ now: '2026-04-15T08:59:00.000Z' }), {
    due: false, businessDate: '2026-04-15',
  })
  assert.deepEqual(isDailyRunDue({ now: '2026-04-15T09:00:00.000Z' }), {
    due: true, businessDate: '2026-04-15',
  })
})

test('runs at the first spring-forward tick, 3:00 a.m. Pacific', () => {
  assert.deepEqual(isDailyRunDue({ now: '2026-03-08T10:00:00.000Z' }), {
    due: true, businessDate: '2026-03-08',
  })
})

test('does not run again after a claim for the same Pacific business date', () => {
  assert.deepEqual(isDailyRunDue({
    now: '2026-04-15T10:00:00.000Z', claimedBusinessDate: '2026-04-15',
  }), { due: false, businessDate: '2026-04-15' })
})

test('rejects invalid scheduler time values', () => {
  assert.throws(() => isDailyRunDue({ now: 'not-a-date' }), /invalid/i)
  assert.throws(() => isDailyRunDue({ now: new Date(Number.NaN) }), /invalid/i)
})

test('accepts date-only ISO strings and rejects non-ISO or timezone-free timestamps', () => {
  assert.equal(pacificBusinessDate('2026-04-15'), '2026-04-14')
  assert.throws(() => pacificBusinessDate('04/15/2026'), /ISO/i)
  assert.throws(() => pacificBusinessDate('2026-04-15T09:00:00'), /ISO/i)
})
