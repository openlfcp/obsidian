# Native matrix and two real Obsidian apps (LFCP-03-025)

The evidence of LFCP-03-025 (M03-4, P0; cases U03-01, U03-08, U03-16…20,
U03-24, U03-29; gates G03-A…F). The built plugin ran in real Obsidian
on macOS, Windows and Linux, Obsidian 1.13.4 and 1.14.4, in GitHub
Actions (`native.yml`). Nothing here ran on a developer machine. Written
2026-10-17 to 2026-10-19 on branch `mvp03/025-native-matrix`, rebased on
`main` `ec4f1ce` (plugin 0.4.2).

**Which runs count.** Runs 39059599290, 39060650167 and 39063362726 ran on
commits before the rebase (`898b5d9`, `2dae01f`, `57921c2`): an older
version of the specs, on `main` `82a1700`. Only run 39163258296 (PR head
`c7144ee`, on `ec4f1ce`) confirms the current code. **No run on the PR
head was green at the first attempt:** in 39163258296 attempt 1 four of six
jobs failed (F4, F6, F7, F8); attempt 2, a rerun of those four jobs on the
same commit, passed (6 of 6). The older runs are kept for the flake counts
and the screenshots.

Only the runs listed below are evidence. Screenshots from the 0.4.0-beta.8
walkthrough are not candidate evidence and are not used here.

## Pins

| Part | Pin |
| --- | --- |
| Plugin | `mvp03/025-native-matrix` over `main` `ec4f1ce` (manifest 0.4.2), developer build (`LFCP_DEV_PANE=1`) |
| SDK | `@openlfcp/*` as locked in `pnpm-lock.yaml` |
| Server | `server.lock`, release build per OS; `LFCP_SERVER_BIN`, `LFCP_REQUIRE_LIVE=1` (a live spec fails rather than skips) |
| Obsidian | 1.13.4 (Electron 43.1.1) and 1.14.4 (Electron 43.7.7), installer = app version |
| Tasks plugin | Obsidian Tasks 8.4.0 |
| Runners | `ubuntu-latest` (xvfb), `macos-latest`, `windows-latest` |

## Runs

