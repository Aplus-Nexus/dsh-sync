#!/usr/bin/env node
/**
 * Assemble the GitHub Pages site: the market index, the icon, and a small
 * landing page that tells a visitor what this is and how to install it.
 *
 * The page is generated from one template so its facts (version, install
 * command, market URL) cannot drift from the packages.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const site = join(root, 'site')
const pkg = JSON.parse(await readFile(join(root, 'packages', 'dsh-plugin', 'package.json'), 'utf8'))
const repo = process.env.GITHUB_REPOSITORY ?? 'Aplus-Nexus/dsh-sync'
const [owner, name] = repo.split('/')
const base = `https://${owner.toLowerCase()}.github.io/${name}`

/** Escape text for HTML so a version string can never become markup. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

await mkdir(join(site, 'assets'), { recursive: true })
for (const asset of ['icon.svg', 'icon.png', 'icon-256.png', 'icon-128.png', 'icon-64.png', 'banner.png']) {
  await cp(join(root, 'assets', asset), join(site, 'assets', asset))
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-sync — encrypted conversation sync for DSH</title>
<meta name="description" content="Message-level, end-to-end encrypted conversation sync across phones, desktops and other AI agents.">
<meta property="og:title" content="dsh-sync">
<meta property="og:description" content="Message-level, end-to-end encrypted conversation sync across phones, desktops and other AI agents.">
<meta property="og:image" content="${base}/assets/banner.png">
<link rel="icon" href="assets/icon.svg">
<style>
  :root { color-scheme: dark; --bg:#0b1224; --panel:#131e3a; --text:#e8f0ff; --muted:#9fb2d4; --mint:#6fe3c4; --blue:#5aa9ff; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.65 -apple-system, "Segoe UI", "Noto Sans SC", system-ui, sans-serif; background:var(--bg); color:var(--text); }
  a { color: var(--mint); }
  header { max-width: 960px; margin: 0 auto; padding: 56px 24px 8px; }
  header img { width: 96px; height: 96px; border-radius: 22px; }
  h1 { font-size: 2.2rem; margin: 16px 0 4px; letter-spacing: -0.02em; }
  .lead { color: var(--muted); font-size: 1.1rem; max-width: 44rem; }
  main { max-width: 960px; margin: 0 auto; padding: 8px 24px 72px; }
  section { margin-top: 40px; }
  h2 { font-size: 1.15rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .card { background: var(--panel); border-radius: 16px; padding: 18px 20px; }
  .card h3 { margin: 0 0 6px; font-size: 1rem; }
  .card p { margin: 0; color: var(--muted); font-size: 0.95rem; }
  code, pre { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9rem; }
  pre { background:#0a1226; border: 1px solid #22314f; border-radius: 12px; padding: 14px 16px; overflow-x: auto; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #17304d; color: var(--mint); font-size: 0.8rem; }
  footer { max-width: 960px; margin: 0 auto; padding: 24px; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<header>
  <img src="assets/icon.svg" alt="">
  <h1>dsh-sync</h1>
  <p class="lead">Message-level, end-to-end encrypted conversation sync. Your phone, your desktop and other agents read the same conversation — through a repository only your devices can decrypt. <span class="pill">v${escapeHtml(pkg.version)}</span></p>
</header>
<main>
  <section>
    <h2>Install</h2>
    <div class="grid">
      <div class="card"><h3>dsh-go / DSH</h3><p>Settings → Plugins → Market, then paste this index URL:</p>
        <pre>${base}/market-index.json</pre></div>
      <div class="card"><h3>Command line</h3><p>First-run setup and exports:</p>
        <pre>npm i -g @aplus-nexus/dsh-sync-cli
dsh-sync init --repo &lt;your private repo&gt;</pre></div>
      <div class="card"><h3>Codex / Claude Code</h3><p>Share the same bus over MCP:</p>
        <pre>npm i -g @aplus-nexus/dsh-sync-mcp
dsh-sync-mcp</pre></div>
    </div>
  </section>
  <section>
    <h2>How it works</h2>
    <div class="grid">
      <div class="card"><h3>Messages, not files</h3><p>Every chat message becomes one portable record. A pull gives you the conversation, not a blob you have to re-parse.</p></div>
      <div class="card"><h3>Sealed before it leaves</h3><p>AES-256-GCM with a scrypt-derived key. The repository only ever sees ciphertext, and a chunk cannot be moved to another path unnoticed.</p></div>
      <div class="card"><h3>No server</h3><p>A private Git repository is the transport. Each device writes only under its own prefix, so simultaneous pushes merge instead of conflicting.</p></div>
    </div>
  </section>
  <section>
    <h2>Links</h2>
    <p><a href="https://github.com/${repo}">Source</a> · <a href="https://github.com/${repo}/blob/main/README.md">Documentation</a> · <a href="https://github.com/${repo}/blob/main/SECURITY.md">Security model</a></p>
  </section>
</main>
<footer>MIT © Aplus-Nexus</footer>
</body>
</html>
`
await writeFile(join(site, 'index.html'), html)
await writeFile(join(site, '.nojekyll'), '')
process.stdout.write(`site -> ${site} (index, assets, market-index.json)\n`)
