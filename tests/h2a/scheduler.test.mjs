import test from 'node:test'
import assert from 'node:assert/strict'
import { createNightlyScheduler } from '../../netlify/functions/nightly-h2a-sync.js'

const ready = (id, extra = {}) => ({ company_id: id, state: 'live', preflight_status: 'valid', preflight_checked_at: '2026-10-05T09:00:00.000Z',
  option_confirmation_status: 'confirmed', selected_start_date: '2026-10-01', portal_id: '123', ...extra })
function fixture({ now = '2026-10-05T09:00:00.000Z', companies = [ready('c1')], claim = async () => ({ id: 'claim-1', acquired: true }),
  dispatch = async () => true, resumes = [], finish = async () => true, isActivationReady = async () => true } = {}) {
  const calls = []
  const supabase = { from: table => ({ select() { calls.push(['select', table]); return this }, eq(k, v) { calls.push(['eq', table, k, v]); return this },
    lte(k, v) { calls.push(['lte', table, k, v]); return this }, gte(k, v) { calls.push(['gte', table, k, v]); return this },
    order() { return this }, limit() { return this }, then(resolve) { resolve({ data: table === 'h2a_company_config' ? companies : [], error: null }) } }),
    rpc: async (name, args) => { calls.push([name, args]); if (name === 'h2a_claim_daily_run') { const result = await claim(args.p_company_id); return { data: { acquired: result.acquired, claim: result } } }
      if (name === 'h2a_finish_daily_run') return { data: await finish(args) }
      return { data: resumes } } }
  const handler = createNightlyScheduler({ supabase, now: () => new Date(now), dispatch, dispatchResume: dispatch,
    listPendingResumes: async companyId => resumes.filter(row => row.company_id === companyId), claimResume: async () => resumes[0] ? { ...resumes[0] } : null,
    finishResume: async () => true,
    queueScheduledRun: async () => true, isActivationReady })
  return { handler, calls }
}

test('scheduler skips before 2am, claims at 2am, and handles spring-forward 3am', async () => {
  for (const [now, expected] of [['2026-10-05T08:00:00.000Z', 0], ['2026-10-05T09:00:00.000Z', 1], ['2026-03-08T10:00:00.000Z', 1]]) {
    const dispatched = []
    const { handler } = fixture({ now, dispatch: async payload => { dispatched.push(payload); return true } })
    await handler({})
    assert.equal(dispatched.length, expected)
  }
})

test('scheduler isolates tenants, preserves stable run identity, and retries failed claims', async () => {
  const sent = [], finishes = []
  const { handler } = fixture({ companies: [ready('c1'), ready('c2')], claim: async companyId => ({ id: `claim-${companyId}`, acquired: true }),
    dispatch: async payload => { sent.push(payload); if (payload.companyId === 'c1') throw Error('uncertain') ; return true },
    finish: async args => { finishes.push(args); return true } })
  const result = await handler({})
  assert.equal(sent.length, 2)
  assert.equal(sent[0].runId, 'claim-c1')
  assert.ok(finishes.some(row => row.p_accepted === false))
  assert.ok(finishes.some(row => row.p_accepted === true))
  assert.deepEqual(result.statusCode, 200)
})

test('invalid or disabled companies never dispatch; pending conflict resumes drain off schedule', async () => {
  const dispatched = []
  const { handler } = fixture({ now: '2026-10-05T08:00:00.000Z', companies: [ready('c1', { preflight_checked_at: '2026-10-05T07:00:00.000Z' }),
    ready('disabled', { state: 'disabled' })],
    resumes: [{ id: 'resume-1', company_id: 'c1', status: 'pending', source_object_type: 'contacts', source_id: '10' }],
    dispatch: async payload => { dispatched.push(payload); return true },
    isActivationReady: async (_repo, _id, config, now) => Date.parse(config.preflight_checked_at) <= now.getTime() &&
      now.getTime() - Date.parse(config.preflight_checked_at) < 86400000 })
  await handler({})
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].resumeId, 'resume-1')
  assert.equal(dispatched[0].companyId, 'c1')
})

test('disabled or activation-ineligible companies do not dispatch pending conflict resumes', async () => {
  for (const [company, activationReady] of [
    [ready('disabled', { state: 'disabled' }), true],
    [ready('not-ready'), false],
  ]) {
    const dispatched = []
    const { handler } = fixture({ companies: [company],
      resumes: [{ id: `resume-${company.company_id}`, company_id: company.company_id, status: 'pending', source_object_type: 'contacts', source_id: '10' }],
      dispatch: async payload => { dispatched.push(payload); return true },
      isActivationReady: async () => activationReady })
    await handler({})
    assert.deepEqual(dispatched, [])
  }
})

test('same stable daily run identity is retried after dispatch failure and claimed once after acceptance', async () => {
  let claimState = { id: 'claim-stable', acquired: true }
  const runIds = [], accepted = []
  let attempt = 0
  const { handler } = fixture({ claim: async () => claimState,
    dispatch: async payload => { runIds.push(payload.runId); attempt += 1; if (attempt === 1) throw Error('network uncertain'); return true },
    finish: async args => { accepted.push(args.p_accepted); if (args.p_accepted) claimState = { id: 'claim-stable', acquired: false }; return true } })
  await handler({})
  await handler({})
  await handler({})
  assert.deepEqual(runIds, ['claim-stable', 'claim-stable'])
  assert.deepEqual(accepted, [false, true])
})

test('scheduled lease collision leaves daily claim pending and retries the same run identity', async () => {
  let claimState = { id: 'claim-stable', acquired: true }
  const runIds = [], outcomes = []
  let attempt = 0
  const { handler } = fixture({ claim: async () => claimState,
    dispatch: async payload => { runIds.push(payload.runId); attempt += 1; return attempt > 1 },
    finish: async args => { outcomes.push(args.p_accepted); claimState = args.p_accepted
      ? { id: 'claim-stable', acquired: false } : { id: 'claim-stable', acquired: true }; return true } })
  await handler({})
  await handler({})
  await handler({})
  assert.deepEqual(runIds, ['claim-stable', 'claim-stable'])
  assert.deepEqual(outcomes, [false, true])
})

test('schedule metadata uses the hourly Netlify cron expression', async () => {
  const mod = await import('../../netlify/functions/nightly-h2a-sync.js')
  assert.deepEqual(mod.config, { schedule: '17 * * * *' })
})
