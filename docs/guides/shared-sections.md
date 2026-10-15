# Shared sections

A **shared section** is a whole part of a note: a heading and everything
under it, down to the next heading of the same or a higher level. That
includes tasks, subtasks, paragraphs and list items. Alice and Bob each
keep the section in their own note, and both can edit it. Whatever either
of them adds inside it is shared too.

This differs from sharing tasks one by one (the
[step-by-step guide](user-guide.md)):

- A shared section keeps its order, its nesting and the text around the
  tasks.
- Everything inside it is shared, including what you add later.
- Each section has its own collaboration, with its own key. The server
  stores it encrypted and cannot read it.

> **New in 0.4.** Shared sections are on in Shared Tasks 0.4 and its
> betas. Keep your vault: it holds the full data of every collaboration.

Every command below runs from the command palette (`Ctrl/Cmd + P`), where
its name starts with "Shared Tasks:". Do the set-up of the
[step-by-step guide](user-guide.md) (Part 1) first.

## 1. Before you start

The section commands are in the palette: "Share section…", "Insert shared
section…" and the others below. (Version 0.3's `"sectionsPreview"` setting
is no longer used. To turn shared sections off, add
`"sectionsDisabled": true` to `.obsidian/plugins/shared-tasks/data.json`
while Obsidian is closed.)

A section is created on the **Default server** (Settings → Shared Tasks).
With no default server, sharing is refused: "set a default sync server in
the settings to share a section."

## 2. Alice shares a section

1. Put the cursor on a heading, or anywhere under it, for example
   `## Launch plan`.
2. Run **"Share section…"**. A preview opens:
   - **`Share section "Launch plan"`**, and "Everything inside this section,
     including future additions, will be shared."
   - **How much it holds:** the number of tasks, paragraphs and list
     items. A large section is sent in several parts.
   - **The exact text** that will be shared.
   - **"Stays private on this device:"** followed by any text under the
     heading that is not part of the section.
   - **"Sync server: …"**: the server the section goes to. To use another
     one, change the default server in the settings first.

   The Shared Tasks pane shows the same summary before you click, for the
   heading under the cursor or an exact selection.
3. Click **Share**. The notice says `section "Launch plan" is shared.`

Without a selection, the section runs from its heading to the next heading
of the same or a higher level. A selection that starts at the heading and
ends on whole lines, inside that heading's section, is shared exactly as
selected; the text after it under the same heading stays private. Any other
selection is refused with its reason, and "Share the whole section…" is
offered where it applies; it is never widened by itself. A smaller heading
inside it blocks sharing: "Line N is a heading inside the section. Share each part
as its own section, or end the section before it."

After sharing, the heading carries a **double tick ✓✓**. Your note also
gets small markers: a comment after the heading and at the end of the
section, and one beside each item.

- **Live Preview** hides the markers.
- **Source mode** shows them.
- **"Show or hide sharing metadata"** toggles them.

Leave the markers in place: they tell Shared Tasks which line is which item.

If the server can't be reached, the notice says the section was created on
this device and the invitation is not ready yet. Use "Resource status" →
"Host on the server now" later.

If you give up on a share that never reached the server — you cancel it, or
it is interrupted and you never host it — nothing is left behind on this
device, and you can share that section again.

Sharing old shared tasks (from step-by-step sharing) as a section opens an
import dialog instead: `Import "…" as a new shared section`. "Restore note
before section import" undoes the import in the note. The new section still
exists; to stop sharing it, remove people's access.

## 3. Alice invites Bob

1. Run **"Invite collaborator"**. Pick the section's collaboration (it is
   named after the heading), then **Read + write** or **Read**.

   You can also open the section's details and click **"Invite
   collaborator…"**, or use the Shared Tasks pane: after a share it says
   "Shared and on its sync server: ready to invite." and offers **"Invite
   collaborator…"** as its next step.

2. The invitation dialog says "The server has the invitation: the link
   works now." The link is hidden. Click **Copy link** (or **Show link**),
   then **Done**.

Send the link to Bob privately. One-time link, does not expire; whoever
opens it first joins. Treat it like a password. After **Copy link** the pane
says "Link copied": the link is not sent for you. "Ready to invite" and
"Link copied" are shown only until Obsidian restarts.

You can only invite once the section is on its server. Until then, the
dialog says "This section is still being created. Invite once it is ready."
or "This section is not on its server yet, so nobody could join it. Host it
first from "Resource status"."

## 4. Bob joins and places the section

1. Run **"Join collaboration"** and paste the link. Give the collaboration
   a name, for your eyes only.

   The progress runs through "Checking the invitation…", "Receiving the
   collaboration's key…", "Claiming access…", "Synchronizing…" and
   "Loading the shared section…". Then: `joined the shared section "…"
   (read and write). Use "Insert shared section…" to place it in a note.`

2. Open the note where the section should go and put the cursor on the
   paragraph it should follow.
3. Run **"Insert shared section…"** and pick the section. The preview says
   "These lines go into this note after the paragraph at the cursor.
   Nothing is sent." Click **Insert**.

