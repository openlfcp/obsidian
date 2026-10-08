# ADR 0001: CodeMirror transactions for shared sections

- **Status:** Proposed (draft for MVP 0.2, wave W2). The direction is the
  owner's decision M3 of 2026-10-08 (`workbook: reviews/mvp-0.2/summary.md`
  §2). Spikes S1–S6 ran on 2026-10-08 ("Verification and evidence"); IME
  and the Tasks plugin's own edits are still open.
- **Scope:** shared sections only (`org.openlfcp.shared-sections.v1`).
  Standalone shared Tasks keep the file path of 0.1–0.3
  ([../projection.md](../projection.md)).
- **Supersedes:** for sections only, the 0.1 choice "Deferring was chosen
  over editor transactions" ([../projection.md](../projection.md),
  "Unsaved editor").

## Context

Since LFCP-062 the plugin works at the file level. A vault `modify` event
(after Obsidian saves the buffer) is debounced for 300 ms. The note is then
diffed against a three-way base, and the result is written back with
`vault.process` under a content-hash echo guard. A note open in an editor
whose buffer differs from the file is never written; the render is deferred
to its next save. That works for Task lines: the only text the plugin
writes into them is the owned fields of a Task the user is not editing.

Shared sections break the assumptions this choice relied on:

- **The plugin must write while the user types.** New paragraphs, items and
  Tasks inside a section get a node marker or a Task ref
  (MARKDOWN-SECTIONS-01 §7). With the file path, that write lands in the
  note being typed in. Either it is deferred for as long as the user types,
  or `vault.process` replaces the buffer and moves the cursor.
- **Remote edits arrive into notes being typed in.** Two people edit one
  section. With deferral, the remote half waits until the local buffer is
  saved and unchanged between read and write; under continuous typing it
  can wait indefinitely (review finding OP-13).
- **Edits need their causal shape.** A file diff cannot tell "Enter at the
  end of a Task, then typing" from "the Task was renamed and a new one
  appeared below". M1 (inline refs inside sections) removes the worst case;
  cut/paste, undo and moves still need the transaction (AR2 §7).
- **Status must react before the save.** SI02 requires the success state to
  drop as soon as a local change exists, not after autosave + debounce.
- The community directory's guideline already prefers the Editor API over a
  vault write for the active note (`../../devel/community-submission.md`).

The public API of Obsidian 1.13.1 (`obsidian.d.ts`) offers what this needs,
without private fields:

- `Plugin.registerEditorExtension(extension)`: CodeMirror 6 extensions in
  every Markdown editor (Source and Live Preview), already used for the
  conflict decoration ([`conflict-decoration.ts`](../../../src/obsidian/conflict-decoration.ts));
- `editorInfoField` (the view's file) and `editorEditorField` (its
  `EditorView`) as state fields;
- `@codemirror/state` and `@codemirror/view` are provided by the app
  (external in `scripts/build.mjs`): annotations, `Transaction.addToHistory`,
  `Transaction.userEvent`, `ChangeSet.mapPos`, `EditorView.composing`.

## Decision

### 1. Who owns which bytes

| Source | Section regions | Everything else (standalone Tasks, private text) |
| --- | --- | --- |
| Note open in an editor | **Section engine, editor path**: the editor's document is the source; reads and writes go through CodeMirror transactions | Unchanged file path of 0.3 (vault events, deferral, `vault.process`) |
| Note not open | **Section engine, file path**: `vault.process` with an exact expected-content check, as `ProjectionWriter` does today | Unchanged |

The legacy engine must skip every line inside a valid or damaged section
range. Task refs inside sections look like ordinary `lfcp-ref`s to the 0.3
scanner (M1 makes them inline), and processing them twice would send
duplicate intents.

### 2. Observing edits (editor path)

- One extension per editor: a `ViewPlugin` (or a `StateField` where layout
  needs it, e.g. hidden metadata lines, M5). It reads the file through
  `editorInfoField`.
- `update(u)` does only cheap, synchronous work:
  - map the section source map through `u.changes` (`mapPos`);
  - mark touched sections as **editing** (status LOCAL_EDIT, SI02);
  - note whether the transaction carries our own origin annotation.

  The origin annotation is the only reliable classifier. `userEvent` is a
  hint at most: Obsidian's own edits (commands, checkbox clicks, the Editor
  API) carry none, and external writes and other views arrive as `"set"`
  (S1, S3).

  No parsing of whole sections, no SDK calls, no I/O in `update`.
- Reconciliation runs later, outside `update`: after a short idle, at
  composition end (`view.composing` false) or at blur. It parses the
  affected section ranges against their trusted base and commits semantic
  intents through the SDK journal (AR2 §5). A debounce reduces work but is
  never the only copy of an intent: the buffer is the copy until the SDK
  receipt, and the journal after it.
- Transactions with our origin annotation update the source map and base.
  They never produce intents (the echo guard of the editor path).
- Changes that reach the editor from outside (another plugin, vault sync
  reloading the file, a second view) arrive as transactions without our
  annotation and are reconciled like typing, against the base. They are
  never taken as remote LFCP state.

### 3. Writing (editor path)

All plugin writes into an open note are one synchronous block:
1. read `view.state`;
2. compute the patch against that exact document;
3. `view.dispatch` it.

JavaScript runs this to completion, so no user keystroke can land between
the read and the write. Revision checks are only needed across the
asynchronous SDK step. The reconciled base records the `doc` it was
computed from. If that document is no longer the current one, the patch is
recomputed from the current document, or paused when owned spans
overlapped meanwhile.

