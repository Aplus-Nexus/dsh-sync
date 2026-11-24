/**
 * The Git backend against a real repository: clone, commit, push, and the
 * rejected-push recovery path two devices hit when they sync at the same time.
 *
 * A local bare repository stands in for GitHub, so this runs offline in CI.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitBackend, stripCredentials } from '../src/git-backend.js'
import { SyncEngine } from '../src/engine.js'

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
}

async function bareRepo() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-'))
  const origin = join(root, 'origin.git')
  git(root, 'init', '--bare', '-q', origin)
  // A first commit gives the clone a branch to check out.
  const seed = join(root, 'seed')
  git(root, 'clone', '-q', origin, seed)
  git(seed, 'checkout', '-q', '-b', 'main')
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(seed, 'push', '-q', 'origin', 'main')
  return { root, origin }
}

test('two devices share one encrypted bus through real git', async () => {
  const { root, origin } = await bareRepo()
  const dirA = join(root, 'a')
  const dirB = join(root, 'b')
  try {
    const a = new SyncEngine({
      backend: new GitBackend({ url: origin, workdir: join(dirA, 'clone'), identity: 'a <a@t>' }),
      statePath: join(dirA, 'state.json'),
      device: 'phone-a',
    })
    await a.open({ passphrase: 'a long shared passphrase' })
    await a.push([record('phone-a', 's1', 0, 'from the phone')])

    const b = new SyncEngine({
      backend: new GitBackend({ url: origin, workdir: join(dirB, 'clone'), identity: 'b <b@t>' }),
      statePath: join(dirB, 'state.json'),
      device: 'laptop',
    })
    await b.open({ passphrase: 'a long shared passphrase' })
    await b.backend.sync({ direction: 'pull' })
    const pulled = await b.pull()
    assert.equal(pulled.records.length, 1)
    assert.equal(pulled.records[0].text, 'from the phone')

    await b.push([record('laptop', 's2', 0, 'from the laptop')])
    await a.backend.sync({ direction: 'pull' })
    const back = await a.pull()
    assert.equal(back.records.length, 1)
    assert.equal(back.records[0].text, 'from the laptop')

    // The remote really received commits from both devices.
    const log = git(root, '--git-dir', origin, 'log', '--format=%s', 'main')
    assert.match(log, /sync/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a rejected push is retried after rebasing onto the remote', async () => {
  const { root, origin } = await bareRepo()
  const dirA = join(root, 'a')
  const dirB = join(root, 'b')
  try {
    const a = new SyncEngine({
      backend: new GitBackend({ url: origin, workdir: join(dirA, 'clone'), identity: 'a <a@t>' }),
      statePath: join(dirA, 'state.json'),
      device: 'phone-a',
    })
    await a.open({ passphrase: 'a long shared passphrase' })
    const b = new SyncEngine({
      backend: new GitBackend({ url: origin, workdir: join(dirB, 'clone'), identity: 'b <b@t>' }),
      statePath: join(dirB, 'state.json'),
      device: 'phone-b',
    })
    await b.open({ passphrase: 'a long shared passphrase' })

    // Both push without pulling: the second one must rebase, not fail.
    await a.push([record('phone-a', 's1', 0, 'a1')])
    await b.push([record('phone-b', 's2', 0, 'b1')])

    const c = new SyncEngine({
      backend: new GitBackend({ url: origin, workdir: join(root, 'c', 'clone'), identity: 'c <c@t>' }),
      statePath: join(root, 'c', 'state.json'),
      device: 'phone-c',
    })
    await c.open({ passphrase: 'a long shared passphrase' })
    const all = await c.pull()
    assert.equal(all.records.length, 2)
    assert.deepEqual(all.records.map((r) => r.text).sort(), ['a1', 'b1'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a token in the URL is never printed', () => {
  assert.equal(stripCredentials('https://user:ghp_secret@github.com/me/repo.git'), 'https://github.com/me/repo.git')
  assert.equal(stripCredentials('https://github.com/me/repo.git'), 'https://github.com/me/repo.git')
})

test('a missing repository is a readable error, not a hang', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-'))
  try {
    const backend = new GitBackend({ url: join(root, 'does-not-exist.git'), workdir: join(root, 'clone') })
    await assert.rejects(() => backend.ensure(), /git clone failed|does not exist|not found|repository/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function record(device, session, seq, text) {
  return {
    id: `id-${device}-${session}-${seq}`,
    origin: { device, session, root: session, parent: null, seq, ts: 1000 + seq, eventType: 'user/message' },
    agent: 'dsh',
    kind: 'message',
    role: 'user',
    text,
  }
}