Bob's other text in that note stays private: only the section is shared.
A reader (Read only) sees "You can read this section but not edit it:
typing in it is not applied, and edits made to the note by other means
stay on this device." Typing into a read-only section is stopped, and a
notice says so; an edit that reaches the note another way (another
plugin, a file sync tool) stays in the note, is not sent, and the
section's details count it (see "Edits not sent" below).

## 5. Work in it together

Edit the section like any other text. Check tasks, add tasks and subtasks,
write paragraphs, and move lines within it. The other side sees your
changes within seconds, and new lines appear in the right place by
themselves.

Each task keeps its hidden ref line with it when you move it:

- **Move line up / down** moves the whole task, with its ref line and its
  subtasks, past the task before or after it. At the first or last task of
  a list it does nothing.
- **Tab / Shift+Tab** on a task line indents or outdents its ref line and
  subtasks too, so the task becomes a subtask of the one above (or stops
  being one).
- **Cut and paste**: a task pasted without its line break at the start of
  another task's line is put on lines of its own. A selection made with
  the keyboard or the mouse never ends halfway through a ref line.

A task you add right after another follows it if a collaborator moved that
task at the same time.

### What the marks mean

The **double tick ✓✓** after the heading means **this section is
shared**. It stays in every state, and it turns green when the section is
current.

Sync progress shows as a separate icon next to it. When there is nothing
to report, there is no icon. Hover over the icon to read what it means;
click it, or press Enter on it, to open the section's details.

| Tooltip | What it means |
| --- | --- |
| No pending local changes; current as last checked | All sent and accepted (no icon) |
| Loading shared section | Opening, or catching up |
| Local changes are being processed | Your edit is being saved for sync |
| Saved locally; waiting to sync | Safe on this device; not sent yet |
| Sending local updates | On its way to the server |
| Local updates accepted; receiving changes | Your changes arrived; others' are coming in |
| Offline; local updates will wait | No connection; your edits are kept |
| Server confirmation unavailable | Sent, but the server could not confirm it |
| Needs your attention | Something needs a decision: open the details |
| Changes are not safely saved for sync | A change could not be saved on this device; nothing was sent for it. Keep the note open and try again |
| Shared section · read-only | You can read this section, not edit it |

The ticks follow a decision for the 0.4 design: ✓✓ means *shared* and
never "delivered", and progress has its own icon.

Lines inside a section stay quiet while all is well. A line with waiting
work shows "Local update waiting"; a line with a problem shows "Needs
attention". A folded heading shows the marks of what is folded inside it.

### When a copy differs

After each sync, your note is compared with the shared version. If a task
ends up somewhere other than where the section puts it — a different parent,
or a different place among its siblings — the ✓✓ stops turning green and the
card says **"One copy of this section differs from the shared version."**
Shared Tasks tries once more to put the task in place, which usually settles
it. A copy that must be compared before it can sync again says **"This copy
… differs from the shared version and has to be compared with it before it
syncs."**

### Section details

Run **"Open shared section details"**, or click the icon. The card shows:

- the status;
- what is shared;
- "Identities with access", as last verified with the server;
- pending invitations, which are listed separately because they are not
  access yet;
- buttons for "Review conflicts…", "Invite collaborator…", "Resource
  status" and "Open Shared Tasks pane".

### The Shared Tasks pane

Click the **Shared Tasks** icon in the left ribbon, run **"Open Shared Tasks
pane"**, or right-click in a note and choose it. The pane opens in the right
sidebar. Opening it again shows the same pane.

The pane follows the last note you worked in. It shows the shared section
under the cursor and its status, the next step for that place, and the
shared sections on this device. **"Join with a link…"** is always at the top.

The right-click menu also offers the next step for the cursor, for example
"Share section…" on a heading that is not shared yet.

**"Name…"** gives a person a local name that only you see.

### Edits not sent

Some edits cannot be sent as they are: a heading typed inside the section
(sections hold no headings), a damaged marker or task line, or an edit in
a section you can only read. Then nothing of that copy is sent until it
is put right, and Shared Tasks says so:

- a notice, once: `2 edits in "…" not sent: the section has content it
  cannot share (line 12). Open the section's details to fix it.`;
- the icon shows "Needs your attention", and the lines concerned show
  "Needs attention";
- the details say how many edits are held and why, for example `2 edits
  not sent: the section has content it cannot share (Plan.md, line 12).`,
  what to do about it, and never "No local changes waiting" or "Current as
  last checked" while an edit is held. **"Go to line …"** takes you
  there, and **"Repair shared sections in this note"** is offered when a
  repair can help.

A task you moved in a copy that is held is counted too, and named:
`… (Plan.md, line 12). Moved, not sent: “Gamma”.`

Undo the edit, or move the heading below the section's end, and the
section syncs again.

## 6. Offline

Edit as usual. The icon shows "Offline; local updates will wait", and your
edits are saved on this device. They survive a restart of Obsidian. When
you are back online, they are sent and the other side's edits come in.

Edits to different lines and fields simply merge. Edits to the same text
merge too.

## 7. Conflicts

Some changes need a choice: for example, Alice and Bob move the same task
under two different parents while offline. Then:

- The icon shows "Needs your attention" on both sides, and the line shows
  "Needs attention".
