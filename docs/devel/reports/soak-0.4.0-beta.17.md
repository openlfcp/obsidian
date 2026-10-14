# Soak of Shared Tasks 0.4.0-beta.17 (discovery)

**Date:** 2026-10-14. **Run:** 03:55–08:00 UTC, 245 minutes.
**Plugin:** obsidian `main` at `10b2116`. That is beta.17 (`b59c651`) plus the
fixes and harness commits landed until then, among them the
batch-release status fix (`314fa7c`) and the epoch Snapshot after a
removal (`05adad7`).
**SDK:** `@openlfcp/*` 0.2.0-beta.8. **Server:** the reference server
built at `138030a`, which behaves as 0.3.2.

This run is a **discovery run, not an acceptance**. It found the
problems below. Most were fixed on `main` while it ran, so the run itself
does not show their fixes. The acceptance soak runs on the 0.4.0-beta.18
candidate.

## 1. Setup

The harness is `node test/soak/soak.mjs`, headless, with its peers in
`test/soak/`.

- **Three peers, each in its own process.** Each is the real plugin on a
  mock Obsidian app under happy-dom, with a CodeMirror view carrying
  the plugin's own editor extensions, as a note open in Live Preview.
  IndexedDB is fake-indexeddb, with finished transactions pruned.
- **Plugin settings:** the plugin's own tick of 250 ms; the reference
  server on 127.0.0.1 only (sockets elsewhere are refused).
- **Content:** one shared section of 150 Tasks (one in ten nested)
  owned by A, joined and inserted by B and C. Two 0.1 shared Tasks in
  another note, joined by B and C too.
- **Edits:** each peer edits its own Tasks about every 2–6 s, through
  editor transactions:
  - typing a title;
  - the checkbox;
  - a new Task;
  - deleting a Task's lines;
  - cut, then paste after another root Task 0.3–1.5 s later;
  - Tab and Shift+Tab;
  - now and then, a 0.1 Task.
- **Events:**
  - every 15–30 min, one peer offline for 2–5 min;
  - the server restarted (10 s down) at 82 and 161 min;
  - at 131 min, A removed C ("Remove access", a Data Epoch rotation),
    and a new identity C2 was invited, joined and inserted the section.
- **Checkpoints, every 10 min (about 15 with the settle wait):**
  - edits pause;
  - up to 5 min for quiet (nothing to send, the same model revision and
    content everywhere, every note equal to its model, no condition on
    any section);
  - then each peer's RSS, heap, pass p50/p95 since the last checkpoint,
    stored units, and the server's state size are recorded.

Raw data: `~/dev/openlfcp-rw/runs/soak/soak-4h/` on the test machine
(`samples.jsonl`, `events.jsonl`, `soak.log`, the notes of each
unsettled checkpoint).

**Overlap window, 52–72 min:** two 40-minute reconnect measurement runs
(6 more peers) and a two-peer repro ran on the same machine from 04:51
to 05:07 UTC. Pass times and RSS at checkpoints 5 and 6 are inflated by
that load and are not comparable with the rest.

## 2. Pass criteria and the result

