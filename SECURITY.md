# Security model

This document states what dsh-sync protects, what it does not, and how to check
the claims yourself. If a claim here is wrong, that is a bug worth reporting.

## Threat model

Assume an attacker who can:

- read the data repository (it is on a hosting provider's disk, and maybe a
  backup, and maybe a public mirror if you misconfigure visibility);
- read the Git history, including deleted files;
- tamper with files in the repository;
- observe network traffic between a device and the repository.

Assume they **cannot** read a device's local storage, and **cannot** guess the
passphrase. Everything below follows from that line.

## What is encrypted

Every file that leaves a device is sealed before it is written:

```
magic(1) | iv(12) | tag(16) | ciphertext
```

- **Cipher**: AES-256-GCM.
- **Key**: 32 bytes from scrypt (N=2¹⁵, r=8, p=1) over the passphrase, with a
  random 16-byte salt stored once at `key/salt`.
- **IV**: fresh random 12 bytes per file. There is no IV reuse across files.
- **AAD**: the file's own repository path, so a chunk cannot be copied onto
  another path without failing authentication.

Three kinds of file are sealed: message chunks (`data/`), native log slices
(`native/`), and shared notes and extras (`notes/`, `extras/`). The only
plaintext file is `key/salt`, which is meaningless without the passphrase.

## What is NOT encrypted

- **Metadata visible to the repository host**: how many sessions you have,
  which device ids wrote them, when, and how large each chunk is. Session ids
  are opaque and the device ids are yours, but the *shape* is visible.
- **Message ordering and size**: chunk filenames encode the sequence range a
  chunk covers.
- **Your Git identity**: a device commits with a local identity like
  `dsh-sync phone-a <sync@localhost>`; the hosting provider sees the push time
  and the account.

If hiding traffic volume or timing matters to you, use a local folder backend
with a sync tool you trust instead of a hosted repository.

## Key handling

- The passphrase is used to derive a key and is not written to the repository.
- It is stored on the device in the DSH plugin configuration (in the profile's
  settings file). It is marked as a secret field in the plugin schema, so DSH's
  own settings UI redacts it, but it is not in a hardware keystore.
- The **key fingerprint** shown in the panel (first 12 hex characters of the
  key) is safe to compare between devices and is never enough to recover the key.
- Losing the passphrase means losing the ability to read existing chunks. There
  is no recovery path, by design.

## Token handling

- The repository token is passed to Git through a generated `GIT_ASKPASS`
  helper reading it from the environment variable `DSH_SYNC_ASKPASS_TOKEN`.
  It never appears in `argv`, so it cannot be read out of the process list.
- `stripCredentials()` removes any embedded `user:token@` from a URL before it
  is printed in logs or the panel.
- The token is stored in the plugin configuration like the passphrase. Use a
  fine-grained token limited to the single data repository, with
  **Contents: Read and write** and nothing else.

## What a pull can and cannot do

- A pull **reads** chunks and writes:
  - a local JSONL mirror under `dsh-sync/mirror` (plaintext, on your device);
  - a native session log under the DSH sessions directory, but **only** if no
    session with that id exists locally.
- A pull never overwrites an existing session, never deletes anything, and
  never changes a local file it did not create.
- A chunk that fails authentication is skipped and counted, never partially
  applied.

## Optional extras (settings, skills, UI)

Off by default; enable per device.

- A path whitelist rejects `.credentials.yaml`, anything named `credentials*`,
  `auth.json`, `.env*`, `*token*`, `*secret*`, `.git/`, `node_modules/`,
  `sessions/` and `storages/`.
- Any settings document whose text still contains a credential-shaped
  assignment (`apiKey: …`, `token=…`, …) is **dropped entirely** rather than
  partially redacted.
- JSON values are redacted by key name; an `apiKeyEnv` value (an environment
  variable *name*) is kept because a name is not a secret.
- Restoring never overwrites a differing local file: the remote copy is written
  beside it as `<file>.remote` and reported as a conflict.

## Verifying the claims

```sh
# The suite asserts that a known phrase never appears in repository bytes.
node --test packages/core/test/engine.test.js

# Check every chunk in a repository really decrypts.
npx @aplus-nexus/dsh-sync-cli verify
```

The end-to-end test (`packages/dsh-plugin/test/e2e.test.js`) pushes a real
conversation and then reads the repository back, asserting the plaintext is
absent and the reconstructed log matches the original event for event.

## Reporting a vulnerability

Open a private security advisory on GitHub rather than a public issue. Please
include the version, the backend in use, and the smallest reproduction you can
manage.
