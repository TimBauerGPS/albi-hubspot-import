import test from 'node:test'
import assert from 'node:assert/strict'
import { applyAlbiTasks, planAlbiUpdate } from '../../netlify/functions/_h2a/albiUpdates.js'
import { executeReviewResolution, sendWaitingAlbiUpdates } from '../../netlify/functions/_h2a/reviewResolutionService.js'
import { runOutboxItem, normalizeOutboxAction } from '../../netlify/functions/_h2a/outbox.js'
import { ApiError } from '../../netlify/functions/_h2a/http.js'

const stamp = '2026-10-13T12:00:00Z'
const actorId = '00000000-0000-4000-8000-000000000001'
const resolutionId = '00000000-0000-4000-8000-000000000002'
const reviewId = '00000000-0000-4000-8000-000000000003'
const input = { companyId: 'tenant', reviewId, actorId, expectedUpdatedAt: stamp, clientRequestId: '00000000-0000-4000-8000-000000000004' }

test('an Albi task maps review fields onto Albi update fields; what Albi cannot take stays manual', () => {
  const plan = planAlbiUpdate({ objectType: 'contacts', targetId: '20', fields: [{ field: 'phoneNumber', value: '(555) 111-2222' },
    { field: 'zipcode', value: '98101' }, { field: 'mobileNumber', value: '5553334444' }, { field: 'city', value: '' }, { field: 'organizationId', value: '50' }] })
  assert.equal(plan.operation, 'updateContact')
  assert.deepEqual(plan.payload, { phoneNumber: '555-111-2222', zipCode: '98101', organizationId: '50' })
  assert.deepEqual(plan.manual.map(item => item.field), ['mobileNumber', 'city'])
  assert.deepEqual(planAlbiUpdate({ objectType: 'contacts', targetId: '20', fields: [{ field: 'phoneNumber', value: '555-111-2222 ext 9' }] }).payload,
    { phoneNumber: '555-111-2222' })
  assert.deepEqual(planAlbiUpdate({ objectType: 'contacts', targetId: '20', fields: [{ field: 'phoneNumber', value: '+44 20 7946 0000' }] }).payload, {})
  const organization = planAlbiUpdate({ objectType: 'companies', targetId: '50', fields: [{ field: 'domain', value: 'acme.test' }, { field: 'address1', value: '1 Main' }] })
  assert.deepEqual([organization.operation, organization.payload, organization.manual.map(item => item.field)], ['updateOrganization', { address1: '1 Main' }, ['domain']])
})

test('applying Albi tasks sends each update once and keeps a refused task whole', async () => {
  const sent = []
  const albiWrite = {
    updateContact: async (id, payload) => { sent.push([id, payload]); if (id === '21') throw new ApiError('validation', { status: 422, providerReason: 'email: invalid' }); return { id } },
  }
  const result = await applyAlbiTasks(albiWrite, [
    { objectType: 'contacts', targetId: '20', fields: [{ field: 'email', value: 'a@example.com' }, { field: 'mobileNumber', value: '5551112222' }] },
    { objectType: 'contacts', targetId: '21', fields: [{ field: 'email', value: 'bad' }] },
  ])
  assert.deepEqual(sent, [['20', { email: 'a@example.com' }], ['21', { email: 'bad' }]])
  assert.deepEqual(result.applied, [{ objectType: 'contacts', targetId: '20', fields: ['email'] }])
  assert.deepEqual(result.remaining.map(task => [task.targetId, task.fields.map(item => item.field)]), [['20', ['mobileNumber']], ['21', ['email']]])
  assert.deepEqual(result.failure, { category: 'validation', code: 'validation', status: 422, providerReason: 'email: invalid' })
})

