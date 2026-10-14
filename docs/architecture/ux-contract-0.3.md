# UX contract for MVP 0.3

**Task:** LFCP-03-006 (milestone M03-1; gates G03-A, G03-C, G03-E).
**Status:** normative for the MVP 0.3 work in this repository. A change to
this contract goes through a pull request that also updates the fixtures.
**Base:** obsidian `main` at `c66a6f5` (Shared Tasks 0.4.0 `ce0660a` plus the
F-05 fix), spec `mvp-0.2-baseline.12` (`bf1c78c`), `@openlfcp/*` 0.2.0.
**Machine-readable part:**
[`test/fixtures/ux-0.3/states.json`](../../test/fixtures/ux-0.3/states.json),
checked by `test/core/ux-contract-fixtures.test.ts`.

This document fixes the actions, labels, targets, call-to-action precedence,
content policy and scope of the MVP 0.3 user interface: the Shared Tasks
pane, the editor context menu, the section card and the palette. Every 0.3
task that adds or changes a user-facing surface implements this contract.
The status reducer and the action seam (LFCP-03-008, 013, 023) make the
fixtures pass; this task does not bind them to code.

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
(LFCP-03-008, U03-07). A disabled action states its reason in words; the
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
| `remove-access` | Remove access… | — (card, existing) | — | yes |
| `discard-local-copy` | Discard the local copy… | — (card, existing) | — | yes |
| `detach-section` | Detach this section | `detach-section` "Detach this section" | — | yes |

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
  does not start another one (LFCP-03-002, 010).

## 4. Target and selection

### 4.1 Target

- **T1.** An idle pane follows the last active Markdown note. Focus in the
  pane does not change the target.
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

### 4.2 Exact selection

With no selection, "Share section…" proposes the heading under or above the
cursor, down to the next heading of the same or a higher level
(`proposeRange`, as in 0.4.0).

With a non-empty selection, the selection is **exact and eligible** only
when all of these hold:

1. **Starts at a heading.** Its first line is an ATX heading that
   `proposeRange` accepts. A section starts at its heading
   (MARKDOWN-SECTIONS-01 §3), so the heading line may be selected in part.
2. **Whole lines at the end.** Its last line is selected through its last
   non-blank character. Trailing blank lines are trimmed; this is not an
   expansion.
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
  preview or copy.

## 5. Primary call to action

The pane shows at most one primary call to action for the current target.
Every other problem is listed below it, in the same order.

**P1. Precedence.** The first matching row decides the primary action:

| # | Condition (from the status facts) | Primary action |
| --- | --- | --- |
| 1 | Local save failed (`localPersistence: "failed"`, `LOCAL_SAVE_FAILED`) | `open-details`, which tells the user to keep the note open |
| 2 | An open flow's result is unknown | `check-result` |
| 3 | Access or refusal: `revoked`, `not-member`, `refused`, `unavailable-key`, server refusal, invalid profile | `review-local-changes` when edits are held, else `open-details` |
| 4 | Rejected updates, or offline work cut off by an access change | `review-conflicts` for work to review, else `open-details` |
| 5 | A copy's source: damaged boundary or binding, unknown base, divergence | `repair-sections` |
| 6 | Unsupported content in a copy | `go-to-problem` |
| 7 | Held edits for another cause (read-only and the like) | `review-local-changes` |
| 8 | Structural conflict, then scalar conflict | `review-conflicts` |
| 9 | Loading, access being checked, a note not checked for held edits | `open-details` (no "current" claim) |
| 10 | An unfinished flow (not unknown) | `continue-flow` |
| 11 | Ordinary context | §5.1 |

This order follows the status reducer that 0.4.0 ships (`statusView`). It
differs from the package's order; see RC-03.

**P2. An open flow owns the current area.** While a flow runs, its progress
and target take the current area and its next step is the primary action.
Only row 1 overrides it.

**P3. Immediate invalidation.** A change to the source, the access or the
target disables an action that is already shown at once. Safety checks are
never debounced.

### 5.1 Ordinary context

