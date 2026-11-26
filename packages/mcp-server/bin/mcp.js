#!/usr/bin/env node
/**
 * dsh-sync MCP server: the bus other agents (Codex, Claude Code, anything that
 * speaks MCP) use to read and write the same conversation bus as DSH.
 *
 * It speaks JSON-RPC over stdio and depends on nothing but Node. Runs on a
 * phone, a laptop or a server; the state directory decides which device it is.
 */
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Advertise the real version: a pinned number drifts from the package on every
// release, and clients compare versions when they reconnect.
const SERVER_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  FolderBackend,
  GitBackend,
  SyncEngine,
  canonicalJson,
  comparePortable,
  parseJson,
  titleOf,
} from '../vendor/core/index.js'

const SERVER = { name: 'dsh-sync', version: SERVER_VERSION }
const PROTOCOL = '2024-11-05'

const TOOLS = [
  {
    name: 'sync_now',
    description: 'Push local changes and pull messages from your other devices. Call this before reading context so you see the newest messages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_sessions',
    description: 'List synced conversations, newest activity first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many to return (default 20).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_session',
    description: 'Read the full message history of one synced conversation, oldest first.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id from list_sessions.' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum messages (default 200).' },
        format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format (default markdown).' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'Search every synced message for a case-insensitive substring.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum hits (default 20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_note',
    description: 'Write a note other agents can read on their next sync. Use it for decisions, hand-offs and open questions.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title.' },
        body: { type: 'string', description: 'Note body, Markdown allowed.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_notes',
    description: 'Read notes other agents left on the bus, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        since_ms: { type: 'integer', description: 'Only notes newer than this Unix time in milliseconds.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum notes (default 20).' },
      },
      additionalProperties: false,
    },
  },
]

const CONFIG_PATH = process.env.DSH_SYNC_CONFIG ?? join(homedir(), '.dsh-sync', 'config.json')

async function loadConfig() {
  const text = await readFile(CONFIG_PATH, 'utf8').catch(() => '')
  const file = parseJson(text, {}) ?? {}
  return {
    backend: process.env.DSH_SYNC_BACKEND ?? file.backend ?? 'git',
    repoUrl: process.env.DSH_SYNC_REPO ?? file.repoUrl ?? '',
    branch: process.env.DSH_SYNC_BRANCH ?? file.branch ?? 'main',
    token: process.env.DSH_SYNC_GIT_TOKEN ?? file.token ?? '',
    folder: process.env.DSH_SYNC_FOLDER ?? file.folder ?? '',
    passphrase: process.env.DSH_SYNC_PASSPHRASE ?? file.passphrase ?? '',
    device: process.env.DSH_SYNC_DEVICE ?? file.device ?? 'mcp',
    home: process.env.DSH_SYNC_HOME ?? file.home ?? join(homedir(), '.dsh-sync'),
    agent: file.agent ?? 'mcp',
  }
}

let enginePromise = null

function engine() {
  if (enginePromise !== null) return enginePromise
  enginePromise = (async () => {
    const config = await loadConfig()
    if (config.passphrase.length < 8) throw new Error(`set a passphrase of at least 8 characters in ${CONFIG_PATH} (or DSH_SYNC_PASSPHRASE)`)
    await mkdir(config.home, { recursive: true })
    const backend = config.backend === 'folder'
      ? new FolderBackend(config.folder === '' ? join(config.home, 'repo') : config.folder)
      : new GitBackend({ url: config.repoUrl, workdir: join(config.home, 'repo'), token: config.token, branch: config.branch, identity: `dsh-sync ${config.device} <sync@localhost>` })
    const instance = new SyncEngine({ backend, statePath: join(config.home, 'state.json'), mirrorDir: join(config.home, 'mirror'), device: config.device, agent: config.agent })
    await instance.open({ passphrase: config.passphrase })
    return instance
  })()
  return enginePromise
}

