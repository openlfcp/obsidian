# Candidate manifest: Shared Tasks 0.5.0-beta.2

The candidate of LFCP-03-067 (D30), built from a fixed commit, never from a moving `main`.
Nothing here is published: no tag and no release page exist; the owner creates them.

## Identity

| Item | Value |
| --- | --- |
| Version | `0.5.0-beta.2` (`manifest-beta.json`); `manifest.json`, `package.json` and `versions.json` stay at 0.4.2 (the catalog line, B14) |
| Commit built | `0d69b989730006a7fdf29bbb44a526eae5c8b4b4` (branch `mvp03/067-beta2-candidate`; later commits of the branch are docs only) |
| Source base | `main` `75cad16793013c6306abeea59237b6284e81ffb5`; the branch differs from it only in `manifest-beta.json`, notes and the navigator, no file under `src/` |
| New since beta.1 | 064 (#79), 055 (#80), 062 (#82); `git log 0858f72..75cad16` |
| Build | `pnpm install --frozen-lockfile`, `node scripts/release-assets.mjs --tag 0.5.0-beta.2` (`release: Shared Tasks 0.5.0-beta.2 (shared-tasks) pre-release in release/`); the release workflow dry run builds the same files |
| Reproducibility | the same `main.js` checksum from the local worktree and from the native and performance runs (both print it) |

## Assets and checksums

| Asset | SHA-256 |
| --- | --- |
| `main.js` | `2292fd62bb68fbd03e2af1a6b3178a82db3a4199cbb4637de013af9104b369af` |
| `manifest.json` (from `manifest-beta.json`) | `5c6136abd4c20b829b40d379634bcf13f0ae055a2158a2f89f177fa297ab8f74` |
| `styles.css` | `b8dd6c368d0c194d127bb85105a2bf3bbb5654ad0d945916d6f1d7ff52c6bb30` |

## Pins

Unchanged from [beta.1](candidate-0.5.0-beta.1.md): lockfile `pnpm-lock.yaml` sha256
`261fc5fbbdce3add9eed79bfbe5db5525e1b65afc3ef7a03fa67357ef0f02996`, `@openlfcp/*` 0.2.2,
`server.lock` `138030a`, `spec.lock` `mvp-0.2-baseline.12` (`bf1c78c`), Obsidian 1.13.4 and 1.14.4, Tasks 8.4.0.

## Evidence (GitHub Actions)

| What | Run | Result |
| --- | --- | --- |
| Native set, 51 specs, Ubuntu / macOS / Windows x Obsidian 1.13.4 / 1.14.4, `release_build=true` (includes `two-hosts`, `upgrade-install`, `upgrade-rollback`, `section-tasks-done`) | [39215441248](https://github.com/openlfcp/obsidian/actions/runs/39215441248) | success. One job (Ubuntu, 1.13.4) failed at the first attempt in `pane-access-copy-detach` (a dialog the spec waited for did not open); `rerun --failed` once, it passed. The other five jobs passed at the first attempt. This is finding F7 of [mvp-0.3-native-matrix.md](mvp-0.3-native-matrix.md) ("product defect or click race, not settled"; earlier failures: run 39063362726 macOS 1.14.4, run 39163258296 Linux 1.14.4), so the flake is a known open item. The log of the failed attempt is not kept here |
| Pane performance B1-B4, macOS, 1.14.4, `release_build=true` | [39215444645](https://github.com/openlfcp/obsidian/actions/runs/39215444645) | B1 p95 108.7 to 123.3 ms in six series (budget 150): PASS; B2 p95 22.1 ms, B4 p95 49.0 ms; B3 cold open p95 37.0 ms (no budget). Its `main.js` sha256 equals the table above |
| Release workflow dry run (`workflow_dispatch`, version 0.5.0-beta.2, branch, after the notes) | [39223415292](https://github.com/openlfcp/obsidian/actions/runs/39223415292) | success: dependency check, build, lint, typecheck, `pnpm test`, release assets, notes exist; attest and release steps skipped |
| Local `release-assets.mjs --tag 0.5.0-beta.2` | n/a | checksums above; the CI runs printed the same `main.js` and `styles.css`; the manifest asset (`manifest-beta.json`) `5c6136ab...` |

The native and performance runs used the catalog `manifest.json` (0.4.2); the manifest asset
differs from it only in `version`. The repository merges by rebase, so the tag commit has a new SHA
with the same `src/`, lockfile and styles; the owner re-verifies the checksums after the release dry
run on `main`. Not rehearsed: rollback to 0.4.2 with the kept copies of a deleted note (048), a crashed
share discard followed by rollback (#53), rollback to beta.1 in real Obsidian, a crash between sending a
held deletion and saving that it was sent (055).

## Not done here

Tag `0.5.0-beta.2` (annotated), the GitHub pre-release with the three attested assets, BRAT check: the owner.
No pilot before 0.5.0 (D31).
