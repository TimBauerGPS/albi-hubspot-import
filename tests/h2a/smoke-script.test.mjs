import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { runSelfTest, runSmoke } from '../../scripts/test-h2a-end-to-end.mjs'

test('default CLI uses fixtures even when provider credentials and write flags are present', () => {
  const result = spawnSync(process.execPath, ['scripts/test-h2a-end-to-end.mjs'], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env,
      H2A_TEST_HUBSPOT_TOKEN: 'fixture-token', H2A_TEST_ALBI_KEY: 'fixture-key',
      H2A_ALLOW_SANDBOX_WRITES: 'true', H2A_ALLOW_HUBSPOT_REVIEW_WRITES: 'true',
      H2A_TEST_HUBSPOT_BASE_URL: 'https://must-not-be-used.invalid' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /resolution self-test passed \(fixtures only\)/)
})

test('write-mode acknowledgements reject the real smoke flow before its transport is called', async () => {
  const valid = {
    H2A_TEST_HUBSPOT_TOKEN: 'fake-hubspot-token',
    H2A_TEST_ALBI_KEY: 'fake-albi-key',
    H2A_ALLOW_SANDBOX_WRITES: 'true',
    H2A_ALLOW_HUBSPOT_REVIEW_WRITES: 'true',
    H2A_SANDBOX_ISOLATION_ACK: 'I_CONFIRM_THIS_IS_AN_ISOLATED_ALBI_SANDBOX',
    H2A_ALBI_ACTIVITY_CONTRACT_ACK: 'I_VERIFIED_ALBI_ACTIVITY_MARKER_READBACK',
    H2A_SMOKE_RUN_ID: 'self-test-14',
  }
  for (const missing of [
    'H2A_ALLOW_SANDBOX_WRITES',
    'H2A_ALLOW_HUBSPOT_REVIEW_WRITES',
    'H2A_SANDBOX_ISOLATION_ACK',
    'H2A_ALBI_ACTIVITY_CONTRACT_ACK',
    'H2A_SMOKE_RUN_ID',
  ]) {
    const env = { ...valid }
    // A review-write acknowledgement is also a request for guarded write mode.
    delete env[missing]
    let transportCalls = 0
    await assert.rejects(runSmoke(env, {
      fetch: async () => { transportCalls += 1; throw new Error('unexpected transport') },
      log: () => {},
    }), new RegExp(missing))
    assert.equal(transportCalls, 0, `${missing} must be checked before transport`)
  }
})

test('a non-exact review-write acknowledgement stops before client construction', async () => {
  for (const acknowledgement of ['TRUE', '1', 'false', '']) {
    let clients = 0
    await assert.rejects(runSmoke({ H2A_TEST_HUBSPOT_TOKEN: 'fixture', H2A_TEST_ALBI_KEY: 'fixture',
      H2A_ALLOW_SANDBOX_WRITES: 'true', H2A_ALLOW_HUBSPOT_REVIEW_WRITES: acknowledgement,
      H2A_SANDBOX_ISOLATION_ACK: 'I_CONFIRM_THIS_IS_AN_ISOLATED_ALBI_SANDBOX',
      H2A_ALBI_ACTIVITY_CONTRACT_ACK: 'I_VERIFIED_ALBI_ACTIVITY_MARKER_READBACK', H2A_SMOKE_RUN_ID: 'test-11' }, {
      makeClients: () => { clients++; throw Error('unexpected client construction') }, log: () => {},
    }), /H2A_ALLOW_HUBSPOT_REVIEW_WRITES/)
    assert.equal(clients, 0)
  }
})

test('end-to-end self-test exercises the smoke orchestration', async () => {
  const result = await runSelfTest({ log: () => {} })
  assert.ok(result?.resolution, 'self-test must exercise and report the fixture resolution path')
  assert.deepEqual(result.resolution, {
    fieldWrite: { status: 'ready_to_recheck', writes: 1, readAfterWrite: true },
    ambiguous: { status: 'ready_to_recheck', writes: 1, event: 'provider_reconciled' },
    manual: { status: 'waiting_on_albi', writes: 0, links: [
      'https://app.albiware.com/Relationships/Contact/20',
      'https://app.albiware.com/Relationships/Organization/50',
    ] },
    mapping: { targetId: '20', writes: 0 },
    organizationChoice: { sourceId: '99', writes: 0 },
    dispatches: 0,
  })
})
