# Contributing

Thanks for looking. This project is small on purpose and has a few hard rules.

## Run it

```sh
pnpm install
node scripts/build.mjs
node --test packages/*/test/*.test.js
```

`scripts/build.mjs` copies `packages/core/src` into each shipped package under
`vendor/core`. Edit the core in `packages/core/src`, never in `vendor/` — the
next build overwrites it.

## The rules that matter

1. **No plaintext in the repository.** Any change that writes a file must go
   through `seal()`. A test asserts a known phrase never appears in repository
   bytes; extend that test when you add a file type.
2. **No secret on a command line.** Tokens go through `GIT_ASKPASS`.
3. **Imports never overwrite.** A session id that exists locally is reported as
   `exists`, not replaced. This is a feature, not a limitation.
4. **Errors are user-facing.** A phone panel shows at most 40 characters, so
   error messages are short, calm and translated. No stack traces in the UI.
5. **No new dependencies without a reason.** The core must run on a phone with
   no build step; today it uses only `node:` builtins.

## Tests

- Every behaviour fix needs a test that fails before it.
- The end-to-end tests read a real DSH log when this machine has one and build
  the same shape from `packages/dsh-plugin/test/fixtures.js` otherwise, so CI
  covers the full path without private data.
- The Git tests use a local bare repository, never the network.

## Commits

Short imperative subject, then why in the body. `fix:`, `feat:`, `docs:`,
`test:`, `chore:` prefixes are welcome but not enforced.
