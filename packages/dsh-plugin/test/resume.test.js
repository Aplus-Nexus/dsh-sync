/**
 * A conversation continued on a second device.
 *
 * The interesting case is not the first copy, it is the second writer: device B
 * imports a conversation and then keeps talking. Its new events must reach the
 * bus without re-sending the imported prefix, and a third device must see one
 * dense, duplicate-free log that still validates.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { sampleHeader, sampleEventLines } from './fixtures.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { encodeLogBytes, parseLogBytes } from '../vendor/core/native.js'
import { importNativeSession } from '../vendor/core/import.js'
import { SyncEngine } from '../vendor/core/engine.js'
import { FolderBackend } from '../vendor/core/backends.js'
import { SyncRuntime } from '../src/runtime.js'

const PASS = 'a long shared passphrase'
const REAL = process.env.DSH_SYNC_REAL_LOG
  ?? '/root/.dsh/sessions/--root-workspace--/session-8290bedb-de30-40db-93b2-8679d588d873/session.v4.jsonl.zstd'

/** Build the same log shape from the fixture when this machine has no real one. */
async function materializeFixture(dir) {
  const path = join(dir, 'fixture.v4.jsonl.zstd')
  await writeFile(path, encodeLogBytes(sampleHeader({ sessionId: 'session-resume' }), sampleEventLines({ turns: 4 })))
  return path
}

function silentCtx() {
  return { get: () => undefined, on: () => () => {}, logger: { debug() {}, info() {}, warn: (m) => { if (process.env.DSH_SYNC_DEBUG) console.error(m) } } }
}

test('a conversation continued on a second device merges once, in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-resume-'))
  const repo = join(dir, 'repo')
  try {
    // Device A publishes the original conversation.
    const a = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: PASS })
    // The repository must exist before B opens it, so the key salt is published first.
    const { SALT_PATH } = await import('../vendor/core/store.js')
    assert.equal((await readFile(join(repo, SALT_PATH), 'utf8')).trim().length > 0, true)

    const sourcePath = existsSync(REAL) ? REAL : await materializeFixture(dir)
    const original = parseLogBytes(await readFile(sourcePath))
    const { type, ...header } = original.header
    const { nativePath, encodeNativeChunk } = await import('../vendor/core/store.js')
    const first = 0
    const last = original.events.length - 1
    const path = nativePath(header.id, 'phone-a', first, last)
    const chunk = [`${JSON.stringify(original.header)}`, ...original.events].join('\n') + '\n'
    await a.backend.write(path, encodeNativeChunk(a.key, path, chunk))
    await a.backend.sync({ direction: 'push', message: 'a' })

    // Device B pulls, imports, and continues the conversation.
    const b = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'b.json'), device: 'phone-b' })
    await b.open({ passphrase: PASS })
    await b.pull()
    const runtimeB = new SyncRuntime(silentCtx(), { enabled: false, importNative: true }, { workdir: join(dir, 'bw'), statePath: join(dir, 'b.json'), mirrorDir: null, exportDir: null })
    runtimeB.engine = b
    const native = await runtimeB.readNativeLog(b, header.id)
    assert.notEqual(native, null)

    const sessionsB = join(dir, 'sessionsB')
    const imported = await importNativeSession({ sessionsRoot: sessionsB, header: native.header, events: native.events, fallbackCwd: '/tmp/b' })
    assert.equal(imported.imported, true)

    const baseSeq = JSON.parse(original.events.at(-1)).seq
    const extra = [
      JSON.stringify({ type: 'turn/start', seq: baseSeq + 1, time: 1, data: { turn: 99 } }),
      JSON.stringify({ type: 'user/message', seq: baseSeq + 2, time: 2, data: { role: 'user', content: [{ type: 'text', text: 'continued on the laptop' }] }, surfaceOp: 'append' }),
      JSON.stringify({ type: 'turn/end', seq: baseSeq + 3, time: 3, data: { turn: 99, reason: { kind: 'completed' } } }),
    ]
    const { writeFile } = await import('node:fs/promises')
    await writeFile(imported.path, encodeLogBytes(original.header, [...original.events, ...extra]))

    // B pushes only its continuation, never the imported prefix.
    const deviceB = runtimeB.device
    const before = (await b.backend.list(`native/${header.id}/${deviceB}/`)).length
    b.state.sessions[header.id] = { importedThroughSeq: baseSeq, pushedSeq: baseSeq, localPath: imported.path }
    await runtimeB.pushNative(b, { [header.id]: header })
    if (process.env.DSH_SYNC_DEBUG) console.error('lastError', runtimeB.lastError)
    const after = await b.backend.list(`native/${header.id}/${deviceB}/`)
    assert.equal(after.length, before + 1, 'one continuation chunk was written')
    const pushed = after[after.length - 1]
    const pushedText = (await import('../vendor/core/store.js')).decodeNativeChunk(b.key, pushed.path, await b.backend.read(pushed.path))
    assert.equal(pushedText.includes('continued on the laptop'), true)
    // The continuation must not restate the imported prefix.
    assert.ok(pushedText.length < 4000, `continuation chunk is small (${pushedText.length} bytes)`)
    assert.equal(pushedText.includes('please'), false)

    // Device C sees one dense log with every event exactly once.
    const c = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'c.json'), device: 'phone-c' })
    await c.open({ passphrase: PASS })
    await c.pull()
    const runtimeC = new SyncRuntime(silentCtx(), { enabled: false }, { workdir: join(dir, 'cw'), statePath: join(dir, 'c.json'), mirrorDir: null, exportDir: null })
    runtimeC.engine = c
    const merged = await runtimeC.readNativeLog(c, header.id)
    const seqs = merged.events.map((line) => JSON.parse(line).seq)
    assert.equal(seqs.length, original.events.length + extra.length)
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicated events')
    assert.deepEqual(seqs, seqs.map((_, index) => index), 'sequence stays dense')
    assert.equal(merged.events.at(-1).includes('continued on the laptop') || merged.events.at(-2).includes('continued on the laptop'), true)

    // And the merged log still decompresses as one valid DSH log.
    const roundTrip = parseLogBytes(encodeLogBytes(merged.header, merged.events))
    assert.equal(roundTrip.header.id, header.id)
    assert.equal(roundTrip.events.length, merged.events.length)
    assert.equal(zstdDecompressSync(encodeLogBytes(merged.header, merged.events)).toString('utf8').split('\n').filter(Boolean).length, merged.events.length + 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
