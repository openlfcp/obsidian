# The shared-section parser (MVP 0.2, LFCP-02-034/035)

`src/core/sections` reads a note and returns its shared sections: where
each one begins and ends, the tree of nodes inside it, and diagnostics. It
is pure (text in, structure out) and Obsidian-free. In this first step it is
**not wired into the plugin**; nothing in 0.3.x calls it.

The grammar is spec `integration/MARKDOWN-SECTIONS-01.md` (Working Draft,
spec `2d1a829`, LFCP-02-007), with the owner's decisions M1 (Task refs on
their own child line), M2 (tabs), M4 (start marker right after the
heading), M5 (a marker on every node) and M6 (raw blocks, no headings
inside a section).

## Modules

| File | Owns |
| --- | --- |
| `grammar.ts` | The spelling of the markers, and nothing else: `parseBoundary`, `parseNodeMarker`, `parseSectionRef` and their formatters. The only file to change while the grammar is a draft |
| `parser.ts` | `parseSections(markdown): SectionScan`: boundaries (pass 1), then the nodes of each valid section (pass 2) |
| `text.ts` | Text positions (LFCP-02-036): UTF-16 offsets ↔ Unicode scalar positions (SSP §10), lone surrogates refused, `diffText` (one edit, in scalars) |
| `presentation.ts` | What the editor hides and where a section's boundary runs (LFCP-02-048); used by `src/obsidian/section-presentation.ts`, the first module wired into the plugin |
| `rules.ts` | Context-aware delete, detach, duplicate and cut/paste (LFCP-02-046) |
| `undo.ts` | Native undo/redo as compensating intents (LFCP-02-044): `compensate` with the session ledger |
| `journal.ts` | Local records (LFCP-02-038): the reconciliation journal, pending candidates, the diagnostics view, rebuild from a note |
| `base.ts` | Three-way bases (LFCP-02-037): `markdownState`, `planSection`, and the base store by projection ID |
| `source-map.ts` | A node's Text extracted from the note, and the map between Text positions and note offsets: `nodeSource`, `textToDoc`, `docToText`, `textEditToDoc` (LFCP-02-036) |
| `port.ts` | What the section engine needs from the SDK, in the names of SDK-SECTIONS-INTEGRATION-01: the snapshot, the profile's intents in the shape of sdk-ts's `SectionReplica` (the section ID as the root's parent, `createdBy` on new nodes), `commit`/`receiptOf`/`releaseReceipt` with the `Receipt`, refusals (`CommitRefused`) and `canWrite`. Tests use a fake (`test/core/sections/fake-port.ts`) until the SDK provides it |
| `input.ts` | When typing becomes a reconciliation (`ReconcileScheduler`) and which new content waits (`transientCandidates`), LFCP-02-043 |
| `engine.ts` | One reconciliation pass of a note's sections: all of the above put together (`SectionEngine.pass`, `written`) |
| `coordinator.ts` | One source per note across editor views, file events and renames; passes coalesced per note (LFCP-02-041) |
| `markers.ts` | Bindings for nodes that just got their IDs: node markers and child-line Task refs (`bindingChanges`) |
| `task-fields.ts` | Task field edits inside sections: the 0.1 planner on section Tasks (`planTaskFields`, `representLine`) |
| `sdk-snapshot.ts` | sdk-ts's `SectionReplica.snapshot()` in the port's terms (`fromSdkSnapshot`) |
| `commit.ts` | Local edits into durable shared updates, exactly once (LFCP-02-039): `commitPass`, `resumeOperation`, `markProjected`, `finish`, `localStatus` |
| `writes.ts` | The plugin's own writes (LFCP-02-042): `GeneratedWrites` by operation ID and exact content, and `pendingBase` while a write is pending |
| `structure.ts` | Nodes a collaborator created or moved, written into the note (`planStructure`) |
| `remote.ts` | Remote changes into the note (LFCP-02-040): `planRemote` (minimal, three-way patches of owned spans) and `applyRemote` (only to the revision planned for) |

```ts
interface SectionScan {
  sections: ParsedSection[];       // valid sections only
  claimed: LineRange[];            // every line a section boundary owns, valid or damaged
  diagnostics: SectionDiagnostic[];
}
interface ParsedSection {
  ref; heading: { line; level; title }; startLine; endLine;
  nodes: SectionNode[];            // tree: kind task | item | paragraph | raw, id or null
  localBlocks: LineRange[];        // Obsidian comments, kept in place, not shared (§4.5)
  privateTail: LineRange | null;   // H5
  blocked: boolean;                // something in the region pauses projection
}
```

## Reuse of the 0.1 scanner

The parser does not read Markdown a second way:

- **Lexical context.** `lineKinds()` (exported from `src/core/refs/scanner.ts`
  for this purpose) says which lines are literal: fences, front matter,
  indented code, multi-line HTML and `%%` comments. A marker on a literal
  line is text (§2, §9), exactly as `lfcp-ref` comments are in 0.1. Both
  parsers therefore agree on what is live Markdown.
- **Task refs.** `scanRefs()` finds Task projections with both placements
  and their diagnostics (MARKDOWN-REFS-01 unchanged, §4.1). The section
  parser only adds the section's context: a Task line in the region is a
  `task` node, bound when it has a ref; a ref to another Resource is
  `FOREIGN_RESOURCE_REF`.
- **Item continuations.** An item's paragraph goes on in continuation
  lines, lazy ones included (CommonMark); its `item` marker follows the last
  of them (§4.2), since an HTML comment interrupts a paragraph.
- **Indentation.** `indentWidth` and `visualWidth` (`src/core/refs/lines.ts`,
  `scanner.ts`) measure visual columns, tabs to the next multiple of four
  (§5, M2). A node's parent is the nearest open Task or item whose content
  column is at or left of the node's column. Paragraphs and raw nodes take
  no children.

## Text and the source map (LFCP-02-036)

The profile's Text intents count Unicode scalars; the note, the editor and
CodeMirror count UTF-16 code units (SSP §10). `text.ts` converts exactly and
refuses an offset inside a surrogate pair or a lone surrogate (invalid in
shared text, SSP §4).

`nodeSource(markdown, node)` builds a node's Text as the profile holds it
(24's answers for LFCP-02-010, to be frozen in MARKDOWN-SECTIONS-01 §5):

| Kind | Text |
| --- | --- |
| paragraph | its lines without the marker line, each stripped to the node's column, joined with LF |
| item | the inline text after the list marker, then its continuation lines stripped to the content column, joined with LF |
| raw | the block's lines stripped to the content column, joined with LF, no final LF |
| task | none: its fields are scalars, read from the Task line by the 0.1 rules |

Text line breaks are LF whatever the note uses; CRLF is local presentation.
A tab that reaches past the stripped column leaves its remainder as spaces,
which are part of the Text and map back to the tab.

The source map is a list of segments, one per line, from Text positions to
note offsets. `textEditToDoc` turns a Text edit (a remote one, to project)
into a note change: a line break in the inserted text becomes the note's
line ending plus the node's continuation indentation. The tests check that
a projected edit, read back, gives the same Text as the edit applied to the
Text, with CRLF, Cyrillic and emoji.

## Three-way bases (LFCP-02-037)

The 0.1 rule carries over: a projection keeps a base, what the note showed
at its last reconciliation. The note differing from the base is the user's
edit; the shared state differing from it is a remote change to render. The
shared state compared is the snapshot taken with the note's read (the 0.3.2
fix, [projection.md](projection.md)).

- `markdownState(markdown, section)` gives the note's state: bound nodes
  with parent, order and Text, plus the unbound candidates (kind, parent,
  bound sibling before it, Text, line) for the adapter to bind or report.
  Bound nodes under a parent without a binding yet (existing items
  indented under a new one) are neither missing nor moved, and new nodes
  under it wait until it is bound.
- `planSection(base, note, shared)` gives the user's edits: section title,
  Text edits (scalar positions, against the base Text), moves and missing
  nodes. With no base (first sight), the note is compared with the shared
  snapshot, and nothing can be missing. Moves are minimal: a reparented node
  moves; among siblings, the longest run that kept its relative order stays
  and the rest move. A node missing from the note is **reported, not
  deleted** (MARKDOWN-SECTIONS-01 §7); a kind change is refused
  (`NODE_KIND_MISMATCH`). Task fields stay with the 0.1 field planner.
- Bases are stored **per projection ID**, not per note path (OP-24): a note
  can hold several projections, and a rename changes only their locator.
  `MemorySectionBaseStore` serves the tests; the install-database adapter,
  under the key `section-base:<projection ID>`, comes with the journal
  (LFCP-02-038).

## One pass over a note (`engine.ts`)

`SectionEngine.pass(path, source, context)` reconciles every section of a
note on the source just read and returns the note changes as one list
against it; the host writes them through the coordinator's route and calls
`written` (bases stored, operations finished) or `abandoned`. The context
carries the caret's line, the bound nodes the user's own transactions
removed with their bindings, and the transactions' origin (undo, redo).
Per section:

1. Every snapshot is taken before the first await (the 0.3.2 rule). No
   snapshot, a paused section or an importing one: nothing happens.
2. Without a base (MS11), a note that shows the model exactly seeds it;
   any other note publishes nothing (`base-unknown`).
3. Unfinished operations of the projection come first. A committed batch
   whose bindings were never written (a crash, an unwritten pass) is
   applied to the base, and its new nodes are found again among the
   unbound ones by kind and content and get the IDs already allocated,
   never new ones.
4. The user's edits since then, against that base, go out as one batch
   (`commit.ts`). A missing node is deleted only when the user's
   transaction removed it with its binding; otherwise it is
   NODE_BINDING_LOST and stays in the base. Undo and redo compensate
   (`undo.ts`). Transient new content waits (`input.ts`). If the batch is
   not committed (read-only, refused, failed), the pass stops there: the
   edit stays in the note and nothing is projected over it.
5. The new nodes get their bindings (`markers.ts`), and the base becomes
   the stored base with the batch applied (`applyBatch`), not the note,
   which may hold edits held back in this pass.
6. The model, read again after the commit, is projected (`remote.ts`).
   Bindings and remote changes are composed into one list.

The stored base keeps a model revision per node, the one at which the
model's Text equals the base's (contract §7.3, §7.5): a Text edit's `base`
names it. A node whose own edit was merged with a concurrent one and not
projected yet has none, and its next Text edits wait until it is projected,
so indices are never sent against a revision whose Text differs.

Task fields inside a section (checkbox, title, dates, priority, tags) are
the 0.1 planner's (`projection/intents.ts`), run by `task-fields.ts` on
each section Task whose line the user changed since the base, three-way
against the base line: its 0.1 Task intents join the section's batch (the
SDK's section intents include them), and the base takes the Task's new
line. The inline ref is left out of what the line represents, wherever it
stands. Remote Task changes are rendered by `remote.ts` with the 0.1
renderer.

## In the editor (`src/obsidian/section-editor.ts`)

`sectionEditorExtension` is the CodeMirror side, not registered by the
plugin until the SDK binding is: a `ViewPlugin` per editor sees every
transaction (ADR 0001 S1). In `update` it only notes the bindings a user
transaction removed (the IDs in the removed marker and ref comments, for
`deletedIds`), the undo or redo origin, and tells the scheduler; our own
writes carry the `sectionWrite` annotation and are never taken for the
user's. Composition and blur reach the scheduler through DOM events. A
pass goes through the coordinator; its changes are dispatched only onto the
revision they were computed for, outside the undo history, else the pass
is abandoned and runs again on the new document. The native harness runs
it on the fake SDK (`specs/section-sync.e2e.mjs`).

## Typing and IME (LFCP-02-043)

Per ADR 0001 §2, reconciliation runs outside the editor's update.
`ReconcileScheduler` runs a pass after a short idle (400 ms), at the end
of an IME composition, at blur, and at the latest 2 s after the first
unreconciled edit while typing goes on, but never during a composition.
It reports the note as edited at the first keystroke (SI02), not at the
pass. The debounce is never the only copy of an edit: the buffer holds it
until the journal and the receipt do (`commit.ts`).

`transientCandidates` holds back new content that is not ready on the
caret's line: an item without text, or a Task without a title (the
`- [ ] ` Enter leaves). It gets no identity in this pass and is reconciled
once the caret leaves or it has content. A Task line damaged while typing
(`- [ Prepare`) leaves its ref orphaned: the parser pauses the section
(`NODE_BINDING_ORPHAN`) and nothing is published from it (MS17-transient).
The IME behaviour on the real host is the manual
[IME checklist](../devel/testing/ime-checklist.md).

