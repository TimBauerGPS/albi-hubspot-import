import assert from 'node:assert/strict'
import test from 'node:test'

async function presentation() {
  try { return await import('../../src/features/hubspotToAlbi/preflightPresentation.js') }
  catch { return {} }
}

test('preflight presentation distinguishes verified, informational, and blocking checks', async () => {
  const { presentPreflightCheck } = await presentation()
  assert.equal(typeof presentPreflightCheck, 'function')
  assert.deepEqual(presentPreflightCheck({ status: 'valid' }), {
    detail: 'available', markerClass: 'bg-green-500', textClass: 'text-gray-700',
  })
  assert.deepEqual(presentPreflightCheck({ status: 'informational', reason: 'verified_on_first_use', requiredScope: 'contacts:create' }), {
    detail: 'Verified when first used · Required scope: contacts:create', markerClass: 'bg-blue-400', textClass: 'text-gray-700',
  })
  assert.deepEqual(presentPreflightCheck({ status: 'informational', reason: 'handled_through_conflicts' }), {
    detail: 'Handled through Conflicts', markerClass: 'bg-blue-400', textClass: 'text-gray-700',
  })
  assert.deepEqual(presentPreflightCheck({ status: 'invalid', reason: 'permission_denied', requiredScope: 'options.activity-types:list' }), {
    detail: 'Permission denied · Required scope: options.activity-types:list', markerClass: 'bg-amber-500', textClass: 'text-gray-700',
  })
})

test('preflight presentation omits unknown scope and unsafe company identity', async () => {
  const { presentPreflightCheck, presentAuthorizedCompany } = await presentation()
  assert.equal(presentPreflightCheck({ status: 'invalid', reason: 'permission_denied', requiredScope: 'secret raw scope' }).detail, 'Permission denied')
  assert.equal(presentAuthorizedCompany({ id: '1319', name: 'Allied Restoration Services Inc' }),
    'Authorized company: Allied Restoration Services Inc (1319)')
  assert.equal(presentAuthorizedCompany({ id: '../1319', name: 'Allied' }), '')
  assert.equal(presentAuthorizedCompany({ id: '1319', name: 'Allied\u0000' }), '')
})
