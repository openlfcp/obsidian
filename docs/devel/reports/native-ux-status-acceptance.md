# Shared sections: native acceptance of UX and statuses

**Task:** LFCP-02-066, with the two-vault demonstration of LFCP-02-072.
**Date:** 2026-10-09. **Status:** draft. C14 is waiting for a native recheck.

## 1. What this covers, and what it does not

- The 18 UX cases (OBSIDIAN-SHARED-SECTIONS-UX-01, UX01–UX18) and the 20
  status cases (OBSIDIAN-SYNC-INDICATORS-01, SI01–SI20), each with its
  evidence (§4).
- The reviewer checklist of the two-vault demonstration (examples
  `docs/demos/two-vault-sections.md` at e4c96e6, C00–C20), filled from an
  automated run (appendix A). The template is not changed.

**Not a substitute for the reviewer's run.** Vault A is real Obsidian with
the built plugin (the native harness, LFCP-02-096). Vault B is the same
plugin core without Obsidian (runtime, collaboration flows, section engine,
on fake IndexedDB), online against the same reference server. B has no
editor, badge or card. A reviewer's manual run on two real Obsidian vaults
is still owed: 072, 066 and B12 stay open for the owner.

## 2. How it ran

`test/native/specs/acceptance-sections.e2e.mjs`, through the native harness:

```sh
node scripts/build-native-harness.mjs   # bundles test/native/peer (vault B, the server)
LFCP_SERVER_BIN=<lfcp-server> NATIVE_OBSIDIAN=1.13.4 \
  pnpm --dir test/native test -- --spec specs/acceptance-sections.e2e.mjs
```

- **Environment:** Obsidian 1.13.4 on macOS 26.5 (Apple silicon), Node 24.4.
- **Pins:** reference server 79c240e, sdk-ts 32e801f, spec mvp-0.2-baseline.4.
- **Fixture:** a 200-Task note with paragraphs, list items and a canary in
  private text on each side.
- **The server:** restartable at the same address with its state (offline,
  restart).
- **Each step:** it records its observations as `EVIDENCE` lines and asserts
  the expected outcome.
- **Runs:** one at a time; the owner granted each native window.

## 3. Results by phase

| Phase | Plugin commit | Result | What it found |
| --- | --- | --- | --- |
| 1 | f8d0a90 | C01–C11 pass | Defects fixed before: 564bcd7, d54b2a6, 52960aa, e835b53; sdk-ts ec595b2 |
| 2 | 3025b20 | 11/13: C14, C17–C18 fail | Defects 1 and 2 (below) |
| 3 | 7586b43 | 12/13: C14 fails | C17–C18 pass with the fix of defect 2; the diagnostics locate defect 1 |
| 4 | ebdd9e0 + sdk-ts 19665ca | **pending** | C14 recheck after the fixes of defect 1 |

### Defects found, and their fixes

Each fix is its own commit with tests. The full live gate passed on each:
LFCP_REQUIRE_LIVE=1, the server and SDK at their locks, spec baseline.4.

1. **A remote Task edit never reached an open note, and the badge said
   CURRENT (C14).**
   - The edit was in A's model: received, merged, nothing held, the session
     LIVE. The SDK's `onNodesChanged` did not fire for a change of a Task's
     fields (title, status, dates), only for node changes, so the plugin was
     never asked to project it.
   - Fixed in sdk-ts 06ead0d/19665ca (events for Task and section changes).
   - The plugin got two safeguards:
     - 9ca02dd: a pass records the model revision it leaves its note at. A
       note at an older revision than the model's is patch-pending, so the
       section is CURRENT only when every copy shows the model's current
       revision.
     - 934cecb, ebdd9e0: the status refresh (every 2 s) passes the notes of
       a section once per revision when a note still lags on two refreshes
       in a row. A pass an event started catches up first, so there is no
       duplicate pass.
2. **A deleted end marker hid the section's badge, and the status stayed
   CURRENT (C17).**
   - The damaged copy yielded no parsed section.
   - c0870b0 (with 5acb0f8): the parser lists damaged copies. Each is a
     binding-error projection of its section until repaired: ATTENTION, the
     card's "One copy of this section has a damaged boundary or binding
     line.", and the badge stays on the copy's heading.
   - 7586b43: "Open shared section details" and "Go to next shared section
     problem" reach the damaged copy by keyboard.
