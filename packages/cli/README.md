# @aplus-nexus/dsh-sync-cli

The parts a phone panel cannot do: first-run setup, verifying a repository, and
getting your words back out.

```sh
npm i -g @aplus-nexus/dsh-sync-cli

dsh-sync init --repo https://github.com/you/dsh-sync-data.git --device laptop
dsh-sync status
dsh-sync verify
dsh-sync sessions
dsh-sync export <session-id> --out chat.md
```

## Commands

| command | what it does |
| --- | --- |
| `init` | Write the config and report the key fingerprint. |
| `status` | Device, fingerprint, backend, and push/pull totals. |
| `verify` | Decrypt every chunk and report what cannot be read. Exit code 2 on failure. |
| `sessions` | List synced conversations with message counts. |
| `export <id>` | Write one conversation as Markdown or JSON. |
| `ingest <file>` | Import a transcript (Markdown or JSONL) produced by another tool. |
| `note` | Write a note to the shared bus. |
| `extras` | Publish or restore settings, skills and UI config. `--dry-run` first. |

## Configuration

`init` writes `~/.dsh-sync/config.json` (mode 0600). Environment variables win
over the file:

| variable | meaning |
| --- | --- |
| `DSH_SYNC_HOME` | State directory, default `~/.dsh-sync`. |
| `DSH_SYNC_REPO` | Data repository URL. |
| `DSH_SYNC_PASSPHRASE` | Encryption passphrase (8+ characters). |
| `DSH_SYNC_GIT_TOKEN` | Repository access token. |
| `DSH_SYNC_DEVICE` | Device name. |
| `DSH_SYNC_BACKEND` | `git` or `folder`. |
| `DSH_SYNC_FOLDER` | Folder root when the backend is `folder`. |
