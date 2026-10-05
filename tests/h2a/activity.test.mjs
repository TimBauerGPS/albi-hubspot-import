import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAlbiActivity, resolveActivityTargets } from '../../netlify/functions/_h2a/activity.js'

test('contact targets suppress organization fallback even when associated companies exist', () => {
  assert.deepEqual(resolveActivityTargets({
    contacts: [{ id: 'hs-1', action: 'link', targetId: 'albi-1' }],
    organizations: [{ id: 'co-1', action: 'link', targetId: 'org-1' }],
  }), {
    targets: [{ type: 'contact', id: 'albi-1', sourceId: 'hs-1' }], conflicts: [],
  })
})

test('emits multiple safe contacts and keeps ambiguous associations as conflicts', () => {
  const result = resolveActivityTargets({ contacts: [
    { id: 'hs-1', action: 'link', targetId: 'albi-1' },
    { id: 'hs-2', action: 'conflict', reason: 'duplicate_candidates' },
    { id: 'hs-3', action: 'link', targetId: 'albi-3' },
  ], organizations: [] })
  assert.deepEqual(result.targets, [
    { type: 'contact', id: 'albi-1', sourceId: 'hs-1' },
    { type: 'contact', id: 'albi-3', sourceId: 'hs-3' },
  ])
  assert.deepEqual(result.conflicts, [{ entityType: 'contact', sourceId: 'hs-2', reason: 'duplicate_candidates' }])
})

test('organization fallback requires zero associated contacts and exactly one safe company', () => {
  assert.deepEqual(resolveActivityTargets({ contacts: [], organizations: [
    { id: 'co-1', action: 'link', targetId: 'org-1' },
  ] }), { targets: [{ type: 'organization', id: 'org-1', sourceId: 'co-1' }], conflicts: [] })
  assert.deepEqual(resolveActivityTargets({ contacts: [], organizations: [
    { id: 'co-1', action: 'link', targetId: 'org-1' },
    { id: 'co-2', action: 'conflict', reason: 'ambiguous' },
  ] }).conflicts, [{ entityType: 'organization', sourceId: 'co-2', reason: 'ambiguous' }])
  assert.equal(resolveActivityTargets({ contacts: [], organizations: [
    { id: 'co-1', action: 'link', targetId: 'org-1' },
    { id: 'co-2', action: 'link', targetId: 'org-2' },
  ] }).targets.length, 0)
  assert.equal(resolveActivityTargets({ contacts: [], organizations: [] }).conflicts[0].reason, 'missing_target')
})

test('builds concise plain text activity with occurrence, owner, title, outcome, and marker', () => {
  const activity = buildAlbiActivity({
    objectType: 'emails', activityId: '123', occurredAt: '2026-10-01T17:21:00.000Z',
    activityTypeId: '6711', ownerName: 'Alex Owner', subject: 'Welcome', outcome: 'Connected',
    body: '<p>Hello&nbsp;🌲 <strong>there</strong></p><script>bad()</script><img src="x">',
    target: { type: 'contact', id: '99' },
  })
  assert.equal(activity.typeId, '6711')
  assert.equal(activity.date, '2026-10-01T17:21:00.000Z')
  assert.match(activity.notes, /Alex Owner/)
  assert.match(activity.notes, /Welcome/)
  assert.match(activity.notes, /Connected/)
  assert.match(activity.notes, /Hello 🌲 there/)
  assert.doesNotMatch(activity.notes, /bad\(\)|img src/)
  assert.match(activity.notes, /Source: HubSpot email 123/)
  assert.equal(activity.contactId, '99')
  assert.equal(activity.organizationId, undefined)
  assert.equal(activity.sourceId, '123')
  assert.equal(activity.source, 'hubspot')
})

test('caps excerpts on Unicode boundaries and excludes email attachments and thread bodies', () => {
  const input = { objectType: 'emails', activityId: '4', occurredAt: '2026-10-01T17:21:00Z',
    activityTypeId: '8', body: '🌲'.repeat(10000), attachments: ['file.pdf'], thread: 'full thread text',
    target: { type: 'organization', id: '3' }, maxExcerptLength: 20 }
  const result = buildAlbiActivity(input)
  assert.ok([...result.notes].length < 200)
  assert.ok(!result.notes.includes('\uFFFD'))
  assert.equal(result.organizationId, '3')
  assert.equal(result.contactId, undefined)
  assert.doesNotMatch(result.notes, /thread|file\.pdf/)
})

test('rejects bulk marketing email activities and unsupported object types', () => {
  for (const data of [
    { objectType: 'emails', isBulkMarketing: true },
    { objectType: 'marketing_emails' },
  ]) assert.throws(() => buildAlbiActivity({ ...data, activityId: '1', occurredAt: '2026-10-01T00:00:00Z',
    activityTypeId: '2', target: { type: 'contact', id: '3' } }))
})