| Criterion | Result |
| --- | --- |
| No divergence | **Met for the models**, with one transient. The shared models were equal at 17 of 18 checkpoints. At checkpoint 10 (131 min, B's pass p95 at 106 s) they differed and were equal again at the next. The 0.1 tasks never differed. **Not met for the notes**: from 67 min a note showed a Task the model hides (§4, #10), and from 146 min C2's note held edits it never sent (§4, #11). |
| No growth trend beyond ~20 % in memory or pass time | **Not met.** Both grow with the section's history (§3). |
| Every reconnect under 30 s | **Not met.** After an outage of 2–5 min, up to 56 s (§3). Server restarts: 1–9 s. |

## 3. Measurements

Per checkpoint: units stored by A, pass p50/p95 in ms, RSS/heap in MiB.

| # | min | Tasks | Server MiB | A | B | C (C2 from 11) |
| ---: | ---: | ---: | ---: | --- | --- | --- |
| 1 | 0 | 151 | 0.8 | 4 u, 120/177, 332/110 | 154 p95, 326/127 | 175 p95, 371/152 |
| 2 | 15 | 165 | 4.6 | 429 u, 141/267, 393/116 | 309, 593/162 | 310, 655/230 |
| 3 | 27 | 175 | 5.3 | 985 u, 206/438, 511/99 | 430, 695/130 | 464, 748/269 |
| 4 | 42 | 172 | 6.1 | 1,424 u, 280/672, 606/130 | 684, 828/122 | 707, 881/225 |
| 5\* | 52 | 170 | 6.6 | 1,865 u, 374/1,141, 937/254 | 1,518, 1,062/244 | 1,450, 1,051/257 |
| 6\* | 67 | 156 | 7.4 | 2,223 u, 876/4,799, 1,223/122 | 6,396, 1,111/369 | 6,277, 1,279/129 |
| 7 | 82 | 164 | 8.0 | 2,569 u, 857/4,088, 1,373/236 | 5,283, 1,167/231 | 6,525, 1,450/386 |
| 8 | 97 | 141 | 8.4 | 2,829 u, 1,129/4,730, 1,630/214 | 12,722, 1,354/155 | 10,058, 1,532/269 |
| 9 | 113 | 137 | 9.1 | 3,067 u, 1,021/4,286, 1,893/683 | 30,443, 1,488/240 | 25,802, 1,596/256 |
| 10 | 131 | 139 | 9.3 | 3,267 u, 2,383/5,213, 2,036/170 | 106,027, 1,543/423 | 63,907, 1,640/506 |
| 11 | 146 | 106 | 9.9 | 3,424 u, 1,400/4,775, 2,123/120 | 18,579, 1,561/355 | C2: 159 u, 2,326, 1,089/88 |
| 12 | 161 | 121 | 10.5 | 3,636 u, 1,109/3,971, 2,340/478 | 8,833, 1,606/194 | 1,684, 1,149/611 |
| 13 | 176 | 117 | 10.9 | 3,796 u, 1,204/4,040, 2,545/298 | 17,583, 1,666/300 | 2,119, 1,212/502 |
| 14 | 191 | 113 | 11.4 | 3,946 u, 1,396/9,637, 2,672/319 | 54,032, 1,692/211 | 4,027, 1,213/310 |
| 15 | 207 | 113 | 11.6 | 4,109 u, 1,262/5,559, 2,886/326 | 16,324, 1,791/744 | 1,895, 1,252/101 |
| 16 | 222 | 121 | 12.0 | 4,280 u, 1,423/9,214, 3,081/620 | 16,011, 1,913/236 | 2,627, 1,284/308 |
| 17 | 237 | 137 | 12.2 | 4,419 u, 1,378/2,880, 3,296/565 | 23,120, 1,992/243 | 2,035, 1,269/106 |
| 18 | 245 | 126 | 12.2 | 4,468 u, 2,451/10,021, 3,357/708 | 22,970, 2,054/262 | 2,435, 1,332/453 |

\* Checkpoints 5 and 6 fall in the overlap window (§1).

**Memory and pass time grow with the history, not with the Task count.**
- The Task count stays between 106 and 175. A's pass p50 grows from 120 ms
  to 1–2.5 s and its RSS from 332 MiB to 3.4 GiB, roughly in step with
  the units stored (4 to 4,468).
- Heap stays at 100–750 MiB, so the growth is outside the JS heap.
- C2, which joined at 131 min from a Snapshot with about 1,200 units since,
  stays at p95 about 2 s and 1.1–1.3 GiB.
- Short runs with the WASM probe (`wasmMiB`, `79379c6`) measured
  Automerge's linear memory at 6–7 MiB at the start and 44–51 MiB at
  about 435 units per peer.
- The cause is in the SDK: its section replica kept a copy of the
  document per unchanged Task. It is fixed in sdk-ts 0.2.0-beta.9 (its
  CHANGELOG: "A section's replica no longer keeps an old copy of the
  document per unchanged task").
- Units stored are not a catch-up measure: a peer that loads a Snapshot
  holds fewer units (B 72 behind A from 52 min, after loading A's
  Snapshot) with the same model.

**Reconnects** (to the first frame from the server, and until nothing
waits to be sent):

| min | Event | First frame | All sent |
| ---: | --- | ---: | ---: |
| 27 | A offline 3.1 min | 55.6 s | 59.1 s |
| 49 | B offline 4.7 min | 24.0 s | 30.8 s |
| 74 | C offline 2.1 min | 5.2 s | 12.1 s |
| 83 | server restart (10 s down) | 7.3–8.6 s | 10.5–14.8 s |
| 101 | A offline 2.8 min | 22.7 s | 57.3 s |
| 126 | C offline 4.3 min | 49.1 s | 82.3 s |
| 150 | B offline 2.8 min | 20.8 s | 60.6 s |
| 162 | server restart (10 s down) | 0.9–6.6 s | 7.6–25.7 s |
| 182 | B offline 3.9 min | 22.7 s | 128.0 s |
| 212 | A offline 3.3 min | 56.2 s | 143.1 s |

- The backoff was the SDK's 1 s doubling to 60 s, and the harness's
  offline switch gives no window "online" event (a server or route
  outage).
- With the plugin's policy since `79379c6` (1 s doubling to 15 s,
  ±20 %), outages of 0.5–0.8 min reconnected in 5.5–10.9 s. With the
  "online" event, in 0.1–0.2 s.
- "All sent" after long outages includes slow passes under the growth
  above.

## 4. Findings

Each is numbered as reported during the run.

| # | Finding | Root cause | Status |
| --- | --- | --- | --- |
| 1 | A section stuck at "SENDING, 1 pending" after reconnects, everything sent | A receipt release (plugin, outside the SDK's queue) raced the ACK's report: the SDK reported "pending" for a batch accepted and gone | Fixed, `314fa7c` (in this build); SDK follow-up LFCP-02-121 |
| 2, 4 | Passes and memory growing on long-lived peers | Partly the harness's fake-indexeddb (fixed in the harness, `10b2116`); the rest the SDK replica (above) | sdk-ts 0.2.0-beta.9 |
| 3 | A member invited after a removal never loads the section | After a rotation a newcomer receives only the current epoch's key; no current-epoch Snapshot was published | Fixed, `05adad7`; native spec `6612a67` |
| 5 | "source-diverged" after collaborators' deletions | Traced by robust-simon | Fixed, `72d4c2b`, `a8ab6a0` |
| 7 | Pass time grows with history | See §3 | sdk-ts 0.2.0-beta.9 |
| 8 | Reconnects up to 56 s | SDK backoff to 60 s; the plugin reconnected at once only on "online" | Fixed, `79379c6` (15 s cap, "focus") |
| — | "Server confirmation unavailable" growing (A 113, B 292 batches at 245 min) | A late ACK after the request-timeout sweep (a busy event loop) was taken as uncorrelated: its units "unconfirmed" for good | Fixed in sdk-ts 0.2.0-beta.9 (`rw/late-ack`, `695cd08`) |
| 9 | Moving one's own Task by cut and paste deletes it for collaborators | A paste while a pass wrote: the coordinator took the pass's older text as the source and dropped the paste's hint | Fixed, `ff117a3` |
| 10 | A Task the note shows and the model hides, with the badge CURRENT (C's c216 from 67 min, B's copy to the end) | Detector gap; the cause is likely #9 (an indent's hints dropped), not traced | Detector fixed, `0c9ad42` |
| 11 | C2, invited after the removal, at "Needs your attention" (source-binding-error) from 146 min to the end, 21–37 unbound lines, its Task titles behind the model | Not traced | **Open**: to be checked in the beta.18 acceptance soak, which has #3, #9, #10 and the SDK fixes |
| — | B and C 72 and 36 units "behind" A | Not a bug: units covered by a loaded Snapshot are not stored (WIRE §29.3); the models were equal | — |

## 5. Next

The acceptance soak runs on the 0.4.0-beta.18 candidate (with sdk-ts
0.2.0-beta.9), with the same harness and pass criteria, and checks #11
in particular. No further discovery runs on beta.17.

## 6. Acceptance soak on 0.4.0-beta.18

**Date:** 2026-10-14. **Run:** 08:05–12:11 UTC, 245 minutes, on obsidian
`main` at `af16007` (0.4.0-beta.18) with `@openlfcp/*` 0.2.0-beta.9 from
npm. It uses the same harness, events and criteria as §1 and §2, and ran
with nothing else from the workers on the machine. The owner's desktop
Obsidian was open.

There was one interruption. At 09:48:30–09:49:03 UTC (103 min),
robust-simon took a 30 s CPU profile of peer B (inspector on
127.0.0.1, then closed), with the orchestrator's agreement. B's pass
times at checkpoint 11 include that window.

**A conflict nobody resolves, from 86 min.** A genuine concurrent
structural conflict arose: some of a peer's Tasks sit under another
peer's, and an owner deleted a parent while another peer added a child.
No peer resolves conflicts in the harness, so all sections stayed at
"Needs your attention" (structural-conflict) from then on. The
orchestrator agreed to judge convergence from then by the models, and
by the notes outside the conflicted subtree.

### Result

| Criterion | Result |
| --- | --- |
| No divergence | **Met, with one transient.** Every checkpoint to 70 min converged. The models (and the 0.1 tasks) were equal at every checkpoint but 15 (184 min). There B, whose single passes then took minutes, was 245 units behind and still applying; the models were equal again from 16. |
| No growth trend beyond ~20 % | **Not met for pass time** (A's p50: 89 ms at 4 units, 1.1–1.3 s from 3,300 units on). **WASM memory is fixed**: 6–20 MiB through 5,357 units (beta.17: 44–51 MiB at 435). RSS: A 341 MiB to 1.5 GiB, B 367 MiB to 1.6 GiB. |
| Reconnect under 30 s | **Met but once.** Outages of 2–5 min came back in 4.7–15.3 s (beta.17: up to 56 s), and the first server restart in 4.4–8.3 s. After the second restart, B (in a minutes-long pass) received its first frame after 102.9 s. |

### Per checkpoint

Units stored by A; pass p50/p95 (ms), RSS/heap (MiB) and WASM (MiB) per
peer.

| # | min | Tasks | A | B | C |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0 | 151 | 4 u, 89/156, 341/112, 9.1 | 134/159, 367/175, 6.1 | 145/218, 352/137, 6.1 |
| 4 | 30 | 172 | 1,352 u, 231/421, 620/302, 9.1 | 238/436, 709/120, 6.8 | 238/447, 699/240, 6.8 |
| 6 | 50 | 164 | 2,226 u, 483/1,150, 605/88, 9.5 | 536/1,567, 843/204, 13.8 | 565/1,549, 850/347, 9.4 |
| 8 | 71 | 123 | 2,967 u, 930/3,959, 656/166, 10.3 | 1,199/5,132, 992/103, 13.8 | 1,794/5,685, 942/415, 10.5 |
| 9 | 86 | 124 | 3,323 u, 1,081/3,640, 711/252, 11.4 | 1,245/5,920, 1,090/173, 13.8 | 782/5,364, 1,056/182, 17.7 |
| 11 | 116 | 126 | 3,759 u, 1,139/4,578, 716/198, 14.0 | 958/42,593, 1,182/504, 20.2 | 3,838/52,009, 1,192/420, 19.7 |
| 13 | 150 | 108 | 4,165 u, 1,160/3,485, 734/148, 16.2 | 1,395/11,958, 1,311/341, 36.5 | (removed) |
| 15 | 184 | 109 | 4,693 u, 1,324/4,150, 1,367/469, 19.8 | 1,444/29,896, 1,380/625, 36.5 | |
| 16 | 200 | 120 | 4,993 u, 2,238/5,484, 1,451/785, 19.8 | 1,461/760,505, 1,377/252, 40.8 | |
| 19 | 245 | 124 | 5,357 u, 197/14,392, 1,465/459, 19.8 | 1,682/3,625, 1,616/1,080, 40.8 | |

- **Before the conflict**, pass time grows with history at a nearly flat
  Task count. This is the "Long history" limit, now reached within about
  an hour by three people.
- **After the conflict**, B's and C's passes reach tens of seconds, and
  one of B's took 12.7 minutes. The orchestrator reads this as the SDK's
  retained edits being quadratic in the history, which the open
  conflict amplifies. sdk-ts 0.2.0-beta.10 addresses it, and beta.19
  takes it.

### Removal and a new member (#3, #11)

- At 120 min A removed C, and C2 joined. C2 loaded the whole section from
  A's Snapshot of the new epoch within seconds: the same section and the
  same 766 nodes as A. **#3 holds.**
- "Insert shared section…" then refused C2's insert. The model still had
  the open conflict, and the preview refuses a section it cannot render
  ("not-renderable"). The harness has no retry for that, so C2 left the
  run.
- **#11** (a newcomer's binding error) could therefore not be observed.
- The refusal itself is accepted for 0.4.0. Its notice now says what to
  do (`0c87bc3`), and LFCP-02-123 lifts the refusal.

### Findings

| # | Finding | Status |
| --- | --- | --- |
| 7 | Pass time grows with history; under an open conflict, single passes of minutes on the members | sdk-ts 0.2.0-beta.10 (in beta.19) |
| 12 | With the conflict open for over two hours, the owner's own new Tasks could no longer be saved: at 245 min A was at "Local save failed" (INVALID_PREDECESSOR), with 21 Task lines of its own unbound. It is visible, not silent, and the conflict was never resolved | New; for triage (a conflict left open long enough blocks edits next to it) |
| — | A newcomer cannot insert while a structural conflict is open | Notice fixed `0c87bc3`; LFCP-02-123 |
| 11 | Newcomer binding error | Not observable in this run (above) |

The fixes of the discovery run hold where this run reached them: #3,
#8, and the replica memory fix (above). The late-ACK fix and #1: no
section was ever at "Server confirmation unavailable" (EVIDENCE_UNKNOWN)
or stuck sending. #9: no section showed "reappeared", its symptom (this
run had no per-move trace). Raw data:
`~/dev/openlfcp-rw/runs/soak/accept-b18/` on the test machine.

## 7. Final acceptance soak on 0.4.0-beta.19

**Date:** 2026-10-14. **Run:** 13:27–15:32 UTC, 125 minutes, on obsidian
`main` at `43c7ce2` (0.4.0-beta.19) with `@openlfcp/*` 0.2.0-beta.10.
That build contains `01231e4` (#12). The harness, events and criteria
are those of §1 and §2, with the events scaled to the 2-hour run:
- one peer offline every 7–15 min for 1–2.5 min;
- server restarts at 40 and 80 min;
- the removal and the new member at 60 min.

The main criterion this time was pass p95 under about 0.5 s through the
run. robust-simon's rc15 gates ran at nice 19 from about 13:30 to 13:45
UTC (3–18 min). Nothing else ran.

### Result

| Criterion | Result |
| --- | --- |
| Pass p95 under ~0.5 s | **Met but at the last checkpoint.** p50 is flat at 98–126 ms through 4,979 units (beta.18: 1.1–1.3 s from 3,300). p95 stays at 164–437 ms to 111 min, and is 526 ms on A at 125 min (B 455, C2 347). The tail rises slowly in the second hour (A: 313, 343, 410, 437, 526 ms at 76–125 min); single passes reached 1.8 s at the end. |
| No divergence | **Models met; notes with transients.** The models (and the 0.1 tasks) were equal at all 12 checkpoints. 9 of 12 converged fully. At 66 and 91 min, B's note showed one node more than the model ("Needs your attention", source-diverged), each cleared by the next checkpoint. At 125 min, the last, C2's note had 2 unbound lines and two Task titles behind the model, also shown as source-diverged; no later checkpoint shows whether it cleared. |
| Memory | WASM 6–25 MiB. RSS from 320–356 MiB to 754 (A) and 856 (B) MiB. It is +13 % (A) and +23 % (B) from 40 to 125 min; C2 went from 404 to 575 MiB in 64 min. Heap flat at 100–290 MiB. |
| Reconnect under 30 s | **Met.** Offline periods: 0.2–12.3 s. Server restarts: 5.3–7.6 s and 5.5–6.3 s. |

No section was ever at "Server confirmation unavailable", "reappeared"
or "Local save failed", and there were no edit errors.

The new member, C2, joined after the removal and inserted the section
within a second. No structural conflict was open this time. C2 edited
for an hour without a binding error, so **#11 did not occur**.

### Per checkpoint (pass p50/p95 in ms, RSS MiB)

| # | min | Units (A) | A | B | C / C2 |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0 | 4 | 90/170, 333 | 131/172, 320 | 149/164, 356 |
| 4 | 30 | 1,377 | 103/205, 586 | 104/204, 620 | 107/207, 689 |
| 6 | 51 | 2,293 | 109/265, 664 | 107/273, 710 | 114/269, 755 |
| 7 | 66 | 2,764 | 113/369, 668 | 113/344, 586 | C2: 164/231, 404 |
| 8 | 76 | 3,217 | 100/313, 670 | 100/297, 756 | 99/218, 732 |
| 10 | 101 | 4,119 | 106/410, 712 | 103/366, 831 | 110/295, 499 |
| 11 | 111 | 4,580 | 112/437, 745 | 115/435, 836 | 114/345, 553 |
| 12 | 125 | 4,979 | 126/526, 754 | 114/455, 856 | 116/347, 575 |

### Open after this run

- **The p95 tail still rises slowly with history** (p50 does not). It
  is within the target to 111 min and just above it at 125 min. A
  longer run would show whether it levels off.
- **Transient note divergences:** one extra node on B, cleared within
  10 min; and C2 at the end. They are visible as "Needs your attention",
  never silent, and the models stayed equal. Not traced.

Raw data: `~/dev/openlfcp-rw/runs/soak/accept-b19/` on the test machine.
