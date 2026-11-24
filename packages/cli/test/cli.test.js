import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/dsh-sync.js', import.meta.url))
const PASSPHRASE = 'a long shared passphrase'

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-cli-'))
  const repo = join(dir, 'repo')
  const env = {
    DSH_SYNC_HOME: join(dir, 'home'),
    DSH_SYNC_BACKEND: 'folder',
    DSH_SYNC_FOLDER: repo,
    DSH_SYNC_PASSPHRASE: PASSPHRASE,
    DSH_SYNC_DEVICE: 'cli-a',
  }
  return { dir, repo, env }
}

test('init reports a stable key fingerprint', async () => {
  const { dir, env } = await workspace()
  try {
    const result = await run(['init', '--device', 'phone-a'], env)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /密钥指纹/)
    const again = await run(['init', '--device', 'phone-a'], env)
    assert.equal(again.code, 0)
    const first = /密钥指纹：(\w+)/.exec(result.stdout)[1]
    const second = /密钥指纹：(\w+)/.exec(again.stdout)[1]
    assert.equal(first, second)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a Markdown transcript is ingested, listed and exported', async () => {
  const { dir, env } = await workspace()
  try {
    const source = join(dir, 'chat.md')
    await writeFile(source, '# 与 Codex 的对话\n\n## 用户\n\n把同步做完\n\n## 助手\n\n引擎已经过测试\n')
    const ingest = await run(['ingest', source, '--session', 'codex-1', '--device', 'laptop', '--agent', 'codex'], env)
    assert.equal(ingest.code, 0, ingest.stderr)
    assert.match(ingest.stdout, /导入 codex-1/)
    const sessions = await run(['sessions'], env)
    assert.match(sessions.stdout, /codex-1/)
    const out = join(dir, 'out.md')
    const exported = await run(['export', 'codex-1', '--out', out], env)
    assert.equal(exported.code, 0, exported.stderr)
    const text = await readFile(out, 'utf8')
    assert.match(text, /把同步做完/)
    assert.match(text, /引擎已经过测试/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('JSONL transcripts are ingested too', async () => {
  const { dir, env } = await workspace()
  try {
    const source = join(dir, 'chat.jsonl')
    await writeFile(source, '{"role":"user","text":"hi"}\n{"role":"model","text":"hello"}\n')
    const ingest = await run(['ingest', source, '--session', 'jsonl-1', '--device', 'laptop'], env)
    assert.equal(ingest.code, 0, ingest.stderr)
    const json = await run(['export', 'jsonl-1', '--format', 'json'], env)
    const records = JSON.parse(json.stdout)
    assert.equal(records.length, 2)
    assert.equal(records[1].role, 'assistant')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verify passes on a healthy repository and fails after tampering', async () => {
  const { dir, repo, env } = await workspace()
  try {
    const source = join(dir, 'chat.md')
    await writeFile(source, '## 用户\n\n一\n\n## 助手\n\n二\n')
    await run(['ingest', source, '--session', 's1', '--device', 'laptop'], env)
    const ok = await run(['verify'], env)
    assert.equal(ok.code, 0, ok.stdout)
    assert.match(ok.stdout, /可解密 1 块，无法解密 0 块/)
    const { readdir, readFile: rf, writeFile: wf } = await import('node:fs/promises')
    // The engine names one directory after the configured device, whatever the
    // ingest file said, so find the chunk instead of assuming the layout.
    const sessionDir = join(repo, 'data', 's1')
    const [deviceDir] = await readdir(sessionDir)
    const dataDir = join(sessionDir, deviceDir)
    const [file] = await readdir(dataDir)
    const bytes = await rf(join(dataDir, file))
    bytes[bytes.length - 1] ^= 0xff
    await wf(join(dataDir, file), bytes)
    const bad = await run(['verify'], env)
    assert.equal(bad.code, 2)
    assert.match(bad.stdout, /无法解密 1 块/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing passphrase is a clear error, not a stack trace', async () => {
  const { dir, env } = await workspace()
  try {
    const result = await run(['status'], { ...env, DSH_SYNC_PASSPHRASE: '' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /PASSPHRASE|passphrase/)
    assert.equal(result.stderr.includes('at async'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
