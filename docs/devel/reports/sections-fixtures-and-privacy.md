# Markdown fixtures and extraction privacy (LFCP-02-047)

The evidence of LFCP-02-047: the published Markdown corpus run through the
plugin's own code, and what a section shares checked in plaintext, before
encryption. Written 2026-10-09; spec `mvp-0.2-baseline.1` (`96e21d6`),
sdk-ts at `sdk-ts.lock`.

## The product adapter

`test/support/sections-fixtures.ts` is the adapter that the spec's verifier
imports (`verify-markdown.mjs --adapter`): `runFixture(input)` returns
`after_files`, `diagnostics`, `intents` and `publication`, and the
verifier compares them with the fixture by deep equality. Only the
fixture's inputs reach it (`before_files`, `event`, `projection_base`); the
expected outputs are never read.

It runs the production code: the section parser, the engine (bases,
journal, local batches, bindings, remote projection, structure), the
editor rules (`keepRefWithTask`, `classifyRemoval`, `detachSection`,
`readableSection`, `sectionContext`) and the 0.1 Task planner and renderer.
The model is the fake SDK port seeded from the fixture's before file, with
a real Shared Objects replica for Task fields (`planShare` over the before
lines); the real SDK's acceptance of the same batches is
`test/core/sections/sdk-snapshot.test.ts` and
`test/core/lfcp/section-port.test.ts`.

| Run | Command | Result |
| --- | --- | --- |
| Our test, in the gate | `pnpm test` (`test/core/sections/fixtures.test.ts`) | 48/48 |
| The spec's verifier | `node scripts/run-sections-fixtures.mjs <spec at spec.lock>` | `{"passed":48,"adapter_executed":true}` |

Translating to the fixtures' intent form: `type`, `id`, `parent_id` (the
section ID at the root), `title` and `due` of a new Task, `text` of a new
block, `completion_date`, and `before` naming an existing node the new one
precedes. Diagnostics are those of the note as the adapter leaves it, plus
the engine's (`NODE_BINDING_LOST`, `PROJECTION_BASE_UNKNOWN`, model
problems); inside a section a section diagnostic on a line restates the
0.1 one there (`NODE_BINDING_LOST` for an orphaned Task ref, not
`ORPHAN_LFCP_REF`).

## What the corpus changed in the code

| Fixture | Change |
| --- | --- |
| MS17-transient | A Task ref left without its Task is `NODE_BINDING_LOST` (was `NODE_BINDING_ORPHAN`) |
| MS18, MS21 | A lost binding suspends the section's publication, other edits included (a lost Task's children no longer "move" to the root) |
| MS10-delete, MS21 | A node is deleted only when its every line was removed, in the editor too (`removedWithEveryLine`); removing only its ref or marker is `NODE_BINDING_LOST` |
| MS27, MS28 | Enter after a Task with a child-line ref goes past the Task's subtree, in the same transaction (one undo step); host fact H9: Obsidian's list Enter replaces the line's last character |
| MS39 | Under `section_comments: shared`, a comment new since the base gets a raw marker and is published; comments kept local before stay local (§4.5) |

## Privacy: the shared plaintext

For every fixture the adapter also returns its payload: every string of the
batches committed to the SDK, the model, and the shared Task objects. The
test checks, before any encryption:

- the private canaries (`PRIVATE_BEFORE_8f3a…`, `PRIVATE_AFTER_71c2…`) and
  `payload_excludes` never appear, including a local comment's text (MS38,
  MS40) and the private text before and after the section (MS01, MS24);
- `payload_contains` appears (the section's own text, a raw block, a shared
  comment, MS16, MS24, MS31, MS33, MS39–MS41);
- Tasks-local fields are not in the shared Task (MS35: priority sign,
  created, start; MS43: recurrence);
- no shared deletion where none is allowed (MS18, MS26), the 0.1 detach
  command is refused inside a section (MS37), and the readable copy is the
  section without bindings (MS25).

The two-Resource canary case of the required checks is covered by
`test/core/sections/projections.test.ts` (a standalone ref to a section's
Task in another note shares nothing) and the 0.3 private-text tests of the
legacy engine; no fixture has two Resources.

## Not covered here

- MS15's rich clipboard (the rendered DOM without its decorations) is a
  native check; the adapter gives the selection's source text only.
- MS36's share preview warning: the share-a-section flow does not exist yet.
- Ciphertext scans are not evidence here (AC3): the check is on plaintext.
