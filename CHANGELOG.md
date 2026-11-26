# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] — 2026-11-26

A vault could grow to gigabytes while holding a handful of conversations. Three
defects combined, and all three are fixed.

### Fixed

- **The cursor was never persisted.** `open()` read `state.cursor`, nothing
  wrote it, so every process started at sequence -1 and republished every
  conversation on every tick. The cursor is now saved in the same step as the
  push that produced it, and a test asserts a fresh engine resumes from it.
- **`push()` discarded the cursor it was given.** It called `commit({})`
  instead of passing the collected map through, so even within one process the
  next tick re-sent everything.
- **Unchanged content was re-sealed and re-written.** A fresh random IV makes
  identical plaintext a different blob, so git could never delta two versions of
  one chunk. Chunk and metadata writes are now skipped when the plaintext is
  unchanged.
- `scripts/rebuild-vault.mjs` no longer deletes the state file. Resetting the
  cursor is what caused the growth in the first place; it is now opt-in via
  `--reset-cursor` and prints a warning.

### Upgrade note

An existing vault keeps its bloated history: git cannot shrink a repository by
rewriting the tip, and GitHub does not garbage-collect unreachable objects on
its own. Republishing into a fresh repository is the only way to reclaim the
space, and `scripts/rebuild-vault.mjs --yes` does that from a device that still
holds the conversations.

## [0.3.1] — 2026-11-24

### Fixed

- Compaction now measures coverage over the *union* of kept chunk intervals, not
  against a single longer chunk. A range split across two later chunks is
  recognised as redundant too, which is the shape an interrupted push actually
  leaves behind.

## [0.3.0] — 2026-11-24

### Added

- **Conflict copies instead of lost turns.** When two devices append different
  events at the same sequence, the session's owner keeps the canonical branch
  and the other branch becomes its own conversation, titled `（冲突N）`. The fork
  keeps the canonical prefix so it reads as a coherent conversation, and it is
  created once — a later sync never re-creates or overwrites it.
- **`pushScope: synced`.** A joining device publishes only conversations that
  arrived from the bus. Everything already on that device stays private and is
  never uploaded.
- **Chunk compaction.** Chunks whose sequence range is fully covered by a longer
  one are removed on the next sync, repairing what an interrupted push leaves
  behind.
- **`docs/onboarding-prompt.md`**: a ready-to-paste prompt that walks another
  dsh-go agent through install, configuration and verification.

### Fixed

- A pull now returns one record per id. An interrupted push could leave two
  chunks covering the same range, and every message in them was counted twice
  (317 duplicates in a real vault before this fix).
- A synthesized conversation no longer re-publishes the whole log it was built
  from: its imported prefix is recorded, so only genuine new turns are sent.
- Native-only sessions (a peer that published chunks but no portable records)
  are now discovered and imported instead of being ignored.

## [0.2.0] — 2026-11-24

### Added

- **Foreign conversations become native.** A conversation with no DSH log of its
  own — Codex, Claude Code, an imported transcript — is synthesized into a
  valid v4 session with a full turn/step lifecycle, validated with DSH's own
  codec before it is written, and then continues like any other conversation.
  Existing sessions are never overwritten.
- **`dsh-sync ingest --native`** materializes a transcript as a local DSH
  session at the same time it is published to the bus.

### Fixed

- `encodeLogBytes` silently wrote `[object Object]` when handed event objects
  instead of JSONL lines, producing a log that looked valid and could not be
  read. It now accepts both and refuses anything else.
- A claimed automatic re-push of an imported session no longer duplicates the
  prefix; only the device's own continuation is published.

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
