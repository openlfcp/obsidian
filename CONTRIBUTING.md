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

You need Node.js 24 or later and pnpm 10. From a clean clone:

```sh
pnpm install --frozen-lockfile
pnpm build       # typecheck src and bundle main.js
pnpm lint        # Biome and the boundary check
pnpm typecheck   # src and tests
pnpm test
```

The `@openlfcp/*` SDK packages come from npm at the versions locked in
`pnpm-lock.yaml` for releases. During 0.4 development `main` links them
from a sibling `../sdk-ts` checkout at the commit in `sdk-ts.lock`, built
first (README, "Build from a clean checkout"); move the pin only to a
pushed sdk-ts commit, in its own commit. The live tests, the two-vault E2E included, run against
the real OpenLFCP server, built with cargo from a `../server` checkout;
without it they are skipped. No server outlives its test process: the
harnesses in `test/support/` kill it when the process exits, and a
watchdog started with each server kills it and removes its temporary
directory if the process is SIGKILLed or crashes (POSIX only;
`test/e2e/orphan.test.ts` checks this). See
[docs/devel/testing/two-vault-e2e.md](docs/devel/testing/two-vault-e2e.md)
and the README's "For developers" section. To try your build in Obsidian:
[docs/devel/testing/load-in-clean-vault.md](docs/devel/testing/load-in-clean-vault.md).

## Changes

- Keep a pull request to one purpose, with tests for what it changes.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass before you open it.
- Code that imports `obsidian` lives in `src/obsidian/` only; the boundary
  check enforces this and the other rules in the README's "Layout".
- Commit messages follow
  [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, for example `fix(collab): keep the ref when a
  task moves`.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the license of this repository.
