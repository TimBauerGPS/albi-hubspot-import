import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCreateDefaults, resolveCreateDefaults } from '../../netlify/functions/_h2a/createDefaults.js'

const base = {
  relationshipTypes: [{ id: '3', label: 'Customer' }, { id: '12', label: 'Referrer' }],
  relationshipStatuses: [{ id: '1', label: 'Inactive' }, { id: '2', label: ' active ' }],
  salespeople: [{ id: '70', label: 'Ali  Brown' }, { id: '71', label: 'Sam Green' }],
  owners: [{ id: '5', firstName: 'Ali', lastName: 'Brown' }],
}

test('type, status and salesperson resolve by exact normalized label', () => {
  assert.deepEqual(resolveCreateDefaults({ ...base, ownerId: '5' }), { ok: true, typeId: '12', statusId: '2', salespersonId: '70' })
  assert.deepEqual(resolveCreateDefaults({ ...base, ownerId: null }), { ok: true, typeId: '12', statusId: '2', salespersonId: null })
})

test('missing or ambiguous labels fail closed with one reason', () => {
  assert.equal(resolveCreateDefaults({ ...base, relationshipTypes: [], ownerId: '5' }).reason, 'referrer_type_missing')
  assert.equal(resolveCreateDefaults({ ...base, relationshipTypes: [...base.relationshipTypes, { id: '13', label: 'referrer' }], ownerId: '5' }).reason, 'referrer_type_missing')
  assert.equal(resolveCreateDefaults({ ...base, relationshipStatuses: [], ownerId: '5' }).reason, 'active_status_missing')
  assert.equal(resolveCreateDefaults({ ...base, owners: [], ownerId: '5' }).reason, 'owner_not_found')
  assert.equal(resolveCreateDefaults({ ...base, salespeople: [{ id: '70', label: 'Alison Brown' }], ownerId: '5' }).reason, 'salesperson_not_found')
  assert.equal(resolveCreateDefaults({ ...base, salespeople: [...base.salespeople, { id: '72', label: 'ali brown' }], ownerId: '5' }).reason, 'salesperson_not_found')
})

test('loader reads Albi options and only fetches owners when the record has one', async () => {
  const calls = []
  const albiRead = { listCreateOptions: async () => ({ relationshipTypes: base.relationshipTypes, relationshipStatuses: base.relationshipStatuses, salespeople: base.salespeople }) }
  const hubspotRead = { getOwnerId: async (type, id) => { calls.push([type, id]); return id === '42' ? '5' : null }, listOwners: async () => { calls.push('owners'); return base.owners } }
  assert.equal((await loadCreateDefaults({ hubspotRead, albiRead, objectType: 'contacts', sourceId: '42' })).salespersonId, '70')
  assert.deepEqual(calls, [['contacts', '42'], 'owners'])
  calls.length = 0
  assert.equal((await loadCreateDefaults({ hubspotRead, albiRead, objectType: 'companies', sourceId: '9' })).salespersonId, null)
  assert.deepEqual(calls, [['companies', '9']])
})