function fixture() {
  const calls = [], events = [], mappings = { contacts: [], organizations: [], options: [] }
  const source = { id: '42', properties: { firstname: 'A', lastname: 'B', email: 'hs@example.com', phone: '5551112222' } }
  const target = { id: '20', firstName: 'A', lastName: 'B', email: 'albi@example.com', phoneNumber: '5552223333' }
  const row = { id: reviewId, company_id: 'tenant', run_id: 'sample', portal_id: '123', object_type: 'contacts', source_id: '42',
    updated_at: stamp, status: 'needs_review', reason: 'nonblank_field_difference', conflict_type: 'contact_fields',
    source_snapshot: { id: '42', firstName: 'A', lastName: 'B', email: 'hs@example.com', phoneNumber: '5551112222' },
    candidate_snapshots: [structuredClone(target)], proposed_changes: { conflicts: { email: { current: 'albi@example.com', proposed: 'hs@example.com' },
      phoneNumber: { current: '5552223333', proposed: '5551112222' } }, updates: {} } }
  const f = { calls, events, row, intent: null }
  const repository = {
    getConfig: async () => ({ portal_id: '123', initial_start_locked_at: stamp }),
    getCurrentReviewSample: async () => ({ id: 'sample', review_capture_version: 1 }),
    getLatestCompletedSampleDryRun: async () => ({ id: 'sample', review_capture_version: 1 }),
    getDryRunReview: async () => row,
    getReview: async () => row,
    getMappings: async () => mappings,
    getCurrentReviewResolution: async () => f.intent,
    getReviewResolution: async () => f.intent,
    createReviewResolution: async (_company, args) => {
      if (f.intent) return { resolution: structuredClone(f.intent), created: false }
      f.intent = { id: resolutionId, company_id: 'tenant', review_id: row.id, run_id: row.run_id, portal_id: '123', object_type: 'contacts',
        source_id: '42', decision: structuredClone(args.decision), action: args.decision.action, expected_review_updated_at: args.expectedUpdatedAt,
        client_request_id: args.clientRequestId, status: 'pending', execution_phase: null }
      return { resolution: structuredClone(f.intent), created: true }
    },
    claimReviewResolution: async (_company, _id, owner) => {
      if (f.intent.lease_owner) return { error: 'not_claimable' }
      f.intent.execution_phase = ['waiting_on_albi', 'ready_to_recheck'].includes(f.intent.status) ? f.intent.status : f.intent.execution_phase ?? 'applying'
      f.intent.status = 'applying'; f.intent.lease_owner = owner; f.intent.lease_expires_at = '2099-10-13T12:00:00Z'
      return { resolution: structuredClone(f.intent) }
    },
    finishReviewResolution: async (_company, _id, owner, args) => {
      assert.equal(owner, f.intent.lease_owner)
      if (f.intent.execution_phase === 'waiting_on_albi') assert.ok(['waiting_on_albi', 'ready_to_recheck'].includes(args.status))
      Object.assign(f.intent, { status: args.status, execution_phase: null, lease_owner: null })
      events.push(args)
      return { resolution: structuredClone(f.intent) }
    },
    appendReviewResolutionEvent: async (_company, _id, args) => { events.push(args); return args },
    listReviewResolutionEvents: async () => events.map(args => ({ event_type: args.eventType, sanitized_details: args.details })),
    setReviewTriage: async () => ({}),
    saveMapping: async () => {}, upsertContactOrganizationChoice: async () => ({}), getContactOrganizationChoice: async () => null,
    applyDryRunRecheck: async () => ({ review: row }),
    appendDryRunReviewEvent: async () => ({ id: 'event' }),
  }
  const hubspotRead = {
    getContacts: async () => [structuredClone(source)],
    getCompanies: async ids => [{ id: ids[0], properties: { name: 'Acme' } }],
    getOwnerId: async () => null,
    getAssociations: async () => [{ fromId: '42', toObjectType: 'companies', toIds: [] }],
  }
  const albiRead = {
    listReferralSources: async () => [], listCreateOptions: async () => ({ relationshipTypes: [], relationshipStatuses: [], salespeople: [] }),
    listContacts: async () => ({ records: [structuredClone(target)], cursor: null }),
    listOrganizations: async () => ({ records: [], cursor: null }),
  }
  const hubspotWrite = {
    updateContact: async (id, properties) => { calls.push(['PATCH', properties]); Object.assign(source.properties, properties); return { id, properties } },
    updateCompany: async () => { throw Error('unexpected') },
    addContactCompanyAssociation: async () => { throw Error('unexpected') },
  }
  const albiWrite = {
    createContact: async () => { throw Error('unexpected') },
    createOrganization: async () => { throw Error('unexpected') },
    updateContact: async (id, payload) => { calls.push(['ALBI-PUT', id, payload]); if (f.albiError) throw f.albiError; return { id } },
  }
  f.deps = { repository, hubspotRead, albiRead, hubspotWrite, albiWrite, now: () => new Date(stamp), sleep: async () => {} }
  return f
}

test('HubSpot values that win are sent to Albi as one update, and the record is ready to recheck', async () => {
  const f = fixture()
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot', phoneNumber: 'hubspot' } } })
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.deepEqual(f.calls, [['ALBI-PUT', '20', { email: 'hs@example.com', phoneNumber: '555-111-2222' }]])
  const finished = f.events.at(-1)
  assert.equal(finished.eventType, 'recheck_requested')
  assert.deepEqual(finished.details.manualTasks, [])
  assert.deepEqual(finished.details.albiUpdates, [{ objectType: 'contacts', targetId: '20', fields: ['email', 'phoneNumber'] }])
})