3. **A removed member was shown as loading, not refused (C16, LFCP-02-115).**
   - The SDK answers `server-refused` without a cause.
   - 65d74ad: an access condition (ATTENTION) whose card says "The sync
     server no longer accepts changes from this vault for this section", and
     claims no cause.
   - 3025b20: the journal records `access-refused`, not `read-only`.

## 4. UX01–UX18 and SI01–SI20

"Native" names the acceptance step (C..), or another native spec. "Headless"
names the unit or e2e test files under `test/`.

| Case | Native | Headless | Result |
| --- | --- | --- | --- |
| UX01 Share 200 Tasks with child notes | C02–C03, C19 | core/sections/share.test.ts | PASS |
| UX02 Edit selection while preview open | — | core/sections/share.test.ts | PASS (headless) |
| UX03 Join interrupted after claim | — | core/collab/live-join-resume.test.ts | PASS (headless) |
| UX04 Add Task + paragraph + nested item | C07 | core/sections/engine.test.ts | PASS |
| UX05 Same-looking text after the end | C05–C06, C20 | core/sections/share.test.ts | PASS |
| UX06 Offline edit, restart, reconnect | C08–C09 | e2e/restart.test.ts | PASS |
| UX07 Access while offline | — | core/status/access.test.ts | PASS (headless) |
| UX08 Revoke with delayed Control result | C16 | core/status/access.test.ts | PASS |
| UX09 Fold a section with a conflict | section-a11y.e2e.mjs, C10 | core/status/a11y.test.ts | PASS |
| UX10 Copy in all supported modes | C12–C13 | core/sections/clipboard.test.ts | PASS |
| UX11 Detach one of two projections | C14 | core/sections/rules.test.ts | PENDING (C14 recheck) |
| UX12 Delete node vs whole projection | section-sync.e2e.mjs | core/sections/engine.test.ts | PASS |
| UX13 Damaged boundary near private text | C17–C18 | core/sections/repair.test.ts, share.test.ts, parser.test.ts | PASS |
| UX14 Unsupported block while a remote edit arrives | — | core/sections/repair.test.ts | PASS (headless) |
| UX15 Scalar and structural conflicts | C10–C11 | core/sections/recovery.test.ts | PASS |
| UX16 Keyboard, zoom, themes | section-a11y.e2e.mjs | core/status/a11y.test.ts, obsidian/section-status.test.ts | PASS; forced colors NOT_RUN |
| UX17 Legacy Tasks copied into a section | C15 | core/sections/legacy-import.test.ts | PASS |
| UX18 Read-only or revoked user types | C16 | core/sections/commit.test.ts | PASS (B's typing headless) |
| SI01 Marker, replica not loaded | — | core/status/reducer.test.ts | PASS (headless) |
| SI02 Source edit, no durable commit | — | core/status/reducer.test.ts, core/sections/commit.test.ts | PASS (headless) |
| SI03 Durable batch, offline | C08 | core/status/reducer.test.ts, badge.test.ts | PASS |
| SI04 Sent, no ACK evidence | — | core/status/reducer.test.ts | PASS (headless) |
| SI05 Accepted, catch-up active | — | core/status/reducer.test.ts, projections.test.ts | PASS (headless) |
| SI06 Accepted, caught up, applied | C08–C09, C10–C11 | core/status/reducer.test.ts, projections.test.ts | PASS |
| SI07 Accepted plus scalar conflict | C10 | core/status/reducer.test.ts | PASS |
| SI08 Accepted plus cycle/placement conflict | — | core/status/reducer.test.ts | PASS (headless) |
| SI09 Current, network lost | C08 | core/status/reducer.test.ts | PASS |
| SI10 One unit retransmitted five times | — | core/status/reducer.test.ts | PASS (headless) |
| SI11 One batch, two units, one accepted | — | core/status/reducer.test.ts | PASS (headless) |
| SI12 Two projections, one broken | C17 | core/status/projections.test.ts, reducer.test.ts | PASS |
| SI13 Pending child under a folded parent | section-a11y.e2e.mjs | core/status/badge.test.ts | PASS |
| SI14 Control removal requested | C16 | core/status/access.test.ts, badge.test.ts | PASS |
| SI15 Revoked with offline work queued | C16 | core/status/reducer.test.ts, access.test.ts | PASS |
| SI16 Empty queue, base unknown | — | core/status/reducer.test.ts, projections.test.ts | PASS (headless) |
| SI17 Storage commit fails after typing | — | core/sections/commit.test.ts, core/status/reducer.test.ts | PASS (headless) |
| SI18 Read-only replica, caught up | — | core/status/reducer.test.ts | PASS (headless) |
| SI19 No ACK evidence mapping | — | core/status/reducer.test.ts | PASS (headless) |
| SI20 Status-only changes keep source bytes and undo | — | — | GAP: no dedicated check (below) |

**SI20 is a gap.**
- What holds by construction: the badge and the row cues are CodeMirror
  widget decorations, and status changes reach the editor only as a state
  effect without document changes (`src/obsidian/section-status.ts`). The
  clipboard checks (C12, clipboard.test.ts) show that no status text is
  copied.
- What is missing: a test that compares the document bytes and the undo
  history across every visual state. It is a native check, for the next
  window.

## 5. Observations, not defects

- **C03:** right after sharing, the 0.1 registry reports the section's
  Resource as `unsupported`. The collaboration layer handles sections
  (564bcd7 shows the section's session state in pickers and status).
- **C09:** the template restarts vault B. Here vault A restarts, because B
  is headless. The pending update survived and was sent.
- **C16:** the template expects B to read "Your access to this section was
  removed…". The SDK answers B with `server-refused`, which names no cause.
  By LFCP-02-115 the plugin shows it as refused, not removed (65d74ad). B's
  text was not seen here, because B is headless.
- **UX16:** forced colors were not run. The harness's driver has no
  emulated media (no puppeteer-core).

## Appendix A. The reviewer checklist, filled (automated run)

From the run of phase 3 (7586b43), except C14. "Result" is what the run
observed. "Deviation" is any difference from the template's expectation.

| # | Result | Deviation |
| --- | --- | --- |
| C00 | Obsidian 1.13.4, macOS 26.5, server 79c240e, sdk-ts 32e801f | Recorded by the harness, not as `versions.txt` |
| C01 | Two identities (different principal IDs) | — |
| C02 | Preview: 200 tasks, 10 paragraphs, 40 list items; no canary in the content | — |
| C03 | Shared and hosted | The 0.1 registry says `unsupported` (§5) |
| C04 | Read and Read + write presets; the link hidden until Show link; the preset text speaks of the shared section | The template's note about "shared tasks" wording no longer applies |
| C05 | Joined (all stages) | B is headless: stages from the flow, no UI |
| C06 | Inserted after the paragraph; B's private text untouched | — |
| C07 | Both ways: A's checked Task reached B; B's paragraph reached A | — |
| C08 | Offline: "Offline; local updates will wait"; 1 update waiting; sent after the server returned | — |
| C09 | After a restart with pending work: "1 local update waiting", then CURRENT once sent | A restarted, not B (§5) |
| C10 | ATTENTION on A; B's model has the scalar conflict; "Problem 1 of 1, in shared section Launch, line 28" | B's badge not seen (headless) |
| C11 | One choice applied; the Task title once on both sides; CURRENT | — |
| C12 | No `lfcp-` line in the readable copy (253 lines) | — |
| C13 | "…it gives nobody access." | — |
| C14 | Detach: pending the recheck (defect 1) | Failed before the fixes; to be rechecked |
| C15 | 0.1 sharing beside the section works; refused inside it | — |
| C16 | A: "waiting for the server"; Remove access warns that copies cannot be erased; B refused by the server; A never got B's later edit | B's text is the refused state (§5) |
| C17 | ATTENTION; the card: "One copy of this section has a damaged boundary or binding line." | — |
| C18 | Repair offered the end marker back, applied; CURRENT | — |
| C19 | No canary, title or text in the server's state (5 files) | — |
| C20 | No B canary in vault A; no A canary in vault B | — |