| Context | Primary action |
| --- | --- |
| Cursor in a private heading, or an exact eligible selection | `share-section` |
| Ineligible selection with a fallback | `share-whole-section` |
| A joined section not inserted anywhere (after the placement index is complete) | `insert-into-note` |
| A healthy section, invite allowed | `invite` |
| A healthy section, invite not allowed | `open-details` |
| Offline with updates queued and no other problem | `sync-details` |
| Setup incomplete (no server, sections off) | `open-settings`, with the exact reason |
| No open Markdown note | None. "Join with a link…" and the section list stay available |
| Reading view, source-changing action wanted | `open-for-editing` |

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
| `sync.held.projections` null | "Checking notes for edits not sent" | "No local changes waiting"; "Current" |
| `sync.queue.batches` 0 and edits held | "No updates in the queue" next to the held edits | "No local changes waiting"; "Nothing to send" |
| `sync.sharedModel` "unknown" | Nothing about acceptance | "The server accepted your changes" |
| `localPersistence` "unconfirmed" | "Local changes are being saved" | "Saved" |
| Access `current` false | "Access as last verified <time>; it may have changed." | "Access verified with the server <time>." |
| Access `refused` | "The sync server no longer accepts changes from this vault for this section." | "Offline"; "Your access was removed" |
| Access `not-member` | "This vault is not a member of this section." | "Your access was removed" |
| Access `revoked` | "Your access to this section was removed. Your local copy stays." | "not a member" |
| `connection` "offline" | "Offline: local updates wait on this device." | "failed" |
| `connection` "connecting" or "failed" | Only from a real transition or error fact (LFCP-03-005) | Any state guessed from a timeout or an animation |
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
  scripts are not run (U03-27, F-09).
- **C6. Body deletion and whole-copy removal are different** (§10). Deleting
  visible content in a healthy section deletes it for everyone (a retained
  tombstone). Removing a whole copy or deleting the note removes the local
  copy only. Detach strips bindings and changes nothing shared. The pane
  explains only these meanings.

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
| RC-03 | CTA order: save → boundary → access → unsupported → conflict → flow → ordinary | `statusView` orders save failure → access and refusal → rejection and stale work → source → conflicts → loading | P1 follows the reducer, so the card's first condition and the pane's primary action never disagree |
| RC-04 | With no heading, "show creating a title in the preview" | A section starts at an ATX heading with its marker on the next line (§3); `preflight` blocks `NOT_A_HEADING` | S3. 0.3 inserts no heading. Open for the owner (O-02) |
| RC-05 | "Deleting the copy's text" is ambiguous | Body deletion is a shared delete; removing a whole copy is local only (§10; reproduced in LFCP-03-001) | C6 |
| RC-06 | D-01 proposes a 7-day expiry and a cancel button | No expiry in the server, no cancel API; claim limit 1 (`DEFAULT_CLAIM_LIMIT`) | The owner's D-01 decision: I1 and §10. The join prompt's "It works once, and only for you" is wrong (anyone holding the link can claim it first). LFCP-03-015/020 replace it with I1 |
| RC-07 | U03-11 lists "expired" among join errors | No server enforces expiry; LFCP-WIRE-01 allows it only as policy | I6: "expired" only from a server refusal that says so |
| RC-08 | F-08 asks for a neutral shared mark | 0.4 design: ✓✓ means shared, turns green when current, progress has its own icon (`docs/guides/shared-sections.md`) | F1 keeps the 0.4 design. The pilot (§5 of the pilot protocol) asks what ✓✓ means. Open for the owner (O-03) |
| RC-09 | The code map says no command has a lock | `InFlight` per note for share, import and insert; join and invite guards (`7070d5f`, beta.6) | A4 builds on them (LFCP-03-002, 010) |
| RC-10 | Held edits are to be added as new facts | 0.4.0 has `HeldEdits`; LFCP-03-003 adds `StatusView.sync` and `vaultSyncSummary` | §6 reads only these; no second status path |
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
editor, loading, unplaced, healthy, held, conflict and offline, access
stale and unknown result, plus selection, refusal and read-only cases. Each
state gives:

- `facts`: the input, shaped like `StatusView.sync`, the access and
  connection facts, the context and the registry. `null` is unknown;
- `expected.primaryCta`: an action ID, or `null` with a reason;
- `expected.enabled` and `expected.disabled`: action IDs, each with its
  reason;
- `expected.forbiddenClaims`: strings that must not appear on any surface
  in that state. `globalForbiddenClaims` apply to every state.

The schema test checks the shape, the coverage of the eight required
states and the consistency with the catalogue. LFCP-03-013 and 023 run the
same fixtures through the real reducer and pane.