- **"Go to next shared section problem"** moves the cursor there and says
  which problem it is.
- In the details, **"Review conflicts…"** opens `Conflicts in "…"`. Each
  item asks one question, such as "This item's location needs a choice: …
  was moved to two places." or "Two changes need a choice: the … of …".
  Pick the answer and click **Apply**. There is no "fix all": each choice
  is yours.

Nothing is thrown away while a choice is open. When one side applies it,
the other side follows.

## 8. Copying

- **"Copy readable text (without sharing metadata)"** copies the selection,
  or with no selection the whole section, without any marker. Use it to
  paste the text elsewhere: "copied without sharing metadata."
- **"Copy shared section"** copies the section with its markers. Pasted into
  another note, it is another copy of the same section: "it gives nobody
  access."
- Copying text in Reading view leaves out the plugin's marks.

## 9. Remove someone's access

In the details, under "Identities with access", click **"Remove access…"**
on the person's row. The confirmation is honest about what this can do:
"Remove future access to this shared section? Copies already received
cannot be erased."

While it completes, the card says "Removing access: waiting for the server.
It is not done yet." The section gets a new key, which the removed person
never receives.

On the removed person's side, the section needs attention: "Your access to
this section was removed. Your local copy stays; new edits are kept on this
device only." Its card no longer says it is current or that it can be
edited: it says **"Not synced: the server does not accept changes from this
vault for this section,"** and lists any waiting updates as "saved on this
device, not sent: the server does not accept them." Opening a **new**
invitation to a section you were removed from does not let you back in:
**"You were removed from this section. Rejoining a section you were removed
from isn't supported yet; your local copy stays on this device."**

### Offline edits from before an access change

If you had edited a section offline, and an access change (someone being
removed, which rotates the key) happened meanwhile, your earlier edits are
sent again by themselves once the change is recorded. The card says **"N
offline edits from before an access change are being sent again. Your note
keeps them until then."**

If one of those edits can't be sent again — a task changed meanwhile, or the
server refuses it — the section needs your attention: **"N offline edits
could not be sent after an access change. Review them in 'Review conflicts…':
keep (send again) or discard. Your note keeps them until then."** In "Review
conflicts…", **Keep** sends the edit again and **Discard** drops it so your
note shows the shared version. Until you choose, your note keeps your edits.

## 10. Stop sharing a section in one note

Put the cursor in the section and run **"Detach this section"**. The
confirmation, `Detach "…" in this note`, says: "Its text stays in this note
as your own and no longer updates. The shared section, your other notes and
your collaborators are not changed."

After detaching, the markers are gone and the text is yours. The notice
says `"…" is no longer shared in this note. The shared section itself is
unchanged.`

## 11. If something goes wrong

| You see | What to do |
| --- | --- |
| *put the cursor on or under a heading to share its section.* | "Share section…" needs a heading: put the cursor on it or below it. |
| *set a default sync server in the settings to share a section.* | Set Settings → Shared Tasks → Default server. |
| *no shared section on this device yet.* | Join with an invitation link first ("Join collaboration"), then "Insert shared section…". |
| The section "has not fully arrived yet" | Wait for it to load, then insert it again. |
| A marker line was deleted or the section looks broken | Run **"Repair shared sections in this note"**. It offers places to put a lost boundary back (**Apply**), points to lines it cannot match (**Go to line**), and for a note that differs from the shared section, lets you **Share my version** or **Use the shared version**. Your own text is kept as a recovery copy on this device. "Nothing in this note needs repair." means all is well. |
| *The server refused N updates (…). The text stays in your note.* | Your text is kept. Open the details for the reason. |
| *Restart Obsidian to continue; your notes are not affected.* | Restart Obsidian. |
| *Shared Tasks: another Shared Tasks instance holds this vault's data. Close other windows on this vault, or restart Obsidian.* | This vault is open in another Obsidian window: close the other windows on it. If the message stays, restart Obsidian. Your notes are not affected; section icons show "Loading shared section" until then. |

A problem in one copy of a section, such as a damaged boundary or a line
that cannot be matched, sets that section's icon to "Needs your attention".
The details name the copy, for example "One copy of this section has a
damaged boundary or binding line." Run "Repair shared sections in this
note" in that note to fix it. Other copies keep syncing meanwhile.

## Limits

- Shared sections are **on** in Shared Tasks 0.4; there is nothing to turn
  on. To turn them off, close Obsidian, add `"sectionsDisabled": true` to
  `.obsidian/plugins/shared-tasks/data.json`, and start it again.
- A section has no fixed size limit. A large one is shared in several
  parts.
- A section starts at a heading. Sharing a selected range, a section
  without a heading, or one task out of a section into another note is not
  available yet.
- Comments you write inside a section (`%% … %%`, `<!-- … -->`) stay on
  this device by default. Settings → "Comments in shared sections" can
  share them instead.
- Removing access cannot erase copies a person already received.
- Rejoining a section you were removed from is not available yet.
- On mobile, shared sections are **read-only**: they arrive and are shown,
  and edits made there stay on the device. Sharing, inviting and removing
  access are desktop-only.
