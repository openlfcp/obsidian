# ADR 0001: CodeMirror transactions for shared sections

- **Status:** Proposed (draft for MVP 0.2, wave W2). The direction is the
  owner's decision M3 of 2026-10-08 (`workbook: reviews/mvp-0.2/summary.md`
  §2); the mechanisms below need the spikes in "Verification" before they
  are accepted.
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
  - record the transaction's `userEvent` and whether it carries our own
    origin annotation.

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
| Node marker / Task ref for new content | `lfcpOrigin.of(opId)`, `userEvent: "lfcp.bind"` | Joined to the user's edit that created the node, so undo removes both or neither (AR2 §7); the joining mechanism is spike S2 |
| Status, boundary, badges | none: decorations only, no document change | none |

The selection and cursor follow through CodeMirror's own change mapping.
Remote patches are minimal: owned spans only, as the 0.3 renderer does for
Task fields.

### 4. One file, several views

Each `MarkdownView` has its own `EditorView`. Per file, the section engine
keeps a single coordinator: it reads from and writes to one live view (the
most recently focused one) and relies on Obsidian to propagate the change
to the other views of the same file. Each view keeps its own decorations.
If propagation does not behave like that (spike S3), the coordinator writes
to each view with the same `opId` and the guard accepts each echo once.

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

## Verification (spikes before the ADR is accepted)

| ID | Question | Pass condition |
| --- | --- | --- |
| S1 | Does a `ViewPlugin` see every edit, including IME, paste, drag-drop, Obsidian commands (move line, toggle checkbox) and the Tasks plugin's own edits, with a usable `userEvent`? | A log of transactions for each gesture on 1.13.1, macOS |
| S2 | How do we join the marker insertion to the user's history event? Candidates: dispatch in the same tick with a matching `userEvent`, or `appendTransaction`-style filters (`EditorState.transactionFilter`) that add the marker to the user's own transaction | One undo removes the new item and its marker; one redo restores both |
| S3 | Several views of one file and a popout window: does Obsidian propagate a dispatched change to the other views, and with which annotation? | Defined behavior, recorded; the coordinator rule in §4 confirmed or replaced |
| S4 | `vault.process` / external modify of an open file: is the buffer replaced or merged, and is the cursor kept? | Recorded; it tells whether a closed-file write racing an opening view is safe |
| S5 | Cost: `update` work and reconciliation of a 200-Task section (W200) | Keystroke-to-paint not worse than without the extension by more than the budget of LFCP-02-067 |
| S6 | `transactionFilter` vs. Live Preview's own filters | No interference with list continuation, folding and checkbox clicks |

## Consequences

- New code in `src/obsidian/` (extension, coordinator) and `src/core/`
  (section parser, reconciliation, journal), tasks LFCP-02-041 to 046. The
  boundary check keeps CodeMirror out of `src/core/`.
- Two write paths coexist in one note, split by section ranges. Tests must
  cover a note with both a section and standalone Tasks, open and closed.
- Undo, IME and multi-view behavior become our responsibility for section
  regions; spikes S1–S4 come before the implementation tasks freeze.
- The 0.1 statement in [../projection.md](../projection.md) stays true for
  standalone Tasks; that document will link here once this ADR is accepted.
