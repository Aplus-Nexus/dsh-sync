import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectExtras, publishExtras, readExtras, restoreExtras, redactSecrets, isSyncablePath, removeExtras } from '../src/extras.js'
import { SyncEngine } from '../src/engine.js'
import { FolderBackend, MemoryBackend } from '../src/backends.js'

test('api keys are removed from a settings document', () => {
  const redacted = redactSecrets({
    provider: { apiKey: 'sk-live-123456', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://x' },
    nested: { token: 'abc', list: [{ password: 'p', name: 'ok' }] },
  })
  const text = JSON.stringify(redacted)
  assert.equal(text.includes('sk-live-123456'), false)
  assert.equal(text.includes('"abc"'), false)
  assert.equal(text.includes('"p"'), false)
  // An env-var *name* is not a secret and must survive.
  assert.equal(redacted.provider.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(redacted.provider.baseURL, 'https://x')
  assert.equal(redacted.nested.list[0].name, 'ok')
})

test('dangerous paths are never syncable', () => {
  for (const path of ['.credentials.yaml', 'a/credentials/b', '.env', 'x/.env.local', 'node_modules/x', 'sessions/a', 'storages/b', 'dsh-sync/state.json', 'token.txt', 'my-secret.md']) {
    assert.equal(isSyncablePath(path), false, path)
  }
  for (const path of ['AGENTS.md', 'skills/x/SKILL.md', 'dsh-go/ui.json', 'settings.yaml']) {
    assert.equal(isSyncablePath(path), true, path)
  }
})

test('extras round-trip through an encrypted repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-extras-'))
  try {
    const backend = new MemoryBackend()
    const a = new SyncEngine({ backend, statePath: join(dir, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    const written = await publishExtras(a, [
      { kind: 'skills', name: 'AGENTS.md', payload: { file: 'AGENTS.md', text: '# rules\nbe nice\n' } },
      { kind: 'ui', name: 'ui', payload: { file: 'dsh-go/ui.json', text: '{"density":"compact"}' } },
    ])
    assert.equal(written.length, 2)
    // Nothing readable is in the repository.
    for (const [path, bytes] of backend.files) assert.equal(bytes.toString('utf8').includes('be nice'), false, path)

    const b = new SyncEngine({ backend, statePath: join(dir, 'b.json'), device: 'phone-b' })
    await b.open({ passphrase: 'a long shared passphrase' })
    const skills = await readExtras(b, 'skills')
    assert.equal(skills.length, 1)
    assert.equal(skills[0].payload.text, '# rules\nbe nice\n')

    const home = join(dir, 'home')
    const applied = await restoreExtras(b, { home, kinds: ['skills', 'ui'] })
    assert.equal(applied.applied.length, 2)
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '# rules\nbe nice\n')
    assert.equal(await readFile(join(home, 'dsh-go', 'ui.json'), 'utf8'), '{"density":"compact"}')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dry run changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-extras-'))
  try {
    const backend = new MemoryBackend()
    const a = new SyncEngine({ backend, statePath: join(dir, 'a.json'), device: 'a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    await publishExtras(a, [{ kind: 'skills', name: 'x', payload: { file: 'AGENTS.md', text: 'remote' } }])
    const home = join(dir, 'home')
    await mkdir(home, { recursive: true })
    const plan = await restoreExtras(a, { home, kinds: ['skills'], dryRun: true })
    assert.equal(plan.applied.length, 1)
    await assert.rejects(() => readFile(join(home, 'AGENTS.md'), 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a newer local edit is not overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-extras-'))
  try {
    const backend = new MemoryBackend()
    const a = new SyncEngine({ backend, statePath: join(dir, 'a.json'), device: 'a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    await publishExtras(a, [{ kind: 'skills', name: 'x', payload: { file: 'AGENTS.md', text: 'remote version' } }])
    const home = join(dir, 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'AGENTS.md'), 'local version')
    const result = await restoreExtras(a, { home, kinds: ['skills'] })
    assert.equal(result.applied.length, 0)
    assert.equal(result.conflicts.length, 1)
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), 'local version')
    // The remote copy is offered beside it, never silently applied.
    assert.equal(await readFile(join(home, 'AGENTS.md.remote'), 'utf8'), 'remote version')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExtras only reads what it is asked for', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-extras-'))
  try {
    await mkdir(join(dir, 'skills', 'demo'), { recursive: true })
    await writeFile(join(dir, 'AGENTS.md'), '# rules')
    await writeFile(join(dir, 'skills', 'demo', 'SKILL.md'), '# skill')
    await mkdir(join(dir, 'profiles', 'web'), { recursive: true })
    await writeFile(join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'apiKey: sk-should-not-travel\nmodel: deepseek\n')
    await writeFile(join(dir, '.credentials.yaml'), 'refs: {apiKey: sk-no}')

    const skillsOnly = await collectExtras({ home: dir, skills: true })
    assert.deepEqual(skillsOnly.map((item) => item.name).sort(), ['AGENTS.md', 'skill-demo'])
    assert.equal(JSON.stringify(skillsOnly).includes('sk-should-not-travel'), false)

    const withSettings = await collectExtras({ home: dir, settings: true })
    const routes = withSettings.find((item) => item.name === 'model-routes')
    assert.notEqual(routes, undefined)
    assert.equal(JSON.stringify(withSettings).includes('sk-should-not-travel'), false)
    assert.equal(JSON.stringify(withSettings).includes('deepseek'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('removing extras only removes this device copies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-extras-'))
  try {
    const backend = new MemoryBackend()
    const a = new SyncEngine({ backend, statePath: join(dir, 'a.json'), device: 'a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    await publishExtras(a, [{ kind: 'skills', name: 'x', payload: { file: 'AGENTS.md', text: 'a' } }])
    const b = new SyncEngine({ backend, statePath: join(dir, 'b.json'), device: 'b' })
    await b.open({ passphrase: 'a long shared passphrase' })
    await publishExtras(b, [{ kind: 'skills', name: 'x', payload: { file: 'AGENTS.md', text: 'b' } }])
    await removeExtras(b, 'skills')
    const left = await readExtras(a, 'skills')
    assert.equal(left.length, 1)
    assert.equal(left[0].device, 'a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
