import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatAlbiPhone,
  normalizeAddress,
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from '../../netlify/functions/_h2a/normalize.js'

test('normalizes ten-digit US phones and common punctuation for comparison and Albi writes', () => {
  for (const value of ['4155550123', '(415) 555-0123', '415.555.0123', '+1 415-555-0123', '1 (415) 555-0123']) {
    assert.deepEqual(normalizePhone(value), {
      comparable: '4155550123', writable: '415-555-0123', extension: null, conflictReason: null,
    })
  }
  assert.equal(formatAlbiPhone('415.555.0123'), '415-555-0123')
})

test('preserves phone extensions for comparison but routes unsupported writes to review', () => {
  const result = normalizePhone('+1 (415) 555-0123 ext. 204')
  assert.equal(result.comparable, '4155550123')
  assert.equal(result.writable, null)
  assert.equal(result.extension, '204')
  assert.equal(result.conflictReason, 'extension_not_supported')
  assert.equal(formatAlbiPhone(result), null)
})

test('does not invent digits for malformed or unsupported international phones', () => {
  assert.deepEqual(normalizePhone('555-1234'), {
    comparable: null, writable: null, extension: null, conflictReason: 'invalid_phone_length',
  })
  assert.equal(normalizePhone('123456789012').conflictReason, 'invalid_phone_length')
  assert.equal(normalizePhone('+44 20 7946 0958').conflictReason, 'unsupported_international_format')
  assert.equal(formatAlbiPhone('+44 20 7946 0958'), null)
  assert.equal(normalizePhone('').conflictReason, null)
})

test('normalizes email case and surrounding whitespace without changing write spelling', () => {
  assert.equal(normalizeEmail('  Jane.Doe+Sales@Example.COM  '), 'jane.doe+sales@example.com')
  assert.equal(normalizeEmail('   '), null)
})

test('normalizes Unicode names and ignores case, punctuation, and repeated whitespace', () => {
  assert.equal(normalizeName('  José  O’Neil-Smith '), 'joseoneilsmith')
  assert.equal(normalizeName('王 小明'), '王小明')
  assert.equal(normalizeName('---'), null)
})

test('normalizes domains with protocol, www, path, trailing slash, and case differences', () => {
  for (const value of ['https://www.Example.com/path/', 'WWW.EXAMPLE.COM/', 'example.com']) {
    assert.equal(normalizeDomain(value), 'example.com')
  }
  assert.equal(normalizeDomain(''), null)
})

test('normalizes addresses as supporting comparison evidence only', () => {
  assert.equal(normalizeAddress('  123 Main St.,  Apt. #4  '), '123 main street apartment 4')
  assert.equal(normalizeAddress(''), null)
})
