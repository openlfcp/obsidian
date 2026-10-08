# Spike: hiding binding lines in Live Preview (LFCP-02-048)

Decision M5 puts a binding marker on every node of a shared section and
hides the markers in Live Preview by default (MARKDOWN-SECTIONS-01 §4).
Obsidian itself shows such comments as source text (host fact H3). This
spike checks the hiding mechanism before LFCP-02-048 is built. Run on
2026-10-08, Obsidian 1.13.4 and 1.14.4, macOS, with the test-only plugin
`test/native/plugins/marker-spike` and `test/native/specs/marker-hiding.e2e.mjs`.
Nothing is registered in Shared Tasks.

## The mechanism tried

A `StateField` registered with `registerEditorExtension`. In Live Preview
(`editorLivePreviewField`) it puts a block `Decoration.replace` on every line
that is only an LFCP binding comment (`lfcp-section`, `/lfcp-section`,
`lfcp-node`, a child-line `lfcp-ref`). It rebuilds when the document, the
selection or the mode changes. A line touched by the selection is shown,
and a `StateEffect` ("show metadata") shows them all. Block replace
decorations that remove whole lines must come from a state field, not a
view plugin (CodeMirror's rule); this one does.

## Results (asserted)

| # | Check | Result |
| --- | --- | --- |
| 1 | Away from the selection | All 5 binding lines hidden in Live Preview |
| 1 | Selection on a binding line | That line shown (1), the others stay hidden |
| 1 | "Show metadata" on | All 5 shown |
| 1 | Source mode | All 5 shown: hiding applies to Live Preview only (§4: raw source always shows them) |
| 2 | Enter at the end of a Task whose ref is hidden | The new Task line lands between the Task and its ref, exactly as without hiding: hiding neither causes nor fixes MS19–MS21; the editor-transaction work of ADR 0001 is still needed |
| 2 | Undo of that edit | The note is back byte for byte |
| 2 | ArrowDown from a Task line | The caret skips the hidden ref and paragraph marker and lands on the paragraph's text |
| 2 | Checkbox click in Live Preview | Toggles the Task (`[x]`); markers untouched |
| 2 | Fold the section heading | Folds as usual (lines 2–12) |
| 2 | Drag a heading in the Outline | Works; the section's markers move with their heading (M4) |
| 3 | Reading view | No binding text at all, **without** a post-processor: Obsidian does not render HTML comments in Reading view (host fact H7) |
| 4 | Cost, 804-line note (200 Tasks, refs, paragraphs), typing 40 characters and 20 caret moves | 58 rebuilds, ~0.15 ms each (whole-document scan); no visible delay |

## Recommendation for LFCP-02-048

1. **Use this mechanism.** A state field with block replace decorations,
   Live Preview only, public API only (`registerEditorExtension`,
   `editorLivePreviewField`). A whole-document rebuild per transaction is
   affordable at W200 (0.15 ms). Make it incremental only if the budgets
   of LFCP-02-067 ask for it.
2. **"Show sharing metadata" must exist** as a command and as a setting
   (declarative settings), because the caret never reaches a hidden line by
   arrow keys: ArrowDown skips it. Reveal-on-selection then covers clicks,
   search results and the plugin's own "Show boundary" action.
3. **Reading view needs no hiding code.** A post-processor is still needed
   later for badges and the card, not for markers.
4. **Hidden markers must not hide the boundary** (§4, §6): the boundary
   decoration (a gutter or line class on the section's lines) comes with
   the same field, so the section's extent stays visible when its markers
   are not.
5. **Hiding does not solve Enter.** The child-line ref split (MS19–MS21) is
   handled in the editor transaction (ADR 0001), whether or not the ref is
   visible.
6. **Still to check** in LFCP-02-063: copying a selection that spans hidden
   lines. Native copy includes the bindings (§10, allowed); the readable
   copy action strips them.
