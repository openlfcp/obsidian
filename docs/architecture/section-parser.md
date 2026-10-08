# The shared-section parser (MVP 0.2, LFCP-02-034/035)

`src/core/sections` reads a note and returns its shared sections: where
each one begins and ends, the tree of nodes inside it, and diagnostics. It
is pure (text in, structure out) and Obsidian-free. In this first step it is
**not wired into the plugin**; nothing in 0.3.x calls it.

The grammar is spec `integration/MARKDOWN-SECTIONS-01.md` (Working Draft,
spec `3a13ba2`, LFCP-02-007), with the owner's decisions M1 (Task refs on
their own child line), M2 (tabs), M4 (start marker right after the
heading), M5 (a marker on every node) and M6 (raw blocks, no headings
inside a section).

## Modules

| File | Owns |
| --- | --- |
| `grammar.ts` | The spelling of the markers, and nothing else: `parseBoundary`, `parseNodeMarker`, `parseSectionRef` and their formatters. The only file to change while the grammar is a draft |
| `parser.ts` | `parseSections(markdown): SectionScan`: boundaries (pass 1), then the nodes of each valid section (pass 2) |

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
- **Indentation.** `indentWidth` and `visualWidth` (`src/core/refs/lines.ts`,
  `scanner.ts`) measure visual columns, tabs to the next multiple of four
  (§5, M2). A node's parent is the nearest open Task or item whose content
  column is at or left of the node's column. Paragraphs and raw nodes take
  no children.

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
- an HTML block: through a multi-line comment's own lines, blank ones
  included (the lexer marks them literal), then down to the line before the
  next blank line or node marker. **Open question for 007:** §4.4 says "the
  line before the next blank line", which would cut a multi-line HTML
  comment at its first blank line. The parser keeps the comment whole until
  007 decides;
- a table or a blockquote: down to the line before the next blank line or
  node marker.

## Obsidian comments (§4.5)

A `%%` comment inside a section is not shared (spec `3a13ba2`, the
orchestrator's decision). The parser reports it as a local block
(`localBlocks`) with `SECTION_UNSUPPORTED_SYNTAX`, detail
`obsidian-comment`, severity warning ("Obsidian comments can't be shared;
move them out of the section"). It is not a node and does not block the
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

`test/core/sections/parser.test.ts`: the grammar module (round trip,
whitespace rule, malformed markers); boundaries (M4, the packet's
marker-above-heading form rejected, missing, mismatched and overlapping
markers, markers in fences and comments, the private tail); nodes (M1
child-line refs and nesting, M2 tabs, M6 raw blocks of each kind, a heading
inside a region, an unclosed fence, `%%` comments kept local, duplicate, foreign,
malformed, orphan and kind-mismatched markers, an empty paragraph). The
byte-exact fixtures of LFCP-02-010 replace the inline cases when they land.