## One source per note (LFCP-02-041)

`SourceCoordinator` decides what a pass reads and how it writes, from the
adapter's events (`opened`, `closed`, `editorChanged`, `fileChanged`,
`remoteChanged`, `renamed`, `deleted`):

- While a note is open, only its editor document is a source, and writes
  go through an editor transaction (route `editor`): the editor can be
  newer than the file, and an external write reaches the editor, which
  reloads it as a transaction. A file event of an open note is never
  reconciled on its own; it may still be the plugin's own write, which
  `writes.ts` recognizes by content. Split views share one document.
- A closed note is read from its file and written by read-modify-write
  (route `file`).
- One pass per note at a time. Events during a pass mark the note dirty,
  and one more pass follows with the latest source and every trigger
  (`local`, `remote`); other notes are not delayed. A source already
  reconciled (same SHA-256) is not reconciled again, unless a remote change
  must be projected. A failed pass is reported and leaves the source
  unreconciled. A rename while a pass is queued carries the note's state to
  its new path.

## The SDK's snapshot (`sdk-snapshot.ts`)

`fromSdkSnapshot` renames and regroups sdk-ts's one-revision snapshot
(sdk-ts `32b72bf`): the root's parent is the section ID there and null
here; `deleted` (the node itself, or a Task node's Task) is the lifecycle
that may remove a node's lines from a note, while `hidden` (also under a
deleted ancestor) only keeps it out of the visible state; recovery facts,
invalid nodes, ID collisions and edits retained under a deletion are the
problems that freeze structure, and concurrent Task field values are not
(the 0.1 conflict marks show them). A section the SDK classifies
`PROFILE_INVALID` gives no snapshot, `IMPORTING` is `ready: false`, and a
node of an unknown kind or without a placement is left out.
`test/core/sections/sdk-snapshot.test.ts` runs against the real
`SectionReplica` at `sdk-ts.lock`: the mapping, and the engine's batches
(creations, a Text edit against the snapshot's revision, a move, a
deletion) accepted by the replica as they are.

