# Contributing to Shared Tasks

Thanks for helping. This guide covers this repository, the Shared Tasks
plugin for Obsidian. Project-wide rules (how work is organized across the
OpenLFCP repositories, the spec change process) are in the organization's
[CONTRIBUTING.md](https://github.com/openlfcp/.github/blob/main/CONTRIBUTING.md).

## Reporting a bug

Open a [GitHub issue](https://github.com/openlfcp/obsidian/issues) with:

- the Shared Tasks version (Settings → Community plugins) and the Obsidian
  version (Settings → About);
- your operating system and its version (and mobile or desktop);
- the steps that reproduce it, what you expected and what happened;
- the exact notice or status text, and whether other plugins (Tasks, for
  example) are enabled.

**Never paste an invitation link, a `#secret=` fragment, keys or the
contents of your vault's private notes**, in an issue or anywhere else.
An invitation link lets anyone join the collaboration until it is used.
Resource IDs and Principal IDs are fine to share.

## Security issues

Do not open a public issue. Report vulnerabilities privately, through a
[private security advisory](https://github.com/openlfcp/obsidian/security/advisories/new)
or by email to **security@openlfcp.org**. See the organization's
[security policy](https://github.com/openlfcp/.github/blob/main/SECURITY.md).

## Building and testing

You need Node.js 24 or later and pnpm 10. From a clean clone, with
openlfcp/sdk-ts checked out next to it at the commit in `sdk-ts.lock`
(see "The SDK pin" below):

```sh
node scripts/sdk-ts-pack.mjs   # packs the SDK into vendor/sdk-ts/
pnpm install --frozen-lockfile
pnpm build       # typecheck src and bundle main.js
pnpm lint        # Biome and the boundary check
pnpm lint:obsidian  # Obsidian's community review lint over src/, zero warnings
pnpm typecheck   # src and tests
pnpm test
```

The live tests, the two-vault E2E included, run against
the real OpenLFCP server, built with cargo from a `../server` checkout;
without it they are skipped. No server outlives its test process: the
harnesses in `test/support/` kill it when the process exits, and a
watchdog started with each server kills it and removes its temporary
directory if the process is SIGKILLed or crashes (POSIX only;
`test/e2e/orphan.test.ts` checks this). See
[docs/devel/testing/two-vault-e2e.md](docs/devel/testing/two-vault-e2e.md)
and the README's "For developers" section. To try your build in Obsidian:
[docs/devel/testing/load-in-clean-vault.md](docs/devel/testing/load-in-clean-vault.md).

### The SDK pin

Until `@openlfcp/*` 0.7.0 is on npm, the plugin builds against a commit of
openlfcp/sdk-ts's `main`:

- `sdk-ts.lock` names the commit, as `spec.lock` and `server.lock` do.
- `node scripts/sdk-ts-pack.mjs [--checkout DIR]` checks that the checkout
  (default `../sdk-ts`) is at that commit, installs and builds it, and packs
  its eight packages into `vendor/sdk-ts/` (gitignored). The packing is
  reproducible: each package is staged with its `workspace:` ranges already
  rewritten in place, since `pnpm pack` writes them in no stable order.
- `package.json` takes each package as a `file:vendor/sdk-ts/…tgz` tarball,
  and `pnpm.overrides` sends every `@openlfcp/*` dependency, those of the
  packages themselves included, to the tarballs, never to npm.
  `pnpm-lock.yaml` records each tarball's integrity: the lock file pins the
  commit, the pnpm lockfile its bytes. `pnpm install --frozen-lockfile`
  fails if a tarball differs.
- CI (`ci.yml`, `native.yml`, `platform-smoke.yml`) checks out sdk-ts at
  the commit in `sdk-ts.lock` and runs the script before `pnpm install`.
- A release is never built from the pin: `release.yml` runs
  `scripts/check-release-deps.mjs`, which refuses `sdk-ts.lock` and any
  `@openlfcp/*` dependency that is not an exact npm version.

To move the pin: check out the new commit, update `sdk-ts.lock`, run the
script and `pnpm install`, and commit `sdk-ts.lock`, `package.json` (if the
version changed) and `pnpm-lock.yaml` together. Once the SDK is published,
remove `sdk-ts.lock` and the overrides and take the exact npm versions again,
in their own commit.

## Changes

- Keep a pull request to one purpose, with tests for what it changes.
- `pnpm lint`, `pnpm lint:obsidian`, `pnpm typecheck` and `pnpm test` pass
  before you open it.
- `pnpm lint:obsidian` reproduces the lint of the plugin's community
  Scorecard: a warning there lowers the plugin's review status. Fix the
  code; do not turn a rule off, and do not add `eslint-disable` comments
  (the config refuses them). In `styles.css`, use Obsidian's CSS variables
  and well-supported properties: the Scorecard also flags CSS features
  Obsidian's Chromium supports only in part. `pnpm lint:obsidian` runs
  `scripts/check-styles.mjs` too: no `:has()`, no list in `:not()`, no
  `!important`, and colours only from Obsidian's variables.
- Code that imports `obsidian` lives in `src/obsidian/` only; the boundary
  check enforces this and the other rules in the README's "Layout".
- Commit messages follow
  [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, for example `fix(collab): keep the ref when a
  task moves`.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the license of this repository.
