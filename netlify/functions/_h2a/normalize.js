const EMPTY_PHONE = Object.freeze({
  comparable: null,
  writable: null,
  extension: null,
  conflictReason: null,
})

function asString(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function foldDiacritics(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '')
}

export function normalizePhone(value) {
  const raw = asString(value).trim()
  if (!raw) return { ...EMPTY_PHONE }

  const extensionMatch = raw.match(/(?:\b(?:ext(?:ension)?\.?|x)|#)\s*(\d+)\s*$/i)
  const extension = extensionMatch?.[1] ?? null
  const main = extensionMatch ? raw.slice(0, extensionMatch.index) : raw
  const digits = main.replace(/\D/g, '')
  const hasInternationalPrefix = /^\s*(?:\+|00)/.test(main)

  if (hasInternationalPrefix && !/^\s*\+?1(?:\D|$)/.test(main)) {
    return { comparable: null, writable: null, extension, conflictReason: 'unsupported_international_format' }
  }

  let nationalDigits = digits
  if (nationalDigits.length === 11 && nationalDigits.startsWith('1')) nationalDigits = nationalDigits.slice(1)
  if (nationalDigits.length !== 10) {
    return { comparable: null, writable: null, extension, conflictReason: 'invalid_phone_length' }
  }
  if (/^([0-9])\1{9}$/.test(nationalDigits)) {
    return { comparable: null, writable: null, extension, conflictReason: 'invalid_phone_length' }
  }
  if (extension) {
    return { comparable: nationalDigits, writable: null, extension, conflictReason: 'extension_not_supported' }
  }
  return {
    comparable: nationalDigits,
    writable: `${nationalDigits.slice(0, 3)}-${nationalDigits.slice(3, 6)}-${nationalDigits.slice(6)}`,
    extension: null,
    conflictReason: null,
  }
}

export function formatAlbiPhone(value) {
  if (value && typeof value === 'object' && 'writable' in value) return value.writable
  return normalizePhone(value).writable
}

export function normalizeEmail(value) {
  const normalized = asString(value).trim().toLocaleLowerCase('en-US')
  return normalized || null
}

export function normalizeName(value) {
  const normalized = foldDiacritics(asString(value).trim().replace(/\s+/gu, ' '))
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]/gu, '')
  return normalized || null
}

export function normalizeDomain(value) {
  let raw = asString(value).trim()
  if (!raw) return null
  raw = raw.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/^\/\//, '')
  raw = raw.split(/[/?#]/, 1)[0].trim().toLocaleLowerCase('en-US')
  raw = raw.replace(/^www\./, '').replace(/\.$/, '')
  return raw || null
}

export function normalizeAddress(value) {
  let normalized = foldDiacritics(asString(value).trim()).toLocaleLowerCase('en-US')
  if (!normalized) return null
  normalized = normalized
    .replace(/\b(street|st)\b\.?/g, 'street')
    .replace(/\b(road|rd)\b\.?/g, 'road')
    .replace(/\b(avenue|ave)\b\.?/g, 'avenue')
    .replace(/\b(boulevard|blvd)\b\.?/g, 'boulevard')
    .replace(/\b(suite|ste)\b\.?/g, 'suite')
    .replace(/\b(apartment|apt)\b\.?/g, 'apartment')
    .replace(/[^\p{L}\p{N}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized || null
}
