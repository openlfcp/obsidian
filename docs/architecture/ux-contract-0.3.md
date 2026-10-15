# UX contract for MVP 0.3

**Task:** LFCP-03-006 (milestone M03-1; gates G03-A, G03-C, G03-E).
**Status:** normative for the MVP 0.3 work in this repository. A change to
this contract goes through a pull request that also updates the fixtures.
**Base:** obsidian `main` at `700caa1` (Shared Tasks 0.4.0 `ce0660a` plus the
F-05 fix and the held-source facts of LFCP-03-003), spec `mvp-0.2-baseline.12` (`bf1c78c`), `@openlfcp/*` 0.2.0.
**Machine-readable part:**
[`test/fixtures/ux-0.3/states.json`](../../test/fixtures/ux-0.3/states.json),
checked by `test/core/ux-contract-fixtures.test.ts`.

This document fixes the actions, labels, targets, call-to-action precedence,
content policy and scope of the MVP 0.3 user interface: the Shared Tasks
pane, the editor context menu, the section card and the palette. Every 0.3
task that adds or changes a user-facing surface implements this contract.
The status reducer and the action seam (LFCP-03-008, 013, 023) make the
fixtures pass. The pane's view model (LFCP-03-007, `src/core/pane/`)
already runs them through the real reducer
(`test/core/pane/model-fixtures.test.ts`).

## 1. Authority

When documents disagree, the first one in this list wins:

1. The normative spec at `mvp-0.2-baseline.12`: LFCP-WIRE-01,
   SHARED-SECTIONS-PROFILE-01, MARKDOWN-SECTIONS-01,
   SDK-SECTIONS-INTEGRATION-01.
2. The released plugin's behaviour, where it conforms to the spec (0.4.0
   and `main`).
3. This contract.
4. The MVP 0.3 package (revision 0.2, 2026-10-12). It was written against
   0.4.0-beta.8 and is a proposal, not a normative document.

The authority map of LFCP-03-001 names the code providers this contract
relies on:
[`.github` docs/mvp-0.3/authority-map.md](https://github.com/openlfcp/.github/blob/main/docs/mvp-0.3/authority-map.md).
Where this contract and the package disagree, §11 lists the decision.

## 2. Vocabulary

The plugin's interface is English. The labels below are the product words;
the package's Russian labels are given only for review against the package.

| Use | Meaning | Do not use on a section surface |
| --- | --- | --- |
| Shared section | The Resource of the section profile, as a user sees it | collaboration, Resource, object |
| Copy in this note | One local projection of a shared section | instance, mirror |
| Insert into a note | Add a projection of a section to a note | import, place (as a verb on a button) |
| Access | Who can read or edit, as last verified with the server | permissions, ACL |
| Invitation link | The one-time `lfcp://join/…` link | invite code, token |
| Technical details | Resource, Control Head, Data Epoch, operation IDs | anywhere outside the collapsed technical details |

"Collaboration" stays only in the names of the 0.1 Task commands, whose IDs
and names do not change.

## 3. Actions and labels

Each action has one stable ID and one label. The pane, the card, the editor
context menu and the palette call the same handler with the same guards
(LFCP-03-008, U03-07), through one dispatcher (`src/core/actions/dispatcher.ts`);
each action's availability is one pure predicate (`src/core/actions/descriptors.ts`,
LFCP-03-010). A disabled action states its reason in words; the
executor checks the same condition again before any side effect, so a
disabled button is never the only guard.

Existing palette command IDs and names stay unchanged. Where a pane or card
label differs from the palette name, the table gives both.

| Action ID | Label (pane, card, menu) | Palette command (unchanged) | Package label | Destructive |
| --- | --- | --- | --- | --- |
| `share-section` | Share section… | `share-section` "Share section…" | Поделиться разделом… | no |
| `share-whole-section` | Share the whole section… | — (pane and menu only) | Выбрать весь раздел | no |
| `invite` | Invite collaborator… | `invite-collaborator` "Invite collaborator" | Пригласить… | no |
| `join-with-link` | Join with a link… | `join-collaboration` "Join collaboration" | Присоединиться по ссылке | no |
| `insert-into-note` | Insert into a note… | `insert-section` "Insert shared section…" | Выбрать место… / Вставить… | no |
| `open-details` | Open details | `open-section-details` "Open shared section details" | Открыть сведения | no |
| `sync-details` | Sync details | — (opens the card at its sync facts) | Сведения о синхронизации | no |
| `review-local-changes` | Review local changes | — (opens the card at its held edits) | Посмотреть локальные изменения | no |
| `review-conflicts` | Review conflicts… | — (card button, existing) | Посмотреть варианты | no |
| `repair-sections` | Repair shared sections… | `repair-shared-sections` "Repair shared sections in this note" | Проверить границы / Сравнить версии | no |
| `go-to-problem` | Go to the problem | `next-section-problem` "Go to next shared section problem" | Найти проблемный блок | no |
| `check-result` | Check the result | — | Проверить результат | no |
| `continue-flow` | Continue | — | Продолжить | no |
| `open-for-editing` | Open for editing | — | Открыть для редактирования | no |
| `open-settings` | Open settings | — | Открыть настройки | no |
| `copy-readable` | Copy readable text | `copy-readable-text` "Copy readable text (without sharing metadata)" | — | no |
| `copy-shared-section` | Copy shared section | `copy-shared-section` "Copy shared section" | — | no |
| `remove-access` | Remove access… | — (card, existing) | — | yes |
| `discard-local-copy` | Discard the local copy… | — (card, existing) | — | yes |
| `detach-section` | Detach this section | `detach-section` "Detach this section" | — | yes |
| `resource-status` | Resource status | `resource-status` "Resource status" | — | no (technical details: the card and the palette only, never a pane entry, §2) |

