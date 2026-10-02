import assert from 'node:assert/strict'
import test from 'node:test'
import { encryptSecret, decryptSecret, maskSecret, loadCredentialKeyring } from '../../netlify/functions/_h2a/crypto.js'

const v1 = Buffer.alloc(32, 1)
const v2 = Buffer.alloc(32, 2)
const ring = { activeVersion: 1, keys: { 1: v1 } }
const secret = 'pat-na1-a-private-secret-123456789'

test('AES-GCM round trips and uses fresh 12-byte IVs without storing plaintext', () => {
  const first = encryptSecret(secret, ring)
  const second = encryptSecret(secret, ring)
  assert.equal(decryptSecret(first, ring), secret)
  assert.equal(decryptSecret(second, ring), secret)
  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.ciphertext, second.ciphertext)
  assert.equal(Buffer.from(first.iv, 'base64').length, 12)
  assert.equal(Buffer.from(first.tag, 'base64').length, 16)
  assert.equal(first.keyVersion, 1)
  assert.equal(JSON.stringify(first).includes(secret), false)
})

for (const field of ['ciphertext', 'iv', 'tag']) {
  test(`tampering with ${field} fails authentication`, () => {
    const envelope = encryptSecret(secret, ring)
    const bytes = Buffer.from(envelope[field], 'base64')
    bytes[0] ^= 1
    assert.throws(() => decryptSecret({ ...envelope, [field]: bytes.toString('base64') }, ring))
  })
}

test('unknown key versions and malformed envelopes fail closed', () => {
  const envelope = encryptSecret(secret, ring)
  for (const invalid of [
    { ...envelope, keyVersion: 2 }, { ...envelope, keyVersion: '1' },
    { ...envelope, iv: 'bad' }, { ...envelope, tag: '' },
    { ...envelope, ciphertext: '%%%invalid' }, null,
  ]) assert.throws(() => decryptSecret(invalid, ring))
})

test('rotation retains v1 reads while new writes use v2', () => {
  const old = encryptSecret(secret, ring)
  const rotated = { activeVersion: 2, keys: { 1: v1, 2: v2 } }
  assert.equal(decryptSecret(old, rotated), secret)
  const latest = encryptSecret(secret, rotated)
  assert.equal(latest.keyVersion, 2)
  assert.equal(decryptSecret(latest, rotated), secret)
  assert.throws(() => decryptSecret(latest, ring))
})

test('key versions are authenticated even when two versions use the same key', () => {
  const envelope = encryptSecret(secret, ring)
  assert.throws(() => decryptSecret({ ...envelope, keyVersion: 2 }, { activeVersion: 2, keys: { 1: v1, 2: v1 } }))
})

test('env loader validates base64 32-byte keys and selects the highest configured version', () => {
  const loaded = loadCredentialKeyring({ H2A_CREDENTIAL_KEY_V1: v1.toString('base64'), H2A_CREDENTIAL_KEY_V2: v2.toString('base64') })
  assert.equal(loaded.activeVersion, 2)
  assert.equal(decryptSecret(encryptSecret(secret, loaded), loaded), secret)
  for (const env of [{}, { H2A_CREDENTIAL_KEY_V1: '%%%bad' }, { H2A_CREDENTIAL_KEY_V1: Buffer.alloc(31).toString('base64') }]) {
    assert.throws(() => loadCredentialKeyring(env))
  }
  assert.throws(() => encryptSecret(secret, { activeVersion: 3, keys: { 1: v1 } }))
  assert.throws(() => encryptSecret(secret, { activeVersion: 1, keys: { 1: Buffer.alloc(31) } }))
  assert.throws(() => encryptSecret('', ring))
})

test('masks reveal only four prefix/suffix characters and fully hide short secrets', () => {
  assert.equal(maskSecret('abcdefghijklmnop'), 'abcd********mnop')
  for (const short of ['a', 'abcd', 'abcdefgh', 'abcdefghijkl']) assert.equal(maskSecret(short), '********')
  assert.equal(maskSecret(null), null)
  assert.equal(maskSecret(''), null)
})
