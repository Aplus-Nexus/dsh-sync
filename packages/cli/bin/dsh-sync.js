#!/usr/bin/env node
/**
 * dsh-sync command line, for the parts a phone panel cannot do: first-run
 * setup, checking that two devices really share a key, and exporting a
 * conversation to Markdown.
 *
 *   dsh-sync init --repo https://github.com/you/dsh-sync-data.git
 *   dsh-sync status
 *   dsh-sync ingest <file> --session <id> [--device <name>] [--agent <name>] [--native] / pull
 *   dsh-sync export <session> --out chat.md
 */
import { readFile, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  FolderBackend,
  GitBackend,
  SyncEngine,
  canonicalJson,
  comparePortable,
  digestOf,
  decodeChunk,
  humanBytes,
  parseJson,
  titleOf,
} from '../vendor/core/index.js'

const CONFIG_DIR = process.env.DSH_SYNC_HOME ?? join(homedir(), '.dsh-sync')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

const HELP = `dsh-sync — message-level encrypted sync for DSH / dsh-go / Codex

Usage
  dsh-sync init [--repo <url>] [--folder <dir>] [--device <name>] [--passphrase <phrase>]
  dsh-sync status
  dsh-sync ingest <file> --session <id> [--device <name>] [--agent <name>] [--native]
  dsh-sync pull
  dsh-sync verify
  dsh-sync extras [--settings] [--skills] [--dry-run]
  dsh-sync models [--show] [--publish] [--apply] [--dry-run]
  dsh-sync sessions
  dsh-sync export <session-id> [--out <file>] [--format md|json]
  dsh-sync note --title <t> --body <b>

Environment
  DSH_SYNC_HOME       state directory (default ~/.dsh-sync)
  DSH_SYNC_REPO       data repository URL
  DSH_SYNC_PASSPHRASE encryption passphrase
  DSH_SYNC_GIT_TOKEN  repository access token
`

const DSH_HOME = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** `## 用户` / `### Assistant:` and similar transcript headings. */
const HEADING = /^#{1,6}\s*(用户|助手|User|Assistant|You|AI|Human|Codex|DSH)\s*:?\s*$/i

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      options._ = [...(options._ ?? []), token]
      continue
    }
    const key = token.slice(2)
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = next
    i += 1
  }
  return { command, options }
}

async function loadConfig() {
  const text = await readFile(CONFIG_PATH, 'utf8').catch(() => '')
  return parseJson(text, {}) ?? {}
}

async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function resolved(config) {
  return {
    backend: process.env.DSH_SYNC_BACKEND ?? config.backend ?? 'git',
    repoUrl: process.env.DSH_SYNC_REPO ?? config.repoUrl ?? '',
    branch: config.branch ?? 'main',
    token: process.env.DSH_SYNC_GIT_TOKEN ?? config.token ?? '',
    folder: process.env.DSH_SYNC_FOLDER ?? config.folder ?? '',
    passphrase: process.env.DSH_SYNC_PASSPHRASE ?? config.passphrase ?? '',
    device: process.env.DSH_SYNC_DEVICE ?? config.device ?? 'cli',
  }
}

async function engineFor(config) {
  const settings = resolved(config)
  if (settings.passphrase.length < 8) throw new Error('set DSH_SYNC_PASSPHRASE (at least 8 characters) or run `dsh-sync init`')
  const backend = settings.backend === 'folder'
    ? new FolderBackend(settings.folder === '' ? join(CONFIG_DIR, 'repo') : settings.folder)
    : new GitBackend({ url: settings.repoUrl, workdir: join(CONFIG_DIR, 'repo'), token: settings.token, branch: settings.branch, identity: `dsh-sync ${settings.device} <sync@localhost>` })
  const engine = new SyncEngine({ backend, statePath: join(CONFIG_DIR, 'state.json'), mirrorDir: join(CONFIG_DIR, 'mirror'), device: settings.device })
  await engine.open({ passphrase: settings.passphrase })
  return engine
}

