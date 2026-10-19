# Candidate manifest: Shared Tasks 0.5.0-beta.1

The candidate of LFCP-03-027 (M03-4; U03-30 technical part, G03-H), built from a fixed
commit in a clean checkout, never from a moving `main`. Nothing here is published: no tag and
no release page exist; the owner creates them.

## Identity

| Item | Value |
| --- | --- |
| Version | `0.5.0-beta.1` (`manifest-beta.json`); `manifest.json`, `package.json` and `versions.json` stay at 0.4.2 (the catalog line, B14) |
| Commit built | `1eb1f28946f85110976651965ff1d28c15b50473` (branch `mvp03/027-candidate-pilot`) |
| Source base | `main` `3cd6969a96c54085b57b586e4c3daf3986e5663e`; the branch differs from it only in notes, pilot materials, `native.yml` and `manifest-beta.json`, no file under `src/` |
| Build | fresh clone, `pnpm install --frozen-lockfile`, `node scripts/release-assets.mjs --tag 0.5.0-beta.1` (exit 0, `release: Shared Tasks 0.5.0-beta.1 (shared-tasks) pre-release in release/`); `pnpm lint`, `pnpm typecheck` and `scripts/check-release-deps.mjs` exit 0 |
| Reproducibility | the same `main.js` checksum from the local worktree, the fresh clone and the CI runs |

## Assets and checksums

| Asset | SHA-256 |
| --- | --- |
| `main.js` | `a0257e138f395f32940d3431f3e570d003b0a2c31b819a71748a39d74982a220` |
| `manifest.json` (from `manifest-beta.json`) | `c755e547b8916986031139c78341e10739e88436f2dbcac9a0c1279e29ae398f` |
| `styles.css` | `b8dd6c368d0c194d127bb85105a2bf3bbb5654ad0d945916d6f1d7ff52c6bb30` |

## Pins

| Pin | Value |
| --- | --- |
| Lockfile | `pnpm-lock.yaml` sha256 `261fc5fbbdce3add9eed79bfbe5db5525e1b65afc3ef7a03fa67357ef0f02996` |
| SDK | `@openlfcp/*` 0.2.2 (npm, as locked) |
| Server | `server.lock` `138030ae6582197193cd4c041726683bcc206bef` (openlfcp/server) |
| Spec | `spec.lock` `mvp-0.2-baseline.12`, `bf1c78c596eef85e272c04a8a35661f814c23a40` |
| Obsidian | 1.13.4 and 1.14.4 (the harness pins), Tasks 8.4.0 |

## Smoke of the exact artifact (GitHub Actions, not a developer machine)

`native.yml` with `release_build=true` builds without the pane prototype (what a release ships),
prints the checksums, and leaves out `pane-prototype`, the one spec that needs the developer pane.

| What | Run | Result |
| --- | --- | --- |
| Native set, 50 specs, Ubuntu / macOS / Windows x Obsidian 1.13.4 / 1.14.4 (includes `two-hosts`, `upgrade-install`, `upgrade-rollback` against 0.3.4, 0.4.0-beta.15, 0.4.1 and 0.4.2, and the section-* specs) | [39185475551](https://github.com/openlfcp/obsidian/actions/runs/39185475551) | 6 of 6 jobs passed at the first attempt, no spec skipped (the workflow fails on a skip) |
| Pane performance B1-B4, macOS, 1.14.4 | [39185482345](https://github.com/openlfcp/obsidian/actions/runs/39185482345) | B1 p95 107.6 to 118.1 ms in six series (budget 150): PASS; B2 p95 23.3 ms, B4 p95 34.0 ms; B3 cold open p95 46.2 ms (no budget). Its `main.js` sha256 equals the table above |
| CI | [39185478971](https://github.com/openlfcp/obsidian/actions/runs/39185478971) | success |
| Platform smoke (unit, live tests with the server) | [39185479214](https://github.com/openlfcp/obsidian/actions/runs/39185479214) | success on three systems |

Runs on earlier commits of this branch were not used: the first `release_build` runs built the
developer pane by mistake (a workflow expression bug, fixed) and were discarded; Platform smoke on
`159db89` failed twice in `section-registry` (a stale snapshot in the test, fixed on `main` by 063).

## Evidence of 023-026 and 025

The reports of 025 (`mvp-0.3-native-matrix.md`) and 026 (`upgrade-rollback-perf-0.5.md`) were taken on
`ec4f1ce` and `82a1700`; `src/` has changed since (048, 056, 057, 058, 060, 061, 063). They are
history. The evidence of this candidate is the runs above, on the same specs and harness.
The pins (server, spec, SDK) are unchanged from those reports.

## Not done here

Tag `0.5.0-beta.1` (annotated), the GitHub pre-release with the three attested assets, BRAT
checks and the pilot (D26: about 2026-11-01): the owner.
