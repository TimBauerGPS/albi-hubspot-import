import assert from 'node:assert/strict'
import test from 'node:test'
import { presentRecheckAllBatch } from '../../src/features/hubspotToAlbi/sampleReview.js'

const batch = extra => ({ id: 'b', status: 'running', total: 40, done: 12, cleared: 5, stillNeedsReview: 6, noLongerInScope: 1,
  stale: 0, failed: 0, errorCode: null, ...extra })

test('no batch or an unknown shape presents nothing', () => {
  assert.equal(presentRecheckAllBatch(null), null)
  assert.equal(presentRecheckAllBatch({ status: 'weird' }), null)
})

test('a queued or running batch is active with bounded progress', () => {
  assert.deepEqual(presentRecheckAllBatch(batch({ status: 'queued', total: 0, done: 0 })),
    { active: true, tone: 'info', percent: 0, message: 'Reading the latest Albi and HubSpot records…' })
  assert.deepEqual(presentRecheckAllBatch(batch()), { active: true, tone: 'info', percent: 30, message: 'Rechecking 12 of 40 open records…' })
  assert.equal(presentRecheckAllBatch(batch({ done: 99 })).percent, 100)
})

test('a completed batch summarizes outcomes and calls out changed or failed records', () => {
  assert.deepEqual(presentRecheckAllBatch(batch({ status: 'completed', done: 40, cleared: 30, stillNeedsReview: 9, noLongerInScope: 1 })),
    { active: false, tone: 'success', percent: 100, message: 'Recheck all finished: 30 cleared, 9 still need review, 1 no longer in scope.' })
  const mixed = presentRecheckAllBatch(batch({ status: 'completed', done: 40, cleared: 30, stillNeedsReview: 6, noLongerInScope: 0, stale: 2, failed: 2 }))
  assert.equal(mixed.tone, 'warning')
  assert.equal(mixed.message, 'Recheck all finished: 30 cleared, 6 still need review, 0 no longer in scope. 2 changed during the recheck and were skipped. 2 could not be rechecked; open them to retry.')
  assert.equal(presentRecheckAllBatch(batch({ status: 'completed', total: 0, done: 0 })).message, 'There were no open records to recheck.')
})

test('a failed batch explains whether any records changed', () => {
  assert.deepEqual(presentRecheckAllBatch(batch({ status: 'failed', done: 0, cleared: 0, stillNeedsReview: 0, noLongerInScope: 0, errorCode: 'network' })),
    { active: false, tone: 'error', percent: 0, message: 'Recheck all could not read the latest Albi or HubSpot records. No records were changed. Try again.' })
  assert.equal(presentRecheckAllBatch(batch({ status: 'failed', errorCode: 'timeout' })).message,
    'Recheck all stopped after 12 of 40 records. Run it again to recheck the rest.')
  assert.equal(presentRecheckAllBatch(batch({ status: 'failed', errorCode: 'superseded' })).message,
    'A newer sample replaced this one, so recheck all stopped after 12 of 40 records. Reload the queue.')
  assert.equal(presentRecheckAllBatch(batch({ status: 'failed', errorCode: 'expired' })).message,
    'Recheck all stopped unexpectedly after 12 of 40 records. Run it again to recheck the rest.')
})