## Committing local edits (LFCP-02-039)

`commitPass(deps, pass)` turns one reconciliation pass of one projection
(the plan of `planSection`, the deletes and restores that `rules.ts` and
`undo.ts` decided, the unbound nodes the transaction shows were inserted)
into one batch, and commits it through the port (contract §3, §7.4–§7.7):

1. Nothing to send: nothing happens. No write access (`canWrite`, §6):
   the section's source is kept as a `read-only` or `access-revoked`
   candidate, and nothing is journaled or sent.
2. The entry is captured, then the new IDs (UUIDv7, by the candidate's
   line) **and the batch** are written to the journal (`ids-allocated`)
   before the commit, so every retry submits exactly the same batch under
   the same operation ID. Consecutive new nodes follow each other (`after`
   is the previous new ID); a new node's children bind on a later pass.
3. `commit` resolves with a durable receipt: `committed`, and the
   receipt's `modelRevision` becomes the projection's base; the caller
   writes the markers for the IDs, then `markProjected` and `finish`
   (which releases the receipt, §3.5).
4. A refusal (`CommitRefused`) abandons the entry: `STALE_BASE` plans again
   from a new snapshot, `SECTION_IMPORTING` waits, `NOT_WRITABLE` and the
   profile's codes keep the source as a candidate (`read-only`,
   `rejected`). Any other error leaves the outcome unknown: the receipt
   decides (§3.4). With one, the pass is committed; without one, it is
   `save-failed` (SI17, `LOCAL_SAVE_FAILED`) and the entry stays
   `ids-allocated` for a retry.