/** Read every dumped record of one session straight from the repository. */
async function readAll(engine, sessionId) {
  const listing = await engine.backend.list('data/')
  const records = []
  for (const entry of listing) {
    if (!entry.path.startsWith(`data/${sessionId}/`)) continue
    try {
      records.push(...decodeChunk(engine.key, entry.path, await engine.backend.read(entry.path)).filter((record) => record.__meta === undefined))
    } catch (error) {
      process.stderr.write(`skipped ${entry.path}: ${error.message}\n`)
    }
  }
  const seen = new Set()
  return records.filter((record) => {
    if (seen.has(record.id)) return false
    seen.add(record.id)
    return true
  }).sort(comparePortable)
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const config = await loadConfig()

  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(HELP)
    return 0
  }

  if (command === 'init') {
    const next = {
      ...config,
      backend: options.folder !== undefined ? 'folder' : 'git',
      ...(options.repo === undefined ? {} : { repoUrl: options.repo }),
      ...(options.folder === undefined ? {} : { folder: options.folder }),
      ...(options.device === undefined ? {} : { device: options.device }),
      ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
    }
    if (options.token !== undefined) next.token = options.token
    await saveConfig(next)
    const engine = await engineFor(next)
    process.stdout.write(`准备就绪\n  设备：${engine.device}\n  密钥指纹：${engine.fingerprint()}\n  配置：${CONFIG_PATH}\n`)
    process.stdout.write('把这台设备的口令和仓库写到其他设备上，指纹一致才说明是同一把钥匙。\n')
    return 0
  }

  if (command === 'status') {
    const engine = await engineFor(config)
    const status = engine.status()
    process.stdout.write(`${canonicalJson(status)}\n`)
    return 0
  }

  if (command === 'verify') {
    const engine = await engineFor(config)
    const listing = await engine.backend.list('data/')
    let ok = 0
    let bad = 0
    for (const entry of listing) {
      try {
        decodeChunk(engine.key, entry.path, await engine.backend.read(entry.path))
        ok += 1
      } catch {
        bad += 1
      }
    }
    process.stdout.write(`可解密 ${ok} 块，无法解密 ${bad} 块，指纹 ${engine.fingerprint()}\n`)
    return bad === 0 ? 0 : 2
  }

  if (command === 'extras') {
    const engine = await engineFor(config)
    const { collectExtras, publishExtras, restoreExtras } = await import('../vendor/core/index.js')
    if (options['dry-run'] === true) {
      const plan = await restoreExtras(engine, { home: config.home ?? DSH_HOME(), kinds: ['settings', 'skills', 'ui'], dryRun: true })
      for (const item of plan.applied) process.stdout.write(`会写入 ${item.file}（来自 ${item.device}）\n`)
      for (const item of plan.conflicts) process.stdout.write(`冲突：${item.file} 本地有改动，远端副本将另存为 .remote\n`)
      if (plan.applied.length === 0 && plan.conflicts.length === 0) process.stdout.write('没有需要写入的内容。\n')
      return 0
    }
    if (options.pull === true) {
      const plan = await restoreExtras(engine, { home: config.home ?? DSH_HOME(), kinds: ['settings', 'skills', 'ui'] })
      process.stdout.write(`写入 ${plan.applied.length} 个文件，${plan.conflicts.length} 个冲突\n`)
      return 0
    }
    const items = await collectExtras({ home: config.home ?? DSH_HOME(), settings: options.settings === true, skills: options.skills === true, ui: options.skills === true })
    const written = await publishExtras(engine, items)
    process.stdout.write(`发布 ${written.length} 项（设置/技能/界面）\n`)
    return 0
  }

  if (command === 'models') {
    const { readModelConfig, describeRoutes, mergeModelConfig, profilePatchPath } = await import('../vendor/core/index.js')
    const home = config.home ?? DSH_HOME()
    const patch = profilePatchPath(home, config.profile ?? 'web')
    const engine = options.publish === true || options.apply === true ? await engineFor(config) : null

    if (options.publish === true) {
      const local = await readModelConfig(patch)
      if (local === null) throw new Error('本机 patch 里没有模型配置可发布')
      const { publishExtras } = await import('../vendor/core/extras.js')
      const written = await publishExtras(engine, [{ kind: 'models', name: 'model-config', payload: { entries: local.entries, redacted: true } }])
      process.stdout.write(`已发布 ${written.length} 项模型配置（不含密钥）\n`)
      return 0
    }

    if (options.apply === true) {
      const { readExtras } = await import('../vendor/core/extras.js')
      const published = await readExtras(engine, 'models')
      if (published.length === 0) throw new Error('仓库里还没有模型配置')
      const result = await mergeModelConfig(patch, published[0].payload.entries, { dryRun: options['dry-run'] === true })
      process.stdout.write(`来自 ${published[0].device}：新建 ${result.created.length}，更新 ${result.updated.length}，已一致 ${result.unchanged}，保留本机密钥 ${result.keptSecrets.length}\n`)
      for (const secret of result.keptSecrets) process.stdout.write(`  密钥保留：${secret}\n`)
      if (options['dry-run'] === true) process.stdout.write('（dry run，未写入）\n')
      return 0
    }

    const local = await readModelConfig(patch)
    if (local === null) {
      process.stdout.write('本机 patch 里没有模型配置。\n')
      return 0
    }
    const routes = describeRoutes(local.entries)
    process.stdout.write(`对话路由：${routes.chat ?? '—'}\n`)
    const searchLine = routes.searchKind === 'model'
      ? `模型 ${routes.searchModel ?? '—'}`
      : `专用 API ${routes.searchProvider ?? '—'}`
    process.stdout.write(`搜索：${searchLine}\n`)
    process.stdout.write(`渠道：${routes.providers.join(', ') || '—'}（${routes.models} 个模型）\n`)
    return 0
  }

  if (command === 'sessions') {
    const engine = await engineFor(config)
    const rows = engine.sessions()
    if (rows.length === 0) {
      process.stdout.write('还没有同步过的对话。\n')
      return 0
    }
    for (const row of rows) {
      process.stdout.write(`${row.sessionId}  ${row.records.toString().padStart(4)} 条  ${row.device}  ${row.title}\n`)
    }
    return 0
  }

  if (command === 'pull') {
    const engine = await engineFor(config)
    const result = await engine.pull()
    process.stdout.write(`拉取 ${result.records.length} 条，${humanBytes(result.bytes)}${result.skipped > 0 ? `，跳过 ${result.skipped} 块` : ''}\n`)
    return 0
  }

  if (command === 'ingest') {
    // Bring a conversation produced by another tool (Codex rollout export, a
    // DeepSeek chat export, a plain Markdown transcript) onto the bus.
    const file = options._?.[0]
    if (file === undefined) throw new Error('ingest needs a file: `dsh-sync ingest chat.md --session <id> --device <name>`')
    const engine = await engineFor(config)
    const device = String(options.device ?? 'external')
    const session = String(options.session ?? `imported-${Date.now().toString(36)}`)
    const raw = await readFile(file, 'utf8')
    const records = parseTranscript(raw, { session, device, agent: String(options.agent ?? 'external') })
    if (records.length === 0) throw new Error('no messages found in that file')
    const result = await engine.push(records)
    process.stdout.write(`导入 ${session}：${result.records} 条，${humanBytes(result.bytes)}\n`)
    if (options.native === true) {
      // Also materialize it as a DSH session on this machine, so the app lists it
      // and the conversation can be continued here.
      const { synthesizeSession, synthesizeSessionId, writeLog } = await import('../vendor/core/index.js')
      const targetId = synthesizeSessionId(session)
      const cwd = process.env.DSH_SYNC_CWD ?? process.cwd()
      const { header, events } = synthesizeSession({ sessionId: targetId, records, cwd, sourceLabel: String(options.agent ?? 'external') })
      const written = await writeLog({ sessionsRoot: join(DSH_HOME(), 'sessions'), header, events })
      process.stdout.write(written.imported
        ? `已生成原生会话 ${written.sessionId}（${events.length} 个事件）\n`
        : `原生会话已存在，未覆盖：${written.path ?? targetId}\n`)
    }
    return 0
  }

  if (command === 'note') {
    const engine = await engineFor(config)
    if (typeof options.title !== 'string' || typeof options.body !== 'string') throw new Error('note needs --title and --body')
    const note = await engine.addNote({ title: options.title, body: options.body })
    process.stdout.write(`已写入笔记 ${note.id}\n`)
    return 0
  }

  if (command === 'export') {
    const sessionId = options._?.[0]
    if (sessionId === undefined) throw new Error('export needs a session id (see `dsh-sync sessions`)')
    const engine = await engineFor(config)
    const records = await readAll(engine, sessionId)
    if (records.length === 0) throw new Error(`no synced messages for ${sessionId}`)
    const format = options.format ?? 'md'
    const out = options.out
    const text = format === 'json'
      ? `${canonicalJson(records)}\n`
      : toMarkdown(records)
    if (typeof out === 'string') {
      await writeFile(out, text)
      process.stdout.write(`写入 ${out}（${records.length} 条）\n`)
    } else {
      process.stdout.write(text)
    }
    return 0
  }

  process.stderr.write(`unknown command: ${command}\n\n${HELP}`)
  return 1
}

