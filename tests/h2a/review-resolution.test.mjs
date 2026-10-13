import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { normalizeResolutionDecision, hashResolutionDecision, projectReviewResolution,
  projectReviewResolutionEvent, safeResolutionEventDetails } from '../../netlify/functions/_h2a/reviewResolution.js'

const ID = '00000000-0000-4000-8000-000000000003'
const TIME = '2026-10-13T12:00:00.123456Z'

test('decisions keep exact action-specific fields and sort field choices without mutating input', () => {
  const input = { action: 'resolve_fields', fieldChoices: { phoneNumber: 'hubspot', email: 'albi' } }
  assert.deepEqual(normalizeResolutionDecision(input), {
    action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' },
  })
  assert.deepEqual(Object.keys(input.fieldChoices), ['phoneNumber', 'email'])
  assert.deepEqual(normalizeResolutionDecision({ action: 'link_existing', candidateId: '2590478', approveManyToOne: true }),
    { action: 'link_existing', candidateId: '2590478', approveManyToOne: true })
  assert.deepEqual(normalizeResolutionDecision({ action: 'link_existing', candidateId: '2590478' }),
    { action: 'link_existing', candidateId: '2590478' })
  assert.deepEqual(normalizeResolutionDecision({ action: 'create_albi' }), { action: 'create_albi' })
  assert.deepEqual(normalizeResolutionDecision({ action: 'choose_organization', organizationSourceId: '123', addHubSpotAssociation: false }),
    { action: 'choose_organization', organizationSourceId: '123', addHubSpotAssociation: false })
})

test('decision hash uses canonical sorted JSON and changes when semantic choices change', () => {
  const input = { fieldChoices: { phoneNumber: 'hubspot', email: 'albi' }, action: 'resolve_fields' }
  const expected = createHash('sha256').update('{"action":"resolve_fields","fieldChoices":{"email":"albi","phoneNumber":"hubspot"}}').digest('hex')
  assert.equal(hashResolutionDecision(input), expected)
  assert.equal(hashResolutionDecision({ action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } }), expected)
  assert.notEqual(hashResolutionDecision({ action: 'resolve_fields', fieldChoices: { email: 'hubspot', phoneNumber: 'hubspot' } }), expected)
  assert.equal(hashResolutionDecision({ candidateId: '12', approveManyToOne: false, action: 'link_existing' }),
    createHash('sha256').update('{"action":"link_existing","approveManyToOne":false,"candidateId":"12"}').digest('hex'))
})

test('decision schemas reject provider values, unknown fields, unsafe IDs and malformed flags', () => {
  for (const input of [null, [], 'create_albi', { action: 'delete' }, { action: 'create_albi', apiKey: 'secret' },
    { action: 'resolve_fields' }, { action: 'resolve_fields', fieldChoices: {} },
    { action: 'resolve_fields', fieldChoices: [] }, { action: 'resolve_fields', fieldChoices: { apiKey: 'hubspot' } },
    { action: 'resolve_fields', fieldChoices: { organizationId: 'albi' } },
    { action: 'resolve_fields', fieldChoices: { email: 'ALBI' } },
    { action: 'resolve_fields', fieldChoices: { email: 'albi' }, values: { email: 'injected' } },
    { action: 'link_existing' }, { action: 'link_existing', candidateId: 12 },
    ...['', '0', '-1', '01', ' 12', '12x', '1'.repeat(101)].map(candidateId => ({ action: 'link_existing', candidateId })),
    { action: 'link_existing', candidateId: '12', approveManyToOne: 'true' },
    { action: 'choose_organization', organizationSourceId: 'https://evil.test' },
    { action: 'choose_organization', organizationSourceId: '12', addHubSpotAssociation: 1 },
    JSON.parse('{"action":"create_albi","__proto__":{"apiKey":"secret"}}'),
  ]) assert.throws(() => normalizeResolutionDecision(input), TypeError)
})

test('normalization and hashing reject array actions before field-choice validation can be bypassed', () => {
  for (const input of [
    { action: ['resolve_fields'], fieldChoices: { apiKey: 'hubspot', email: 'arbitrary provider value' } },
    { action: ['create_albi'] },
  ]) {
    assert.throws(() => normalizeResolutionDecision(input), TypeError)
    assert.throws(() => hashResolutionDecision(input), TypeError)
  }
})

test('normalization and hashing reject object actions that coerce to valid action names', () => {
  for (const action of [new String('create_albi'), { toString() { return 'create_albi' } }]) {
    assert.throws(() => normalizeResolutionDecision({ action }), TypeError)
    assert.throws(() => hashResolutionDecision({ action }), TypeError)
  }
})