The IDs are written into the note by `markers.ts`: a paragraph's or raw
block's marker on the line before it, at its indentation; an item's after
its last line, at its content column; a Task's ref on its child line, at
its content column, as 0.1's `attachRef` writes it. Only lines are added
(no Text changes, line endings kept), and a node no longer there unbound is
reported as missed, its ID kept in the journal. A new node's new children
bind on the next pass. Inside sections every new Task ref goes on its child
line for now: the canonical inline form (the ref before the Tasks fields,
spec bb4ba6f) needs the ref scanner to accept a ref that is not at the end
of its line (MS42–MS45), so the "on the task line" setting does not apply
to sections yet.

After a restart, `resumeOperation` follows the journal's crash table: an
entry at `ids-allocated` asks for its receipt and either projects the
existing IDs or resubmits the recorded batch under the same operation ID;
`committed` projects the existing IDs, never new ones; `projected`
finishes when the source still has the patched hash. A Task is therefore
created once however often a pass is retried. `localStatus` gives the
indicator's local part: `LOCAL_EDIT` until a receipt exists (SI02), then
`SAVED_LOCAL`.

## Remote changes into the note (LFCP-02-040)

`planRemote(markdown, section, base, snapshot, tasks)` turns the model's
state into the smallest note changes (contract §7.6), against the
projection's base, so concurrent local typing is never overwritten:

- A node is patched only while the note still shows its base. Otherwise it
  is deferred (`local-edit`): the user's edit is committed first and the
  merged value comes back on a later pass. A node the note already shows
  as the model has it only advances the base.
- The title changes inside the heading line (level and closing hashes
  kept); a Text through the source map (`textEditToDoc`, the note's line
  ending and the node's indentation for new lines); a Task line through
  the 0.1 renderer (`renderProjectedLine`, shared with `renderNote`), so a
  remote completion changes one character and keeps either ref placement
  (MS02, MS12).
- A node deleted in the model loses its lines (markers, ref, children and
  the blank line after it), but only when none of them changed here and no
  local comment sits among them (`edited-under-deletion`, `private-text`).
- Fail closed (MS14): a node the model reports a problem for is left as it
  is; with any problem, nothing structural is projected (`frozen`); a node
  the model's tree merely omits is never deleted; a value the note cannot
  hold (a blank line in a paragraph, a line break in a title) is deferred
  as `unrenderable`. Creations and moves are listed as `unprojected` for
  the structural writer, which is the next step.
- Nothing is projected while the section imports, without a base (MS11:
  rebuild first) or while the parser has paused the section.

The patch carries the note's revision (SHA-256, as the mutation guard
uses) and the snapshot's. `applyRemote` refuses another revision of the
note (null): the caller plans again from the current note rather than
shifting old offsets. `patch.base` is the projection's base once the patch
is written, and an applied patch planned again is empty.

## Nodes a collaborator created or moved (`structure.ts`)

