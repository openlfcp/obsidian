# Interruption and durable journeys (LFCP-03-024)

The evidence of LFCP-03-024 (M03-4, P0; findings F-03, F-04; cases
U03-09…U03-17; gates G03-A, G03-C, G03-D, G03-E). It closes the crash and
recovery scenarios the MVP 0.3 baseline left unrun, on the reference
server, and maps every case to the tests that hold it. Written 2026-10-15
on `main` `6595d4e` (tasks 001–023, 039 merged).

## Pins

| Part | Pin |
| --- | --- |
| Plugin | branch `mvp03/024-interruption-journeys` from `main` `6595d4e` |
| SDK | `@openlfcp/*` 0.2.1 (`package.json`, lockfile) |
| Server | `openlfcp/server` `138030a` (`server.lock`), release build, `LFCP_SERVER_BIN`, `LFCP_REQUIRE_LIVE=1` |
| Spec | `mvp-0.2-baseline.12` (`bf1c78c`), `LFCP_SPEC_DIR` |
| Native | `native.yml`, Obsidian 1.14.4, ubuntu-latest; the run ID is in the PR |

## Harnesses and evidence levels

- **Real plugin, real server** (`test/e2e`, E2EVault and SoakPeer): the
  plugin on a mock Obsidian app, IndexedDB, the SDK's signed and encrypted
  transport against the reference server. A *crash* kills the plugin
  instance: its sockets, timers, lock and vault handlers go, nothing is
  stopped or flushed. A new instance starts over the same vault, local
  storage and IndexedDB. A *lost answer* is one incoming frame dropped
  (the DropTap rule, `network.dropNextIn`). *Between reservation and
  write* is a storage commit with a Data Unit that never returns
  (`hangUnitCommits`).
- **Headless peer, real server** (`test/core/**/live-*.test.ts`, the
  native peer): the plugin's core without Obsidian.
- **Fakes** (`test/core`): the journals and flows on fake ports, each
  phase stopped in turn.
- **Native** (`test/native/specs`): the built plugin in real Obsidian, in
  CI.

A crash in this process cannot cross a process boundary. A promise of
the dead instance that was already running can still finish against the
shared storage. The SDK's own child-process crash tests cover that layer.
No human pilot was simulated (G03-G stays with the pilot task).

## Fault schedule (new: `test/e2e/sections-interruption.test.ts`)

Owner A shares six Tasks; B joins read-write and inserts into a closed
note. C and D join later. Each row names where the fault falls relative
to the durable effect, and what is checked.

| # | Case | Fault: before / after which effect | Checked: journal and storage | Checked: source note | Checked: peer and server |
| --- | --- | --- | --- | --- | --- |
| 1 | U03-09, F-03 | Share: after the import is committed and the note bound, after the server hosted it; its `RESOURCE_HOSTED` dropped; crash | No "is shared" before the crash. After: "is shared" from the new instance, no share flow left, the registry and the stored Resources +1 exactly (no orphan), `RESOURCE_HOST` sent again for the same Resource | One section, one start and one end marker for that Resource | No "stopped syncing", "no longer", "could not" or "lost" notice. C joins it: each Task once, none of the private text around the section |
| 2 | AC1 | Edit: after commit and `DATA_PUT`; its ACK dropped; crash | The unit still queued before the crash; queue drained after it; more `DATA_PUT` frames sent | — | A stores B's units +1, the last one with the queued unit's ID and byte hash; sequences unique and increasing; the title once in A's note |
| 3 | AC1 | Edit: after the SDK reserved the sequence, before the unit was written; crash | Counter at `n+1` before the crash, queue empty; after it the counter is `n+2` | The edit stays in the note and is sent from it | A holds B's unit at `n+2` (`n+1` lost, never reused); the title once; no `EQUIVOCATION` in the server log |
| 4 | AC1 | Edit queued offline; crash while offline | Same outbound item ID and byte hash after the crash | — | Back online: A stores exactly one more unit, with that ID; no reuse |
| 5 | U03-10 | Claim: after its ACK, before the insert; crash | Same Principal after the crash; the Resource once in the registry | — | The same link again sends no `CONTROL_PUT`; A lists C once as a member; the section loads |
| 6 | U03-15 | Two more copies on B (Second.md, Third.md). Second.md loses its whole copy (markers and all), Third.md is deleted | B's counter unchanged, B's queue empty, A stores no new unit of B | B's other copy unchanged; Second.md keeps only its own text; Third.md is not recreated | A's note and model unchanged. Then A deletes a Task in its editor: B's copy loses it (A's units on B grow), and the removed copies do not come back |
| 7 | U03-17, F-04 | A read-only member (D) edits a Task title; crash | A kept candidate with reason `read-only` before and after the crash; diagnostics show its reason and size, never its text; no counter for D, no queue, no `DATA_PUT` sent | The held edit stays in D's note across the crash | A's note unchanged. A's next edit reaches D's model, and D's held line stays |
| 8 | G03-D, privacy | All of the above | — | — | No frame sent or received by A, B, C or D, and no file the server stored, contains the private text, a shared title, an edited title or the held edit (more than 100 frames, `DATA_PUT` frames present) |

Three consecutive runs: 8/8 passed each time.

## Case map

