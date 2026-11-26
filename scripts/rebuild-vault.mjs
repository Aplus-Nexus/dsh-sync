#!/usr/bin/env node
/**
 * Rebuild a vault from the live conversations, discarding the history an
 * earlier version bloated.
 *
 * This does NOT try to salvage the old repository: the history is 11 GB of
 * re-sealed ciphertext, every commit holding a full re-encryption of the same
 * conversations. The plaintext is on this device, so the honest repair is to
 * publish one clean commit and delete the rest.
 *
 *   node scripts/rebuild-vault.mjs --yes
 *
 * Every conversation this device owns is pushed once, with the fixed engine, so
 * the resulting repository holds each chunk exactly once.
 *
 * Two steps, in this order:
 *   1. `--fresh-clone` re-clones without history into `repo-rebuild`, so the
 *      push arrives as one initial commit instead of a 421-commit mountain.
 *   2. the caller then promotes that clone and deletes the old refs, which is
 *      what actually reclaims the space on the server.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SyncRuntime } from '../packages/dsh-plugin/src/runtime.js'
import { GitBackend } from '../packages/core/src/git-backend.js'
import { SyncEngine } from '../packages/core/src/engine.js'
import { parseLogBytes } from '../packages/core/src/native.js'

const args = process.argv.slice(2)
const dryRun = !args.includes('--yes')
const configPath = process.env.DSH_SYNC_CONFIG ?? '/root/.dsh/dsh-sync/runtime.json'

async function loadConfig() {
  const text = await readFile(configPath, 'utf8').catch(() => '')
  if (text.trim() === '') throw new Error(`write the runtime config first: ${configPath}`)
  const parsed = JSON.parse(text)
  for (const key of ['repoUrl', 'passphrase']) {
    if (typeof parsed[key] !== 'string' || parsed[key] === '') throw new Error(`runtime config is missing ${key}`)
  }
  return parsed
}

async function collectHost(sessionsRoot) {
  const persisted = []
  for (const project of await readdir(sessionsRoot)) {
    if (project.startsWith('.')) continue
    let dirs = []
    try { dirs = await readdir(join(sessionsRoot, project)) } catch { continue }
    for (const name of dirs) {
      const full = join(sessionsRoot, project, name)
      if (!(await stat(full)).isDirectory()) continue
      const log = (await readdir(full)).find((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f))
      if (log === undefined) continue
      const path = join(full, log)
      const parsed = parseLogBytes(await readFile(path))
      const { type, ...header } = parsed.header
      persisted.push({ header, events: parsed.events.map((line) => JSON.parse(line)), path })
    }
  }
  return {
    persisted,
    host: {
      get(name) {
        if (name === 'sessionQuery') return {
          async listSessions() { return persisted.map((p) => ({ header: p.header, live: true, persisted: true })) },
          async readSession(id) {
            const found = persisted.find((p) => p.header.id === id)
            if (found === undefined) throw new Error(`no such session: ${id}`)
            return { session: found.header, events: found.events, inheritedEventCount: 0 }
          },
        }
        if (name === 'sessionPersistence') return {
          root: sessionsRoot,
          async stat(id) {
            const found = persisted.find((p) => p.header.id === id)
            return found === undefined ? undefined : { location: { kind: 'jsonl', path: found.path } }
          },
        }
        return undefined
      },
      on: () => () => {},
      logger: { debug() {}, info() {}, warn: (m) => process.stderr.write(`warn: ${m}\n`) },
    },
  }
}

const config = await loadConfig()
const sessionsRoot = config.sessionsRoot ?? '/root/.dsh/sessions'
const home = config.home ?? '/root/.dsh/dsh-sync'
const { persisted, host } = await collectHost(sessionsRoot)

process.stdout.write(`sessions on this device: ${persisted.length}\n`)
if (dryRun) {
  process.stdout.write('dry run: pass --yes to publish one clean commit\n')
  process.stdout.write('the old repository history is NOT modified by this script\n')
  process.exit(0)
}

const repoDir = args.includes('--fresh-clone') ? `${home}/repo-rebuild` : `${home}/repo`

// The live state file, never a throwaway one. Deleting it resets the cursor,
// and a reset cursor re-publishes every conversation — the exact defect that
// made a vault grow without bound. Only `--reset-cursor` starts a new cursor,
// and it says so out loud.
const statePath = `${home}/state.json`
if (args.includes('--reset-cursor')) {
  await (await import('node:fs/promises')).rm(statePath, { force: true })
  process.stderr.write('warning: cursor reset; every conversation will be published again\n')
}

const runtime = new SyncRuntime(host, {
  enabled: false,
  backend: 'git',
  repoUrl: config.repoUrl,
  branch: config.branch ?? 'main',
  token: config.token ?? '',
  passphrase: config.passphrase,
  deviceName: config.deviceName ?? 'this-phone',
  intervalSec: 0,
  pushOnTurnEnd: false,
  importNative: true,
  mirror: false,
  syncSettings: false,
  syncSkills: false,
  pushScope: 'all',
  workdir: repoDir,
  folder: '',
}, {
  workdir: repoDir,
  statePath,
  mirrorDir: null,
  exportDir: null,
  home,
})

const started = Date.now()
const result = await runtime.sync('rebuild')
process.stdout.write(`pushed ${result.pushed} messages, imported ${result.imported}, ${Math.round((Date.now() - started) / 1000)}s\n`)
process.stdout.write(`state: ${statePath}\n`)