/**
 * Read either a Markdown transcript (`## User` / `## Assistant` headings, the
 * shape DSH's own export uses) or JSONL of `{ role, text }`.
 */
function parseTranscript(raw, { session, device, agent }) {
  const records = []
  const push = (role, text, index) => {
    const body = text.trim()
    if (body === '') return
    records.push({
      id: digestOf(`${device}:${session}:${index}:${role}:${body}`).slice(0, 32),
      origin: { device, session, root: session, parent: null, seq: index, ts: Date.now() + index, eventType: role === 'assistant' ? 'assistant/message' : 'user/message' },
      agent,
      kind: 'message',
      role,
      text: body,
    })
  }
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{')) {
    let index = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      const value = parseJson(line)
      if (value === undefined) continue
      const role = value.role === 'assistant' || value.role === 'model' ? 'assistant' : 'user'
      push(role, String(value.text ?? value.content ?? ''), index)
      index += 1
    }
    return records
  }
  let currentRole = 'user'
  let buffer = []
  let index = 0
  const flush = () => {
    if (buffer.length > 0) {
      push(currentRole, buffer.join('\n'), index)
      index += 1
    }
    buffer = []
  }
  for (const line of raw.split('\n')) {
    // No `\b`: CJK labels are not word characters, so a boundary assertion after
    // 用户 never matches and the whole transcript would collapse into one message.
    const heading = HEADING.exec(line.trim())
    if (heading !== null) {
      flush()
      const label = heading[1].toLowerCase()
      currentRole = ['助手', 'assistant', 'ai', 'codex', 'dsh'].includes(label) ? 'assistant' : 'user'
      continue
    }
    if (line.startsWith('# ') && buffer.length === 0 && records.length === 0) continue
    buffer.push(line)
  }
  flush()
  return records
}

function toMarkdown(records) {
  const lines = [`# ${titleOf(records)}`, '']
  for (const record of records) {
    if (record.kind === 'title') continue
    if (record.kind === 'tool-result') continue
    if (record.kind === 'tool-call') {
      lines.push(`- \`${record.tool?.name ?? 'tool'}\` — ${String(record.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
      continue
    }
    const who = record.role === 'user' ? '用户' : '助手'
    lines.push(`## ${who}`, '', String(record.text ?? '').trim(), '')
  }
  return lines.join('\n')
}

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  process.stderr.write(`dsh-sync: ${error.message}\n`)
  process.exitCode = 1
})