| Run | Commit | What | Result |
| --- | --- | --- | --- |
| [39059599290](https://github.com/openlfcp/obsidian/actions/runs/39059599290) | `898b5d9` (branch before the fixes below) | all 50 specs × 3 OS × 2 versions | Linux 50/50, 50/50; macOS 50/50, 50/50; Windows 1.13.4 47/50, 1.14.4 49/50 (F1, F3, F4 below) |
| [39060650167](https://github.com/openlfcp/obsidian/actions/runs/39060650167) | `2dae01f` | `acceptance-sections`, `section-two-panes`, `section-remove-invite` × 3 OS × 2 versions | 5 of 6 jobs green; Windows 1.13.4: `section-two-panes` (F3) |
| [39061599103](https://github.com/openlfcp/obsidian/actions/runs/39061599103) | `dc58638` | `section-two-panes`, Windows × 2 versions | green |
| [39062480638](https://github.com/openlfcp/obsidian/actions/runs/39062480638) | `dc58638` | the three specs above, Windows 1.13.4 | green |
| [39063362726](https://github.com/openlfcp/obsidian/actions/runs/39063362726) | `57921c2` | all 50 specs × 3 OS × 2 versions | Linux 50/50 ×2, macOS 1.13.4 50/50, Windows 50/50 ×2 (F1, F3, F4 did not recur); macOS 1.14.4 49/50: `pane-access-copy-detach` (F7) |
| [39163258296](https://github.com/openlfcp/obsidian/actions/runs/39163258296) | `c7144ee` (PR head, over `main` `ec4f1ce`) | all 51 specs × 3 OS × 2 versions, attempt 1 | green: Linux 1.13.4, macOS 1.13.4, Windows 1.14.4. Failed: Linux 1.14.4 (`pane-access-copy-detach` F7, `pane-insert` F6), macOS 1.14.4 (`section-idle-remote` F4), Windows 1.13.4 (`section-two-panes`, last describe, F8). Attempt 2 (rerun of the four failed jobs, same commit): all green, so all six jobs have passed on this commit across the two attempts |

The history of `native.yml` since 2026-10-15 12:00 (80 runs, every
branch) was read for the flaky specs; its counts are in "Flaky specs".

## Two real Obsidian apps (criterion 1, U03-29)

`test/native/specs/two-hosts.e2e.mjs`. A is the harness's Obsidian; B is
a second Obsidian of the same version started by the spec
(`wdio-obsidian-service` standalone session): its own process, its own
configuration directory, install database and identity, its own copy of
the vault. Each run checks and logs that the two differ in PID, vault
path hash and principal and share the version. Both use the reference
server; no headless peer takes part.

Roles: A owns the section and invites; B joins with a **Read + write**
invitation (the role chosen explicitly in A's role prompt), then is
removed by A. The flow runs twice, Tasks 8.4.0 **disabled** on both apps,
then **enabled** on both, each time with a section of its own:

1. A shares from the pane (ribbon, no palette) and invites with a chosen role.
2. B opens its pane from the ribbon, joins with the link and inserts the section into its own note.
3. Real keys on each side reach the other; a Task checked off (Obsidian's command with Tasks off, Tasks' toggle with it on) reaches the other.
4. B offline (its WebSocket), both change one Task (with Tasks on, A deletes the Task B changes); B back; the conflict is resolved in one host's UI ("Review conflicts…") and both end CURRENT and equal.
5. B's Obsidian restarts (a new process on the same configuration) while A edits; both edits cross afterwards.
6. A removes B's access in the section card; B's badge and card say so; B's next edit stays in B's note and never reaches A.

| OS | 1.13.4 Tasks off | 1.13.4 Tasks on | 1.14.4 Tasks off | 1.14.4 Tasks on |
| --- | --- | --- | --- | --- |
| Linux | PASS | PASS | PASS | PASS |
| macOS | PASS | PASS | PASS | PASS |
| Windows | PASS | PASS | PASS | PASS |

Run 39059599290 for the Linux and macOS cells; Windows cells also in 39063362726 (all green there). Both runs: all twelve cells PASS.

Limits: both apps run on one runner, so A and B have the same OS and
version; a mixed pair (macOS A with Windows B, 1.13.4 with 1.14.4) is
NOT_RUN: GitHub runners cannot reach each other's localhost, and the
harness has no shared server for two runners. A human on two machines is
LFCP-03-028 (pilot). Clipboard is not the channel between A and B (one
system clipboard): the link is read from A's dialog after "Show link".

## Targeted matrix (criterion 2)

Each row names the specs of the full set that cover an area. PASS means the spec passed in the attempt that
covers that cell: 39059599290 for Linux and macOS (the spec files then
were those of `898b5d9`), where the two Windows jobs had failures that
are named as FAIL in the row; the Windows cells otherwise come from
39063362726 and 39163258296. Since the PR head had no run green at the
first attempt, a PASS here is not a claim of a stable cell: see Flaky specs.

| Area | Spec(s) | Linux 1.13.4 / 1.14.4 | macOS 1.13.4 / 1.14.4 | Windows 1.13.4 / 1.14.4 |
| --- | --- | --- | --- | --- |
| Visible entries, first use (U03-01) | `pane-host`, `pane-share-invite`, `pane-join`, two-hosts 1–2 | PASS / PASS | PASS / PASS | PASS / PASS |
| Share → invite, explicit role (U03-08) | `pane-share-invite`, two-hosts 1 | PASS / PASS | PASS / PASS | PASS / PASS |
| Keyboard, focus, Escape (U03-18) | `pane-keyboard`, `section-a11y` | PASS / PASS | PASS / PASS | PASS / PASS |
| Source / Live Preview / Reading, popout, zoom, themes (U03-19) | `pane-keyboard`, `section-matrix`, `marker-hiding`, `section-metadata` | PASS / PASS | PASS / PASS | PASS / PASS |
| Focus across panes | `section-matrix` (focus), `section-two-panes` | PASS / PASS | PASS / PASS | FAIL (F3) / PASS |
| Clipboard: no UI or bindings in plain copies; cut/paste moves | `section-matrix` (clipboard), `pane-access-copy-detach`, `section-cut-paste-move`, `section-whole-line-cut`, `section-shift-down-cut` | PASS / PASS | PASS / PASS | PASS / PASS |
| Lifecycle: disable/enable, one pane (U03-20) | `pane-keyboard`, `upgrade-install` | PASS / PASS | PASS / PASS | PASS / PASS |
| Legacy routing in and out of a section (U03-24) | `section-resolve-dispatch`, `acceptance-sections` C15 | PASS / PASS | PASS / PASS | PASS / PASS (C15) |
| Revoked recipient UI | two-hosts 6 (B real Obsidian), `section-access-mid-edit` (A real Obsidian is the removed one), `pane-access-copy-detach` | PASS / PASS | PASS / PASS | PASS / PASS |
| Structural and retained UI (U03-16) | two-hosts 4 (Tasks on: delete vs change), `section-review-conflicts`, `pane-problem-hub`, `acceptance-sections` C17–C18, `section-share-held` | PASS / PASS | PASS / PASS | PASS / PASS |
| Offline queue and restart | `acceptance-sections` C08–C09 | PASS / PASS | PASS / PASS | FAIL (F1, fixed) / FAIL (F1, fixed) |
| Tasks plugin next to Shared Tasks | `tasks-plugin`, two-hosts Tasks on | PASS / PASS | PASS / PASS | PASS / PASS |
| UX fixture states in the real pane | `pane-fixture-states` (light and dark) | PASS / PASS | PASS / PASS | PASS / PASS |
| Second shared section after a server restart by the harness | `section-lp-markers` (2nd describe) | PASS / PASS | PASS / PASS | FAIL (F4) / PASS |

NOT_RUN: IME with a real input method (WebDriver simulates composition;
`ime-checklist.md` stays manual); screen readers; Obsidian mobile;
Obsidian versions other than the two pinned; a human using the apps
(LFCP-03-028).

## Screenshots

Small, from run 39059599290 (Linux, 1.14.4), resized. Runner paths do
not appear; the identities are throwaway test keys and the server is the
runner's localhost.

- [A during the conflict, Tasks on](../../assets/native-matrix-0.3/two-hosts-structure-conflict-a.jpg): the structure conflict ("their place is not updated in your note until it is resolved", retained), the problem with "Review conflicts…". The visible `lfcp-ref` line under Alpha is finding P2. Observation: the screen shows two "Review conflicts…" buttons at once, one under Problems and one in the pane's actions; they open the same list (not a defect found, noted for the UX owner).
- [B after A removed its access](../../assets/native-matrix-0.3/two-hosts-removed-b.jpg): B's card ("Your local copy stays; new edits are kept on this device only"), the pane, and the notice of finding P3.

Every step's screenshots of both apps (both modes, each job) are in the
`native-<os>-<version>` artifact of each run, `screenshots/two-hosts`
and `screenshots/fixture-states`.

## Flaky specs

Counts are from the 80 runs since 2026-10-15 12:00 plus the runs above
(release run 38850350274, where everything failed for a build reason, is
left out).

| # | Spec | Where | Cause | Kind | Done |
| --- | --- | --- | --- | --- | --- |
| F1 | `acceptance-sections` C08–C09 ("Expected OFFLINE, received LOCAL_DURABLE") | Windows only, 8 of 12 Windows jobs | After the plugin restarts with the server down, the badge says LOCAL_DURABLE ("Saved locally; waiting to sync") until the first connection fails, then OFFLINE. On Windows a refused connection to a closed port takes about 2 s (the SYN is retried), and the spec took the first non-loading state. The evidence of every failure shows OFFLINE one second later. | test race | `5d0863f`: waits for OFFLINE, asserts nothing before it claims more than LOCAL_DURABLE. Green in 39060650167 and 39062480638 |
| F1b | `acceptance-sections` C04 (warning "no invitation dialog") | all OS, a warning | `find()` gives undefined, the loop waited on null: it stopped after 50 ms and threw; WebdriverIO's retry hid it | test bug | `3414c4d` |
| F2 | `acceptance-sections` C15 (refusal not found) | Linux 1.14.4, 2 of 35 | The spec counted notices and took those past the count; when older notices timed out meanwhile, the refusal was below the count | test race | `61b7caa`: notices shown before the command are marked |
| F3 | `section-two-panes`, a cut in one pane pasted in the other | Windows 1.13.4 3 of 8 jobs, Windows 1.14.4 1 of 7 (38851415519, not analysed), macOS 1.14.4 1 of 3; never on Linux (42 runs) | Two cases. (a) macOS: the cut keys made no cut, and the following steps failed on its state. (b) Windows: the cut is made, the other pane shows it, the clipboard holds LF text; after the paste A's note has lost **Delta**, a line nobody touched, while the model and B keep it; A's badge is ATTENTION with no recovery item. Run 39061599103 (1.14.4, passing) shows Obsidian's "modified externally, merging changes automatically" at that moment: Obsidian's merge of two views of one note (ADR 0001, S7) | (a) test; (b) Obsidian host race with a plugin gap | `c2dd7fa`: the cut is checked to have happened (focus logged), the paste waits until the other pane shows the cut. `dc58638`: the panes' saves, merges and texts are logged when a step fails. (b) is candidate C-1 |
| F4 | second share in a spec ("the section shared and hosted" timeout): `section-two-panes` 2nd describe, `section-lp-markers` 2nd describe | Linux 1.14.4 2 of 42; Windows 1.13.4 once (39059599290); `section-idle-remote` macOS 1.14.4 once (39163258296, of 44) | Both: `startPeers()` again, a new server, the plugin restarted with the first section on a server that is gone; the new share does not reach `hosted` in 60 s. No facts were logged | cause not established (every case follows a server restart by the harness's `startPeers()`; a product defect is possible, a harness effect is not excluded) | `51ab003` logs what A holds on a timeout. In 39163258296 (macOS 1.14.4, `section-idle-remote`) it shows: the new Resource exists with hosting `pending`, the note has no end marker (`marked:false`), no notice, no dialog, runtime ready: the share did not finish and said nothing. Candidate C-2 |
| F5 | `section-remove-invite`, the newcomer after A's plugin reload | Windows 1.13.4 only, 3 of 12 jobs (on the 0.4.1 and 0.4.2 release branches) | C joins but never holds the section in 15 s; the case without a reload passes (C loads in 0.3 s). The invitation waits for a Snapshot of the new epoch only while `epochSnapshotState` says `publishing`/`checking`; after a reload it may answer otherwise before the session is LIVE (cf. LFCP-03-037). Not confirmed | product race, suspected | `2dae01f`: on a timeout the spec logs A's snapshot state, epochs, snapshots, queue, C's snapshots, and whether C loads within 45 s more; it still fails. Candidate C-3 |
| F6 | `pane-insert` :160 ("the existing placement named") | Linux 1.14.4, 3 runs (38863125221, 39059818149 attempt 1, 39163258296) | The insert preview says "Not inserted in any note yet." for a section that is in the source note. A share writes the note before hosting; the placement index learns the note from the vault change, which is batched and queued behind projection work. With the index `complete`, the preview claims "not inserted" for a note it has not seen yet, and the open dialog does not update | product defect (honesty, U03-02) | not fixed (product); candidate C-4. The spec is kept as it is: it shows the defect |
| F7 | `pane-access-copy-detach` :153 (no card with C's row) | Linux 1.14.4, run 39059818149 attempt 2 (branch 047); macOS 1.14.4, run 39063362726; Linux 1.14.4, run 39163258296 | In the macOS run the diagnostics of `57921c2` show **no dialog at all** (`cards: []`) while C's access is intact: the click on the pane's "Remove access…" (reported as clicked) did not open the card. Same family as P1: a first click on a pane button that does nothing right after another flow. The earlier reading (the card lacking C's row) is not supported. | product defect or click race, not settled | diagnostics only (`57921c2`); candidate C-5 |
| F8 | `section-two-panes`, last describe: "a Move line next to a Task cut and pasted earlier names the Task moved" | Windows 1.13.4, once in 39163258296 (first time; 0 of 40 other runs of the spec) | Titles and order are right and the badge CURRENT, but the pass recorded **two** `node.move` operations (Delta and one more Task) where the spec expects only Delta's. A Move line right after a cut and paste put the earlier pasted Task into the same pass as a move. This is what the spec guards (hints of the last cut), not a harness effect | product defect (extra move op, no visible damage) | not fixed; candidate C-9 |

Retries are not added anywhere. One retry already in `two-hosts` (the
pane's "Join with a link…" clicked up to three times) is kept because
every attempt is logged; what it shows is finding P1.

## Findings (product)

| # | Finding | Evidence |
| --- | --- | --- |
| P1 | In B's pane, after B's previous section was removed and B's Obsidian restarted, the first click on "Join with a link…" opens no field; the second does. The button is drawn and enabled. | two-hosts "TWO-HOSTS join button", Tasks-on flow: 4 of 6 jobs in 39059599290 (Linux both, macOS 1.13.4, Windows 1.14.4) |
| P2 | In the app where the Obsidian Tasks plugin completed a Task (it appends "✅ date"), the Task's `lfcp-ref` line is shown in Live Preview and stays visible; in the other app, and with Tasks off, it is hidden. | two-hosts screenshots `*-tasks-on-4-conflict-A.png` and `*-tasks-on-5-resolved-A.png` (Linux 1.14.4, macOS 1.13.4); B's copy of the same Task hides it |
| P3 | The notice when B's access is removed names the section "a shared section" instead of its title ("Core with Tasks"), and shows the raw server URL. | `two-hosts-removed-b.jpg` |
| P4 | A's badge is ATTENTION with an empty recovery list when the note lost a Task the model keeps (F3 b). | F3 evidence, `"recovery":[]` |

## Candidate tasks

- C-1 (obsidian): two views of one note, a cut in one and a paste in the other: Obsidian's merge can drop an untouched line. Offer the missing Task back (or say it is missing) instead of ATTENTION with nothing to do (P4). With LFCP-03-038.
- C-2 (investigation first): a share made after the harness restarted the server did not reach `hosted` (Resource `pending`, note unmarked, no message). Cause not established: decide between a harness effect (the plugin restarted at a new server URL) and a product defect (a share that stalls silently); the logs of `51ab003` say where it stops.
- C-3 (obsidian): an invitation right after a removal and a plugin reload can let a newcomer join before a Snapshot of the new epoch exists (F5).
- C-4 (obsidian): the placement index learns a shared note when the share writes it, or the insert preview says "Looking for copies…" while a creation of that section is open; the open preview updates (F6, U03-02).
- C-5 (obsidian): a pane button click ("Remove access…" in F7, 4 occurrences, no dialog and no notice recorded; "Join with a link…" in P1) that opens nothing; record the notices in the spec first; look for a redraw replacing the button between the draw and the click, and make the click idempotent for the user.
- C-6 (obsidian): the first click on "Join with a link…" after a restart opens nothing (P1).
- C-7 (obsidian): the `lfcp-ref` line is not hidden after the Tasks plugin completes a Task (P2).
- C-9 (obsidian): a Move line next to a cut and paste made earlier records a move of the earlier Task as well (F8, Windows 1.13.4, rare); look at the last-cut hint's lifetime across the pass.
- C-8 (obsidian): the removal notice names the section and leaves the server URL to the details (P3).

## Status of the criteria

| Criterion | Result |
| --- | --- |
| 1. Core flow on two real Obsidian with Tasks enabled and disabled; roles, OS, versions stated | PASS on Linux, macOS and Windows × 1.13.4, 1.14.4 (same OS and version for A and B). Mixed OS/version pairs: NOT_RUN |
| 2. macOS/Windows/Linux targeted matrix, modes/focus/clipboard; revoked recipient UI and structural/retained UI | PASS for every area on at least one full run per OS × version; no run is fully green on all six jobs at once: F4, F6, F7, F8 (product defects or unsettled, candidates C-2, C-4, C-5, C-9) and F3b (Obsidian host race) recur at about 1–5% per spec; P1–P4 found |
| 3. NOT_RUN explicit, no beta.8 screenshots as evidence | PASS: NOT_RUN listed above; only screenshots of these runs are used |