`planStructure` writes the model's new and moved nodes into the note, on
the note after the Text patches (the engine's last layer). It takes the
nodes `unprojected` lists: new ones, a new parent, or a new place among
siblings (the longest run that kept its order stays, so a swap moves one
node).

- New nodes go in the model's preorder: after their visible predecessor's
  subtree, or first under their parent (after its own lines, or the start
  marker), so a new parent's new children follow it.
- Each kind in its binding form (§4): a Task as 0.1 renders a new one,
  its ref on the child line (it waits while its Shared Objects Task is not
  here: `no-task`); an item with its marker after its text; a paragraph
  or raw block after its marker. Children at the parent's content column,
  under a tab-indented parent one more tab (M2); an ordered run numbered
  from 1 (§5).
- Paragraphs and raw blocks are set apart by a blank line, except as a
  Task's or item's first child (§6) and next to the boundaries (MS41).
- A moved node takes its subtree, re-indented for its new parent, with
  the blank line after it; not when anything in it changed here
  (`local-edit`) or a local comment sits in it (`private-text`).
- Nothing structural under a model problem (`frozen`, MS14); a node whose
  predecessor or parent is not in the note yet waits (`no-anchor`).

The engine composes the layers (resumed bindings, new bindings, Text
patches, structure) with `composeChanges` into one list against the source
read. When a later layer cuts into text an earlier one just inserted, that
layer waits for the next pass. A property test checks the composition
against applying the lists in turn.

## The plugin's own writes (LFCP-02-042)

Feedback is prevented by the base, not by ignoring events. A write (a
remote patch, a marker insertion) is recorded with the base it leads to,
and the next pass compares the note with that base three-way: the write's
own content gives no intent, and anything else in the same note (the
user's typing, the Tasks plugin's ✅) does. No time window, and no events
ignored while a write is in flight.

- `GeneratedWrites` knows a write by its operation ID (an editor
  transaction carries it as an annotation) or by the exact content it
  produces (a file event, SHA-256 as the 0.1 mutation guard). Seeing one
  consumes it and every older write of the note; a repeated notification
  is then an ordinary event that plans nothing.
- The host confirms a write once it landed (the transaction was
  dispatched, the file's read-modify-write resolved) or abandons it (stale
  revision, failed write).
- While a write is pending, `pendingBase` compares each node (and the
  title) with the base the note shows for it: the written one or the prior
  one. A node changed from both was edited: on top of the write once it is
  confirmed, so the edit does not repeat the remote change; over the prior
  value otherwise, so a write lost to an external one never turns into an
  intent that reverts the remote change (the 0.3.1 race, for sections). A
  node the write removed stays in the base while the note still shows it.

## Journal and local records (LFCP-02-038)

Interfaces and an in-memory store; the install-database adapter and the
SDK's durable receipts (LFCP-02-025) come later.

- **Journal.** One entry per reconciliation, with phases in order
  (OBSIDIAN-SECTIONS-ARCHITECTURE-02 §5): `captured` → `ids-allocated`
  (IDs written before anything that could be retried) → `committed` (with
  the SDK's durable receipt) → `projected` (markers written, the patched
  hash recorded) → `done`, or `abandoned` with a reason. `advance()` only
  moves forward and never replaces an allocated ID or a receipt.
- **Recovery** after a restart follows the crash table: re-evaluate with
  the recorded IDs; ask the SDK for the receipt when the commit is
  uncertain (never repeat blindly); project the existing IDs after a
  commit; finish when the source still has the patched hash.
- **Pending candidates** keep text that cannot be shared yet (unsupported
  syntax, a lost binding, an unknown base, read-only or revoked access, a
  rejection) with its reason. They are removed only by an explicit
  resolution, never to save space. `diagnosticView()` is the only shape
  default diagnostics may show: no text, no path.
- **Rebuild from a note** (`rebuildFromNote`) recovers section identities,
  ranges and bound IDs, and always reports the base as unknown: markers
  prove identity, not whether a difference is an unsent edit or a stale
  rendering (MARKDOWN-SECTIONS-01 §11).

## Undo and redo (LFCP-02-044)

Undo changes the note, never shared history (OBSIDIAN-SECTIONS-ARCHITECTURE-02
§7). Text and Task field edits need nothing new: the three-way planner sees
the note back at an older value and sends it as a new edit. Only nodes that
disappear or reappear need a decision, made from the transaction's
`userEvent` (`undo`/`redo`, ADR 0001 S1) and a session ledger of the nodes
this projection created and deleted:

| Change | Origin | Intent |
| --- | --- | --- |
| A node created in this session is gone | undo | `node.delete` (compensating) |
| A node deleted in this session is back | undo | `node.restore`, a fresh lifecycle operation (SSP §9) |
| The same, the other way round | redo | `node.restore` / `node.delete` |
| A node is gone | anything else | `NODE_BINDING_LOST`, text kept (§7) |
| A deleted node is back | anything else | review, nothing sent |

The marker of a node created by typing joins the user's undo step (S2), so
one undo removes text and marker together, which is what makes the
"created in this session" case reliable.

## Delete, detach, duplicate, cut and paste (LFCP-02-046)

Pure rules for MARKDOWN-SECTIONS-01 §7 and §10:

- `detachSection` removes every binding of one projection (boundary lines,
  node markers, child-line refs, inline refs) and keeps the readable text
  and the line endings. No shared change follows (fixture MS10-detach,
  byte for byte).
- `readableSection` is the "Copy readable text" output: the heading and the
  content without bindings, LF, the note unchanged (fixture MS25, byte for
  byte).
- `classifyRemoval` calls a missing node a **delete** only when the editor
  transaction removed every line the node owned, marker and ref included
  (MS10-delete). With only its marker gone (MS21), or with no transaction
  (an external edit, MS18), it is `NODE_BINDING_LOST`, and the text stays.
- `duplicates` keeps the identity on the occurrence the base knew and
  offers "Duplicate as new" for the others; with no base, none is the
  original (MS08).
- `pasteDecision`: a same-session paste of a cut into the same section is a
  move; into another section or Resource, an explicit copy with new
  identities; without a matching cut, nothing is inferred.

## Fail closed

A damaged boundary (missing, mismatched, overlapping, or a start marker not
right after a heading, M4) yields **no section**. It yields only a
`claimed` range from the heading down to the end of the note, plus a
diagnostic. Nothing infers a wider or a narrower region (§9). An unclosed
fence inside a region hides the end marker from the lexer, so the region
never closes: `SECTION_BOUNDARY_MISSING` plus `SECTION_UNSUPPORTED_SYNTAX`
(detail `unclosed-fence`) at the fence.

A comment preceded by a `raw` marker is a raw node, shared, whatever the
section comments setting (§4.5, MS41); only a comment without one is kept
local.

Problems inside a valid region mark it `blocked`: a heading, a duplicate
ID, a foreign Task ref, a malformed node marker, or a Task ref no Task owns
any more (`NODE_BINDING_ORPHAN`: its line was edited into something else
while typing, MS17-transient). Such a ref is never part of a block's Text.
The adapter then pauses that section's projection (§8), and the other
sections continue.

## For the 0.1 Task engine (ADR 0001 §1)

`claimed` is what the existing projection engine must skip. Task refs
inside a section look like ordinary `lfcp-ref`s, especially with child-line
placement (M1). The 0.3 engine processing them would send Shared Objects
intents to a section Resource. Wiring (a later task):
`ProjectionEngine.processFile` drops every projection whose `taskLine` lies
in a `claimed` range, before grouping.

## Raw blocks (M6, §4.4)

A raw node is a fence (through its closing fence), a table, a blockquote or
callout, or an HTML block, bound by a `<!-- lfcp-node: raw:<id> -->` line
right above it. Its extent:

- a fence, or any other run of literal lines: the run;
- an HTML block that is not a comment: down to the line before the next
  blank line or node marker;
- a table or a blockquote: down to the line before the next blank line or
  node marker.

## Comments (§4.5)

A comment inside a section, Obsidian's `%%` or an HTML comment that is not
an LFCP marker, is not shared (spec `3a13ba2`, `2d1a829`). The parser
reports it as a local block (`localBlocks`) with `SECTION_UNSUPPORTED_SYNTAX`,
detail `obsidian-comment` or `html-comment`, severity warning ("Comments
can't be shared; move them out of the section"). Its extent is the comment
itself, blank lines inside it included (the lexer marks them literal). It is not a node and does not block the
section: the rest syncs. Keeping it next to the line it follows when a
remote patch arrives, and pausing the projection when a remote change
removes or moves its neighbours, is the adapter's work (fixture MS30).
Markers inside a comment stay literal.

## Private tail (H5)

Obsidian folds, drags and embeds a heading with every line down to the next
heading of the same or a higher level. `privateTail` is the non-blank text
between the end marker and that heading. The share and insert commands use
it to warn that this private text travels with the shared heading (§3).

## Not the parser's job

- **New vs. lost content (§7).** A node without a marker comes back with
  `id: null`: an *unbound candidate*. Whether it is new (to be bound and
  shared) or a binding that was lost (`NODE_BINDING_LOST`) is decided by the
  adapter, from the editor transaction or the projection base (ADR 0001).
  The parser has neither.
- **Enter after a Task (MS19–MS21).** The new Task line between a Task and
  its child-line ref is the editor transaction's case (ADR 0001, S1: the
  Enter transaction inserts the continuation after the current line).
- **Decorations, hiding markers in Live Preview (M5, H3).** The editor
  extensions.

## Tests

`test/core/sections/remote.test.ts`: MS02, MS12 and MS14 (their notes
checked byte for byte against spec `mvp-0.2-baseline.1`), minimal Text and
title changes in UTF-16, CRLF and indentation of new lines, local edits
deferred, deletion with its blank line, edited or commented deleted nodes
kept, created and moved nodes listed, a stale revision refused, a second
pass empty, and the three skips.

`test/core/sections/engine.test.ts` (against the fake port with a model):
seeding and MS11, one batch for a Text edit with a new paragraph and Task
and their bindings, a transient Task, deletion versus a lost binding,
read-only, remote projection alone and with local edits, and a crash
between the commit and the bindings (one Task, the same ID).

`test/core/sections/task-fields.test.ts`: a Task line read with its inline
ref at the end or before the fields; only the changed field sent; an
unknown Task reported. `engine.test.ts` also ticks a section Task
(`task.complete`, the note kept) and renders a collaborator's completion.

`test/core/sections/input.test.ts`: idle, the cap while typing, no pass
during a composition and one at its end, blur, dispose; transient
candidates on and off the caret's line.

`test/core/sections/coordinator.test.ts`: the file route for closed
notes and the editor route while open (a lagging or external file event
ignored), split views, repeated notifications, coalescing during a pass
with every trigger, one slow note not delaying another, a failed pass,
rename while queued, deletion.

`test/core/sections/markers.test.ts`: each kind bound where the parser
reads it with the same Text, pass by pass for nested new nodes; continuation
lines before children; CRLF and tabs; nested Tasks at their content
column; missed bindings.

`test/core/sections/commit.test.ts` (against the fake port, mock
evidence): one batch per pass with IDs before the commit and chained new
nodes; a failed save (SI17) and its retry; a crash before the commit,
after it (before the journal knew) and after the source write, each with
exactly one change; `OPERATION_ID_REUSED`; read-only and revoked access;
the refusal codes.

`test/core/sections/structure.test.ts`: MS41 byte for byte (its note
checked against spec `mvp-0.2-baseline.1`); a Task under its parent as 0.1
renders it, waiting for its Task; a paragraph as a first child; a new
parent with new ordered children; tab indentation; a predecessor not in
the note yet; a subtree moved and re-indented; a swap moving one node; a
local edit or a model problem holding a move. Each result parses back to
the model's tree. `compose.test.ts`: 3000 random cases against applying in
turn. `engine.test.ts` also projects a paragraph and a Task added
remotely, and a remote move, with nothing sent back.

`test/core/sections/writes.test.ts`: own writes by operation ID and by
content, once; older writes consumed; abandon and rename; typing
elsewhere and on top of a confirmed write; a write lost to an external
one (shown to revert against the written base, and not against
`pendingBase`); title, removal and marker insertion without intents.

`test/core/sections/rules.test.ts`: detach with inline refs, CRLF and a
last line without an ending; the readable copy; delete vs. lost; duplicates
with and without a base; paste decisions. MS10-detach and MS25 were also
checked byte for byte against spec `1e87206`.

`test/core/sections/undo.test.ts`: origins, a text undo as a new edit,
compensating delete and restore for undo and redo, and the cases left to
review.

`test/core/sections/journal.test.ts`: forward-only phases, IDs and
receipts never replaced, the recovery table, unfinished entries, candidates
kept until resolved, the diagnostics view, rebuild without a base.

`test/core/sections/base.test.ts`: the note's state and unbound
candidates, user edits vs. remote changes, first sight against the
snapshot, minimal moves and reparenting, missing nodes, title and kind
changes, the store by projection ID across a rename.

`test/core/sections/source-map.test.ts`: scalar conversion with emoji
(a ZWJ sequence counts its scalars), lone surrogates, `diffText`, tab
stripping, the Text of each kind, position round trips and projected edits.

`test/core/sections/parser.test.ts`: the grammar module (round trip,
whitespace rule, malformed markers); boundaries (M4, the packet's
marker-above-heading form rejected, missing, mismatched and overlapping
markers, markers in fences and comments, the private tail); nodes (M1
child-line refs and nesting, M2 tabs, M6 raw blocks of each kind, a heading
inside a region, an unclosed fence, `%%` comments kept local, duplicate, foreign,
malformed, orphan and kind-mismatched markers, an empty paragraph). The
byte-exact fixtures of LFCP-02-010 replace the inline cases when they land.
