# Candidate manifest: Shared Tasks 0.5.0

The stable candidate of LFCP-03-073 (D31). Nothing here is published: no tag and no release
page exist; the owner creates them.

## Identity

| Item | Value |
| --- | --- |
| Version | `0.5.0` in `manifest.json`, `package.json`, `versions.json` (`"0.5.0": "1.13.4"`) and `manifest-beta.json` (as after 0.4.0, 0.4.1 and 0.4.2) |
| Commit built | `1eda57ad96bcd046052bfad6fd9b2234b4ac4659` (branch `mvp03/073-release-0.5.0`); later commits of the branch are docs only |
| Source base | `main` `94e36b7`; the branch differs from it in the version files and docs, no file under `src/` |
| Build | `pnpm install --frozen-lockfile`, `node scripts/release-assets.mjs --tag 0.5.0` (`release: Shared Tasks 0.5.0 (shared-tasks) in release/`) |
| Reproducibility | the local `main.js` checksum equals the one the performance run printed (`mainJsSha256`); repeated after the last commit |

## Assets and checksums

| Asset | SHA-256 |
| --- | --- |
| `main.js` | `35fb226f28ddb6378ef85a425014873dbc96a63b0e6dcf348e8ed932ab9bae31` |
| `manifest.json` | `5500adc55a32565311a9ad93745946540501045bf2c1eb6715ab84eed9139667` |
| `styles.css` | `373028272ef8c3ed42c2c6b3b3c45ffaec3d030ee3ddd6b6163366d5f91a67c1` |

## Pins

Unchanged from [beta.2](candidate-0.5.0-beta.2.md): lockfile `pnpm-lock.yaml` sha256
`261fc5fbbdce3add9eed79bfbe5db5525e1b65afc3ef7a03fa67357ef0f02996`, `@openlfcp/*` 0.2.2,
`server.lock` `138030a`, `spec.lock` `mvp-0.2-baseline.12` (`bf1c78c`), Tasks 8.4.0.

## Evidence (GitHub Actions, commit `1eda57a`; the notes commit changes no asset)

| What | Run | Result |
| --- | --- | --- |
| Native set, 51 specs, `release_build=true`, Ubuntu / macOS / Windows x Obsidian 1.13.4 / 1.14.4 | [39233558057](https://github.com/openlfcp/obsidian/actions/runs/39233558057) | 4 of 6 jobs passed (Ubuntu both, macOS 1.13.4, Windows 1.14.4). Two failed with 50 of 51 specs passed: Windows 1.13.4 and macOS 1.14.4, both in `section-two-panes` ("a cut in one pane pasted in the other within one pass: a move, Gamma keeps its ID"; expected status CURRENT, received ATTENTION). Not rerun and not diagnosed: the run was started before the scope changed (D32/D33), so this is an open result, not a pass. It looks like the double-move flake C-9 of D30 (1 in 40 on Windows) but is not confirmed, and the spec passed in beta.2's matrix (run 39215441248) |
| Pane performance B1-B4, macOS, 1.14.4, `release_build=true` | [39233568673](https://github.com/openlfcp/obsidian/actions/runs/39233568673) | success; `main.js` sha256 equals the table. B1 p95 108.1 to 146.5 ms (budget 150; `active-leaf` with Tasks on 146.5, the others 108 to 115, at the edge of budget and higher than beta.2's 108.7 to 123.3 on one sample of a shared runner), B2 p95 39.6 ms, B3 p95 36.0 ms (no budget), B4 p95 32.7 ms |
| Short native run, macOS 1.14.4, `release_build=true`: `upgrade-install`, `upgrade-rollback`, `smoke` | [39239809804](https://github.com/openlfcp/obsidian/actions/runs/39239809804) | 3 of 3 passed |
| Release workflow dry run (`workflow_dispatch`, version 0.5.0) | [39233669043](https://github.com/openlfcp/obsidian/actions/runs/39233669043) | success: dependency check, build, lint, typecheck, `pnpm test`, release assets, notes exist; attest and release steps skipped |
| Local `pnpm lint`, `pnpm typecheck` | n/a | exit 0, exit 0 |
| Local `release-assets.mjs --tag 0.5.0` | n/a | checksums above, repeated after the last commit |

Earlier evidence: the full matrix of 0.5.0-beta.2 (run 39215441248, 6 of 6 after one rerun of the
known flake F7); #86 (dialog layout and "Link copied") ran the full native suite on Linux 1.14.4
(run 39226996766). The upgrade from 0.4.2 and the rollback were checked on beta.2; the short run
above repeats them on this build on one system only.

## Order of publication

The community directory and Obsidian read `manifest.json` from `main`, and the release workflow
refuses a tag whose commit does not say the tag's version. So the commit that carries the bump
must exist before the release. The repository merges by rebase, so a tag on the PR head is a
commit that `main` never has (as 0.4.2's tag). Tagging the PR head before the merge keeps
catalog users from seeing 0.5.0 before the release page exists; merging first and tagging
`origin/main` leaves a window of a few minutes (the release workflow's run) in which `main` names
0.5.0 and no release exists (0.4.0 had hours). See the owner's steps in the PR.

## Not done here

Tag `0.5.0` (annotated), the GitHub release with the three attested assets, the post-release
checks: the owner. The full native matrix is not green on this build (two `section-two-panes`
failures above) and is to be scheduled after the release.
