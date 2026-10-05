# Markdown → Shared Object projection (LFCP-061)

How an edit to a bound Markdown Task becomes Shared Objects intents
(`src/core/projection`). Local Tasks, without an `lfcp-ref`, never produce
anything. Raw lines are never synchronized: the plugin compares what the
line represents with the current Shared Object and sends only the intents
for owned fields that changed, through the SDK. The path is intent, then
Automerge change, then a queued Data Unit.

## Checkbox glyphs (ST-1)

| Glyph | Status |
| --- | --- |
| `[ ]` | `todo` (`task.reopen`) |
| `[x]`, `[X]` | `done` (`task.complete`) |
| `[/]` | `in_progress` |
| `[-]` | `cancelled` (`task.cancel`) |
| anything else | not owned: no status intent, the shared status is untouched |

An extension status (`x/<domain>/<value>`) is not owned either.

## Fields

The title is the Task text without the `^block-id`, the suffix metadata
and the ref (item 6). Trailing `#tags` stay in the title in 061: the
Markdown cannot tell a tag meant as metadata from one in the prose. They
are not synced as the `tags` set.

| Markdown | Field | Notes |
| --- | --- | --- |
| `📅 YYYY-MM-DD` | `due` | removed → `task.clear_due` |
| `⏳ YYYY-MM-DD` | `scheduled` | removed → `task.clear_scheduled` |
| `✅ YYYY-MM-DD` | `completion_date` | only on a done Task (ST-5); with `[x]`, sent as `task.complete` with the date |
| `🔺 ⏫ 🔽 ⏬` | `priority` | highest, high, low, lowest; none → normal |
| `🔼` | not owned | Obsidian Tasks "medium" has no profile value |
| `🔁 rule` | not synced | warning (ST-5) |
| `🛫`, `➕`, `❌` dates | not owned | kept local |

Wikilinks in a shared title are sent as written, with a warning that the
note names become visible to collaborators (ST-4).

## Rules

- **Conflicts** (item 8): a conflicted field gets no intent, even when the
  Markdown equals its visible value or holds a new value. Only an explicit
  `resolve_field_conflict` resolves it.
- **Invalid objects** (item 10): an object that is not a valid live Task
  (PROFILE_INVALID, an Object ID collision, deleted) gets no intents, with a
  diagnostic.
- **Copies in one note**: projections of one object are one decision. Copies
  edited differently send nothing.
- **Moves and renames** change nothing shared. A lost ref is a local
  detachment: the object is untouched.
- **Re-association** (ST-2): if a child ref's new owner line differs from the
  shared title while the local Task just above matches it, nothing is sent.
  The plugin offers the command *Repair moved shared task ref*, which moves
  the ref back.
- **Echo guard** (item 9): before writing a note, a projection writer
  (LFCP-062, LFCP-064) calls `guard.expect(path, content)`. The vault's
  report of exactly that content (path + SHA-256) is skipped. No time window
  is involved.

Fixtures: `test/fixtures/projection/cases.json` (portable, LF and CRLF).
