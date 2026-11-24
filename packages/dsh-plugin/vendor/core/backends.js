/**
 * Backends: the only thing that differs between "a private Git repository" and
 * a folder on a sync drive. Every backend exposes the same tiny port so the
 * engine never learns about Git.
 *
 * A backend stores opaque files by path. It must implement:
 *   list(prefix)                  -> [{ path, size?, mtime? }]
 *   read(path)                    -> Buffer
 *   write(path, bytes)            -> void   (create or replace)
 *   remove(path)                  -> void   (missing is not an error)
 *   sync()                        -> void   (push/pull; no-op for folders)
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function safeJoin(root, path) {
  const full = path === undefined || path === null || path === '' ? resolve(root) : resolve(root, path)
  const rel = relative(resolve(root), full)
  // '' is the root itself: a listing of the whole repository, which is legal.
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) throw new Error(`refusing path outside the sync folder: ${path}`)
  return full
}

/** A plain directory: Syncthing, iCloud Drive, a mounted WebDAV folder, a USB stick. */
export class FolderBackend {
  kind = 'folder'

  constructor(root) {
    if (typeof root !== 'string' || root === '') throw new Error('folder backend needs a root directory')
    this.root = resolve(root)
  }

  async list(prefix = '') {
    const base = safeJoin(this.root, prefix)
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
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          const info = await stat(full)
          out.push({ path: relative(this.root, full).split(sep).join('/'), size: info.size, mtime: info.mtimeMs })
        }
      }
    }
    await walk(base)
    return out
  }

  async read(path) {
    return readFile(safeJoin(this.root, path))
  }

  async write(path, bytes) {
    const full = safeJoin(this.root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, bytes)
  }

  async remove(path) {
    await rm(safeJoin(this.root, path), { force: true })
  }

  async sync() {}

  describe() {
    return `folder:${this.root}`
  }
}

/** Memory backend: tests and dry runs. */
export class MemoryBackend {
  kind = 'memory'
  files = new Map()

  async list(prefix = '') {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort().map((path) => ({ path, size: this.files.get(path).length }))
  }

  async read(path) {
    const value = this.files.get(path)
    if (value === undefined) {
      const error = new Error(`no such file: ${path}`)
      error.code = 'ENOENT'
      throw error
    }
    return Buffer.from(value)
  }

  async write(path, bytes) {
    this.files.set(path, Buffer.from(bytes))
  }

  async remove(path) {
    this.files.delete(path)
  }

  async sync() {}

  describe() {
    return 'memory'
  }
}
