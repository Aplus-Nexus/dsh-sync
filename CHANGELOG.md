# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-24

First release. Everything below is new.

### Added

- **Sync core** (`@aplus-nexus/dsh-sync-core`, vendored into each shipped
  package): portable message records, chunked storage, AES-256-GCM sealing with
  a scrypt-derived key, folder and Git backends, and a merge that is
  conflict-free by construction.
- **Native session import**: the origin device's own DSH log is published and
  restored byte for byte, so DSH validates it with its own codec and the
  conversation can be continued on the receiving device.
- **Echo suppression**: a device that imported a session publishes only its own
  continuation, never the imported prefix.
- **Foreign conversations become native**: a conversation with no DSH log of its
  own (Codex, Claude Code, an imported transcript) is synthesized into a valid
  v4 session, checked with DSH's own codec, and can be continued on any device.
  `dsh-sync ingest --native` does the same from the command line.
- **DSH / dsh-go plugin**: "Sync" capsule, live status strip, and a panel with
  push/pull counts, key fingerprint and recent conversations; a `sync_now` tool;
  a `/sync` command; automatic sync on an interval and after each turn.
- **MCP server** (`@aplus-nexus/dsh-sync-mcp`): six tools — `sync_now`,
  `list_sessions`, `read_session`, `search`, `add_note`, `list_notes` — for
  Codex, Claude Code and any other MCP client.
- **CLI** (`@aplus-nexus/dsh-sync-cli`): `init`, `status`, `verify`, `sessions`,
  `export`, `ingest`, `note`, `extras`.
- **Opt-in extras**: settings and model routes (keys always stripped), skills,
  `AGENTS.md`, and the dsh-go `ui.json`, behind a path whitelist.
- **Release pipeline**: tag-driven CI on Linux, macOS and Windows across Node 22
  and 24; a GitHub release with checksummed tarballs; a GitHub Pages site and a
  plugin market index pinned to the built commit.

### Security

- Repository contents are ciphertext only; a test asserts a known phrase never
  appears in any written file.
- A chunk is bound to its repository path through the AEAD additional data, so
  it cannot be relocated without detection.
- The Git token is passed through `GIT_ASKPASS`, never on a command line, and is
  stripped from any URL that is logged.
- Restoring extras never overwrites a differing local file; the remote copy is
  written beside it as `<file>.remote`.

### Known limits

- No real-time co-editing of a single conversation.
- Attachments are referenced by id; their bytes do not travel.
- Model API keys never sync.
