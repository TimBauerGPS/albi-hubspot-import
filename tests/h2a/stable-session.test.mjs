import assert from 'node:assert/strict'
import test from 'node:test'
import { createStableSessionHolder } from '../../src/lib/stableSession.js'

const session = (id, token) => ({ access_token: token, user: { id, email: `${id}@example.com` }, expires_at: 100 })

test('refocus and token refresh keep one session object whose fields read the latest values', () => {
  const holder = createStableSessionHolder()
  const first = holder.update(session('u1', 'token-1'))
  const second = holder.update(session('u1', 'token-1'))
  const refreshed = holder.update(session('u1', 'token-2'))
  assert.equal(second, first); assert.equal(refreshed, first)
  assert.equal(first.access_token, 'token-2')
  assert.equal(first.user.id, 'u1')
  assert.equal(JSON.parse(JSON.stringify(first)).access_token, 'token-2')
})

test('a different user or sign-out produces a new identity, and sign-out clears it', () => {
  const holder = createStableSessionHolder()
  const first = holder.update(session('u1', 'a'))
  const other = holder.update(session('u2', 'b'))
  assert.notEqual(other, first)
  assert.equal(other.user.id, 'u2')
  assert.equal(holder.update(null), null)
  assert.notEqual(holder.update(session('u1', 'c')), first)
})
