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

## 5. Raw data

The JSON of each run (`LFCP_PERF_OUT`) holds every metric's n, p50, p95
and max, the workload spec, note sizes, queued units and checkpoint
bytes. Re-run with `LFCP_PERF=1 LFCP_PERF_OUT=/tmp/perf.json pnpm perf
-- -t "W200$"` for one workload.
