# Manual check: IME input in a shared note (ADR 0001)

WebDriver cannot drive an input method editor, so the native harness does
not cover composition. ADR 0001 is accepted on the condition that this check
passes by hand **before the first 0.4 beta** (LFCP-02-069). Whoever runs it
records the result in the table at the end.

## Setup

- macOS with Obsidian 1.13.4 or later. The built plugin with sections (0.4
  beta candidate) is installed in a **test vault**, never the everyday one.
- Two input sources enabled in System Settings → Keyboard → Input Sources:
  Japanese (Romaji) and Pinyin – Simplified. On Windows, use Microsoft IME
  for Japanese.
- A shared section with a few Tasks, an item and a paragraph, synced with a
  second vault, and the native harness's spike plugin **not** installed.

## Steps

For each input source:

| # | Do | Expect |
| --- | --- | --- |
| 1 | In a paragraph inside the section, start composing (type `nihon` / `zhongguo`), but do not confirm | No node marker or ref appears while the composition is open; the status shows a local edit, not success |
| 2 | Confirm the composition (Enter or Space) | The text appears once in the other vault; no duplicate, no half-composed Latin letters |
| 3 | Start a new Task line (`- [ ] `) and type the title with the IME, confirm | One new Task in the other vault, with the composed title; exactly one ref on the line |
| 4 | Compose, then cancel with Escape | Nothing is sent; the note is as before |
| 5 | Compose inside a Task title while the other vault edits the same Task's date | Both changes arrive; the composition is not interrupted or moved |
| 6 | Undo once after step 3 | The new Task and its ref disappear together |

## Record

| Date | OS / Obsidian | Plugin build | Input sources | Result | By |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
