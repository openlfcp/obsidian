# `src/core/refs`: `lfcp-ref` markers

This module implements `spec: integration/MARKDOWN-REFS-01.md` at the spec
pin in `spec.lock` (`mvp-0.1-baseline.6`). It is pure TypeScript with no
Obsidian or Node dependency, so a VS Code or other Markdown adapter can reuse
it unchanged. LFCP-060 was done before LFCP-059 on purpose: the parser
needs no SDK. Its token validators (`tokens.ts`) delegate to
`@openlfcp/core` since LFCP-059; a differential test against the spec's own
fixtures still checks them.

| File | Purpose |
| --- | --- |
| `tokens.ts` | base64url, Resource ID and Object ID validators over `@openlfcp/core`, and the object type check (§8–§10) |
| `object-ref.ts` | `lfcp1:<resource>#<type>:<object-id>` parsing and formatting (§7) |
| `comments.ts` | recognizing `lfcp-ref` comments on a line (§6) |
| `lines.ts` | physical lines with their line endings |
| `scanner.ts` | `scanRefs`: projections, Task states and diagnostics (§11–§17, §25–§27) |
| `serializer.ts` | `attachRef`, `detachRef`, `replaceTaskText`, `emitUnit` (§12, §18–§21, §28) |

## Output contract

- `scanRefs(markdown)` takes text only. A binding never depends on a file
  name, path or server (§23, §24): renaming or moving a file cannot change
  it.
- Lines are 0-based. Every range has `start`/`end`, UTF-16 offsets within
  the line's text (JavaScript string indices, line ending excluded), and
  `offsetStart`/`offsetEnd`, UTF-16 offsets in the whole input. CRLF, LF and
  CR are all line endings; each belongs to the line it ends and never lies
  inside a range. Edits keep every line ending as it was.
- Every recognized Task has a `binding`:
  - `local`: no ref. Local-only; it must never produce Shared Object
    mutations (§17).
  - `bound`: exactly one valid ref; a `MarkdownProjectionRef` describes it.
  - `blocked`: a ref that is duplicated, malformed, misplaced or of an
    unsupported type. Neither shared nor local: nothing may act on it until
    the Markdown is repaired.
- A projection is the same `(resourceId, objectType, objectId)` binding in
  either placement (§2), plus its placement metadata (`inline` | `child`),
  the exact comment text and range, `rawRef` (the object reference as
  written), `canonical` (spacing), `taskText` (the Task's semantic text,
  without the inline comment) and `parts`, from which `emitUnit` re-emits
  the projection unit byte for byte in its original placement (§19).
- Diagnostics: the §27 codes `MALFORMED_LFCP_REF`, `DUPLICATE_LFCP_REF`,
  `ORPHAN_LFCP_REF`, `OBJECT_TYPE_UNSUPPORTED`, `OBJECT_ID_INVALID`,
  `RESOURCE_ID_INVALID`, and `OBJECT_TYPE_MISMATCH` (from
  `checkObjectType`, since it needs the Shared Object), plus two editor
  codes: `LFCP_REF_NOT_AT_LINE_END`, `LFCP_REF_UNSUPPORTED_CONTEXT`.

## Readings MR-A1 to MR-A4 (normative since baseline.5)

These began as provisional readings of baseline.3 and are the specification's
text since `mvp-0.1-baseline.5` (§6, §9, §13.2, §14, §16; acceptance cases
18–21).

- **MR-A1** (§9, §15): an object type token is `task` or a reverse-domain
  name per SHARED-OBJECTS-PROFILE-01 §18. Anything else is
  `MALFORMED_LFCP_REF`. A well-formed type other than `task` is parsed but
  not projected: `OBJECT_TYPE_UNSUPPORTED`, Task blocked.
- **MR-A2** (§6): the comment is `<!--` + spaces/tabs + `lfcp-ref:` +
  spaces/tabs + the object reference + spaces/tabs + `-->`. One space at
  each separator is canonical; more is accepted (`canonical: false`).
  Anything else, such as `<!--lfcp-ref:`, `lfcp-ref :` or no space after the
  colon, is `MALFORMED_LFCP_REF`. A comment is *recognized* as an
  `lfcp-ref` comment when its content contains `lfcp-ref:` (§6) or starts
  with `lfcp-ref` after spaces or tabs (so `lfcp-ref :` is reported, not
  ignored).
- **MR-A3** (§13.2, §14): the unbroken run of ref-only lines directly under
  a Task is that Task's unit. Two or more refs in a unit (child, inline, or
  both) are `DUPLICATE_LFCP_REF`; a ref separated from the Task by any other
  line or a blank line is `ORPHAN_LFCP_REF`.
- **MR-A4** (§14, §15): in a duplicate, every ref is `DUPLICATE_LFCP_REF`
  and a malformed one also gets its own code; nothing is bound.

## Adapter choices (where the specification defers to the adapter)

- **Task lines** (§5): optional leading whitespace, a list marker (`-`, `*`,
  `+`, or 1–9 digits followed by `.` or `)`), whitespace, a checkbox with
  any single character (`[ ]`, `[x]`, `[/]`, `[-]`, `[>]`, …: Obsidian's
  custom statuses), then whitespace or the end of the line.
- **Blockquotes**: Tasks inside blockquotes are not recognized in v0.1. A
  ref on a blockquote line is `LFCP_REF_UNSUPPORTED_CONTEXT`, so the user
  sees why it is not bound.
- **Child indentation** (§12, §13.2 rule 4; CommonMark): a ref line is a
  compatible child when its indentation is at least the Task's content
  column (the column of `[`) and less than that column + 4. Tabs advance to
  the next multiple of 4. Less indentation, or 4 or more columns beyond the
  content column (a paragraph continuation in CommonMark, not a ref line),
  makes the ref an orphan. The serializer indents a new child line to the
  content column, reusing the Task's own leading whitespace.
- **Inline placement** (§11, §13.1 rule 4): the comment must be the last
  non-whitespace element of the Task line. Text after it (`--> 📅 …`,
  `--> ^blockid`) gives `LFCP_REF_NOT_AT_LINE_END`; nothing is recovered and
  the Task is blocked. The Task's semantic text ends at the first `lfcp-ref`
  comment.
- **Literal contexts** (§13, §25): fenced code (``` and ~~~, closed by the
  same character at least as long; an unterminated fence runs to the end of
  the text), YAML front matter, inline code spans, Obsidian comments
  (`%% … %%` on one line and across lines), multi-line HTML comments, and
  top-level indented code (4+ columns after a blank line, outside a list).
  Refs there are ignored without diagnostics.
- **Spec examples**: the `md` examples of MARKDOWN-REFS-01 are golden
  fixtures `mr-*` verbatim. Their placeholders (`AAA`, `RESOURCE`, `...`)
  are invalid tokens, so they show the structure plus `RESOURCE_ID_INVALID`.
  The §12 nested example begins with four spaces and no parent item, so on
  its own CommonMark reads it as an indented code block; under a parent item
  it binds (fixture `nested-child`).
