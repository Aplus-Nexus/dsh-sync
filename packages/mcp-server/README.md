# @aplus-nexus/dsh-sync-mcp

An MCP server that puts the same conversation bus in front of any MCP client —
Codex, Claude Code, or an agent you wrote yourself.

```sh
npm i -g @aplus-nexus/dsh-sync-mcp
```

Configure it with three environment variables (or a config file at
`~/.dsh-sync/config.json`):

```toml
# ~/.codex/config.toml
[mcp_servers.dsh_sync]
command = "dsh-sync-mcp"

[mcp_servers.dsh_sync.env]
DSH_SYNC_REPO = "https://github.com/you/dsh-sync-data.git"
DSH_SYNC_PASSPHRASE = "the same passphrase as your phone"
DSH_SYNC_DEVICE = "codex"
# optional: DSH_SYNC_GIT_TOKEN
```

## Tools

| tool | what it does |
| --- | --- |
| `sync_now` | Pull the newest messages before reading context. |
| `list_sessions` | List synced conversations, newest activity first. |
| `read_session` | Read one conversation as Markdown or JSON. |
| `search` | Case-insensitive substring search across every message. |
| `add_note` | Leave a note for the other agents. |
| `list_notes` | Read notes the others left, newest first. |

A typical first turn is `sync_now` → `list_sessions` → `read_session`.

The server never writes to the repository's message chunks; only `add_note`
creates a file, under its own device prefix.
