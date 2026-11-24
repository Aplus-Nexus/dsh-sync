# @aplus-nexus/dsh-sync

The DSH / dsh-go plugin. Adds message-level, end-to-end encrypted sync to the
phone app and to a desktop DSH: a "Sync" capsule above the composer, a live
status strip, a panel, a `sync_now` tool and a `/sync` command.

```sh
dsh plugin --profile web add @aplus-nexus/dsh-sync
```

Then set four things in the plugin settings: `repoUrl` (a private repository),
`token` (fine-grained, Contents: Read and write on that repository), `passphrase`
(8+ characters, identical on every device) and `deviceName`.

Two devices are configured correctly when the panel shows the **same key
fingerprint**. That is what proves they hold one key.

## What it does

- Publishes every new DSH message as a portable record.
- Publishes the origin device's own session log, compressed and sealed, so a
  peer can import a real, continuable conversation.
- Pulls, mirrors, and imports sessions this device has never seen; never
  overwrites one it already has.
- Syncs on a 60-second interval and after each turn; both are configurable.

## Options

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the plugin off without uninstalling. |
| `backend` | `git` | `git` or `folder`. |
| `repoUrl` | — | HTTPS URL of the data repository. |
| `branch` | `main` | Branch to use. |
| `token` | — | Access token; passed to Git through `GIT_ASKPASS`. |
| `folder` | — | Root directory when `backend` is `folder`. |
| `passphrase` | — | Encryption passphrase. Losing it loses the data. |
| `deviceName` | hostname | Name this device shows to the others. |
| `intervalSec` | `60` | Automatic sync interval; `0` disables it. |
| `pushOnTurnEnd` | `true` | Push right after a turn ends. |
| `importNative` | `true` | Import foreign sessions as native DSH conversations. |
| `mirror` | `true` | Keep a plaintext JSONL mirror other agents can read. |
| `syncSettings` | `false` | Also sync non-secret settings and model routes. |
| `syncSkills` | `false` | Also sync skills, `AGENTS.md` and `dsh-go/ui.json`. |

See the repository [README](https://github.com/Aplus-Nexus/dsh-sync#readme) for
the full setup and [SECURITY.md](https://github.com/Aplus-Nexus/dsh-sync/blob/main/SECURITY.md)
for the threat model.