The palette IDs are those registered at `c66a6f5` in
`src/obsidian/plugin.ts` and `src/core/commands.ts`.

Rules:

- **A1.** A destructive action is never the primary call to action. It sits in
  a menu or a secondary row and keeps its existing confirmation.
- **A2.** "Join with a link…" stays in the pane header in every state,
  including no open note.
- **A3.** A label ending in "…" opens a preview, a choice or a confirmation
  before any side effect. A label without it acts at once and changes no
  shared state.
- **A4.** A second invocation of a running action reveals the running flow; it
  does not start another one (LFCP-03-002, 010). A flow whose last effect has
  an unknown result keeps its reservation: a second invocation, or "Check the
  result", checks that result for the same operation and never starts a new
  one (owner decision D12). Once the result is known, a later explicit share
  or insert is a new operation.
- **A5.** An action that does not apply to the context is hidden. One that
  applies but is blocked is shown disabled with its reason, for example
  "Detach this section" while the section is loading (owner decision D10).
- **A6. Pane entries (LFCP-03-012).** The ribbon icon (tooltip "Open Shared
  Tasks pane"), the command `open-shared-tasks-pane` "Open Shared Tasks
  pane", the section card's "Open Shared Tasks pane" and the editor context
  menu's "Open Shared Tasks pane" reveal one pane per workspace
  (`src/obsidian/ui/pane-view.ts`). A second leaf of it is closed. The
  editor menu also offers the pane's primary action for the cursor, through
  the dispatcher (surface `menu`). Opening the pane opens no dialog and runs
  no action. Every action of §3 has its handler in the dispatcher
  (LFCP-03-013), so every enabled button runs. While shared sections are
  off on this device only "Join with a link…" runs; the others are shown
  disabled with "Shared sections are off on this device."
- **A7. The card's buttons are the same actions** (LFCP-03-013). Each button
  of the section card ("Review conflicts…", "Invite collaborator…", "Go to
  line N", "Repair shared sections in this note", "Resource status",
  "Discard the local copy…") runs its action through the dispatcher
  (surface `card`). The card reads the same descriptors as the pane: an
  action that applies but is blocked is shown disabled with its reason
  (A5), for example "Invite collaborator…" while access is not checked
  with the server.

## 4. Target and selection

### 4.1 Target

- **T1.** An idle pane follows the last active Markdown note. Focus in the
  pane does not change the target.
- **T1a.** The pane is about the section under the cursor, else the one the
  user chose in the section list, else the one just joined. It never picks
  another one from the list on its own (owner decision D9).
- **T2.** An open flow captures its target before the preview: the note
  (a host handle and its current path), the source revision, the range and
  the editor mode. Switching tab or note does not move the flow to the new
  note (U03-03).
- **T3.** Before each side effect the executor reads the note through the host
  adapter and checks its revision and exact range. A rename keeps the
  target only when the host proves the mapping. Otherwise the user chooses
  again and sees a new preview. A deleted target is never recreated at its
  old path (U03-12, LFCP-03-009).
- **T4.** Reading view: details are available. An action that changes source
  offers "Open for editing" and never writes through a hidden editor.
  "Repair shared sections in this note" from the card, on a note shown only
  in Reading view, says exactly: "Shared Tasks: open the note for editing
  to repair it (it is in Reading view)." (LFCP-03-009).
- **T5. Insert destination** (LFCP-03-016, U03-12/13/15). "Insert into a
  note…" previews the section and says where it goes: by default "into this
  note after the paragraph at the cursor". "Choose another note…" offers
  this note, any other Markdown note (the block goes at its end), or a new
  note named by what the user types, offered only where no note of that
  name exists. The preview and the choice name the notes that already hold
  the section ("Already in: …. Inserting adds another copy."; "Looking for
  copies in your notes…" while the placement index is building); those
  notes are marked "already has this section". The section the pane is
  about (a joined one) is not chosen again.
  - Selected text is never replaced: the block is inserted, never written
    over a selection.
  - A new note is created empty when Insert is clicked, never over a file
    that is already there ("a note named "…" already exists. Nothing was
    inserted…"). A note whose end is inside an unclosed fence or comment is
    refused: the block would not read back as the section.
  - Another note is held from its choice: a rename moves the insertion with
    it, a deletion refuses it and nothing is created at the old path. It is
    reserved as the starting note is (one share or insert per note, A4),
    and a closed note is written through the host's read-modify-write and
    passed through its file.
  - The result is a notice "Shared Tasks: section "…" inserted into "…"."
    with an "Open" button that opens the note at the section's heading.
  - A write whose result is unknown keeps that note reserved; inserting
    into it again checks the same insertion and writes nothing new (D12).
    Once the result is known, a new explicit insertion makes another copy.

### 4.2 Exact selection

With no selection, "Share section…" proposes the heading under or above the
cursor, down to the next heading of the same or a higher level
(`proposeRange`, as in 0.4.0).

With a non-empty selection, the selection is **exact and eligible** only
when all of these hold:

1. **Starts at a heading.** Its first line is an ATX heading that
   `proposeRange` accepts. A section starts at its heading
   (MARKDOWN-SECTIONS-01 §3), so the heading line may be selected in part.
   The preview always shows the whole heading line: it is the section's
   title.
2. **Whole lines at the end.** Its last line is selected through its last
   non-blank character. A selection that ends at column 0 of a line ends on
   the line before it: that is how an editor selects whole lines. Trailing
   blank lines are trimmed. Neither is an expansion.
3. **Inside the heading's scope.** It ends at or before the last line that
   `proposeRange` gives for that heading.
4. **No preview problem.** `preflight` for the range reports no problem: no
   heading inside (`NESTED_HEADING`), no cut block (`PARTIAL_BLOCK`), no
   unclosed fence, no existing binding, no 0.1 shared Task, no damaged ref.

An eligible selection is previewed **exactly**: the preview and the payload
cover the selected range and nothing more. Text after it under the same
heading stays private and the preview shows the existing warning about it
(H5).

An ineligible selection blocks "Share section…" with one reason:

| Reason ID | Sentence (pane and preview) | Fallback |
| --- | --- | --- |
| `no-heading-start` | A shared section starts at its heading. Your selection does not. | "Share the whole section…" when a heading's scope contains the whole selection |
| `partial-line` | The selection ends in the middle of a line. Select whole lines. | "Share the whole section…" as above |
| `crossing` | The selection runs past the end of the heading's section. | None |
| `nested-heading` | Line N is a heading inside the selection. Share each part as its own section. | None |
| `partial-block` | The selection ends in the middle of a paragraph or list item (line N). End it at a blank line. | "Share the whole section…" |
| `unclosed-fence` | A code block from line N is not closed. Close it before sharing. | None |
| `already-bound` | Line N is already part of a shared section. | None |
| `legacy-tasks` | Tasks in the selection are already shared in another collaboration. | The existing explicit import |
| `broken-ref` | The shared task marker on line N is damaged. Repair it before sharing. | None |
| `damaged-boundary` | The shared section from line N has a damaged boundary, so this text may belong to it. Repair shared sections in this note before sharing. | None |
| `multiple-selections` | Several parts of the note are selected. Select one range of lines. | None |
| `heading-only` | Only the heading is selected. Select the lines to share with it. | "Share the whole section…" |

- **S1. No silent expansion.** The selection is never widened to the
  heading section, the next heading or the end of the note without the user's
  explicit choice.
- **S2. A new preview for the fallback.** "Share the whole section…" runs
  `proposeRange` from the heading and opens a new preview. The selection's
  checks are not reused for it.
- **S3. No new heading.** 0.3 does not insert a heading above a selection
  that has none. The user adds the heading and shares again (§11, RC-04).
- **S4. Damaged EOF ranges stay diagnostic.** A fail-closed range up to the
  end of the file is a diagnostic region. It is never a share boundary,
  preview or copy. `preflight` reports a range in it as `DAMAGED_BOUNDARY`,
  with or without a selection (`damaged-boundary`, LFCP-03-009).
- **S5. One range.** Several selection ranges (multiple cursors) are not one
  scope: `multiple-selections`, no fallback (LFCP-03-009).
- **S6. Final text only.** While an input method is composing, no action
  takes a scope or writes: the action says to finish typing first. A
  section-changing action from Reading view asks to open the note for
  editing (T4).
- **S7. A heading alone is not an empty section** (owner decision D13). A
  selection of only the heading line, when the heading's section has a
  body, is refused as `heading-only` with the explicit fallback "Share the
  whole section…" and its new preview. A heading whose section is empty is
  shared as it is (LFCP-03-009).

## 5. Primary call to action

The pane shows at most one primary call to action for the current target.
Every other problem is listed below it, in the same order.

**P1. Precedence.** The first matching row decides the primary action:

| # | Condition | Primary action |
| --- | --- | --- |
| 1 | Local save failed: condition `save-failed` (`localPersistence: "failed"`, `LOCAL_SAVE_FAILED`) | `open-details`, which tells the user to keep the note open |
| 2 | A running flow on this target (P2) | The flow's next step; none while a stage waits for the network (its progress shows) |
| 3 | A flow whose result is unknown (P2) | `check-result` |
| 4 | Conditions `access`, `server-refused`, `invalid-profile` | `review-local-changes` when edits are held, else `open-details` |
| 5 | Conditions `rejected`, `stale-work` | `review-conflicts` when work waits for review, else `review-local-changes` |
| 6 | The first `source` condition, mapped by that projection's facts (below) | By the table below |
| 7 | Condition `held-unknown` (`heldCheck: "failed"`) | `open-details` |
| 8 | Conditions `structural-conflict`, then `scalar-conflict` | `review-conflicts` |
| 9 | Conditions `loading`, `access-checking` | `open-details` (no "current" claim) |
| 10 | Conditions `catching-up`, `local-edit`, `offline`, `pending`, `control-pending`, `evidence-unavailable` | §5.1 (offline or queued with no other problem: `sync-details`) |
| 11 | Condition `held-unchecked` (`heldCheck: "pending"`) | `open-details` (no "current" claim) |
| 11a | Condition `connecting` (`connection: "connecting"`, LFCP-03-005) | `open-details` (no "current" claim) |
| 12 | An unfinished flow (P2) | `continue-flow` |
| 13 | No condition: ordinary context | §5.1 |

Rows 1 and 4–11a are the conditions of `statusView` on `main` in the order
it pushes them, so the card's first condition and the pane's primary
action never disagree. Rows 2, 3 and 12 are flows, which the reducer does
not see. The package's order differs; see RC-03.

**Row 6 is matched by the projection's own facts.** The reducer reports a
projection that holds edits with a clean source as `source: "diverged"`.
That value is synthetic. Row 6 therefore reads the projection's
`ProjectionFacts.source` and its `held.cause`, never the condition's
`source` alone. It takes the first `source` condition, as the card does:

| Projection's facts | Primary action |
| --- | --- |
| `source` `binding-error`, or `held.cause` `boundary` or `binding` | `repair-sections` |
| `source` `base-unknown` or `diverged` (real), or `held.cause` `base-unknown` | `repair-sections` (compare versions) |
| `source` `unsupported`, or `held.cause` `unsupported` | `go-to-problem` |
| `held.cause` `read-only`, `revoked`, `refused` or `rejected`, with a clean source | `review-local-changes` |

**P2. Flows.** A flow is one share, invite, join, insert or repair the user
started. It is in exactly one of three states:

- **Running.** It was started in this session and one of its steps is in
  progress, or it is waiting for the user's input inside the flow (a
  preview or a choice is open). It owns the current area: its target and
  progress replace the context. Its next step is the primary action (row
  2). Only a local save failure (row 1) comes first.
- **Unknown result.** It stopped after a side effect started and before
  its receipt or answer arrived: a lost claim response, a crash between
  writing the note and registering the copy. The user checks the result
  (row 3). It is never retried as a new operation.
- **Unfinished.** It stopped at a known stage with no step in progress: the
  pane was closed, the user chose "Continue later", or Obsidian restarted.
  Every effect it started has its receipt. It is listed under
  "Unfinished", and "Continue" resumes the same operation (row 12). Any
  section problem comes first.

**P3. Immediate invalidation.** A change to the source, the access or the
target disables an action that is already shown at once. Safety checks are
never debounced. In the pane (LFCP-03-013) a status or flow change is drawn
at once, and a click is checked against the facts at the click: the action
must still be enabled and act on the same note, section and flow as the
button that was drawn; otherwise the pane redraws and runs nothing.

**P5. The flow in the current area** (LFCP-03-013). The pane holds the flow
it shows (share and insert flows, `SectionActions.flows()`): while it runs
or its result is unknown, a later flow does not take the current area, and
its next step goes back to that flow on its own note (T2). Other flows are
listed with where they stand; "Continue" brings the first of them forward.

**P6. After a restart** (LFCP-03-017). A flow is a view over the journals
that already exist; a restart reads them again and adds no journal of its
own. Nothing is deleted, revoked or detached on the way.

| Flow | Read at start | Where it stopped | After the restart |
| --- | --- | --- | --- |
| Share | The creation journal | Any phase | It goes on by itself and holds its note until its result is known. An unknown result is checked again under the same operation; no second Resource is created |
| Insert | The insertion journal (an insertion still `prepared`) | Before the note was written | Listed as unfinished on its note. "Continue", or a new insert on that note, shows the same preview at the place chosen before. Insert writes it once under the same insertion ID; Cancel ends it and writes nothing. A changed place writes nothing and ends it |
| Insert | The same | The note written, the copy not registered | The copy is registered at start, with no second block; a notice says so |
| Insert | The same | The note is gone | It ends; nothing is written; a notice says so |
| Join | The claim journal and the join record (the server and the name, never the link) | The claim sent, its answer lost | Settled at start. If the server cannot be reached, the pane shows the claim as unknown: "Check the result" settles the same claim, "Give up" drops its journal. The link is not asked for again |
| Invite | None | — | Nothing to resume: the invitation exists or it does not, and the card lists it |

A check of an unknown result waits at most 60 seconds. Then a notice
says the result is still not known, and "Check the result" is enabled
again. A check meanwhile joins the one still running; nothing is started
again. A share or insert that wrote nothing ends, so the next start does
not offer it. Closing the pane changes no flow: flows belong to the
plugin, and the pane shows them again when it opens.

**P4. No primary action.** When no row gives a primary action, the pane
says why in one sentence for the user, never in the contract's terms:
"Open a note to share from it, or join with a link." (no note);
"Select the lines of one section, from its heading, to share it." (a
selection with no fallback); "Put the cursor on a heading, or select a
section, to share it." (private text, no section). A running step says
what is in progress. The fixtures' `primaryCtaNone` holds these sentences.

### 5.1 Ordinary context

| Context | Primary action |
| --- | --- |
| Cursor in a private heading, or an exact eligible selection | `share-section` |
| Ineligible selection with a fallback | `share-whole-section` |
| A joined section not inserted anywhere (after the placement index is complete) | `insert-into-note` |
| A healthy section, invite allowed | `invite` |
| A healthy section, invite not allowed | `open-details` |
| Offline with updates queued and no other problem | `sync-details` |
| Setup incomplete (no server, sections off) | `open-settings`, with the exact reason (also a secondary action next to a share preview, to change its sync server, I8) |
| No open Markdown note | None. "Join with a link…" and the section list stay available |
| Reading view, source-changing action wanted | `open-for-editing` |

### 5.2 Problem hub (LFCP-03-018)

Below the status the pane lists every problem of the section and of the
note in view, one row each (`src/core/pane/problems.ts`). A row says what
the problem is, where it comes from, and offers the one action that opens
its resolver. The primary action of P1 is unchanged; the rows are the way
to each problem, not a second precedence.

| Problem | Source shown | Row action and what it carries |
| --- | --- | --- |
| Conflict or kept work (`RecoveryItem`) | "The shared section"; "Kept on this device" (stale work); "A note on this device" (reappeared) | `review-conflicts` with the item's `RecoveryItem.key`: the review re-reads its items and opens on that one; an item no longer there opens nothing and says so |
| A start marker without its end, or an end marker without its start, in the note in view (`repairItems`: `missing-end`, `missing-start`) | The note and its line | `repair-sections` with the item's line key, its line and the note's revision. The executor parses the note again: at the same revision the item must be at that line; at another revision it is found by its key, the nearest to its old line. Then the repair opens with that item first. Gone, nothing opens and nothing is written |
| Any other repair item in the note in view (`repairItems` `locate`: a mismatched or overlapping boundary, a misplaced start marker, an unreadable marker, a binding that cannot be matched, unsupported content) | The note and its line | `go-to-problem` with the same line key and revision, found again as above: the cursor goes to its line as the note is now; nothing is written |
| Held edits (`StatusView.held`), in any note; a copy held for a boundary, a binding or unsupported content in the note in view is shown by that note's repair rows instead when it has any | That note and its line, as the last pass found it | By cause: `repair-sections` (boundary, binding, base unknown: the note opened, then its repair), `go-to-problem` (unsupported), `review-local-changes` (read-only, revoked, refused, rejected) |
| Access or refusal (`access`, `server-refused`) | "The sync server", "This vault's access, as this device last verified it" (or "as checked with the server"), "This device" | `review-local-changes` when edits are held, else `open-details` |

Rules:

- **H1. No fix-all, no destructive default.** Each row has at most one
  action and none is destructive; discarding stays in the menu with its
  confirmation (A1).
- **H2. A line number is a hint, never an identity.** A repair row carries
  its line key and the revision the pane read; before any effect the note
  is parsed again. A held copy in the note in view is shown by that note's
  repair rows, not twice.
- **H3. Facts, not clicks.** A row is gone only when the facts no longer
  have it: the status, the review items, the note's text. After a repair or
  a review choice the executor tells the pane to read them again; the pane
  does not promise that held edits are sent (F2), it shows what the next
  pass did.
- **H4. L2 for rows.** A click runs only when the facts now still have that
  problem with the same action, enabled. The request is the one drawn, so a
  repair carries the revision the user saw.
- **H5. Read-only, revoked, not-member and refused** keep their own row
  text and source (F3).
- **H6. Lost base (owner decision D15).** The repair's choice for a copy
  whose base is lost is "Keep my version" or "Use the shared version".
  Keeping it makes the shared version the copy's base, so the next pass
  sends the note's differences as this vault's edits; it says that the
  pane and the card show whether they were sent, and promises nothing more.

### 5.3 First use and tips (LFCP-03-021)

The pane explains what an action does when it offers it, in one short tip
(`src/core/pane/hints.ts`). The words are in the code and checked by
`test/core/pane/hints.test.ts` and the vocabulary scan.

| Tip ID | Shown when (the first that applies) | Says |
| --- | --- | --- |
| `share-preview` | A share preview is shown and the primary action is `share-section` | Sharing makes this part of the note a shared section; people invited insert it into a note of their own; each note keeps a copy, synced through the sync server shown |
| `insert-copies` | The primary action is `insert-into-note` | It adds a copy to the chosen note; the rest of that note stays private; more notes later |
| `invite-link` | The primary action is `invite` | It makes a one-time link; Shared Tasks does not send it |
| `section-copy` | The cursor is inside a section | Inside is shared, outside stays in this note; ✓✓ means shared, not seen |
| `first-use` | The section list is read and empty | Where to start: Share section… from a heading (the heading, every line under it and lines added later; comments local by default, C3), or Join with a link… |

- **G1. First use leads to share and join.** With the list read and empty,
  its summary says "No shared sections on this device yet. Share one from
  a note, or join one with a link." This sentence is not a tip and always
  shows. While the list is read, nothing says it is empty (U03-02).
- **G2. One tip, never over a problem.** At most one tip shows. None shows
  while a problem line, a problem row, a preview problem or held edits are
  shown, or while a running flow or one with an unknown result holds the
  current area. A tip states no status and claims no delivery or reading
  (§10).
- **G3. Hide and bring back.** "Hide tip" hides that tip in this vault:
  its ID goes to the plugin's settings (`dismissedHints` in `data.json`),
  and the next tip that applies may show. "Show tips again", in the pane's
  Help area and in the settings tab, empties the list. Problems, held edits,
  the effects of a change (C6), the one-time-link sentence (I1) and every
  disabled action's reason are not tips and cannot be hidden.
- **G4. Local and migrated.** `normalizeSettings` reads an absent list
  (0.4 and earlier) as none hidden, keeps well-formed IDs of other
  versions, and drops anything else; no other setting, key, journal or
  stored note changes. A tip whose meaning changes gets a new ID. 0.4.x
  ignores the list without failing but drops it when it next saves its
  settings, so after a downgrade that saves, the hidden tips show again.
- **G5. No tour, no telemetry, no wizard.** Installing or upgrading opens
  no pane, dialog or tour; nothing about tips is sent; the sync server is
  chosen in the settings as before.

## 6. Status facts and what may be said

The pane, the card and the badge read one status path: `StatusView` and its
`sync` facts (LFCP-03-003), and `vaultSyncSummary` for the pane's overview.
No surface derives its own status. `null` means unknown and is shown as
unknown, never as zero.

| Fact | May say | Must not say |
| --- | --- | --- |
| `sync.current` true | "Current as last checked with the server. This does not mean others have seen it." | "delivered", "seen", "read", "received by" |
| `sync.current` false | The first condition's sentence | "Current", "Synced", "Up to date" |
| `sync.queue.batches` with `counted` true | "N local updates waiting" | A count when `counted` is false |
| `sync.queue.batches` with `counted` false | "Local updates waiting" | A number |
| `sync.held.edits` a number | "N edits not sent: <cause>" | Adding held edits to the queue count |
| `sync.held.edits` null | "Edits not sent: <cause>" | A number; "0 edits" |
| `heldCheck` "pending" (`sync.held.projections` null) | "Not current yet: not every note with this section was checked."; with an empty queue, the card's "No updates waiting in the sync queue. Notes with this section are still being checked for edits not sent."; the label "Checking notes for edits not sent" when it is the first condition | "No local changes waiting"; "Current"; a number of held edits |
| `heldCheck` "failed" (`sync.held.projections` null, condition `held-unknown`) | "Not current: whether a note with this section holds edits not sent is unknown." | "Checking notes" (nothing is in progress); "No local changes waiting"; "Current"; "0 edits" |
| `sync.queue.batches` 0 and edits held | "No updates waiting in the sync queue: the edits held in your note are not in it." | "No local changes waiting"; "Nothing to send" |
| `sync.sharedModel` "unknown" | Nothing about acceptance | "The server accepted your changes" |
| `localPersistence` "unconfirmed" | "Local changes are being saved" | "Changes saved" |
| Access `current` false | In the access list: "Access as last verified <time>; it may have changed." | "Access verified with the server <time>." |
| Access `revoked` or `not-member`, `current` not true | The problem's sentence, then "This is as this device last verified it; it may have changed." (no time) | The removal or non-membership as confirmed |
| Access `refused` | "The sync server no longer accepts changes from this vault for this section." | "Offline"; "Your access was removed" |
| Access `not-member` | "This vault is not a member of this section." | "Your access was removed" |
| Access `revoked` | "Your access to this section was removed. Your local copy stays." | "not a member" |
| `connection` "offline", `connectionQualifier` "lost" or "not-syncing" | "Offline: local updates wait on this device." | "failed" |
| `connection` "offline", `connectionQualifier` "no-evidence" (no session reported a transition yet, or there is none) | "Not checked with the server yet. Local updates wait on this device."; the label "Not checked with the server yet; local updates will wait" when it is the first condition (LFCP-03-013) | "Offline"; "failed" |
| `connection` "offline", `connectionQualifier` "network-offline" | "Offline (no network): local updates wait on this device." | "failed"; "The server is down" |
| `connection` "offline", `connectionQualifier` "not-responding" | "Offline: the server stopped responding, reconnecting. Local updates wait on this device." | "failed" |
| `connection` "failed" | "Could not connect to the server; trying again. Local updates wait on this device."; with `connectionQualifier` "not-responding": "The server stopped responding and connecting again failed; trying again. Local updates wait on this device." | "Offline" alone; a failure without a failed attempt |
| `connection` "connecting" | "Connecting to the server: not checked with it yet. Local updates wait on this device."; the label "Connecting to the server" when it is the first condition | "Current"; "failed" |
| `connection` "connecting" or "failed" | Only from a real transition or error fact (LFCP-03-005, `docs/architecture/access-connection-facts.md`) | Any state guessed from a timeout or an animation |
| Registry placement index building | "Looking for copies in your notes…" | "Not inserted yet"; "Never used" |

- **F1. The double tick ✓✓ is the mark of a shared section** (F-08). It
  turns green when the section is current: the server accepted this
  device's changes and nothing is held, queued or unchecked. It never
  means delivery to a peer, and no surface pairs it with one-tick or
  two-tick delivery states. The state icon and its text stay separate from
  it.
- **F2. Held source, queue and acceptance are separate facts.** A server
  acknowledgement of earlier shared state never makes a note with held
  edits current. The pane does not promise that held edits are sent after
  a repair; it shows the result after the repair.
- **F3. Read-only, revoked, not-member and refused are four states**, each
  with its own sentence (U03-17, U03-28).
- **F4. Not checked is not offline** (LFCP-03-020). With `connectionQualifier`
  "no-evidence" the badge draws its own icon (a cloud with dots, not
  crossed out) next to the tooltip "Not checked with the server yet; local
  updates will wait". The crossed-out cloud is only for offline with
  evidence.

## 7. Names: shared title and local alias

- **N1.** A section's primary label is its **shared title**: the heading
  text of the shared model.
- **N2.** The local alias (the name given on this device, for example at
  join) is shown as a second line, "On this device: <alias>", only when it
  differs from the shared title (F-10).
- **N3.** Before the shared title has loaded, the pane shows the alias with
  the qualifier "(name on this device)". It does not show the title of
  another projection or an empty label.
- **N4.** Sections are deduplicated by Resource and section IDs, never by
  name. Two sections with the same title stay two rows.
- **N5.** Naming at join is optional. The pane's join flow has no naming
  step. An empty name falls back to the shared title, not to "Shared
  collaboration".
- **N6.** A member's label is local ("Name…"), not a verified name. Equal
  labels never merge members.
- **N7.** The insert choice ("Insert shared section…", "Insert into a
  note…") names each section as N1–N3 do, and finds it by either name
  (LFCP-03-020). "Review conflicts…" asks about a task's title by the
  task's place ("the title of a task under "Plan""), never by one of the
  competing titles (F-10).

## 8. Content policy: raw blocks and comments

The share preview shows what is published, and the payload equals the
preview (MARKDOWN-SECTIONS-01 §8).

- **C1. Raw blocks are shared.** Fences, tables, callouts, blockquotes and
  HTML blocks other than comments are shared verbatim as raw nodes (§4.4,
  §5). The preview counts them as "other block(s)". An unclosed fence
  blocks the share. No surface says that tables or code blocks are
  unsupported.
- **C2. A heading inside blocks.** A heading inside the range blocks the
  first share and offers to split (§3, §8).
- **C3. Comments are local by default.** The sender's "section comments"
  setting decides (§4.5): `local`, the default, keeps a new `%%…%%` or
  non-LFCP `<!--…-->` comment on the device; `shared` makes it a raw node.
  A comment that already has a `raw` marker stays shared under either value.
  Under `local` the preview says exactly: "Comments (%% … %% and <!-- …
  -->) in this section stay on this device."
- **C4. A paragraph is content.** A plain paragraph under a Task is a
  paragraph node and is shared. It is not a comment.
- **C5. The readable preview hides only recognised binding lines.** The
  insert preview hides `lfcp-section`, `lfcp-node` and `lfcp-ref` metadata
  that the parser recognises. The source that is written keeps every
  marker. Unknown comments and raw text are not removed. Remote embeds and
  scripts are not run (U03-27, F-09). In 0.3 (LFCP-03-020,
  `src/core/sections/preview-display.ts`): the preview shows the readable
  text, and the exact lines under a collapsed "Technical details: the
  lines as written". A marker inside a fence or a multi-line comment is
  text and stays. A marker the parser cannot read stays visible, with
  "Line N has sharing metadata that could not be read. It is shown as it
  is."; a block that does not read back as one section hides nothing and
  says so. Both parts are drawn as text, never as Markdown or HTML.
- **C6. Body deletion and whole-copy removal are different** (§10). Deleting
  visible content in a healthy section deletes it for everyone (a retained
  tombstone). Removing a whole copy or deleting the note removes the local
  copy only. Detach strips bindings and changes nothing shared. The pane
  explains only these meanings. With the cursor in a section, the pane says
  them before the user acts, next to "More actions" (LFCP-03-019, N-05):
  "Deleting text inside this section deletes it for everyone who has this
  section." (only where this vault's edits go out: a writer whose access the
  server accepts), "Removing this whole copy from the note, or deleting the
  note, removes only this copy.", and, where "Detach this section" is
  offered, "Detach this section keeps its text here as your own. The shared
  section, its other copies and everyone's access stay as they are." The
  card says the first two under "What is shared". The detach confirmation
  says that the shared section, the other notes, the collaborators and
  their access are not changed. No new operation is added.
- **C7. Boundary cues** (LFCP-03-020, package §8). A thin dotted line marks
  a section's last visible line. With an idle cursor (moved, not typing)
  on that line the editor shows "Inside the shared section"; on the line
  right after the section, "Outside the shared section". Typing hides the
  cue. A damaged copy shows "Section boundary not determined" at its
  heading, whatever the cursor, and no line after it is drawn as shared
  (S4). Cues are editor widgets whose words come from CSS: never in the
  note, its undo history, its text content or the clipboard (U03-19).

## 9. Invitations and joining

- **I1. Invitation text.** The invitation dialog and the pane say:
  "One-time link, does not expire; whoever opens it first joins." It stays
  next to the existing sentence "treat it like a password".
- **I2. Explicit role.** Read or Read + write is an explicit choice. No
  default raises access.
- **I3. Hidden secret.** The link stays hidden until "Show link" or "Copy link".
  After "Copy link" the pane says "Link copied". It never says
  "invitation sent" or "invited".
- **I4. Ready means hosted.** "Invite collaborator…" is offered only when the
  section is on its server and access is current. A local-only share is
  not an invitation that is ready.
- **I5. Explicit join input.** Join takes a link the user pastes into the
  field. There is no clipboard polling and no OS `lfcp://` handler in 0.3.
- **I6. Join errors from real evidence.** Malformed link, link already used,
  removed from the section, needs a newer version, refused by the server,
  offline, and result unknown (the claim was sent) are each told apart. The
  text says "expired" only when the server reports it.
- **I7. An unknown claim is reconciled.** It resumes with the same link and
  the same claim. It is never retried as a new join.
- **I8. Share and invite are one journey in the pane** (LFCP-03-014). With
  the cursor on a private heading, or an exact eligible selection, the pane
  shows the share preview of the note as it is now: the same `preflight`
  as the share dialog (counts, the scope sentence, C3 and H5), the sync
  server it goes to ("Sync server: <server>. To use another one, change it
  in the settings first.", with "Open settings" enabled), and, under the
  `shared` comments setting, that comments added later are shared. The
  share dialog is the review: it says the same server and comments lines,
  and a source changed under it is reviewed again (a heading) or refused
  (an exact selection), never widened (S1). After the share the pane tells
  "Shared and on its sync server: ready to invite." (inviting enabled) from
  "Created on this device only: not on its sync server yet, so nobody can
  join." (I4), and its next step is "Invite collaborator…", run only on a
  click. The invitation's role choice and link stay in their dialogs; while
  one is open the pane shows the flow with I1, points to the dialog, and
  "Invite collaborator…" is disabled with "An invitation is open. Finish it
  in its dialog." (A4: one invitation at a time). "Link copied" follows
  "Copy link" (I3). A range with 0.1 shared Tasks is shared only through
  the existing explicit import, which makes new Tasks with new identities;
  the pane says so before it opens. "Ready to invite" and "Link copied"
  are kept only for the current session: after a restart the pane says
  only what the hosting and access facts say.
- **I9. The join flow in the pane** (LFCP-03-015). "Join with a link…" in
  the pane opens a masked field and an optional "Name on this device"; no
  dialog, nothing is sent until the user chooses Join. One join flow
  (`src/core/collab/join-flow.ts`) holds the one join lock for the pane's
  field and the palette's dialog, and the pane shows its steps: claim,
  access (only once the server accepted the claim), load, choose a place.
  Each step done is shown with the fact that confirms it ("The server
  accepted the claim.", "Access: read and write.", "Loaded on this
  device."). A stopped join keeps its cause in view (I6) with the field
  for another link. A Resource this vault already holds is reached without
  a new claim. Once joined, the section is the pane's subject (D9), listed
  as not inserted yet, and its next step is "Insert into a note…" through
  the existing insert, into the note in view (the destination choice is
  LFCP-03-016); "Later" ends the flow. A claim whose answer was lost offers
  "Check the result" (the same claim, from its journal) or "Give up" (its
  journal dropped, as at a restart). A join and an invitation under way
  share the current area by P5: a running share or insert the pane holds,
  then the invitation (its dialog is open), then the join; the other is
  listed. The link is never kept, shown, put in
  a notice or logged.

## 10. Scope boundaries

MVP 0.3 does **not** add, and no 0.3 surface may imply:

- peer delivery or read receipts, or any "seen by" state;
- an incoming invitation inbox. The pane shows only the link the user
  pasted and this device's own pending claim;
- cancelling or revoking an unused invitation, or an expiry for one (D-01).
  The card keeps its "Invitation xxxx: … used 0 of 1" row;
- rejoining after removal (the existing text for `removed` stays);
- ownership transfer, migration, presence, per-node access, a global
  dashboard or a task editor in the pane;
- a new wire, profile or Markdown format, or a second journal, registry or
  status path;
- clipboard reads in the background, or registering `lfcp://` with the OS.

## 11. Resolved contradictions

Each row is a place where the MVP 0.3 package disagrees with the shipped 0.2
behaviour (plugin 0.4.0, spec `mvp-0.2-baseline.12`). Where the code
conforms to the spec, the code and the spec win.

| ID | Package says | Code and spec say | Decision |
| --- | --- | --- | --- |
| RC-01 | The old draft calls tables and fences unsupported | Raw nodes, shared verbatim (MARKDOWN-SECTIONS-01 §4.4, §5; MS16, MS33, MS34) | C1. No surface says tables or fences are unsupported |
| RC-02 | Comment exclusions are shown "if the baseline provides them" | `local` by default, per sender; the preview sentence exists in `share.ts` (§4.5; MS38–MS41) | C3, with the exact sentence |
| RC-03 | CTA order: save → boundary → access → unsupported → conflict → flow → ordinary | `statusView` on `main` orders save failure → access and refusal → rejection and stale work → source → held check failed → conflicts → loading and access check → catch-up, local edit, offline, pending → held check pending | P1 rows 1 and 4–11 take the reducer's conditions in that order, so the card's first condition and the pane's primary action never disagree. Flows (rows 2, 3, 12) are outside the reducer and placed by P2 |
| RC-04 | With no heading, "show creating a title in the preview" | A section starts at an ATX heading with its marker on the next line (§3); `preflight` blocks `NOT_A_HEADING` | S3. 0.3 inserts no heading. Open for the owner (O-02) |
| RC-05 | "Deleting the copy's text" is ambiguous | Body deletion is a shared delete; removing a whole copy is local only (§10; reproduced in LFCP-03-001) | C6 |
| RC-06 | D-01 proposes a 7-day expiry and a cancel button | No expiry in the server, no cancel API; claim limit 1 (`DEFAULT_CLAIM_LIMIT`) | The owner's D-01 decision: I1 and §10. The join prompt's "It works once, and only for you" is wrong (anyone holding the link can claim it first). LFCP-03-015 replaced it with I1 in the join dialog and the pane |
| RC-07 | U03-11 lists "expired" among join errors | No server enforces expiry; LFCP-WIRE-01 allows it only as policy | I6: "expired" only from a server refusal that says so |
| RC-08 | F-08 asks for a neutral shared mark | 0.4 design: ✓✓ means shared, turns green when current, progress has its own icon (`docs/guides/shared-sections.md`) | F1 keeps the 0.4 design. The pilot (§5 of the pilot protocol) asks what ✓✓ means. Open for the owner (O-03) |
| RC-09 | The code map says no command has a lock | `InFlight` per note for share, import and insert; join and invite guards (`7070d5f`, beta.6) | A4 builds on them (LFCP-03-002, 010) |
| RC-10 | Held edits are to be added as new facts | 0.4.0 has `HeldEdits`; LFCP-03-003 (on `main`, `700caa1`) adds `StatusView.sync`, `heldCheck` and `vaultSyncSummary` | §6 reads only these; no second status path |
| RC-11 | Russian labels | The plugin's interface is English; command IDs and names must not change (LFCP-03-008 AC2) | §3: English labels; palette names unchanged |
| RC-12 | Pins: plugin 0.4.0-beta.8, spec baseline.10 | Released 0.4.0 (`ce0660a`), spec baseline.12 (`bf1c78c`), `main` `c66a6f5` | This contract is pinned to the second set |
| RC-13 | Join stages include a required naming step (beta.8) | The palette join asks for a name (may be empty → "Shared collaboration") | N5. This is the intended 0.3 change for F-10, not a spec matter |

## 12. Open for the owner

| ID | Question | Contract default until decided |
| --- | --- | --- |
| O-01 | Rejoin after removal (gap register, `rejoin-after-removal.md`) | Not in 0.3; the `removed` text stays |
| O-02 | Insert a heading above a heading-less selection, as an explicit previewed edit | Not in 0.3 (S3) |
| O-03 | Keep the green ✓✓ for "current" | Keep it (F1); the pilot measures comprehension |

## 13. Fixtures

[`test/fixtures/ux-0.3/states.json`](../../test/fixtures/ux-0.3/states.json)
holds the action catalogue of §3 and table-driven expected states: no
editor, loading, unplaced, healthy, held (including a failed held check),
conflict and offline, access stale and unknown result, plus running and
unfinished flows, selection, content, refusal and read-only cases. Each
state gives:

- `facts`: the input, shaped like `StatusView.sync`, the access and
  connection facts, the context and the registry. `null` is unknown.
  `section.access` is `StatusView.access` (`verifiedAt` in local
  milliseconds); `section.connection`, `connectionQualifier` and
  `refusal` are the view's fields of the same names.
  `section.accessView.canInvite` comes from the access list (`AccessView`),
  not from the status facts;
- `expected.primaryCta`: an action ID, or `null` with a reason;
- `expected.enabled` and `expected.disabled`: action IDs, each with its
  reason;
- `expected.forbiddenClaims`: strings that must not appear on any surface
  in that state. `globalForbiddenClaims` apply to every state.

The schema test checks the shape, the coverage of the eight required
states and the consistency with the catalogue. A fixture's section must be
one the reducer can produce: LFCP-03-007 rebuilds its `StatusFacts`, runs
`statusView` and the pane view model, and checks the view, the primary
action, the enabled and disabled actions (reasons word for word) and the
claims. LFCP-03-013 runs the same fixtures through the plugin's pane path:
the plugin on the recording Obsidian mock, its host adapter, the wired
dispatcher and the renderer, with a sections host built by hand for each
state (`test/obsidian/pane-fixtures.test.ts`). The join flow's state runs
on the plugin's join flow (LFCP-03-015). The unfinished insert is the one
a restart leaves: approved, its note not written yet (LFCP-03-017). The
two with a share preview (selection-exact, content-comments-and-table)
draw it from the note in view and claim its lines (LFCP-03-014).
LFCP-03-023 runs them in the native harness.
