import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveKey, open, seal, keyFingerprint, sameKey } from '../src/crypto.js'
import { canonicalJson, digestOf, chunkByBytes } from '../src/util.js'

test('a sealed envelope round-trips', async () => {
  const { key } = await deriveKey('correct horse battery staple')
  const plain = Buffer.from('你好，世界\nsecond line\n')
  const envelope = seal(key, plain, 'dsh-sync:chunk:x')
  assert.notDeepEqual(envelope.subarray(0, 20), plain.subarray(0, 20))
  assert.deepEqual(open(key, envelope, 'dsh-sync:chunk:x'), plain)
})

test('a different passphrase cannot open an envelope', async () => {
  const one = await deriveKey('correct horse battery staple', undefined, { scrypt: { N: 1024 } })
  const two = await deriveKey('correct horse battery staple!', one.salt, { scrypt: { N: 1024 } })
  const envelope = seal(one.key, Buffer.from('secret'), 'aad')
  assert.throws(() => open(two.key, envelope, 'aad'))
  assert.notEqual(keyFingerprint(one.key), keyFingerprint(two.key))
})

test('binding to a different path fails authentication', async () => {
  const { key } = await deriveKey('correct horse battery staple', undefined, { scrypt: { N: 1024 } })
  const envelope = seal(key, Buffer.from('payload'), 'dsh-sync:chunk:data/a/b/000001-000002.jsonl.enc')
  assert.throws(() => open(key, envelope, 'dsh-sync:chunk:data/a/c/000001-000002.jsonl.enc'))
})

test('identical salt reproduces the key on another device', async () => {
  const first = await deriveKey('shared passphrase', undefined, { scrypt: { N: 1024 } })
  const second = await deriveKey('shared passphrase', first.salt, { scrypt: { N: 1024 } })
  assert.ok(sameKey(first.key, second.key))
})

test('a truncated envelope is rejected before decrypting', async () => {
  const { key } = await deriveKey('correct horse battery staple', undefined, { scrypt: { N: 1024 } })
  const envelope = seal(key, Buffer.from('payload'), 'aad')
  assert.throws(() => open(key, envelope.subarray(0, 10), 'aad'), /truncated/)
})

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }))
})

test('chunking respects the byte budget and never drops records', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ i, text: 'x'.repeat(50) }))
  const chunks = chunkByBytes(items, 600)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.flat().length, items.length)
  for (const chunk of chunks) assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 2000)
})

test('a short passphrase is refused', async () => {
  await assert.rejects(() => deriveKey('short'), /at least 8 characters/)
})
