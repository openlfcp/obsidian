# Shared sections: headless performance of the plugin

**Tasks:** LFCP-02-067 (the plugin's headless side) and LFCP-02-068.
**Date:** 2026-10-09. The SDK and server side of 067 (history growth,
admission, server storage) is measured in
[.github docs/devel/reports/section-scale-measurements.md](https://github.com/openlfcp/.github/blob/main/docs/devel/reports/section-scale-measurements.md);
this report does not repeat it.

## 1. What was measured, and how

`LFCP_PERF=1 LFCP_PERF_OUT=<file.json> pnpm perf` runs
`test/perf/sections.perf.test.ts`: the plugin's section paths on a real
runtime (SDK `@openlfcp/*` at `sdk-ts.lock` b92f701, IndexedDB storage
through fake-indexeddb, the section engine as the plugin runs it),
offline, one process, one workload at a time, Node 24.4 on an Apple M-series
Mac. The ordinary test run skips it.

Workloads (`test/perf/workloads.ts`, the plan's §9, recorded seeds): one
note per workload, the section under `## Workload` between private text.

| Workload | Seed | Tasks (nested) | Paragraphs × scalars | Items | Depth | Note bytes |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| W20 | 20 | 20 (0) | 20 × ~80 | 10 | 1 | 4,183 |
| W100 | 100 | 100 (25) | 100 × ~120 | 25 | 4 | 24,684 |
| W200 | 200 | 200 (50) | 200 × ~200 | 50 | 4 | 72,830 |
| W200-H | 200 | W200 after 10,000 changes | | | | 72,830 |
| W2000 | 2000 | 2,000 (500) | 2,000 × ~200 | 500 | 4 | 727,839 |

Latin, Cyrillic and emoji text, supported Tasks dates. W200-H: 10,000
changes committed to the model as other writers' (text edits, moves of
root nodes, which leave old placement slots, deletions and restores), in
batches of 10, then measured like W200.

Metrics, each after warm-up (W20–W200: 5 warm-up, 200 edit samples, 30 of
the others; W200-H: 3/50/10; W2000: 2/10/3):

| Metric | Boundary here | Plan §10 metric |
| --- | --- | --- |
| Durable local update | one paragraph edited in the note → the engine pass until its commit's durable receipt (no coalescing wait) | Durable local update |
| Remote projection | another writer's text edit in the model → the pass that writes it into the note (no render) | Remote projection (render NOT_RUN) |
| Cached open | restart on the same storage → section open → its note passes with nothing to change | Cached section open (UI NOT_RUN) |
| Card | the details card's facts from the cached model | Details card (render NOT_RUN) |
| Longest event-loop delay | during the edit samples (monitorEventLoopDelay) | Main-thread blocking, a proxy |
| Heap, RSS | Node process after the run | Incremental memory, a proxy |

**NOT_RUN** (native or network needed; the native batch runs them):
input responsiveness (key to paint), render of remote changes, the card's
paint, reconnect backlog at 100 ms RTT / 10 Mbit/s, memory against a
plugin-disabled Obsidian, lifecycle cleanup over 20 open/close cycles.
Cold-start runs were not separated (all samples are warm).

## 2. Results (p95, ms; after the fixes of §3)

| Workload | Durable local update | Remote projection | Cached open | Card | Longest delay | Heap MiB | Checkpoint bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| W20 | 151 | 68 | 129 | 0.1 | 119 | 114 | 8,714 |
| W100 | 524 | 276 | 260 | 0.2 | 389 | 144 | 34,925 |
| W200 | 1,052 | 587 | 522 | 0.4 | 768 | 216 | 72,922 |
| W200-H | 1,551 | 902 | 1,185 | 0.3 | 976 | 570 | 94,863 |
| W2000 | 11,013 | 7,674 | 6,248 | 10.5 | 6,010 | 749 | 706,167 |

p50 and max are in the JSON output. Budgets (plan §10, W200): durable
local update ≤ 300, remote projection ≤ 250, cached open ≤ 2,000,
card ≤ 200, no task > 200.

**W200 does not meet the durable update, remote projection and blocking
budgets.** Cached open and the card do. The cost grows linearly with the
section's size (W20 → W100 → W200 ≈ 1 : 3.5 : 7).

**W200-H:** correct after 10,000 changes (every pass committed or
projected; no crash). Against fresh W200: durable update ×1.47, remote
projection ×1.54, cached open ×2.27 and heap ×2.6. Cached open and memory
pass the plan's "investigate above twice" line: both follow the
history (the retained slots and changes the SDK walks), see §4.

**W2000** (exploratory, mandatory for safe failure): created (35 s), every edit was committed and every remote change projected (the run fails otherwise), and a restart reopened the section with nothing to change in the note; no crash. It is about ten times W200 (linear): an edit blocks the main thread for up to 6 s, which in Obsidian would freeze the editor. Not a supported size; the SDK remediation of §4 is what changes it.

## 3. What the plugin changed (068)

Profiled with the V8 sampling profiler around one W200 pass:

| Change | Commit | W200 p95 before → after |
| --- | --- | --- |
| The port keeps a replica's snapshot per revision: the status (every 2 s), the card and the engine asked for it again at one revision; each read walks and validates the whole document (~400 ms) | 3af9e6f | card 412 → 1; durable 1,623 → 1,244; remote 1,196 → 801; open 1,070 → 798 |
| `nodeSource` split the note into lines for every node (quadratic, ~130 ms of a pass); the lines of the last note are kept | 4607317 | durable 1,244 → 1,034; remote 801 → 704; open 798 → 534 |

Found on the way: a Task nested three or more levels deep made sharing
the section fail ("not a Task line"): a lone line indented 4+ spaces read
as code. Fixed in c4ab7ee (W100/W200 nest to depth 4).

No semantics changed: no history pruning, no truncation, no privacy check
removed. Section tests and the e2e suite pass after each change.

## 4. What remains: the SDK (remediation)

A W200 editing pass now spends about 820 of its ~1,000 ms in sdk-ts:

- `SyncClient.commit` → `stage` → `#prepare` → `validateSection`, ~410 ms
  per commit;
- `SectionReplica.snapshot()` at the new revision → `deriveTree` →
  `validateSection`, ~410 ms (the cache cannot help: the revision just
  moved).

`validateSection` reads every value of every field of every node with a
separate Automerge call (`getAll`, 354 of 364 ms). The remediation is in
sdk-ts (handed to 24, to be scheduled by the orchestrator): read the
document in one pass, cache the validation and the tree per heads, then,
if needed, validate only what a commit touches. The same work explains
W200-H's growth. Until then the plugin cannot meet the W200 durable,
remote and blocking budgets.

## 5. After sdk-ts a3e205f

The remediation of §4 is in sdk-ts:

- 63a2d30 validates one revision once: a reader keeps each Automerge
  answer for its pass (29,626 backend calls become 11,913 on W200), and a
  validation is kept per document and per heads, so the commit no longer
  validates the revision the last snapshot validated.
- a3e205f validates a later revision only where its changes touched:
  the facts of each node, placement and object are kept with the
  validation, the entities `A.diff` names between the two heads are read
  again, and the checks across entities are assembled from the facts.

The result equals a validation in full. A seeded test compares the two at
every revision of random histories: valid and invalid writes, concurrent
edits, collisions and deletions. The sections corpus (SS01 to SS60) and
the Automerge corpus (`CAN-*`, `REF-*`) pass unchanged. In sdk-ts, on
W200, one edit and the snapshot after it took 791 ms before and take
53 ms; a new revision's validation took 147 ms after 63a2d30 and takes
6 ms.

The same harness as §2 (fake IndexedDB, Node 24.4, Apple M-series),
against sdk-ts a3e205f, gave these p95 values in ms:

| Workload | Durable local update | Remote projection | Cached open | Card | Longest delay | Heap MiB | Checkpoint bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| W20 | 39 | 18 | 32 | 0.1 | 18 | 164 | 8,678 |
| W100 | 115 | 78 | 106 | 0.1 | 89 | 400 | 34,847 |
| W200 | 221 | 211 | 232 | 0.3 | 150 | 307 | 73,000 |
| W200-H | 559 | 458 | 737 | 0.3 | 454 | 615 | 94,851 |
| W2000 | 2,493 | 2,724 | 3,260 | 8.9 | 1,807 | 1,269 | 705,197 |

- **W200 meets every budget** of plan §10:
  - durable local update: 221 ms, budget 300 (before: 1,052);
  - remote projection: 211 ms, budget 250 (before: 587);
  - longest event-loop delay: 150 ms, under 200 (before: 768);
  - cached open: 232 ms, budget 2,000; card: 0.3 ms, budget 200.
- **W200-H is open for investigation.** It improved about threefold
  (durable 1,551 → 559, remote 902 → 458, open 1,185 → 737). It is still
  2.5 times fresh W200, above the plan's "investigate above twice" line.
  As §2 notes, the cost follows the history: the retained placement slots
  and the changes the SDK walks. This run did not separate the parts. The policy for history growth is the
  owner's decision 112, and this remains open with it.
- **W2000** remains not a supported size. A durable update now takes
  2,493 ms (before: 11,013), and the longest blocking is 1,807 ms.

## 6. Raw data

The JSON of each run (`LFCP_PERF_OUT`) holds every metric's n, p50, p95
and max, the workload spec, note sizes, queued units and checkpoint
bytes. Re-run with `LFCP_PERF=1 LFCP_PERF_OUT=/tmp/perf.json pnpm perf
-- -t "W200$"` for one workload.