test('a mixed choice writes HubSpot and Albi in the same resolution', async () => {
  const f = fixture()
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'albi', phoneNumber: 'hubspot' } } })
  assert.equal(result.resolution.status, 'ready_to_recheck')
  assert.deepEqual(f.calls, [['PATCH', { email: 'albi@example.com' }], ['ALBI-PUT', '20', { phoneNumber: '555-111-2222' }]])
  assert.equal(f.events.at(-1).eventType, 'provider_applied')
})

test('an update Albi refuses stays a manual task with its reason, and Send to Albi sends it later', async () => {
  const f = fixture()
  f.albiError = new ApiError('permission', { status: 403, requiredScope: 'Permissions.Contacts.Edit' })
  const result = await executeReviewResolution(f.deps, { ...input, decision: { action: 'resolve_fields', fieldChoices: { email: 'hubspot' } } })
  assert.equal(result.resolution.status, 'waiting_on_albi')
  assert.deepEqual(f.events.at(-1).details.manualTasks, [{ provider: 'albi', objectType: 'contacts', targetId: '20', fields: [{ field: 'email', value: 'hs@example.com' }] }])
  assert.deepEqual(f.events.at(-1).details.albiUpdateError, { category: 'permission', code: 'permission', status: 403, requiredScope: 'Permissions.Contacts.Edit' })

  f.albiError = null
  const sent = await sendWaitingAlbiUpdates(f.deps, { companyId: 'tenant', reviewId, actorId })
  assert.equal(sent.resolution.status, 'ready_to_recheck')
  assert.deepEqual(f.calls.at(-1), ['ALBI-PUT', '20', { email: 'hs@example.com' }])
  assert.deepEqual(f.events.at(-1).details.albiUpdates, [{ objectType: 'contacts', targetId: '20', fields: ['email'] }])
  // Nothing waiting any more: a second send changes nothing.
  assert.equal((await sendWaitingAlbiUpdates(f.deps, { companyId: 'tenant', reviewId, actorId })).unchanged, true)
})

test('the outbox sends waiting Albi edits and maps a refusal to its reason', async () => {
  assert.deepEqual(normalizeOutboxAction({ kind: 'send_albi_updates' }), { kind: 'send_albi_updates' })
  assert.throws(() => normalizeOutboxAction({ kind: 'send_albi_updates', extra: true }))
  const row = { company_id: 'tenant', review_id: reviewId, requested_by: actorId, action: { kind: 'send_albi_updates' } }
  const run = result => runOutboxItem({ repository: {}, sendAlbiUpdates: async () => result }, row)
  assert.deepEqual(await run({ resolution: { status: 'ready_to_recheck' }, applied: [], remaining: [], failure: null }), { outcome: 'sent' })
  assert.deepEqual(await run({ resolution: { status: 'ready_to_recheck' }, unchanged: true }), { outcome: 'sent' })
  assert.equal((await run({ resolution: { status: 'failed' }, unchanged: true })).errorCode, 'not_waiting_on_albi')
  assert.equal((await run({ failure: { category: 'rate_limit' } })).outcome, 'busy')
  assert.equal((await run({ failure: { category: 'transient' } })).outcome, 'retry')
  assert.equal((await run({ failure: { category: 'permission' } })).errorCode, 'not_allowed')
  assert.equal((await run({ failure: { category: 'validation', providerReason: 'email: invalid' } })).errorCode, 'albi_rejected')
})

test('a create Albi refuses as a duplicate (409) fails in the outbox with its own reason', async () => {
  const row = { company_id: 'tenant', review_id: reviewId, requested_by: actorId, expected_updated_at: stamp, client_request_id: input.clientRequestId,
    action: { kind: 'resolution', decision: { action: 'create_albi', referralSourceId: '5' } } }
  const failedWith = details => runOutboxItem({ executeResolution: async () => ({ resolution: { id: resolutionId, status: 'failed' } }),
    repository: { listReviewResolutionEvents: async () => [{ event_type: 'failed', sanitized_details: details }] } }, row)
  assert.equal((await failedWith({ category: 'validation', code: 'operation_failed', providerStatus: 409 })).errorCode, 'albi_duplicate')
  assert.equal((await failedWith({ category: 'validation', code: 'operation_failed', providerStatus: 422 })).errorCode, 'albi_rejected')
})
