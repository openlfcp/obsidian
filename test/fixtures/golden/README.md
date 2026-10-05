# Golden projection fixtures (LFCP-063)

Each directory is one case: Markdown notes before, one event, and the exact
notes after, plus the Shared Objects intents and diagnostics expected. The
format uses no Obsidian concepts and no implementation types, so another
editor client (e.g. VS Code) can run the same cases.

## A case

```text
<case>/
  case.json            the Shared Tasks, the event, the expectations
  before/<note>.md     every note before the event
  edit/<note>.md       for "edit" events: the note as the user saved it
  after/<note>.md      the note expected after the event (optional)
```

Notes are compared byte for byte. A note with no `after/` file is expected
to keep its content: its `edit/` version for an edited note, else its
`before/` version. After the event, the set of notes must be exactly those
listed in `before/`, with the moved note renamed for a `move` event.

In every Markdown file, `{{X}}` stands for the object reference of the Shared
Task with alias `X`: `lfcp1:<resource>#task:<object id>`. The resource is
the runner's own Resource; the object ID is the one in `case.json`.

### case.json

```jsonc
{
  "description": "what the case shows",
  // The Shared Tasks before the event (Shared Objects field values, §30).
  "objects": {
    "A": { "id": "<UUIDv7>", "title": "…", "status": "todo", "due": "YYYY-MM-DD",
           "scheduled": "…", "priority": "high", "tags": ["web"],
           "completion_date": "…" }
  },
  "event": { … },                 // see below
  "expect": {
    // Intents sent, in order. Each lists the object alias, the intent name
    // and the intent fields that must match. Omitted: not checked.
    "intents": [ { "object": "A", "intent": "task.complete" } ],
    // Diagnostic codes that must be reported for a note (others may be too).
    "diagnostics": [ { "file": "note.md", "code": "OBJECT_DELETED" } ],
    // Conflicted fields surfaced for a note (never written into it).
    "conflicts": [ { "file": "note.md", "object": "A", "fields": ["status"] } ]
  },
  // When the visible value of a conflict is engine-defined: any of these
  // contents is accepted for the note.
  "alternatives": { "note.md": ["…", "…"] }
}
```

### Events

| `type` | Fields | Meaning |
| --- | --- | --- |
| `remote` | `set: { alias: { field: value } }`, `delete: [alias]` | The Shared Tasks change elsewhere (status, title, due, scheduled, priority, tags, completion_date; `null` clears a date). Unchanged values are still written (G-SC4). |
| `edit` | `file` | The user saves `edit/<file>`. |
| `move` | `from`, `to` | The note is renamed. |
| `concurrent` | `object`, `local`, `remote` | Two concurrent changes of the same Task, one from this client and one from another. |
| `withdraw` | `object`, `applied` | `applied` was changed by this client and is shown in `before/`; a Key Epoch cutoff then withdraws it (G-EP7). |

Any event may carry `then`: a second event applied afterwards.

## Running

The runner first syncs every `before/` note, which must already match the
objects (no writes, no intents). It then applies the event and compares.
Afterwards a second sync of every note must be a no-op (idempotency).

Every case runs twice: as written (LF), and with every line ending, in every
Markdown file, turned into CRLF. On a mismatch the runner prints the case,
the event and a unified diff of the note.

The Obsidian runner is `test/core/projection/golden.test.ts`.