| Write | Annotations | Undo history |
| --- | --- | --- |
| Remote projection patch | `lfcpOrigin.of(opId)`, `userEvent: "lfcp.remote"` | `addToHistory.of(false)`: a peer's edit never becomes the user's undo step |
| Node marker / Task ref for new content | `lfcpOrigin.of(opId)` on the appended spec | Joined to the user's edit that created the node, so undo removes both or neither (AR2 §7): an `EditorState.transactionFilter` appends the marker to the **user's own transaction** (S2). A separate dispatch, even in the same tick with the same `userEvent`, is its own undo step |
| Status, boundary, badges | none: decorations only, no document change | none |

The selection and cursor follow through CodeMirror's own change mapping.
Remote patches are minimal: owned spans only, as the 0.3 renderer does for
Task fields.

A transaction filter runs synchronously inside the user's transaction, so
the marker's node ID is allocated there (a local UUIDv7, no I/O) and
journaled right after. A crash in between leaves a marker with an ID that
was never published; recovery treats it as a new node with that ID.

### 4. One file, several views

Each `MarkdownView` has its own `EditorView`. Per file, the section engine
keeps a single coordinator: it reads from and writes to one live view (the
most recently focused one) and relies on Obsidian to propagate the change
to the other views of the same file. Each view keeps its own decorations.

Obsidian does propagate, but as a `"set"` transaction **without** our
annotation (S3), the same way an external write arrives (S1, S4). So the
coordinator never extracts intents from a single transaction: any change
it did not make, in any view, only marks the file for reconciliation, and
reconciliation compares the coordinator view's document with the base. A
mirrored change it made itself yields no difference and no intent.

### 5. Leaving the editor

When the last view of a file closes, pending reconciliation is flushed
first. The file path then takes over from the saved content, against the
same base. A file that changes on disk while closed is reconciled against
its base on the next open or vault event, as today.

### 6. What does not change

- Standalone Tasks, the 0.3 golden fixtures and minimal-diff guarantees.
- The SDK boundary: intents go through `runtime.writeIntent` (or its batched
  successor, review OP-12); the plugin implements no protocol logic
  (`test/core/collab/no-protocol.test.ts`).
- Only public Obsidian API: no `editor.cm`, no monkey-patching, nothing the
  directory's automated review flags.

## Alternatives

- **File path for sections too** (0.3 approach). Rejected: it cannot insert
  markers while the user types, starves remote edits during co-editing and
  loses the causal shape of edits (Context).
- **`Editor.transaction(tx, origin)`** (Obsidian's wrapper). It carries no
  CodeMirror annotations and gives no control over undo history. Usable as
  a fallback for a single replace, not as the main path.
- **Editor path for everything, legacy Tasks included.** Not now: it would
  change 0.3 behavior that has passed the golden suite and the directory
  review, with no user benefit in 0.2. It can be revisited after the pilot.

## Verification and evidence

The spikes run in the native harness ([../../devel/testing/native-harness.md](../../devel/testing/native-harness.md)):
`test/native/specs/adr-0001-spikes.e2e.mjs`, through a test-only plugin
(`test/native/plugins/cm-spike`) that uses the same public API as this
design. Results agree on Obsidian 1.13.4 and 1.14.4 (macOS, 2026-10-08)
and are asserted, so a later Obsidian that changes one fails there.

| ID | Question | Evidence | Consequence |
| --- | --- | --- | --- |
| S1 | Does a `ViewPlugin` see every edit, with a usable `userEvent`? | Every gesture arrives. `userEvent`: typing and Enter in a list `input.type` (Enter's transaction already contains the list continuation `\n- [ ] `); Backspace `delete.backward`; paste `input.paste`; undo `undo`; move line `move.line`; the toggle checklist command, a checkbox click in Live Preview and the Editor API: none; `vault.process` on the open note: `set` | Classify by our origin annotation only (§2). **Open:** IME composition (WebDriver cannot drive an IME; manual check) and the Tasks plugin's own edits (needs a pinned Tasks plugin in the harness) |
| S2 | How is a marker joined to the user's undo step? | A `transactionFilter` appending the marker to the user's transaction: one undo removes text and marker, one redo restores both. A separate dispatch right after, with the same `userEvent`: undo removes only the marker | Use the transaction filter (§3) |
| S3 | Two views of one note | A change dispatched in one view reaches the other at once, as `userEvent: "set"`, without our annotation; both documents equal | Coordinator rule refined (§4) |
| S4 | `vault.process` on an open note | Applied to the buffer within ~5 ms; the cursor is mapped (line 2 → 3 after a line inserted above); unsaved typing in the buffer is kept and merged with the external write (the disk lacks it until the next save) | Obsidian merges external writes into an open buffer, so the closed-file path stays safe when a view opens meanwhile. Remote patches into an open note still go through `dispatch` (§3), for `addToHistory` and the annotation |
| S5 | Cost while typing in a 200-Task note | A recording `ViewPlugin`: 40 updates, ~0.003 ms each | `update` work is negligible; the cost budget belongs to reconciliation (LFCP-02-067) |
| S6 | A transaction filter vs. Live Preview | An active filter leaves list continuation (Enter), checkbox clicks and heading folding unchanged | No interference found |

## Consequences

- New code in `src/obsidian/` (extension, coordinator) and `src/core/`
  (section parser, reconciliation, journal), tasks LFCP-02-041 to 046. The
  boundary check keeps CodeMirror out of `src/core/`.
- Two write paths coexist in one note, split by section ranges. Tests must
  cover a note with both a section and standalone Tasks, open and closed.
- Undo, IME and multi-view behavior become our responsibility for section
  regions. S1–S6 ran; IME and the Tasks plugin's edits stay open before
  the implementation tasks freeze.
- The 0.1 statement in [../projection.md](../projection.md) stays true for
  standalone Tasks; that document will link here once this ADR is accepted.
