import assert from 'node:assert/strict'
import test from 'node:test'
import { runSelfTest, runSmoke } from '../../scripts/test-h2a-end-to-end.mjs'

test('write-mode acknowledgements reject the real smoke flow before its transport is called', async () => {
  const valid = {
    H2A_TEST_HUBSPOT_TOKEN: 'fake-hubspot-token',
    H2A_TEST_ALBI_KEY: 'fake-albi-key',
    H2A_ALLOW_SANDBOX_WRITES: 'true',
    H2A_SANDBOX_ISOLATION_ACK: 'I_CONFIRM_THIS_IS_AN_ISOLATED_ALBI_SANDBOX',
    H2A_ALBI_ACTIVITY_CONTRACT_ACK: 'I_VERIFIED_ALBI_ACTIVITY_MARKER_READBACK',
    H2A_SMOKE_RUN_ID: 'self-test-14',
  }
  for (const missing of [
    'H2A_SANDBOX_ISOLATION_ACK',
    'H2A_ALBI_ACTIVITY_CONTRACT_ACK',
    'H2A_SMOKE_RUN_ID',
  ]) {
    const env = { ...valid }
    delete env[missing]
    let transportCalls = 0
    await assert.rejects(runSmoke(env, {
      fetch: async () => { transportCalls += 1; throw new Error('unexpected transport') },
      write: false,
      log: () => {},
    }), new RegExp(missing))
    assert.equal(transportCalls, 0, `${missing} must be checked before transport`)
  }
})

test('end-to-end self-test exercises the smoke orchestration', async () => {
  await runSelfTest({ log: () => {} })
})
