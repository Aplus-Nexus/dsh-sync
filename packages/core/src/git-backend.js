/**
 * Private Git repository backend.
 *
 * The repository is the only transport: no server, no account, no vendor. A
 * local clone is kept under the state directory, files are committed, and a
 * push retries on rejection by rebasing onto the remote — which is safe here
 * because every device only ever adds files under its own path prefix.
 *
 * Authentication never appears on the command line: a token is handed to Git
 * through a generated askpass helper that reads it from the environment.
 */
import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

function safeJoin(root, path) {
  const full = path === undefined || path === null || path === '' ? resolve(root) : resolve(root, path)
  const rel = relative(resolve(root), full)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) throw new Error(`refusing path outside the repository: ${path}`)
  return full
}

export class GitBackend {
  kind = 'git'

  /**
   * @param {object} options
   * @param {string} options.url        https or ssh remote.
   * @param {string} options.workdir    local clone directory (kept between runs).
   * @param {string} [options.token]    personal access token; stored locally, never committed.
   * @param {string} [options.branch]   default `main`.
   * @param {string} [options.identity] commit identity, e.g. `dsh-sync <sync@local>`.
   * @param {string} [options.bin]      git executable, default `git`.
   */
  constructor(options) {
    if (typeof options?.url !== 'string' || options.url === '') throw new Error('git backend needs a repository url')
    this.url = options.url
    this.workdir = resolve(options.workdir ?? './.dsh-sync/repo')
    this.token = options.token ?? process.env.DSH_SYNC_GIT_TOKEN ?? ''
    this.branch = options.branch ?? 'main'
    this.identity = options.identity ?? 'dsh-sync <sync@localhost>'
    this.bin = options.bin ?? 'git'
    this.ready = null
  }

  env() {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    if (this.token !== '') {
      env.DSH_SYNC_ASKPASS_TOKEN = this.token
      env.GIT_ASKPASS = join(this.workdir, '..', 'askpass.sh')
    }
    return env
  }

  async git(args, options = {}) {
    const env = this.env()
    if (this.token !== '') {
      const askpass = env.GIT_ASKPASS
      await mkdir(dirname(askpass), { recursive: true })
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *sername*) echo "x-access-token" ;;\n  *) echo "$DSH_SYNC_ASKPASS_TOKEN" ;;\nesac\n')
      await chmod(askpass, 0o700)
    }
    const [name, email] = splitIdentity(this.identity)
    const full = [
      '-c', `user.name=${name}`,
      '-c', `user.email=${email}`,
      '-c', 'core.autocrlf=false',
      '-c', 'commit.gpgsign=false',
      ...args,
    ]
    try {
      const { stdout } = await run(this.bin, full, { cwd: options.cwd ?? this.workdir, env, maxBuffer: 32 * 1024 * 1024, timeout: options.timeout ?? 120_000 })
      return stdout
    } catch (error) {
      const stderr = String(error.stderr ?? '').trim()
      const message = stderr === '' ? String(error.message ?? error) : stderr
      const wrapped = new Error(`git ${args[0]} failed: ${message}`)
      wrapped.code = error.code
      wrapped.stderr = stderr
      throw wrapped
    }
  }

  async ensure() {
    if (this.ready !== null) return this.ready
    this.ready = (async () => {
      await mkdir(dirname(this.workdir), { recursive: true })
      const already = await stat(join(this.workdir, '.git')).catch(() => undefined)
      if (already === undefined) {
        await rm(this.workdir, { recursive: true, force: true })
        await this.git(['clone', '--quiet', this.url, this.workdir], { cwd: dirname(this.workdir), timeout: 180_000 })
      }
      // The remote may name its default branch differently (or the clone may
      // land detached), so track the configured branch explicitly.
      const tracking = await this.git(['checkout', '-q', '-B', this.branch, `origin/${this.branch}`]).catch(() => undefined)
      if (tracking === undefined) await this.git(['checkout', '-q', '-B', this.branch])
    })()
    return this.ready
  }

  async list(prefix = '') {
    await this.ensure()
    const base = safeJoin(this.workdir, prefix)
    const out = []
    const walk = async (dir) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          const info = await stat(full)
          out.push({ path: relative(this.workdir, full).split(sep).join('/'), size: info.size, mtime: info.mtimeMs })
        }
      }
    }
    await walk(base)
    return out
  }

  async read(path) {
    await this.ensure()
    return readFile(safeJoin(this.workdir, path))
  }

  async write(path, bytes) {
    await this.ensure()
    const full = safeJoin(this.workdir, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, bytes)
  }

  async remove(path) {
    await this.ensure()
    await rm(safeJoin(this.workdir, path), { force: true })
  }

  /**
   * Commit and push. On a rejected push, rebase onto the remote and retry; each
   * attempt re-reads the remote so a phone that was offline for a day catches up.
   */
  async sync({ message = 'sync', attempts = 3, direction = 'push' } = {}) {
    await this.ensure()
    if (direction === 'pull') {
      // A brand-new remote has no branch to pull yet; that is not an error.
      const pulled = await this.git(['pull', '--rebase', '--quiet', 'origin', this.branch], { timeout: 180_000 }).then(() => true).catch(() => false)
      if (!pulled) await this.git(['fetch', '-q', 'origin'], { timeout: 180_000 }).catch(() => {})
      return
    }
    await this.git(['add', '-A'])
    const dirty = await this.git(['status', '--porcelain']).catch(() => '')
    if (dirty.trim() !== '') await this.git(['commit', '-q', '-m', message])
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.git(['push', '-q', 'origin', `HEAD:${this.branch}`], { timeout: 180_000 })
        return
      } catch (error) {
        lastError = error
        // A rejected push means another device was faster. Fetch, then replay
        // our commits on top of the remote tip. `--rebase` needs a clean tree,
        // which the commit above guarantees.
        await this.git(['fetch', '-q', 'origin'], { timeout: 180_000 }).catch(() => {})
        const rebased = await this.git(['rebase', '--quiet', `origin/${this.branch}`], { timeout: 120_000 }).then(() => true).catch(() => false)
        if (!rebased) {
          await this.git(['rebase', '--abort']).catch(() => {})
          // Last resort that still never loses data: merge the remote tip.
          const merged = await this.git(['merge', '--no-edit', '-q', `origin/${this.branch}`], { timeout: 120_000 }).then(() => true).catch(() => false)
          if (!merged) await this.git(['merge', '--abort']).catch(() => {})
        }
      }
    }
    throw lastError ?? new Error('git push failed')
  }

  describe() {
    return `git:${stripCredentials(this.url)}#${this.branch}`
  }
}

function splitIdentity(identity) {
  const match = /^(.*?)\s*<(.+)>$/.exec(identity)
  if (match === null) return [identity, 'sync@localhost']
  return [match[1] || 'dsh-sync', match[2]]
}

/** Never print a token that a user pasted into the URL. */
export function stripCredentials(url) {
  return String(url).replace(/\/\/[^/@]*@/, '//')
}