/** Read every message of one session from the local mirror, decrypted on demand. */
async function readSessionMessages(instance, sessionId) {
  const { open } = await import('../vendor/core/index.js')
  const records = []
  const listing = await instance.backend.list('data/')
  for (const entry of listing) {
    const parts = entry.path.split('/')
    if (parts[1] !== sessionId) continue
    try {
      const text = open(instance.key, await instance.backend.read(entry.path), `dsh-sync:chunk:${entry.path}`).toString('utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const value = parseJson(line)
        if (value === null || value === undefined || value.__meta !== undefined) continue
        records.push(value)
      }
    } catch {}
  }
  const seen = new Set()
  return records.filter((record) => {
    if (typeof record.id !== 'string' || seen.has(record.id)) return false
    seen.add(record.id)
    return true
  }).sort(comparePortable)
}

function toMarkdown(records) {
  const lines = [`# ${titleOf(records)}`, '']
  for (const record of records) {
    if (record.kind === 'title') continue
    const stamp = record.origin?.ts ? new Date(record.origin.ts).toISOString().slice(0, 16).replace('T', ' ') : ''
    if (record.kind === 'tool-call') {
      lines.push(`- \`${record.tool?.name ?? 'tool'}\` ${stamp} — ${oneLine(record.text, 200)}`)
      continue
    }
    if (record.kind === 'tool-result') continue
    const who = record.role === 'user' ? 'User' : record.role === 'assistant' ? 'Assistant' : record.role
    lines.push(`### ${who}${stamp === '' ? '' : ` · ${stamp}`}`, '', String(record.text ?? '').trim(), '')
  }
  return lines.join('\n')
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

async function callTool(name, args) {
  const instance = await engine()
  switch (name) {
    case 'sync_now': {
      const pulled = await instance.pull()
      return `pulled ${pulled.records.length} message(s)${pulled.skipped > 0 ? `, skipped ${pulled.skipped} corrupted chunk(s)` : ''}`
    }
    case 'list_sessions': {
      const limit = args?.limit ?? 20
      const rows = instance.sessions().slice(0, limit)
      if (rows.length === 0) return 'No synced conversations yet. Run sync_now first.'
      return rows.map((row) => `- ${row.title} — \`${row.sessionId}\` (${row.device}, ${row.records} messages)`).join('\n')
    }
    case 'read_session': {
      const records = await readSessionMessages(instance, args?.session_id)
      if (records.length === 0) return `No messages for ${args?.session_id}.`
      const limit = args?.limit ?? 200
      const sliced = records.slice(0, limit)
      return args?.format === 'json' ? canonicalJson(sliced) : toMarkdown(sliced)
    }
    case 'search': {
      const query = String(args?.query ?? '').toLowerCase()
      if (query === '') return 'Empty query.'
      const limit = args?.limit ?? 20
      const hits = []
      for (const row of instance.sessions()) {
        const records = await readSessionMessages(instance, row.sessionId)
        for (const record of records) {
          if (String(record.text ?? '').toLowerCase().includes(query)) {
            hits.push(`- ${row.title} · ${record.role}: ${oneLine(record.text, 160)}`)
            if (hits.length >= limit) break
          }
        }
        if (hits.length >= limit) break
      }
      return hits.length === 0 ? 'Nothing matched.' : hits.join('\n')
    }
    case 'add_note': {
      const note = await instance.addNote({ title: String(args?.title ?? 'note'), body: String(args?.body ?? ''), tags: args?.tags ?? [] })
      return `Note saved (${note.id}).`
    }
    case 'list_notes': {
      const notes = await instance.listNotes({ since: args?.since_ms ?? 0, limit: args?.limit ?? 20 })
      if (notes.length === 0) return 'No notes yet.'
      return notes.map((note) => `## ${note.title}\n_${new Date(note.ts).toISOString().slice(0, 16).replace('T', ' ')} · ${note.device}_\n\n${note.body}`).join('\n\n')
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER } }
  }
  if (method === 'notifications/initialized') return null
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    try {
      const text = await callTool(params?.name, params?.arguments ?? {})
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } }
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `dsh-sync: ${error.message}` }], isError: true } }
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (id === undefined) return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let request
  try {
    request = JSON.parse(trimmed)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  void handle(request).then((reply) => {
    if (reply !== null) send(reply)
  })
})
