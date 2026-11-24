#!/usr/bin/env node
/**
 * Vendor the sync core into each package that ships to a host.
 *
 * Hosts install a plugin with `pnpm add <path>`, and a `workspace:*` dependency
 * does not resolve outside this repository. Rather than publish four packages
 * to npm, the core is copied into `vendor/core` at build time, so every shipped
 * package is self-contained and installs from one directory.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const coreSrc = join(root, 'packages', 'core', 'src')

const TARGETS = ['packages/dsh-plugin', 'packages/mcp-server', 'packages/cli']

/**
 * Rewrite `@aplus-nexus/dsh-sync-core` imports to the vendored copy, with the
 * specifier relative to the importing file (bin/ is one level deeper than src/).
 */
function rewrite(text, specifier) {
  // Idempotent: a second build must be able to re-point specifiers that were
  // already rewritten by the first run, so both spellings are replaced.
  return text
    .replace(/['"]@aplus-nexus\/dsh-sync-core['"]/g, `'${specifier}'`)
    .replace(/['"][^'"]*vendor\/core\/index\.js['"]/g, `'${specifier}'`)
}

async function vendorInto(target) {
  const dir = join(root, target)
  const dest = join(dir, 'vendor', 'core')
  await rm(join(dir, 'vendor'), { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await cp(coreSrc, dest, { recursive: true })
  await writeFile(join(dest, 'package.json'), `${JSON.stringify({ name: 'dsh-sync-core-vendored', type: 'module', private: true }, null, 2)}\n`)
  // Rewrite the files that import the core by package name.
  const files = target === 'packages/dsh-plugin' ? ['src/index.js', 'src/runtime.js']
    : target === 'packages/mcp-server' ? ['bin/mcp.js']
      : ['bin/dsh-sync.js']
  for (const file of files) {
    const path = join(dir, file)
    const text = await readFile(path, 'utf8')
    const depth = file.split('/').length - 1
    const specifier = `${'../'.repeat(depth)}vendor/core/index.js`
    await writeFile(path, rewrite(text, specifier))
  }
  process.stdout.write(`vendored core -> ${target}/vendor/core\n`)
}

for (const target of TARGETS) await vendorInto(target)
