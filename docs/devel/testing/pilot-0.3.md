# MVP 0.3: performance budgets and pilot protocol

**Task:** LFCP-03-006 (gates G03-F, G03-G). **Frozen:** 2026-10-15, before
any measurement. **Status:** proposed by the package and pinned here; the
owner may change a value only before the first qualifying run, by a pull
request that says why.

The budgets and the pass threshold below do not move after a result is
known. A change after a run needs a new candidate and a full rerun of the
affected measurements (MVP 0.3 test and release plan, "Performance
defaults" and "Pilot"). The UX being measured is
[docs/architecture/ux-contract-0.3.md](../../architecture/ux-contract-0.3.md).

## 1. Performance budgets

### 1.1 Host and corpus

- **Reference host.** A macOS Apple-silicon desktop with the Obsidian and
  Tasks versions that LFCP-03-001 pinned. Tasks runs both on and off. The
  run records the OS, Obsidian and Tasks versions, the plugin build and its
  `main.js` sha256.
- **Corpus P200.** It is the seeded W200 workload of
  `test/perf/workloads.ts`: 200 Tasks, 50 of them nested, 200 paragraphs
  and 50 list items, depth 4. It is one shared section with **two
  projections** in two notes, and the vault also holds **300 private
  notes** of about 2 KB each. The private notes make a full-vault scan per
  event visible in the timings.
- **Network.** Excluded from the UI latencies: the server runs locally, or
  the section is already loaded. Loading and connection feedback are
  measured on their own (B4).

### 1.2 Budgets

| ID | Metric | Start → end | Budget | Gate |
| --- | --- | --- | --- | --- |
| B1 | Context update | Caret or selection change, or `active-leaf-change` → the pane's context area committed to the DOM | p95 ≤ 150 ms | G03-F |
| B2 | Warm pane open | Pane command or ribbon click, pane already created once → pane content committed | p95 ≤ 500 ms | G03-F |
| B3 | Cold pane open | The first pane open after the plugin loads, registry ready | Recorded, no budget in 0.3 | Reported |
| B4 | Loading feedback | Pane open or join start while the network waits → a visible loading or connecting state | p95 ≤ 500 ms | G03-F |
| B5 | No full-vault scan | Vault file reads (`read`, `cachedRead`) per caret event, after warm-up | 0 | G03-F |
| B6 | No status writes | Markdown writes and undo-history entries caused by status events alone | 0 | G03-F |

### 1.3 Method

- **Timing points.** The native harness drives real Obsidian. A build-time
  test hook records `performance.mark` at the host event and at the pane's
  commit. The released build does not contain it.
- **Samples.** Each metric runs 5 warm-up samples, then 30 measured samples.
  The report gives p50, p95 and max. Cold samples (B3) restart Obsidian each
  time and are reported apart from warm ones.
- **Counters.** B5 and B6 count calls through the vault adapter and the
  editor transaction filter during 30 caret moves and 30 status events.
- **Comparison.** The same inputs run on 0.4.0, the closest existing path:
  the badge and card update for B1, the card open for B2. A result that is
  more than 20 % slower than 0.4.0 on the same host is reported even when it
  is within budget.
- **Recording.** The results go to `docs/devel/reports/` with the commit,
  the host and the raw samples. A metric that did not run is NOT_RUN and
  never counts as a pass.

## 2. Pilot protocol

### 2.1 Threshold (G03-G)

- **Five pairs** of people who are new to Shared Tasks and do not know its
  commands.
- **At least four pairs** complete the core flow in **≤ 10 minutes** and
  the prepared problem in **≤ 5 minutes**, both without a hint about the
  sequence of steps.
- **No privacy, data-loss or wrong-target event** in any session.

Any hint about the flow makes that run *assisted*, and an assisted run does
not count toward the four. If fewer than five real pairs take part, G03-G is
NOT_RUN. Agents never stand in for people.

### 2.2 Setup (not timed)

- Each participant has a desktop with Obsidian and the candidate build
  installed and a synthetic vault: `Plan.md` with the heading "Launch" and
  three Tasks, `Sprint notes.md` with private text, and a few unrelated
  notes. There are no real names or data.
- Both use a test sync server that already works. Installation and the
  network are checked before the clock starts and are assessed separately.
- A moderator per pair, who only observes and keeps time.

### 2.3 Tasks given to participants

1. **Core flow (≤ 10 min).** Person A is told: "Make the Launch part of your
   plan shared with your partner. Your partner should have it in their own
   'Sprint notes' note, and you should both keep working on it." No step,
   command or label is named. The clock starts at the instruction and stops
   when B has the section in `Sprint notes.md` and an edit by each person
   has appeared on the other side.
2. **Problem (≤ 5 min).** The moderator prepares one ordinary problem: a
   conflicting edit to the same Task made while one side was offline. The
   participant is told: "Something about your shared list needs your
   attention. Sort it out." The clock stops when the conflict is resolved
   and both sides show the same value.

### 2.4 What is recorded

| Item | How |
| --- | --- |
| Time for each task | Moderator's stopwatch, start and stop as defined in §2.3 |
| Completed or not | Yes, no, or assisted |
| Hints | Each hint word for word, and when it was given |
| Stop points | Where a participant stopped or hesitated for more than 30 s, and what was on screen |
| Entry used | Ribbon, pane, context menu, card or palette |
| Understanding | After the session, three questions: "What exactly did you share?" (the boundary), "Where else does this text appear?" (other copies), "What does the ✓✓ mark mean?" (F-08, contract O-03) |
| Incidents | Any private text published, data lost, or a write to the wrong note: a blocker, recorded at once |

Video is not required. Any optional recording needs the participant's
consent first and stays with the moderator. The record keeps first names or
pair numbers only.

### 2.5 Result

The result goes in the MVP 0.3 evidence template with each pair's times,
hints, stop points and answers, the build and server used, and a verdict for
G03-G: PASS, FAIL or NOT_RUN. A failed threshold is a major finding with an
owning task. The threshold is not lowered after the run.
