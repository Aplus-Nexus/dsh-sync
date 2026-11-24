#!/usr/bin/env node
/**
 * Repository hygiene for CI and for a human before a release: no secrets, no
 * oversized files, every JSON file parseable, and every markdown link that
 * points inside the repo actually resolves.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const root = resolve(new URL('..', import.meta.url).pathname)
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.tmp'])
const MAX_BYTES = 2 * 1024 * 1024

const problems = []
const files = []

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (entry.isFile()) files.push(full)
  }
}

await walk(root)

// 1. No obvious credential material is committed.
const SECRET_PATTERNS = [
  [/ghp_[A-Za-z0-9]{20,}/, 'GitHub personal access token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained token'],
  [/sk-[A-Za-z0-9]{20,}/, 'API secret key'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  // A passphrase used as a *test literal* is the one legitimate case; flag only
  // assignments to something long and high-entropy that is not obviously a test.
  [/(password|passphrase|token)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{32,}["']/i, 'hard-coded secret'],
]
for (const file of files) {
  if (!/\.(js|mjs|json|md|yml|yaml|toml|txt)$/.test(file)) continue
  const text = await readFile(file, 'utf8').catch(() => '')
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) problems.push(`${relative(root, file)}: looks like a ${label}`)
  }
}

// 2. Every JSON file parses; every file is under the size budget.
for (const file of files) {
  const info = await stat(file)
  if (info.size > MAX_BYTES) problems.push(`${relative(root, file)}: ${info.size} bytes is too large to commit`)
  if (file.endsWith('.json')) {
    try {
      JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      problems.push(`${relative(root, file)}: invalid JSON (${error.message})`)
    }
  }
}

// 3. Relative links in markdown resolve.
for (const file of files.filter((name) => name.endsWith('.md'))) {
  const text = await readFile(file, 'utf8')
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (target === '' || /^[a-z]+:/i.test(target) || target.startsWith('#')) continue
    const resolved = resolve(dirname(file), decodeURIComponent(target))
    if (!existsSync(resolved)) problems.push(`${relative(root, file)}: link target missing: ${target}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`check-repo: ${problem}\n`)
  process.exit(1)
}
process.stdout.write(`check-repo: ${files.length} files clean\n`)
