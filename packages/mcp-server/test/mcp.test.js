import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryBackend } from '../../core/src/backends.js'
import { SyncEngine } from '../../core/src/engine.js'

const MCP = fileURLToPath(new URL('../bin/mcp.js', import.meta.url))
const PLUGIN_VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version

function startServer(env) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve !== undefined) {
        pending.delete(message.id)
        resolve(message)
      }
    }
  })
  let nextId = 1
  return {
    child,
    call(method, params) {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000)
        pending.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
    },
    close() {
      child.kill()
    },
  }
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-sync-mcp-'))
}

test('the MCP server advertises the bus tools', async () => {
  const dir = await tempDir()
  const server = startServer({ DSH_SYNC_HOME: dir, DSH_SYNC_PASSPHRASE: 'a long shared passphrase', DSH_SYNC_BACKEND: 'folder', DSH_SYNC_FOLDER: join(dir, 'repo') })
  try {
    const init = await server.call('initialize', {})
    assert.equal(init.result.serverInfo.name, 'dsh-sync')
    assert.equal(init.result.protocolVersion, '2024-11-05')
    // The reported version must track package.json, not a pinned literal.
    assert.equal(init.result.serverInfo.version, PLUGIN_VERSION)
    const list = await server.call('tools/list', {})
    const names = list.result.tools.map((tool) => tool.name)
    assert.deepEqual(names, ['sync_now', 'list_sessions', 'read_session', 'search', 'add_note', 'list_notes'])
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('notes written by one agent are readable through MCP', async () => {
  const dir = await tempDir()
  const server = startServer({ DSH_SYNC_HOME: dir, DSH_SYNC_PASSPHRASE: 'a long shared passphrase', DSH_SYNC_BACKEND: 'folder', DSH_SYNC_FOLDER: join(dir, 'repo'), DSH_SYNC_DEVICE: 'codex' })
  try {
    await server.call('initialize', {})
    const added = await server.call('tools/call', { name: 'add_note', arguments: { title: 'hand-off', body: 'continue with the parser' } })
    assert.equal(added.result.isError, false)
    assert.match(added.result.content[0].text, /saved/)
    const listed = await server.call('tools/call', { name: 'list_notes', arguments: {} })
    assert.match(listed.result.content[0].text, /hand-off/)
    assert.match(listed.result.content[0].text, /continue with the parser/)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('messages pushed by DSH are readable as Markdown over MCP', async () => {
  const dir = await tempDir()
  const repo = join(dir, 'repo')
  // Seed the bus with a DSH-style record, exactly as the plugin would push it.
  const seed = new SyncEngine({ backend: new MemoryBackend(), statePath: join(dir, 'seed.json'), device: 'phone-a' })
  const backend = (await import('../../core/src/backends.js')).FolderBackend
  const seedEngine = new SyncEngine({ backend: new backend(repo), statePath: join(dir, 'seed.json'), device: 'phone-a' })
  await seedEngine.open({ passphrase: 'a long shared passphrase' })
  await seedEngine.push([{
    id: 'msg-1',
    origin: { device: 'phone-a', session: 'session-x', root: 'session-x', parent: null, seq: 0, ts: 1_700_000_000_000, eventType: 'user/message' },
    agent: 'dsh', kind: 'message', role: 'user', text: 'please continue the sync work',
  }, {
    id: 'msg-2',
    origin: { device: 'phone-a', session: 'session-x', root: 'session-x', parent: null, seq: 1, ts: 1_700_000_001_000, eventType: 'assistant/message' },
    agent: 'dsh', kind: 'message', role: 'assistant', text: 'done: the engine is tested',
  }])

  const server = startServer({ DSH_SYNC_HOME: dir, DSH_SYNC_PASSPHRASE: 'a long shared passphrase', DSH_SYNC_BACKEND: 'folder', DSH_SYNC_FOLDER: repo, DSH_SYNC_DEVICE: 'codex' })
  try {
    await server.call('initialize', {})
    await server.call('tools/call', { name: 'sync_now', arguments: {} })
    const sessions = await server.call('tools/call', { name: 'list_sessions', arguments: {} })
    assert.match(sessions.result.content[0].text, /session-x/)
    const read = await server.call('tools/call', { name: 'read_session', arguments: { session_id: 'session-x' } })
    assert.match(read.result.content[0].text, /please continue the sync work/)
    assert.match(read.result.content[0].text, /### Assistant/)
    const found = await server.call('tools/call', { name: 'search', arguments: { query: 'engine' } })
    assert.match(found.result.content[0].text, /engine is tested/)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing passphrase is reported, not crashed on', async () => {
  const dir = await tempDir()
  const server = startServer({ DSH_SYNC_HOME: dir, DSH_SYNC_PASSPHRASE: '', DSH_SYNC_BACKEND: 'folder', DSH_SYNC_FOLDER: join(dir, 'repo') })
  try {
    await server.call('initialize', {})
    const call = await server.call('tools/call', { name: 'list_sessions', arguments: {} })
    assert.equal(call.result.isError, true)
    assert.match(call.result.content[0].text, /passphrase/)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
