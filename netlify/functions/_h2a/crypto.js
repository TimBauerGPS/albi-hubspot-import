import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid encrypted credential format.')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || (expectedLength && bytes.length !== expectedLength)) {
    throw new Error('Invalid encrypted credential format.')
  }
  return bytes
}

function getKey(keyring, version) {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid credential key version.')
  const key = keyring?.keys?.[version]
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Credential key version is unavailable.')
  return key
}

export function loadCredentialKeyring(env = process.env) {
  const keys = {}
  for (const [name, value] of Object.entries(env)) {
    const match = /^H2A_CREDENTIAL_KEY_V([1-9]\d*)$/.exec(name)
    if (!match) continue
    const version = Number(match[1])
    if (!Number.isSafeInteger(version)) throw new Error('Invalid credential key version.')
    keys[version] = decodeBase64(value, 32)
  }
  const versions = Object.keys(keys).map(Number)
  if (!versions.length) throw new Error('Credential encryption is not configured.')
  return { activeVersion: Math.max(...versions), keys }
}

function versionAAD(version) {
  return Buffer.from(`h2a:credential:v${version}`, 'utf8')
}

export function encryptSecret(plaintext, keyring) {
  if (typeof plaintext !== 'string' || !plaintext.length) throw new Error('A nonempty credential is required.')
  const keyVersion = keyring?.activeVersion
  const key = getKey(keyring, keyVersion)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(versionAAD(keyVersion))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  }
}

export function decryptSecret(envelope, keyring) {
  const key = getKey(keyring, envelope?.keyVersion)
  const iv = decodeBase64(envelope.iv, 12)
  const tag = decodeBase64(envelope.tag, 16)
  const ciphertext = decodeBase64(envelope.ciphertext)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(versionAAD(envelope.keyVersion))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Credential authentication failed.')
  }
}

export function maskSecret(secret) {
  if (secret == null || secret === '') return null
  if (typeof secret !== 'string') throw new Error('Invalid credential.')
  return secret.length <= 12 ? '********' : `${secret.slice(0, 4)}********${secret.slice(-4)}`
}
