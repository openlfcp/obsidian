# Obsidian host facts (evidence for LFCP-02-005)

These are facts about Obsidian itself that the MVP 0.2 designs depend on,
observed in real Obsidian builds through the
[native harness](native-harness.md). Facts with an automated check are
asserted in `test/native/specs/host-facts.e2e.mjs`, so an Obsidian release
that changes one of them fails there first.

| # | Fact | Observed on | How | Consequence |
| --- | --- | --- | --- | --- |
| H1 | Obsidian 1.13.1 (the manifest's `minAppVersion`) was an Insider-only beta. The first public 1.13 build is 1.13.4, the latest public build is 1.14.4 | obsidian-launcher's version list, 2026-10-08 | `obsidian-versions.json` in the harness cache: `isBeta: true` for 1.13.0–1.13.3 | The harness tests 1.13.4 and 1.14.4. Whether to raise `minAppVersion` is the owner's decision |
| H2 | "Indent using tabs" is on by default: `app.vault.getConfig("useTab") === true` in a new vault | 1.13.4, 1.14.4, macOS | asserted (`host-facts`) | Nested lists typed with Tab use tabs. The section grammar must accept tabs (decision M2) |
| H3 | In Live Preview, an HTML comment on its own line or at the end of a Task line stays visible as source text when the cursor is elsewhere | 1.13.4, 1.14.4, macOS | asserted (`host-facts`): both `lfcp-ref` lines render with their text | Hiding per-node markers in Live Preview (decision M5) is the plugin's work (editor decorations); Obsidian does not do it |
| H4 | Dragging a heading in the Outline view moves the heading with every line down to the next heading of the same or a higher level. A comment line right **above** a heading belongs to the previous heading's lines and stays behind | 1.13.4, 1.14.4, macOS | asserted (`host-facts`), drag by DOM drag events in the Outline. With the marker above `## Shared`, dragging `## Other` above `## Shared` left the start marker in place: the private `## Other` section ended up between the section markers. With the marker right below `## Shared`, it moved with its heading and the region stayed intact | Confirms decision M4 (start marker right after the heading). The parser must still fail closed when a heading moves away from its marker |
| H5 | Folding a heading hides every line down to the next heading of the same or a higher level, including an end marker and any private text after it | 1.13.4, 1.14.4, macOS | asserted (`host-facts`): folding `## Shared` folds lines 4–10, "Private tail." included | Obsidian's heading model does not know the section boundary: private text after the end marker folds, drags and embeds (`![[note#Shared]]`) with the shared heading. Share and insert should warn about private text between the end marker and the next heading (review finding OP-05) |
| H6 | The Obsidian Tasks plugin 8.4.0, toggling a Task done, appends `✅ <date>` at the end of the line, **after an inline `lfcp-ref` comment**. A child-line ref is untouched. A recurring Task gets its next occurrence on a new line **above**, unbound; the child-line ref stays with the done one. Its edits carry no `userEvent` | 1.14.4, macOS | asserted (`tasks-plugin`) | An inline ref is then not last on the line (`LFCP_REF_NOT_AT_LINE_END` in 0.1): **decision M1 (inline refs inside sections) conflicts with Tasks**. Child-line placement is what keeps Tasks working; this is why 0.1 chose it |
| H7 | Reading view does not render HTML comments: a section's markers and refs leave no text there | 1.13.4, 1.14.4, macOS | asserted (`marker-hiding`) | Hiding markers (M5) is needed in Live Preview only; see [../reports/marker-hiding-spike.md](../reports/marker-hiding-spike.md) |

## 0.3 baselines

`test/native/specs/baseline-0.3.e2e.mjs`, plugin 0.3.1 code (obsidian
`771f298`), Apple M3 Pro, 18 GB, macOS 26.5.2. The collaboration is local
only (an unreachable server), so these are device costs: SDK commits,
Markdown work and vault writes, no network. Two runs each on Obsidian
1.13.4 and 1.14.4 agreed within 5%. These numbers are a baseline, not
budgets (budgets belong to LFCP-02-067).

| Metric | What is measured | Result |
| --- | --- | --- |
| Plugin start | `enablePlugin` → `onload` returned / runtime ready | 54–74 ms / 63–77 ms |
| Share selected tasks, 200 Tasks | Enter in the collaboration picker → 200 refs in the note | 2.1–2.3 s (≈ 11 ms per Task: one SDK commit, i.e. one queued Data Unit, per Task); 201 units queued |
| Share settle | then until the plugin has processed its own write (300 ms change debounce + one pass over 200 Tasks) | ≈ 445 ms |
| Edit → queued | a title edited in the open note and saved → its unit queued | ≈ 330 ms (300 ms of it is the change debounce) |
| Change → render | a shared change (as a remote one would arrive) → the 200-Task note rewritten | ≈ 240 ms, nothing sent back |

### Found while measuring: a pass without bases can revert a concurrent change

The first version of the baseline renamed a Task about 300 ms after the
share. The plugin then sent the old title back: the peer's change was
reverted. The cause, reproduced:

1. The share writes the refs with `vault.process`. The resulting vault
   change waits in the 300 ms change debounce.
2. An edit and save within that window joins the same change batch. The
   pass sees content that is not the guarded echo, so it processes the note
   with **no bases** for the 200 new projections ("first sight": the
   Markdown is the user's intent).
3. That pass reads the note once, but reads each Task's shared state while
   it goes. A change that lands mid-pass, for a Task later in the note,
   differs from the Markdown snapshot, and with no base it is "the user's
   edit": `task.set_title` back to the old value.

The window is small (a pass over 200 Tasks takes about 100 ms), but any
pass without bases is exposed: right after sharing or inserting, after a
base store is lost, and after G-EP5 forgets bases.

**Fixed in 0.3.2.** A pass compares the Markdown with a snapshot of the
shared state taken with the read, and commands record their bases as soon
as they write ([../../architecture/projection.md](../../architecture/projection.md)).
Regression tests: `test/core/projection/writer.test.ts` (the race,
deterministic) and `test/native/specs/projection-race.e2e.mjs` (the
original scenario in a real Obsidian).

The ADR 0001 spikes (transactions, undo grouping, several views, external
writes, cost, Live Preview) are recorded in the ADR's evidence table:
[../../architecture/decisions/0001-codemirror-transactions-for-sections.md](../../architecture/decisions/0001-codemirror-transactions-for-sections.md).

Still to establish (LFCP-02-005): IME composition in an open note, by hand
([ime-checklist.md](ime-checklist.md)).
