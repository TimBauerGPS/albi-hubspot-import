import assert from 'node:assert/strict'
import test from 'node:test'
import { followOrganizationMerge, organizationMergeConflict } from '../../netlify/functions/_h2a/organizationMerges.js'

const survivor = { id: '900', properties: { name: 'PURE Insurance', hs_merged_object_ids: '777;778' } }
const mapped = (hubspotId, albiId, portal = '321') => ({ portal_id: portal, hubspot_id: hubspotId, albi_organization_id: albiId, match_method: 'reviewed' })

test('a merged company is read under the mapping of the records HubSpot merged into it', () => {
  const other = mapped('555', '666')
  const rows = [mapped('777', '888'), other]
  const followed = followOrganizationMerge(rows, survivor, '321')
  assert.deepEqual(followed, [other, { ...mapped('900', '888'), merged_from: ['777'] }])
  assert.deepEqual(rows, [mapped('777', '888'), other], 'the loaded mappings are not changed')
  // Several merged records on the same Albi organization collapse into one owner, so it is not a many-to-one share.
  assert.deepEqual(followOrganizationMerge([mapped('777', '888'), mapped('778', '888')], survivor, '321'),
    [{ ...mapped('900', '888'), merged_from: ['777', '778'] }])
})

test('merged records on different Albi organizations, an own mapping, or no merge leave the mappings alone', () => {
  const split = [mapped('777', '888'), mapped('778', '889')]
  assert.equal(followOrganizationMerge(split, survivor, '321'), split)
  assert.equal(organizationMergeConflict(split, survivor, '321'), true)
  const own = [mapped('900', '111'), mapped('777', '888')]
  assert.equal(followOrganizationMerge(own, survivor, '321'), own)
  assert.equal(organizationMergeConflict(own, survivor, '321'), false)
  const plain = [mapped('777', '888')]
  assert.equal(followOrganizationMerge(plain, { id: '900', properties: { name: 'PURE' } }, '321'), plain)
  assert.equal(followOrganizationMerge(plain, { id: '900', properties: { hs_merged_object_ids: '' } }, '321'), plain)
  assert.equal(organizationMergeConflict([mapped('777', '888')], survivor, '321'), false)
})

test('only this portal’s mappings and well-formed merged ids are followed', () => {
  const elsewhere = [mapped('777', '888', '999')]
  assert.equal(followOrganizationMerge(elsewhere, survivor, '321'), elsewhere)
  const odd = { id: '900', properties: { hs_merged_object_ids: ' 777 ; bad;;900' } }
  assert.deepEqual(followOrganizationMerge([mapped('777', '888')], odd, '321'), [{ ...mapped('900', '888'), merged_from: ['777'] }])
  assert.equal(followOrganizationMerge(null, survivor, '321'), null)
  assert.deepEqual(followOrganizationMerge([mapped('777', '888')], null, '321'), [mapped('777', '888')])
})
