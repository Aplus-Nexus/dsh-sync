#!/usr/bin/env node
/**
 * Publish the shipped packages to npm.
 *
 * Only the plugin, the MCP server and the CLI are published; the core is
 * vendored into each of them, so it never needs its own release. A package that
 * is marked private is skipped rather than failing the run.
 */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
// The core is vendored into each shipped package, so it is not published on
// its own: one version to pin, one thing to install.
const PACKAGES = ['packages/dsh-plugin', 'packages/mcp-server', 'packages/cli']

for (const dir of PACKAGES) {
  const pkgDir = join(root, dir)
  const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
  if (pkg.private === true) {
    process.stdout.write(`skip ${pkg.name} (private)\n`)
    continue
  }
  try {
    execFileSync('npm', ['publish', '--access', 'public', '--provenance'], { cwd: pkgDir, stdio: 'inherit' })
    process.stdout.write(`published ${pkg.name}@${pkg.version}\n`)
  } catch (error) {
    // Re-running a release for an existing version is a normal event, not a failure.
    const message = String(error.stderr ?? error.message ?? '')
    if (/cannot publish over the previously published versions|EPUBLISHCONFLICT|previously published/i.test(message)) {
      process.stdout.write(`skip ${pkg.name}@${pkg.version} (already published)\n`)
      continue
    }
    throw error
  }
}
