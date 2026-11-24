/**
 * End-to-end encryption for sync content.
 *
 * The repository only ever stores ciphertext. A passphrase is stretched with
 * scrypt into an AES-256-GCM key; every file is one sealed envelope with its
 * own random IV and an AAD string that binds the ciphertext to its purpose, so
 * a chunk cannot be moved onto another path unnoticed.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

export const ENVELOPE_VERSION = 1
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }

/** Stretch a passphrase into a 32-byte key. The salt must be stored next to the data. */
export async function deriveKey(passphrase, saltB64u, options = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('passphrase must be at least 8 characters')
  }
  const salt = saltB64u === undefined ? randomBytes(SALT_BYTES) : Buffer.from(saltB64u, 'base64url')
  const key = await scrypt(passphrase.normalize('NFKC'), salt, KEY_BYTES, { ...SCRYPT, ...options.scrypt })
  return { key: Buffer.from(key), salt: salt.toString('base64url'), params: { N: options.scrypt?.N ?? SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, n: KEY_BYTES } }
}

/** Seal one buffer into a self-describing envelope (binary: magic|iv|tag|ciphertext). */
export function seal(key, plaintext, aad = '') {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, tag, body])
}

/** Open an envelope produced by {@link seal}. Throws on tamper or a wrong passphrase. */
export function open(key, envelope, aad = '') {
  const buf = Buffer.from(envelope)
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) throw new Error('encrypted file is truncated')
  const version = buf[0]
  if (version !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${version}`)
  const iv = buf.subarray(1, 1 + IV_BYTES)
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
  const body = buf.subarray(1 + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** A short fingerprint of the key, safe to print, used to check two devices configured the same passphrase. */
export function keyFingerprint(key) {
  return Buffer.from(key).toString('hex').slice(0, 12)
}

export function sameKey(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
