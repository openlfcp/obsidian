# Host and platform baseline for MVP 0.2 (LFCP-02-005)

Evidence for LFCP-02-005, under decision V4: native checks on macOS, a
three-OS CI harness later, manual smoke on Windows and Linux. Written
2026-10-08, obsidian `6cee927`. Details live in the documents linked here;
this report is the index and the open list.

## Environments used

| Item | Value |
| --- | --- |
| Machine | Apple M3 Pro, 18 GB, macOS 26.5.2 |
| Obsidian (app = installer) | 1.13.4 and 1.14.4, downloaded by the [native harness](../testing/native-harness.md); Chromium 150.0.7871.114 / .250 |
| Why not 1.13.1 | The manifest's `minAppVersion` 1.13.1 was an Insider-only beta (fact H1) |
| Obsidian Tasks plugin | 8.4.0 (2026-08-25), installed disabled, enabled by its spec |
| Toolchain | Node 24.4.0, pnpm 10.33.4; WebdriverIO 9.32.0, wdio-obsidian-service 3.2.1 |
| Editor modes covered | Live Preview (default) and Source mode through the editor; Reading view not yet (no 0.3 feature depends on it) |

## What is established

| Area | Result | Where |
| --- | --- | --- |
| Host facts H1–H6 | `minAppVersion` was a beta; tabs by default; comments visible in Live Preview; Outline drag and folding follow the heading model; Tasks appends after an inline ref | [obsidian-host-facts.md](../testing/obsidian-host-facts.md) |
| 0.3 baselines | Start ~70 ms; share 200 Tasks 2.1–2.3 s; edit → queued ~330 ms; change → render ~240 ms | [obsidian-host-facts.md](../testing/obsidian-host-facts.md#03-baselines) |
| ADR 0001 spikes S1–S6 | Transactions, undo grouping, several views, external writes, cost, Live Preview | [ADR 0001](../../architecture/decisions/0001-codemirror-transactions-for-sections.md) |
| Bugs found on the way | A collaborator's change reverted right after sharing (fixed for 0.3.2, `2e0d8a2`); foreign-profile Resources (0.3.2, [legacy-client-and-other-profiles.md](legacy-client-and-other-profiles.md)) | — |
| Decisions affected | M2 and M4 confirmed (H2, H4). **M1 conflicts with the Tasks plugin** (H6), reported to the orchestrator | — |

## Platform matrix (V4)

| Platform | 0.3 today | Proposed for 0.4 |
| --- | --- | --- |
| macOS | CI platform smoke (vitest, two-vault E2E against the real server); native harness locally | Native harness on every release candidate; p95 budgets measured here only |
| Windows | CI platform smoke; never tested by hand | CI native harness (below); manual smoke from [platform-smoke.md](../testing/platform-smoke.md); claim "functional, not performance-qualified" |
| Linux | CI platform smoke; never tested by hand | as Windows |
| Mobile | not tested | Sections read-only or marked unsupported (V3) |

Inherited claims that need regression coverage before they are repeated
for 0.4: "works with the Obsidian Tasks plugin" (only the emoji syntax was
tested in 0.3; H6 is the first real check), "Markdown stays Markdown" (the
per-node markers of decision M5 are visible in Live Preview until the plugin
hides them, H3), and the website's "one invisible comment" (review OP-06).

## `pnpm native` in CI (manual runs only)

A separate workflow, `.github/workflows/native.yml`, so the main CI stays
fast. It exists with a manual trigger only (`workflow_dispatch`, the
orchestrator's decision of 2026-10-08); automatic triggers come later:

- **Triggers (later):** pushes to `main` that touch `src/`, `test/native/`
  or `manifest.json`, and release tags.
- **Matrix:** `macos-latest`, `windows-latest`, `ubuntu-latest` × Obsidian
  `1.13.4`, `1.14.4` (`NATIVE_OBSIDIAN`), `max-parallel: 3`, one Obsidian per
  job (the runner refuses to start next to another).
- **Linux:** run under `xvfb-run` (Electron needs a display).
- **Cache:** `actions/cache` on `OPENLFCP_OBSIDIAN_CACHE` (set to
  `${{ runner.temp }}/obsidian-cache`), keyed by OS, the Obsidian version and
  the hash of `test/native/pnpm-lock.yaml`; about 630 MB per OS and version.
- **Steps:** checkout, pnpm with the root lockfile, `pnpm native`, upload
  WebdriverIO logs and `METRIC` lines as an artifact; the baselines are not
  gated (numbers vary by runner).
- **Order:** first `workflow_dispatch` only on macOS, then Linux, then
  Windows (Windows firewall prompts are a known wdio-obsidian-service note).

## Open (still in LFCP-02-005)

- IME composition: the manual check [ime-checklist.md](../testing/ime-checklist.md),
  by the owner before the first 0.4 beta.
- Performance and pilot targets: the baselines above are inputs, not
  budgets; the owner freezes budgets in LFCP-02-067.
- Reading view mapping and clipboard checks: when sections render there
  (LFCP-02-048, 063).
- Windows and Linux by hand: never done for 0.3; on the 0.4 candidate.
