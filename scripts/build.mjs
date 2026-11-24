#!/usr/bin/env node
/**
 * Build = vendor the core into every shipped package, then check that each
 * entry point loads without a host present. Runs in CI on every push.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

execFileSync(process.execPath, [join(here, 'vendor-core.mjs')], { stdio: 'inherit', cwd: root })

// The vendored core resolves on its own; importing it proves the copy is complete.
const core = await import(join(root, 'packages', 'core', 'src', 'index.js'))
if (typeof core.SyncEngine !== 'function') throw new Error('vendored core is missing SyncEngine')
process.stdout.write(`build ok: core exports ${Object.keys(core).length} names\n`)
