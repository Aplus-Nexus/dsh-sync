/**
 * End-to-end: a real DSH session log on "device A" is pushed, and "device B"
 * pulls it and imports a native, byte-faithful conversation.
 *
 * The DSH services are faked with the smallest possible surface (list/read/stat
 * and a `session/event` emitter). On the machine that has one it is fed a real
 * phone conversation; elsewhere it builds the same log shape from the fixture,
 * so CI still exercises the whole path instead of skipping it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import { sampleHeader, sampleEventLines } from './fixtures.js'
import { parseLogBytes, logPathFor, projectKey, encodeSegment } from '../vendor/core/native.js'
import { importNativeSession } from '../vendor/core/import.js'

const REAL_LOG = process.env.DSH_SYNC_REAL_LOG
  ?? '/root/.dsh/sessions/--root-workspace--/session-03939ae6-a256-4477-8420-237f751aa469/session.v4.jsonl.zstd'
const HAS_REAL = existsSync(REAL_LOG)
const SOURCE = HAS_REAL ? REAL_LOG : await materializeFixture()

/** Write the fixture as a real .zstd log in a temp dir so the test path is identical. */
async function materializeFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-fixture-'))
  const path = join(dir, 'session.v4.jsonl.zstd')
  const { encodeLogBytes } = await import('../vendor/core/native.js')
  await writeFile(path, encodeLogBytes(sampleHeader(), sampleEventLines()))
  return path
}

/** A DSH host stub: enumerate and read local logs, emit nothing. */
function fakeHost(logPath) {
  const cache = new Map()
  const load = async (id) => {
    if (cache.has(id)) return cache.get(id)
    const bytes = await readFile(logPath)
    const parsed = parseLogBytes(bytes)
    const { type, ...header } = parsed.header
    const events = parsed.events.map((line) => JSON.parse(line))
    const value = { header, events, path: logPath }
    cache.set(id, value)
    return value
  }
  return {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          async listSessions() {
            const one = await load('real')
            return [{ header: one.header, live: true, persisted: true }]
          },
          async readSession(id) {
            const one = await load('real')
            return { session: one.header, events: one.events, inheritedEventCount: 0 }
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async stat(id) {
            const one = await load('real')
            return { location: { kind: 'jsonl', path: one.path } }
          },
          root: '/nonexistent-sessions-root',
        }
      }
      return undefined
    },
    on() {
      return () => {}
    },
    logger: { debug() {}, info() {}, warn() {} },
  }
}

test('the real phone conversation becomes a native log on the second device', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-e2e-'))
  const repo = join(dir, 'repo')
  const homeA = join(dir, 'homeA')
  const homeB = join(dir, 'homeB')
  const sessionsB = join(dir, 'sessionsB')
  await rm(sessionsB, { recursive: true, force: true })

  try {
    const { SyncRuntime } = await import('../src/runtime.js')
    const { FolderBackend } = await import('../vendor/core/backends.js')

    const config = {
      enabled: true, backend: 'folder', folder: repo, repoUrl: '', branch: 'main', token: '',
      passphrase: 'a long shared passphrase', deviceName: 'phone-a', intervalSec: 0,
      pushOnTurnEnd: false, importNative: true, mirror: true, syncSettings: false,
    }
    const fixtureHeader = parseLogBytes(await readFile(SOURCE)).header
    const runtimeA = new SyncRuntime(fakeHost(SOURCE), config, { workdir: join(homeA, 'repo'), statePath: join(homeA, 'state.json'), mirrorDir: join(homeA, 'mirror'), exportDir: join(homeA, 'export') })
    const first = await runtimeA.sync('test')
    assert.ok(first.pushed > 0, 'device A pushed messages')

    // What landed in the repository: sealed message chunks AND a sealed native log.
    const backend = new FolderBackend(repo)
    const listing = await backend.list('')
    const sessionId = fixtureHeader.id
    assert.ok(listing.some((entry) => entry.path.startsWith(`data/${sessionId}/phone-a/`)), 'portable chunks exist')
    assert.ok(listing.some((entry) => entry.path.startsWith(`native/${sessionId}/phone-a/`)), 'native log chunk exists')
    assert.ok(listing.some((entry) => entry.path === 'key/salt'), 'salt is published')

    // Nothing readable leaked into the repository.
    for (const entry of listing) {
      const bytes = await backend.read(entry.path)
      assert.equal(bytes.includes('DeepSeek Harness'), false, entry.path)
    }

    // Device B reads the same repository and writes a real DSH log.
    const engineB = new (await import('../vendor/core/engine.js')).SyncEngine({
      backend,
      statePath: join(homeB, 'state.json'),
      device: 'phone-b',
    })
    await engineB.open({ passphrase: 'a long shared passphrase' })
    const pulled = await engineB.pull()
    assert.ok(pulled.records.length > 0, 'device B pulled messages')

    const native = await readNativeFrom(backend, engineB, sessionId)
    assert.ok(native !== null)
    const result = await importNativeSession({
      sessionsRoot: sessionsB,
      header: native.header,
      events: native.events,
      fallbackCwd: '/root/workspace',
    })
    assert.equal(result.imported, true)

    // The imported file must be a log DSH itself can parse, with the same events.
    const expectedPath = logPathFor(sessionsB, native.header.cwd, sessionId, 4)
    const importedBytes = await readFile(expectedPath)
    const imported = parseLogBytes(importedBytes)
    const original = parseLogBytes(await readFile(SOURCE))
    assert.equal(imported.header.id, original.header.id)
    assert.equal(imported.events.length, original.events.length)
    assert.deepEqual(imported.events.slice(0, 5), original.events.slice(0, 5))

    // Importing twice must not clobber the existing conversation.
    const again = await importNativeSession({ sessionsRoot: sessionsB, header: native.header, events: native.events, fallbackCwd: '/root/workspace' })
    assert.equal(again.imported, false)
    assert.equal(again.reason, 'exists')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Reassemble a native log from repository chunks, exactly as the plugin does. */
async function readNativeFrom(backend, engine, sessionId) {
  const { decodeNativeChunk } = await import('../vendor/core/store.js')
  const { parseNativeName } = await import('../vendor/core/store.js')
  const listing = await backend.list(`native/${sessionId}/`)
  const parts = []
  for (const entry of listing) {
    const range = parseNativeName(entry.path.split('/').pop() ?? '')
    if (range !== undefined) parts.push({ range, path: entry.path })
  }
  if (parts.length === 0) return null
  parts.sort((a, b) => a.range.first - b.range.first)
  const lines = []
  for (const part of parts) {
    const text = decodeNativeChunk(engine.key, part.path, await backend.read(part.path))
    for (const line of text.split('\n')) if (line.trim() !== '') lines.push(line)
  }
  return { header: JSON.parse(lines[0]), events: lines.slice(1) }
}
