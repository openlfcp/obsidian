# Upgrade, rollback and pane performance of the 0.5 development build

**Task:** LFCP-03-026 (M03-4; U03-21, U03-22; gates G03-D, G03-H, G03-F).
**Date:** 2026-10-17. **Build measured:** `main` of this repository on
branch `mvp03/026-perf-upgrade` (base `82a1700`, the 0.5 development line;
its manifest still says 0.4.2). Everything below ran in GitHub Actions, not
on a developer's machine.

## 1. Verdict

| Criterion | Result |
| --- | --- |
| 1. Frozen workload, hardware and budgets; 30 samples, p95; warm and cold apart; no full-vault scan per caret event; no status writes | **B1 FAIL** (p95 150.1–161 ms against ≤ 150 in 3 of 6 series), B2, B4, B5, B6 **PASS**, B3 recorded (no budget); comparison with 0.4.0 **NOT_RUN** |
| 2. Upgrade with keys, pending queues, journals and an unresolved operation; safe rollback to a pinned section-capable build | **PASS** (0.4.1 → main, 0.4.2 → main, main → 0.4.2 → main; macOS and Ubuntu) |
| 3. Changed schema and limits described; identity and queue never cleared for a test | **PASS** (§4; the specs start from the state a user has and assert it is kept) |

No data loss was found.

## 2. Inputs and pins

| Input | Pin |
| --- | --- |
| Plugin under test | branch `mvp03/026-perf-upgrade`; upgrade run on `d8f4754`, perf run on `837ac83` (test-only commits on `82a1700`); developer build (`LFCP_DEV_PANE=1`, as every native run), `main.js` sha256 `b35c57d6600e13796e324be76f7612b7fecb4bf2107a73f3788309ce5369f1e2` |
| Released builds | GitHub release assets: 0.4.1 (`main.js` sha256 `298aa9fb…`), 0.4.2 (tag → `112a596`, `main.js` sha256 `81bf95a6…`), plus 0.3.4 and 0.4.0-beta.15 for the older upgrade spec |
| SDK | `@openlfcp/*` 0.2.2 on main; 0.2.1 in 0.4.1 and 0.4.2 |
| Server | `server.lock` `138030a` (the same in 0.4.1, 0.4.2 and main), built by `native.yml` |
| Spec | `spec.lock` `mvp-0.2-baseline.12` (`bf1c78c`), unchanged |
| Obsidian / Tasks | 1.14.4 / Tasks 8.4.0 (the harness pins) |
| Host (perf) | GitHub `macos-latest`: Apple M1 (Virtual), 3 vCPU, 7 GiB, Darwin 25.6.0, arm64 |
| Corpus P200 | `test/perf/workloads.ts` W200 (seed 200: 200 Tasks, 50 nested, 200 paragraphs, 50 items, depth 4) shared as one section, inserted into a second note (two projections; 1,154 and 1,101 section lines), and 300 private notes of about 2 KB |

CI runs:

- [39060487550](https://github.com/openlfcp/obsidian/actions/runs/39060487550):
  `upgrade-rollback` and `upgrade-install`, `ubuntu-latest` and
  `macos-latest`, Obsidian 1.14.4: 12/12 passed on each, no skip. (The
  first run, 39060016778, also passed; it could not tell 0.4.2 from main,
  see §3.3.)
- [39060827430](https://github.com/openlfcp/obsidian/actions/runs/39060827430):
  the perf measurements (`-f perf=true`), `macos-latest`: 7/7 passed (the
  flows worked; the budgets do not gate). Artifact
  `native-macos-latest-1.14.4` holds `perf-results/pane-darwin-1.14.4.json`
  (sha256 `82f44642…cacc7`) and the log. The raw samples are also in §5.3.
  The run before it (39060489984) failed while building the corpus (the
  insert clicked the pane before it followed the new note), fixed in
  `837ac83`.

## 3. Upgrade and rollback (U03-21)

### 3.1 What runs

`test/native/specs/upgrade-rollback.e2e.mjs`, in real Obsidian, with the
reference server and the headless peer B. Each case starts from a fresh
vault and builds the state of a user, never a cleared one:

1. the old version installed; a section "Plan" shared from A, B joins and
   inserts it (A's identity, keys and journals, its base store);
2. the server down; A edits a Task (a pending queue);
3. still offline, A shares a second section "Later": created and bound on
   this device, its hosting not done, its creation journal left open at
   phase `projected` with the reason "not reachable" (an unfinished
   operation);
4. the other version installed as an update installs it (disabled, files
   replaced, enabled), the server back.

Then it checks: the same Principal; the same Resources, none added; the
pending edit reaches B and B's later edit reaches A (the section keys);
the unfinished creation finished under **its own operation ID** and its own
Resource (`hosted`, the journal's open list empty), never a second Resource
or a new operation; no marker problem, no section doubled; no notice about a
newer version, an update or upgraded data; the outbound queue drained; the
badge CURRENT.

### 3.2 Compatibility matrix

| From → to | State before | Result |
| --- | --- | --- |
| 0.4.1 → main | section joined; 1 edit queued; 1 creation open (`projected`, not hosted) | **PASS**: Principal kept; 2 Resources before and after; edit at B; B's edit at A; the open creation hosted under its own ID and Resource; queue 2 → 0; no update notice |
| 0.4.2 → main | the same | **PASS**, as above |
| main → 0.4.2 (rollback) | the same, plus `dismissedHints: ["first-use"]` in data.json (a 0.5 setting) | **PASS**: 0.4.2 starts on the data main wrote; Principal and Resources kept; edit sent; creation hosted under its own ID; no "newer version", "update" or "upgraded" notice; `upgradedLocalData` false |
| 0.4.2 → main (after the rollback) | the state 0.4.2 left | **PASS**: Principal and Resources kept, A's edit reaches B, no open creation, no update notice |
| 0.3.4 → main, 0.4.0-beta.15 → main, fresh install, disable/enable, reinstall | `upgrade-install` (support matrix 0.2) | **PASS** (rerun with this build) |
| main → 0.3.x | — | Not supported, as for 0.4 (database version 2, docs/releases/0.4-compatibility.md); not run |
| main → 0.4.1 | — | Not run: 0.4.2 is the pinned rollback target; 0.4.1 lacks the 043 fix (R01) and is not recommended |

All of it on macOS and Ubuntu (run 39060487550).

### 3.3 Which build ran

0.4.2 and main both have `"version": "0.4.2"` in their manifest. The spec
therefore identifies every install by the sha256 of `main.js` read from the
vault on disk by the test process, against the bytes it wrote, and by a 0.5
only method (`setDismissedHints`) on the running plugin:

| Step | Manifest | `main.js` on disk | 0.5 build running |
| --- | --- | --- | --- |
| 0.4.1 before | 0.4.1 | `298aa9fb…` = written | no |
| 0.4.2 before / rollback target | 0.4.2 | `81bf95a6…` = written | no |
| main | 0.4.2 | `b35c57d6…` = written | yes |

The first run read `manifest.json` through Obsidian's adapter and saw
"0.4.2" after installing 0.4.1, although Obsidian loaded 0.4.1's manifest;
the file system read of the second run shows 0.4.1's files on disk. The spec
no longer relies on the adapter read.

### 3.4 Notices seen

After an update and after the rollback, the only notices were
"section "Later" was created on this device; invitation is not ready yet.
The server … is not reachable now…" and then "section "Later" is shared."
The first is the old run's own notice of the offline share or the first
resume attempt before the session was up; the second is the reconcile
finishing. After the round trip back to main: none. No notice names a newer
version, an update or upgraded data.

### 3.5 Headless checks of the same paths (local, short)

`LFCP_SERVER_BIN=<reference server at server.lock> LFCP_REQUIRE_LIVE=1
pnpm vitest run test/core/lfcp/compatibility.test.ts
test/core/settings.test.ts test/core/lfcp/discard.test.ts
test/e2e/sections-resume.test.ts`: 4 files, 27 tests passed, exit 0. They
cover the 0.3 → 0.4 storage upgrade, settings normalization (unknown and
new keys), a discard that keeps a maybe-sent Resource, and unfinished
inserts across a crash on the reference server. Unknown-outcome reconcile of
share, claim and insert across a crash is LFCP-03-024's qualification
(interruption-journeys-qualification.md); its storage is unchanged between
0.4.x and main (§4), so it applies to an upgraded vault too.

## 4. What changed between 0.4.x and main (schema and limits)

**IndexedDB and SDK storage: unchanged.** `@openlfcp/storage` and
`@openlfcp/storage-idb` 0.2.1 → 0.2.2 differ only in their version; the
database name, its version (2) and the local-state sealing are the same.
SDK 0.2.2 changes behaviour, not format: `createInvitation` queues the grant
and its Key Package in one commit (LFCP-03-044), and a throwing profile
listener no longer interrupts a change (`onListenerError`). A 0.4.2 queue
holding a grant and its package from two commits is read by 0.2.2 as before.

**Plugin local state (sealed rows), additive only:**

| Row | Change | 0.4.x reading it |
| --- | --- | --- |
| `resource-discard-reason:<hex>` | new (LFCP-03-002): why a discarded Resource was kept (`RESOURCE_SENT:…`, `DELETE_FAILED`) | ignored; the mark `resource-discarded:<hex>` stays `true` as 0.4 writes it, so 0.4.x still hides the Resource and retries its deletion |
| `section-create:<id>` | optional `discarded` (`pending`/`deleted`/`kept`/`absent`) and `keptReason`; a creation cancelled while its discard has not run stays in the open list `section-creates` | ignored fields; see risk R1 |
| `section-insert:*`, `section-op:*`, `section-base:*`, `collab-hosting:*`, `collab-join-name:*`, `resource-name:*` | unchanged format | — |
| join records | main stores a section joined without a name as no local name (`null`, the shared title shows) | 0.4.x shows the generic name for it |

**data.json:** `dismissedHints` (tip IDs, `^[a-z0-9][a-z0-9-]{0,47}$`, at
most 64) and `developerPanePrototype` (developer only) are new;
`settingsVersion` stays 2. 0.4.x ignores both keys and keeps them until it
saves its settings; after that, back on main, hidden tips show again (cosmetic).
In the rollback run 0.4.2 did not save, so `["first-use"]` survived.

**Limits and timings new in main:** "Check the result" waits at most
60 s (`CHECK_TIMEOUT_MS`); the pane coalesces caret and registry changes for
100 ms (`COALESCE_MS`), which is most of B1 (§5.2). Server, spec and wire
limits are unchanged (same `server.lock` and `spec.lock`); the server quotas
of D20 are untouched.

## 5. Performance (U03-22)

### 5.1 Method

`test/native/perf/pane.perf.mjs`, run only with `NATIVE_PERF=1`
(`gh workflow run native.yml --ref <branch> -f perf=true -f
os=macos-latest`). Budgets and corpus as frozen in
[pilot-0.3.md](../testing/pilot-0.3.md) §1 (LFCP-03-006). Five warm-up
samples, then 30; p95 by nearest rank. The server is local, so no network
wait is in B1–B3.

- **Timing points.** The host event is caused in the page
  (`editor.setCursor`, `workspace.setActiveLeaf`, the pane command) and the
  end is the pane's draw committed to the DOM: the view's `drawings` counter
  read when its synchronous draw returns. Paint is not included. pilot-0.3.md
  asks for a build-time `performance.mark` hook; none exists yet, so the
  harness wraps the view's `render` for the sample and restores it.
- **B3 cold** is the first pane open after Shared Tasks is disabled and
  enabled (its runtime ready, its start-up note pass settled), not after an
  Obsidian restart.
- **B4** opens the pane after a plugin start with the server down, until a
  status fact of the section is visible.
- **B5** counts `vault.read`, `vault.cachedRead` and `adapter.read` by path
  during 30 caret moves after the warm-up. **B6** counts `vault.modify`,
  `vault.process`, `adapter.write/process/append` and `editor-change`
  events during 30 status passes (`scheduleStatus`), with the server taken
  down after 10 and back after 20.

### 5.2 Results (ms)

| ID | Metric | Tasks | p50 | p95 | max | Budget | Result |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| B1 | caret inside the section | off | 118.6 | 127.1 | 138.3 | ≤ 150 | PASS |
| B1 | caret section ↔ private text | off | 124.6 | **161.0** | 181.1 | ≤ 150 | **FAIL** |
| B1 | active leaf between the two projections | off | 121.3 | 144.2 | 144.6 | ≤ 150 | PASS |
| B1 | caret inside the section | on | 121.1 | **150.1** | 156.8 | ≤ 150 | **FAIL** |
| B1 | caret section ↔ private text | on | 125.7 | 147.0 | 148.8 | ≤ 150 | PASS |
| B1 | active leaf between the two projections | on | 127.3 | **152.1** | 152.3 | ≤ 150 | **FAIL** |
| B2 | warm pane open | off | 13.0 | 29.2 | 30.8 | ≤ 500 | PASS |
| B3 | cold pane open | off | 19.3 | 39.6 | 42.2 | none (recorded) | — |
| B3 | plugin ready after enable | off | 154.6 | 230.7 | 242.5 | none | — |
| B4 | loading feedback, server down | off | 17.3 | 38.5 | 45.3 | ≤ 500 | PASS ("Could not connect to the server; trying again. Local updates wait on this device.") |

| ID | Counter | Result |
| --- | --- | --- |
| B5 | reads of notes other than the active one, 30 caret events | **0** (Tasks off and on): PASS. The active note itself is read 3 times per caret event (90 reads of `P200.md`, 92 KB) |
| B6 | Markdown writes and editor document changes from 30 status passes (8 status events, offline and back) | **0** writes, 0 `editor-change`, both notes byte-identical: PASS |

**B1 reading.** About 100 ms of every sample is the pane's deliberate
coalescing (`COALESCE_MS = 100`); the draw after it takes about 20 ms
(p50) on this 3-vCPU virtual M1. Three of the six series exceed the
150 ms p95 by 0.1 to 11 ms, so B1 fails as frozen. The budget is not
changed after the result (pilot-0.3.md §1). Candidate fix: draw a context
change at once (leading edge) and coalesce only the following ones, or
lower `COALESCE_MS`; then rerun B1.

**NOT_RUN:**

- the comparison with 0.4.0 on the same inputs (pilot-0.3.md §1.3): 0.4.x
  has no pane; its card and badge paths were not instrumented;
- a reference desktop other than the GitHub runner (a physical Apple-silicon
  Mac), Obsidian restarts for B3, paint time, and Windows and Linux numbers;
- the join-start variant of B4 (only the pane open with the server down
  ran).

### 5.3 Raw samples (ms, 30 each, in order; also in the artifact)

```text
B1-caret-in-section-tasks-off: 120.3, 119.2, 117.8, 123.5, 122.5, 125.6, 127.1, 122.6, 123.8, 118.4, 116.6, 118.6, 114.1, 123.1, 117.3, 122.8, 123.4, 138.3, 115.8, 117.5, 121.7, 112.7, 124.5, 115.8, 120.4, 113.8, 110.2, 111.9, 115.8, 109.6
B1-caret-section-private-tasks-off: 119.4, 148.3, 181.1, 150.0, 117.4, 119.5, 141.5, 118.3, 110.8, 127.2, 112.7, 112.2, 111.3, 139.0, 124.6, 126.8, 116.3, 127.9, 115.6, 124.6, 161.0, 138.6, 114.6, 129.1, 114.1, 142.7, 118.5, 125.7, 124.9, 125.9
B1-active-leaf-tasks-off: 117.4, 116.2, 117.6, 144.6, 128.3, 113.2, 112.3, 124.0, 126.7, 128.8, 119.2, 138.1, 137.1, 117.9, 114.4, 138.4, 120.3, 129.4, 141.1, 133.8, 118.1, 117.6, 118.3, 112.8, 115.9, 144.2, 126.0, 137.3, 137.0, 121.3
B1-caret-in-section-tasks-on: 110.5, 109.9, 126.7, 144.2, 134.9, 140.7, 156.8, 120.4, 115.3, 135.8, 138.0, 116.7, 148.6, 150.1, 143.4, 115.1, 137.4, 120.3, 112.3, 116.2, 146.5, 111.5, 116.8, 108.3, 110.4, 132.5, 121.1, 130.4, 140.7, 113.4
B1-caret-section-private-tasks-on: 121.5, 131.3, 132.8, 120.8, 135.9, 110.1, 126.3, 119.9, 111.9, 110.0, 127.3, 138.1, 113.8, 124.9, 139.1, 114.6, 125.7, 147.0, 131.5, 132.5, 143.2, 126.1, 137.1, 148.8, 121.5, 121.8, 116.4, 125.6, 124.9, 130.1
B1-active-leaf-tasks-on: 124.0, 133.0, 122.5, 152.3, 152.1, 128.1, 132.2, 142.2, 123.4, 116.6, 113.7, 128.0, 138.1, 125.3, 111.4, 120.8, 145.4, 128.4, 137.5, 120.7, 143.5, 138.6, 113.2, 126.8, 110.4, 136.7, 138.3, 126.0, 123.3, 127.3
B2-warm-pane-open: 10.9, 8.4, 12.1, 14.3, 27.6, 27.4, 7.0, 6.3, 21.1, 27.0, 29.2, 22.8, 29.0, 6.1, 8.1, 10.2, 9.0, 7.3, 7.6, 8.4, 6.5, 6.1, 13.2, 13.0, 29.0, 26.8, 28.7, 30.8, 28.6, 27.9
B3-cold-pane-open: 34.0, 14.6, 14.9, 11.7, 12.8, 32.5, 31.1, 19.6, 12.4, 12.2, 15.7, 15.8, 10.4, 24.5, 39.6, 17.1, 38.3, 42.2, 19.3, 28.7, 33.0, 12.3, 22.3, 15.4, 26.0, 33.6, 29.4, 14.4, 17.3, 25.4
B4-loading-feedback: 14.8, 12.1, 34.5, 37.3, 11.8, 30.0, 28.5, 11.1, 13.1, 13.5, 11.9, 17.3, 14.9, 45.3, 15.6, 24.8, 38.5, 25.6, 36.5, 11.4, 13.5, 31.0, 15.2, 21.6, 29.3, 14.0, 13.4, 29.3, 25.6, 24.6
```

## 6. Residual risks

- **R1 (rollback, narrow).** A share cancelled on main whose discard a crash
  cut leaves its creation in the open list as `cancelled` with
  `discarded: "pending"`, and no `resource-discarded` mark yet. 0.4.2 resumes
  it at each start as cancelled (nothing written, the entry not closed) and
  lists its never-hosted Resource as an ordinary section. No data is lost;
  main finishes the discard when it runs again. Not reproduced natively (it
  needs a crash in that window).
- **R2.** Hidden pane tips come back after 0.4.x saves its settings and main
  runs again (§4). Cosmetic.
- **R3.** The perf host is a 3-vCPU virtual M1, not a physical desktop;
  B1's margin is within 11 ms, so another host can pass or fail it.
- **R4.** The unfinished operation in the native cases is a creation whose
  hosting was not done (server unreachable). An outcome lost after the
  request was sent (a claim or a commit) is covered across a crash by 024's
  headless qualification, not across a version change.

## 7. Candidate tasks

1. B1: draw a pane context change at once and coalesce only the following
   ones (or lower `COALESCE_MS`); rerun `-f perf=true`.
2. B5 side note: the active note is read three times per caret event (no
   other note); one read would do.
3. A build-time `performance.mark` hook for B1/B2 (pilot-0.3.md §1.3) and a
   0.4.x comparison of the card and badge paths.
4. R1: on a rollback-capable path, write the `resource-discarded` mark
   before journaling `discarded: "pending"`, or have 0.4.x close a
   cancelled entry (0.4.x is frozen, so main's order is the place).
