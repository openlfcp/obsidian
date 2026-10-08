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

Still to establish (LFCP-02-005, ADR 0001 spikes S1–S6):

- dragging a heading in the Outline view, and folding, with a section start
  marker next to the heading (decision M4);
- 0.3.1 baselines: "Share selected tasks" with 200 Tasks, save-to-render
  time, plugin start;
- transactions, undo grouping, multiple views and IME for ADR 0001.