test('public projection drops array and object actions without invoking their string coercion', () => {
  for (const action of [['create_albi'], ['resolve_fields'], new String('create_albi'),
    { toString() { return 'create_albi' } },
    { toString() { throw new Error('Action coercion must not run') } },
  ]) {
    const projected = projectReviewResolution({ action, decision: { action, fieldChoices: { apiKey: 'secret' } } })
    assert.equal(projected.action, null)
    assert.equal(projected.decision, null)
  }
})

test('public resolution projection drops all internal leases, arbitrary JSON and provider messages', () => {
  const row = { id: ID, company_id: ID, run_id: ID, review_id: ID, portal_id: '123', object_type: 'contacts', source_id: '42',
    action: 'resolve_fields', status: 'waiting_on_albi', expected_review_updated_at: TIME,
    decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot', apiKey: 'secret' }, raw: 'secret' },
    provider_outcome_code: 'authorization_rejected', created_by: ID, created_at: TIME, updated_at: TIME,
    decision_hash: 'secret', client_request_id: ID, lease_owner: ID, lease_expires_at: TIME, execution_phase: 'waiting_on_albi',
    source_snapshot: { email: 'secret' }, raw_response: 'secret', error: 'secret', credentials: 'secret' }
  const event = { id: ID, actor_id: ID, event_type: 'waiting_on_albi', created_at: TIME, raw: 'secret',
    sanitized_details: { code: 'authorization_rejected', category: 'permission', outcome: 'waiting_on_albi',
      manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '2590478', url: 'https://evil.test',
        fields: [{ field: 'phoneNumber', value: '111', raw: 'secret' }, { field: 'apiKey', value: 'secret' }], snapshot: { token: 'secret' } }],
      message: 'secret', providerResponse: { secret: 'secret' }, snapshots: ['secret'], apiKey: 'secret' } }
  const projected = projectReviewResolution(row, [event])
  assert.deepEqual(projected, { id: ID, runId: ID, reviewId: ID, portalId: '123', objectType: 'contacts', sourceId: '42',
    action: 'resolve_fields', status: 'waiting_on_albi', expectedUpdatedAt: TIME,
    decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } },
    providerOutcomeCode: 'authorization_rejected', createdBy: ID, createdAt: TIME, updatedAt: TIME,
    events: [{ id: ID, actorId: ID, eventType: 'waiting_on_albi', createdAt: TIME, details: {
      code: 'authorization_rejected', category: 'permission', outcome: 'waiting_on_albi',
      manualTasks: [{ provider: 'albi', objectType: 'contacts', targetId: '2590478', fields: [{ field: 'phoneNumber', value: '111' }] }],
    } }] })
  assert.equal(JSON.stringify(projected).includes('secret'), false)
  assert.equal(JSON.stringify(projected).includes('lease'), false)
})

test('projection fails closed for unsafe identities and codes and caps manual task details and event history', () => {
  assert.equal(projectReviewResolution(null), null)
  const result = projectReviewResolution({ id: 'raw secret', source_id: 'token', object_type: 'raw', action: 'raw', status: 'raw',
    provider_outcome_code: 'provider_secret', created_at: 'secret', decision: { action: 'create_albi', arbitrary: 'secret' } },
  Array.from({ length: 150 }, () => ({ event_type: 'raw', actor_id: 'secret', sanitized_details: { code: 'provider_secret', message: 'secret' } })))
  assert.equal(result.id, null); assert.equal(result.sourceId, null); assert.equal(result.action, null)
  assert.equal(result.status, null); assert.equal(result.providerOutcomeCode, null); assert.equal(result.createdAt, null)
  assert.equal(result.decision, null); assert.equal(result.events.length, 100)
  assert.deepEqual(result.events[0].details, {})
  const details = safeResolutionEventDetails({ execution_phase: 'waiting_on_albi', code: 'timeout',
    manualTasks: Array.from({ length: 20 }, () => ({ provider: 'albi', objectType: 'contacts', targetId: '1',
      fields: [{ field: 'organizationId', value: '12' }, { field: 'email', value: 'a'.repeat(600) },
        { field: 'city', value: { token: 'secret' } }] })) })
  assert.equal(details.execution_phase, undefined)
  assert.equal(details.manualTasks.length, 10)
  assert.deepEqual(details.manualTasks[0].fields, [{ field: 'organizationId', value: '12' }, { field: 'email', value: 'a'.repeat(500) }])
  assert.deepEqual(projectReviewResolutionEvent({ event_type: 'claimed', sanitized_details: { execution_phase: 'waiting_on_albi' } }).details, {})
})
