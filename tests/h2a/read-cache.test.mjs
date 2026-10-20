import assert from 'node:assert/strict'
import test from 'node:test'
import { cachedRead, clearReadCache } from '../../netlify/functions/_h2a/readCache.js'
import { loadCreateDefaults } from '../../netlify/functions/_h2a/createDefaults.js'

test('cached reads share one load per key until they expire, and never cache failures', async () => {
  clearReadCache()
  let loads = 0, clock = 0
  const load = async () => ++loads
  assert.equal(await cachedRead('a', load, { now: () => clock }), 1)
  assert.equal(await cachedRead('a', load, { now: () => clock }), 1)
  clock = 10 * 60000
  assert.equal(await cachedRead('a', load, { now: () => clock }), 2)
  await assert.rejects(cachedRead('b', async () => { throw new Error('down') }))
  assert.equal(await cachedRead('b', async () => 'ok'), 'ok')
  assert.equal(await cachedRead(null, load), 3)
})

test('create defaults read Albi options and HubSpot owners once per company while warm', async () => {
  clearReadCache()
  const calls = []
  const albiRead = { listCreateOptions: async () => { calls.push('options'); return { relationshipTypes: [{ id: '12', label: 'Referrer' }], relationshipStatuses: [{ id: '2', label: 'Active' }], salespeople: [{ id: '70', label: 'Ali Brown' }] } } }
  const hubspotRead = { getOwnerId: async () => { calls.push('owner'); return '5' }, listOwners: async () => { calls.push('owners'); return [{ id: '5', firstName: 'Ali', lastName: 'Brown' }] } }
  for (let i = 0; i < 3; i++) assert.equal((await loadCreateDefaults({ hubspotRead, albiRead, objectType: 'contacts', sourceId: '42', cacheKey: 'company-1' })).salespersonId, '70')
  assert.deepEqual(calls.filter(call => call === 'options').length, 1)
  assert.deepEqual(calls.filter(call => call === 'owners').length, 1)
  assert.deepEqual(calls.filter(call => call === 'owner').length, 3)
})
