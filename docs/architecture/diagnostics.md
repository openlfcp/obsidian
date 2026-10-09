# Diagnostics export (LFCP-02-065)

"Export diagnostics…" builds a plain-text report on this device. It is
shown in full in a preview first, and leaves the window only when the user
presses "Copy" or "Save as file" (a `.txt` file in the vault). Nothing is
sent anywhere; there is no telemetry.

## What the report holds

- Versions: the plugin, Obsidian's API, the platform.
- The runtime's state and the local encryption summary line.
- Per collaboration, numbered: its profile, registry state, session phase,
  hosting, refusal code, control sequence, data epoch, pending outbound
  count, conflict count and blocked collaborator count.
- Per shared section, numbered: its status state, condition kinds and codes
  (`rejected:INVALID_INTENT`, `source-base-unknown`, …), pending batches.
- Text kept on this device as candidates: how many, by reason.
- The last 200 safe events: SDK events (`error`, `connection`, `nack`, …)
  and the plugin's (`checkpoint-rebuilt`, `needs-restart`), each with its
  kind and code-like fields only, never a message.

## What it leaves out

Note and Task text, titles, collaboration and section names, paths, kept
candidate text, keys, invitation links and secrets, server diagnostics and
error messages. Collaborations and sections are numbered, not named.

Resource IDs, section keys and server addresses are added only when the
user ticks "Include identifiers and server addresses" in the preview.

Two layers keep it so (`src/core/diagnostics.ts`):

1. Every value goes through a code check: an UPPER_SNAKE code, a lowercase
   kind, a version or a profile ID passes; anything else prints as
   `(text)`.
2. A last pass removes anything shaped like an invitation secret, a key, a
   ref, a path and, unless detailed, an identifier or an address.

## Failure

If the report cannot be prepared, the preview says so. If copying or
saving fails, a notice says why and suggests copying the text from the
window.

## Tests

`test/core/diagnostics.test.ts` (synthetic canaries in every field) and
`test/core/diagnostics-collect.test.ts` (a real offline runtime: a canary
collaboration name, Task title, kept text and an error message with an
invitation link).