| Case | Pass condition (summary) | Evidence | Status |
| --- | --- | --- | --- |
| U03-09 Double Share | One active flow, no orphan, no false lost-hosting notice; before and after durable effects | New #1; `create.test.ts` (each phase, a lost ACK, created twice, two at once); `share-reservation.test.ts` (entry points, crash after import); `live-discard.test.ts`; native `section-share-reservation`, `section-share-held` (F-03) | PASS (headless and native) |
| U03-10 Interrupted claim | Lost response or crash, restart, the same claim; no new identity, the invite spent once | `sections-resume` #3 (claim ACK lost, crash offline, same claim, the link refused to a fourth vault); `live-join-resume.test.ts`; new #5 (claim answered, then a crash); `join-flow.test.ts`; native `pane-join` | PASS |
| U03-11 Join errors | Malformed, used, expired, offline, refused, unknown told apart; no secret in logs or settings | `join-flow.test.ts` (errors by cause, malformed, never holds the secret); `sections-resume` #3 (secret in no setting, notice or pane); `diagnostics.test.ts`; native `pane-join` | PASS. "Expired" does not happen: D2, links do not expire |
| U03-12 Target changes | Switch, rename, close, delete: the right target or an explicit reselect | `actions.test.ts` (U03-12), `insert-destination.test.ts`, `share-reservation.test.ts` (rename, delete); native `section-stable-target`, `pane-insert` | PASS |
| U03-13 Insert crash/retry | Before and after the source write and the registration; one retry; a later explicit insert is new | `sections-resume` #1 and #2 (live, crash); `insert-resume.test.ts`; `insert-destination.test.ts` (D12, a second explicit copy); native `pane-insert` | PASS |
| U03-14 Cancel/unknown | Closing the pane does not cancel a committed result; continue later or reconcile; no automatic delete or revoke | `insert-resume.test.ts` (Continue, Cancel), `share-reservation.test.ts` (given up after a durable effect: kept, not deleted, no notice, also after a crash), `discard.test.ts` (only never-sent Resources deleted), `join-flow.test.ts` (Later, Give up); UX contract P6 (flows belong to the plugin, not the pane) | PASS |
| U03-15 Projection/delete/detach | Two projections; detach one; body delete against whole-projection removal; private and remote work kept | New #6 (whole copy, note deletion, body deletion, live); `live-detach-access.test.ts` (detach, three members); `placement-index.test.ts`; native `pane-access-copy-detach` | PASS |
| U03-16 Recovery | Scalar, placement, retained, base, boundary alternatives; stale choice; the held edit after a repair checked on the peer | `live-problem-repair.test.ts` (held while damaged, repaired from its row, the peer gets it); `recovery.test.ts`, `repair.test.ts`, `actions.test.ts` (problem hub resolvers); `live-review-conflicts.test.ts`; native `pane-problem-hub` (the held edit reaches B) | PASS |
| U03-17 Access | Read-only clean and edited, stale and current, not a member, revoked, refused told apart; rejected source kept; recipient UI | New #7 (read-only candidate across a crash); `access-connection.test.ts`; `live-detach-access.test.ts` (revoked: kept copy, nothing new); native `section-access-mid-edit`, `section-share-held` (F-04 read-only), `pane-access-copy-detach` | PASS |

Acceptance criteria:

1. DropTap, process restart and the real server, with the exact operations
   before and after each effect or ACK, and no identity or sequence
   reused: **PASS** (#1–#5; `restart.test.ts` #2/#3 for 0.1;
   `restart-mid-pass.test.ts` and `stale-work-restart.test.ts` for every
   journal phase on fakes).
2. Orphan registry, saved candidates, whole-projection semantics, the held
   edit after a repair on the peer: **PASS** (#1, #7, #6,
   `live-problem-repair`).
3. Headless and security evidence kept apart from native UI; no simulated
   pilot: **PASS** (the levels above; native is a separate run).

## Product changes

None. No defect of interruption or durability was found: nothing was
lost, nothing was applied twice, and no identity or sequence was reused.

## Observations and candidates

- **O1. A deleted note's projection bases stay in local state.** On a
  vault delete the host unindexes the note but does not drop its bases
  (`SectionsHost.vaultChange`; a rename moves them). Nothing is sent and
  nothing is wrong in the notes (#6). This is local-state growth only.
  A small cleanup task, if wanted.
- **O2. A crash within one process.** See the harness note above: a real
  process kill across IndexedDB is checked by the SDK, not here. The
  native `section-restart-mid-pass` spec restarts the real app.
- **O3. Native fixtures (C4 of LFCP-03-023).** Building each `states.json`
  state in real Obsidian is still NOT_RUN. It is not an interruption
  journey, so it was not taken into this task.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint; pnpm typecheck
LFCP_SPEC_DIR=<spec checkout at bf1c78c> \
LFCP_SERVER_BIN=<lfcp-server at server.lock> LFCP_REQUIRE_LIVE=1 pnpm vitest run \
  test/e2e/sections-interruption.test.ts
LFCP_SPEC_DIR=… LFCP_SERVER_BIN=… LFCP_REQUIRE_LIVE=1 pnpm vitest run --no-file-parallelism \
  test/e2e/sections-resume.test.ts test/e2e/restart.test.ts \
  test/core/collab/live-join-resume.test.ts test/core/sections/live-problem-repair.test.ts \
  test/core/sections/live-detach-access.test.ts test/core/sections/live-discard.test.ts
pnpm test
gh workflow run native.yml --ref mvp03/024-interruption-journeys \
  -f specs=section-share-reservation,section-share-held,pane-join,pane-insert,pane-problem-hub,pane-access-copy-detach,section-restart-mid-pass,section-access-mid-edit
```

The results are in the PR description.
