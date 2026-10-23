import assert from 'node:assert/strict'
import test from 'node:test'
import { mountComponent } from './workspace-harness.mjs'

const j = value => JSON.parse(JSON.stringify(value))

async function mountSettings({ referralSources = [{ id: '5', label: 'Network' }, { id: '6', label: 'Property Management' }], failSources = false } = {}) {
  const saved = []
  const supabase = { from: () => ({ upsert: async row => { saved.push(row); return { error: null } } }) }
  const getH2ACreateBatch = async () => { if (failSources) throw new Error('no access'); return { referralSources } }
  const ui = await mountComponent('../../components/UserSettings.jsx', {
    bindings: { supabase, getH2ACreateBatch },
    props: { userId: 'u1', session: { access_token: 't' }, companyId: 'c1',
      initialConfig: { sales_team: [{ name: 'Victoria Dunn', email: 'victoria@allied.test' }, { name: 'Sam Lee', email: 'sam@allied.test', referralSourceId: '5' }] } } })
  for (let i = 0; i < 4; i++) await ui.flush()
  return { ui, saved }
}

test('each sales-team member can have a default Albi referral source, saved with the team', async () => {
  const { ui, saved } = await mountSettings()
  const victoria = ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === 'Default referral source for Victoria Dunn')
  assert.ok(victoria)
  assert.match(JSON.stringify(victoria.children), /Property Management/)
  assert.equal(ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === 'Default referral source for Sam Lee').props.value, '5')
  victoria.props.onChange({ target: { value: '6' } }); await ui.flush()
  await ui.find('form').props.onSubmit({ preventDefault() {} }); await ui.flush()
  assert.deepEqual(j(saved[0].sales_team), [
    { name: 'Victoria Dunn', email: 'victoria@allied.test', referralSourceId: '6' },
    { name: 'Sam Lee', email: 'sam@allied.test', referralSourceId: '5' }])
})

test('when Albi referral sources cannot be loaded, the column says so and keeps saved defaults', async () => {
  const { ui, saved } = await mountSettings({ failSources: true })
  assert.match(ui.text(), /Albi referral sources could not be loaded/)
  await ui.find('form').props.onSubmit({ preventDefault() {} }); await ui.flush()
  assert.equal(saved[0].sales_team[1].referralSourceId, '5')
})
