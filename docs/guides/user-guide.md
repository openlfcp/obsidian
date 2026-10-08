# Shared Tasks: step-by-step guide

This guide sets up Shared Tasks and walks through everyday use. It follows
two people: **Alice**, who shares tasks, and **Bob**, who joins. Each has
their own vault on their own computer. You can be either one.

Every command below runs from the command palette (`Ctrl/Cmd + P`). In the
palette its name starts with "Shared Tasks:".

## Part 1 · Set up (both people, once)

### 1. Check your Obsidian version

Shared Tasks needs Obsidian **1.13.4 or later**. Check it in Settings →
About. Update Obsidian first if it is older.

### 2. Install the plugin

1. Settings → Community plugins. If "Restricted mode" is on, turn it off.
2. Click "Browse" and search for **Shared Tasks**.
3. Click **Install**, then **Enable**.

Obsidian updates the plugin like any other community plugin. To try
pre-release builds with BRAT, or to install by hand, see the
[README](../../README.md#install).

### 3. Check that it is ready

Open Settings → Shared Tasks. "Identity on this device" should say
**Ready**.

This vault now has its own identity: a key pair that stays on this
computer. There is no account, sign-up or password.

The other settings can stay as they are:

| Setting | What it does | Default |
| --- | --- | --- |
| Ref placement | Where the small link marker of a shared task goes: on the line under the task, or at the end of the task line | Child line (recommended) |
| Default server | The sync server offered when you create a collaboration | `wss://sync.openlfcp.org/v1/ws`, the free public beta server |

Before you use the public server, read its
[privacy note](https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-privacy.md)
and [terms](https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-terms.md).
To run your own server instead, see
[Choosing a sync server](choosing-a-server.md).

## Part 2 · Share your first task

### 4. Alice creates a collaboration

A **collaboration** is a group of shared tasks and the people who can see
them. Make one per project or per person you work with.

1. Run **"Create collaboration"**.
2. Type a name, for example `Launch`. Only you see this name.
3. Keep the suggested server and confirm.

You see *"Launch" created and hosted. You own it.*

The server cannot be changed later, so choose it now.

### 5. Alice shares a task

1. Open any note with a task, for example:

   ```md
   - [ ] Prepare API contract 📅 2026-10-20
   ```

2. Put the cursor on that line.
3. Run **"Share task under cursor"** and pick `Launch`.

You see *task shared*. The task line itself does not change. A small
marker appears under it:

```md
- [ ] Prepare API contract 📅 2026-10-20
  <!-- lfcp-ref: lfcp1:…#task:… -->
```

The marker links the line to the shared task. Reading view hides it.
Leave it in place, and the line keeps syncing. The rest of the note stays
private and never leaves your computer.

### 6. Alice invites Bob

1. Run **"Invite collaborator"** and pick `Launch`.
2. Choose the access:
   - **Read + write**: Bob can see and change the tasks.
   - **Read**: Bob can only see them.
3. Click **"Copy link"**.
4. Send the link to Bob privately, for example in a direct message.

> **The link is a secret, like a password.** It works **once**. Whoever
> uses it first joins the collaboration. Don't post it in public channels.
> To invite a second person, make a second link.

### 7. Bob joins

On Bob's computer, after Part 1:

1. Run **"Join collaboration"**.
2. Paste the link. The field hides it, like a password field.
3. Give the collaboration a local name, for example `Alice's launch`.

Progress goes from *connecting* to *synchronizing*. Then Bob sees
*joined "Alice's launch" (read and write)*.

### 8. Bob places the task in his note

Joining does not change Bob's notes. He chooses where shared tasks
appear:

1. Open any note and put the cursor on an empty line.
2. Run **"Insert shared object"**, pick the collaboration, then the task.

The task appears with its own marker. Bob's note can look completely
different from Alice's. Only this line is shared.

### 9. Work as usual

Either of you can now edit the line like any other task:

- tick it (`- [x]`). The other note shows it done, with its `✅` date;
- rename it;
- change its dates (`📅` due, `⏳` scheduled), priority or tags.

Changes appear in the other note within seconds while both of you are
online.

## Part 3 · Many tasks at once

### Share a whole list or section

1. Do one of these:
   - **select** the task lines you want to share; or
   - **put the cursor under a heading** (`## Sprint`). This takes every
     task under that heading, down to the next heading of the same or a
     higher level.
2. Run **"Share selected tasks"** and pick the collaboration once.

One notice says how many tasks were shared. Each task is shared on its
own. Tasks that are already shared are skipped.

### Insert everything on the other side

1. Bob opens a note and puts the cursor where the tasks should go.
2. He runs **"Insert all tasks from collaboration"** and picks it.

Every task that the note does not show yet is inserted, in the order the
tasks were created.

Good to know:

- Everyone in a collaboration sees **every** task in it, including tasks
  added later. For tasks that belong to different people, make separate
  collaborations.
- Each command handles at most 200 tasks.
- Only the tasks are shared, not the section. The heading, the order of
  lines and indentation stay local. If Alice adds a task to her section
  later, she shares it and Bob inserts it, the same way as before.

## Part 4 · Everyday situations

### Working offline

Edit shared tasks offline as usual. Changes wait on your computer and
sync when you are back online. Edits to different fields merge: if Alice
renames a task while Bob moves its date, both changes arrive.

### The same field changed on both sides (a conflict)

Suppose Alice marks a task in progress (`[/]`) while Bob, offline, cancels
it (`[-]`). Nothing is lost:

- the note shows one of the two values;
- the status bar says *1 shared task has a conflict*, and the task line is
  marked.

To choose the value, put the cursor on the task, run **"Resolve shared
task conflict"**, pick the field and the value to keep. Both notes then
show it.

### The same task in several notes

Run "Insert shared object" in another note to show the same task there as
well. Every copy stays in sync.

### Stop sharing a task in one note

Put the cursor on the task and run **"Detach shared task"**. The marker is
removed and the line stays as an ordinary local task. The shared task
itself, and the other person's copy, are not changed.

### Check a collaboration

**"Resource status"** shows a collaboration's state: its server, whether
it syncs, and why it stopped if it did. Secrets are never shown.

### You moved a task line and its marker ended up under another task

The plugin stops sending changes for it and tells you. Run **"Repair moved
shared task ref"** to put the marker back under its task.

## Part 5 · If something goes wrong

| You see | What to do |
| --- | --- |
| *not ready yet (starting, or writing is paused on this device)* | Wait a few seconds after starting Obsidian. If it persists, check Settings → Shared Tasks → "Identity on this device" and restart Obsidian. |
| *no collaboration yet* | Run "Create collaboration" or "Join collaboration" first. |
| *put the cursor on a task line (- [ ] …) to share it* | The cursor is not on a task. Put it on a line that starts with `- [ ]`. |
| *this task's lfcp-ref is malformed or duplicated* | The marker was edited or copied. Undo the edit (`Ctrl/Cmd + Z`). If you copied a task line, delete the copied marker and use "Insert shared object" instead. |
| *could not join* | The reason follows in the notice. Most often the link was already used, since each link works once. Ask for a new one. |
| *"…" was hosted again on wss://…* | Nothing to do. The server had lost the collaboration (for example after a restore from a backup); Shared Tasks put it back and is sending the missing changes. |
| *"…" stopped syncing* | The server no longer has the collaboration and refused to take it back, or no longer lets you in. Your tasks stay on your computer. "Resource status" says why; ask the collaboration's owner. |
| *could not join… needs a newer version of Shared Tasks* | The collaboration uses a newer kind of sharing. Update Shared Tasks in Settings → Community plugins, then join again with the same link: it has not been used. |
| A change does not arrive | Check that both of you are online, then look at "Resource status". |

Bugs and questions go to [GitHub issues](https://github.com/openlfcp/obsidian/issues).
Security problems go to **security@openlfcp.org**, never a public issue.

## Limits of the beta

- This is beta software. **Don't use it yet for data you need to protect.**
- Keep your vault. It holds the full data of every collaboration, and the
  public server can lose recent changes.
- Members can't be removed from inside Obsidian yet. A collaboration
  can't move to another server.
- Recurring tasks (`🔁`) are shared without their recurrence.
- Mobile is not tested yet.

Everything else, including what the server can see, is in the
[README](../../README.md).
