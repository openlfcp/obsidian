# Markdown ↔ Shared Object projection (LFCP-061, LFCP-062)

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

The title is the Task text without the `^block-id`, the suffix metadata,
the tag run and the ref (item 6).

Tags follow ruling (a), in force since LFCP-062:
- The trailing contiguous run of valid Obsidian tags is the Task's `tags`
  set. `#123` is not a tag.
- A `#tag` inside the text stays title text.
- Shared tags that are not Obsidian tags are never removed from Markdown
  and are not rendered.
- A Task shared under LFCP-061 whose shared title still ends with the run
  is migrated (title without the run, the run as tags) only together with a
  real user edit (`LEGACY_TAGS_MIGRATED`).

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

## Three-way comparison

The plugin keeps a base for every bound Task: what the note showed at its
last sync. Bases are persisted in the install database, never in the vault.

- A field is a user edit, and becomes an intent, only when the Markdown
  differs from the base.
- Every other field is rendered from the shared state. A stale note (one
  closed before a remote change arrived) therefore never sends old values
  back.
- With no base (first sight of a projection), the Markdown is the user's
  intent.

## Shared Object → Markdown (LFCP-062)

`ProjectionWriter` handles one note at a time and serializes all work:

1. It sends the note's own edits first.
2. It renders every bound Task from the current shared state
   (`renderNote`).

A note is written only when the render changes it, through
`guard.expect(path, content)` and `vault.process`. Re-rendering a current
note writes nothing.

- **Rewritten:** the glyph (owned statuses), the title, the sorted tag run,
  the owned priority emoji (🔼 is never written), 📅, ⏳ and exactly one ✅
  on a done Task (removed when it leaves done). A piece that already matches
  keeps its bytes; a new one goes where Obsidian Tasks puts it.
- **Kept:** the ref comment byte for byte, the placement, child lines, the
  `^block-id`, unowned tokens (🛫 ➕ ❌ 🔼 🔁), indentation, surrounding
  text, local Tasks (their ✅ too) and line endings.
- **Not rewritten:** deleted, PROFILE_INVALID or collided objects, objects
  of Resources not on this device, and a ref that slid under another Task
  (ST-2). Each gets a diagnostic.
- **G-EP7:** a rebuild can show older values again (done back to todo). The
  render projects it faithfully through the guard and reports
  `STATE_REGRESSED` once.
- **Conflicts:** the visible value is rendered, and concurrent values in
  lifecycle, title, status, dates or priority are surfaced in the status bar
  (count), as an editor line decoration (`.openlfcp-conflict`, with a
  tooltip) and in a notice. Nothing is ever written into the text.
- **Unsaved editor (item 6):** a note open in an editor whose buffer differs
  from the file is not written. The render is deferred to its next save, the
  vault change that then follows. If the file changes between the writer's
  read and its write, the write is abandoned the same way. Deferring was
  chosen over editor transactions: it works the same for every note,
  whether or not it is open, and never races the user's typing.
- **Startup:** notes containing refs are synced one by one, field by field.
  Notes without refs are not read further.

The new projection unit for "Insert shared object" (LFCP-065) comes from
`renderNewTaskLine`.
