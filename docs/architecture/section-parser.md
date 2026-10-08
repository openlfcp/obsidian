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
| `rules.ts` | Context-aware delete, detach, duplicate and cut/paste (LFCP-02-046) |
| `undo.ts` | Native undo/redo as compensating intents (LFCP-02-044): `compensate` with the session ledger |
| `journal.ts` | Local records (LFCP-02-038): the reconciliation journal, pending candidates, the diagnostics view, rebuild from a note |
| `base.ts` | Three-way bases (LFCP-02-037): `markdownState`, `planSection`, and the base store by projection ID |
| `source-map.ts` | A node's Text extracted from the note, and the map between Text positions and note offsets: `nodeSource`, `textToDoc`, `docToText`, `textEditToDoc` (LFCP-02-036) |

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

Problems inside a valid region mark it `blocked`: a heading, a duplicate
ID, a foreign Task ref or a malformed node marker. The adapter then pauses
that section's projection (§8), and the other sections continue.

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
