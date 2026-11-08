# Your devices

You can use Shared Tasks on several devices: a laptop, a second computer,
a phone. Each device is one vault with Shared Tasks. Paired together, they
are **one person**: your collaborators see you once, and what you write on
any of your devices is shown as yours.

> **New in this version.** Devices need a sync server that supports them.
> The project server does; a server of your own needs an update (see
> [Collaborators and older versions](#6-collaborators-and-older-versions)).

Every command below runs from the command palette (`Ctrl/Cmd + P`), where
its name starts with "Shared Tasks:".

## 1. How it works

- **Your first device holds your identity.** The vault where you first run
  "Add my other device…" becomes your first device. It keeps the key that
  makes you one person. There is no recovery kit in this version: keep
  that vault (and a backup of your computer).
- **Your device list** is kept, encrypted, on your default server
  (Settings → Shared Tasks). The server cannot read it.
- **Each device has its own keys.** Nothing secret is copied from one
  device to another; your shared sections reach a new device through the
  sync server, encrypted for that device.
- **Access is chosen once.** When you add a device you choose what it may
  do. To change it later, remove the device and add it again (see
  [Change a device's access](#5-change-a-devices-access)).

| Access | What the device can do | For |
| --- | --- | --- |
| **Full** | Read and write, invite people, add and remove your devices, change keys | Another computer |
| **Edit** | Read and write | A phone |
| **Read** | Read only | A device you only look at |
| **Service** | Read and write only the sections you chose | A bridge or a bot |

On a phone, shared sections stay read-only in this version, whatever
access you give.

## 2. Add a device

On the device you already use (your first device, or one with Full
access):

1. Run **"Add my other device…"**.
2. The first time, if you share sections with other people, Shared Tasks
   first warns that collaborators on an older version stop syncing those
   sections until they update (see
   [section 6](#6-collaborators-and-older-versions)). Choose **Continue**
   to go on.
3. A **link** appears. It works once and only for adding a device. Treat
   it like a password: send it only to yourself (copy it, or show it and
   type it on the other device). Don't paste it into a chat or a note.

On the new device (a new, empty vault with Shared Tasks):

4. Run **"Pair this device with a link…"** and paste the link. The new
   device shows a **fingerprint**: four groups of letters and digits.

Back on the first device:

5. The request appears with its name, platform and fingerprint.
   **Compare the fingerprint with the one on the new device.** Approve only
   if they are the same. If they differ, someone else has your link:
   **Reject** it, which also closes the link.
6. Choose the access (Full for a computer and Edit for a phone are offered
   first), confirm that the fingerprints match, and **Approve**.

The new device then shows its result and opens each of your shared
sections. A section can say "waiting for keys" or "waiting to be added"
for a moment; the dialog keeps checking. Closing it is safe: run "Pair
this device with a link…" again to see where it stands.

**A vault that already shares sections** under its own name cannot become
a device of someone else: it would turn one person into another. Pair a
new, empty vault instead.

**A copied vault is a new device.** If you copy a vault to another
computer, the copy starts without your keys (they are never inside the
vault). Pair it like any new device; its notes with shared sections then
follow those sections.

**A synced vault on another device.** A vault synced through iCloud,
Obsidian Sync, Git or a similar service brings your notes to the other
device, never Shared Tasks' keys or local data. The first time, Shared
Tasks starts there as a new device: pair it as above. If its local data
on that device is later lost or no longer matches (a phone can clear an
app's storage, for example), Shared Tasks says so instead of loading: the
pane, a section's details and its badge say "can't open its local data on
this device", with the reason. A device in that state can't be paired as
it is. It takes two steps, and nothing is reset until you ask:

1. In Settings → Shared Tasks, choose **Create a new identity**. This is
   an empty start on this device; your notes don't change.
2. On a device of yours that syncs, run **"Add my other device…"**; on
   this one, run **"Pair this device with a link…"** and go on as in
   steps 4 to 6 above.

Your shared sections then open there again, as you. A new identity on its
own, without step 2, is a separate person: it has none of your earlier
sections, and collaborators would need to invite it again. If the device
was in your device list before, its old entry stays there: remove it from
another device with "Your devices…". If none of your other devices can add
a device (the lost one was your first device and no other has Full
access), pairing isn't possible in this version: a new identity is then
the only way, and collaborators invite it again. When another Shared Tasks
window holds the vault's data, no new identity is offered: close the other
window or restart Obsidian.

### A bridge or a bot

A headless bridge (for example, a notes bridge on a server) is paired
with the `lfcp-node pair` command of `@openlfcp/storage-node`. That
command only pairs: this build has no bridge that reads or writes notes
yet. It names
the sections it asks for. On your device you see it as "A service asks to
join", with its fingerprint and those sections; you may remove sections
from the list, not add any. A bridge can read and write only those
sections. It can't invite anyone, read your device list or reach your
other sections. What it writes is shown as yours, "via" the bridge.

## 3. See your devices

**"Your devices…"** lists your first device, this device and the others,
each with its access, its state and its fingerprint:

- **active**: in use;
- **suspended**: it was added by a device you removed (see below);
- **removed**: it no longer has access.

It also lists what is unfinished, for example a device not added to a
section yet because a server was unreachable, with **Finish now**. Shared
Tasks also finishes these by itself while it runs.

In a section's details, the people list shows each person once; your own
devices are listed under you.

## 4. Remove a device or handle a lost one

From your first device or a device with Full access, open **"Your
devices…"** and choose **"Remove device…"** next to the device. Before
anything changes you see what removing it does:

- the device loses access to all your sections;
- **devices it added stop too.** You are offered to re-certify them first,
  so they keep working;
- the sections whose key someone else changes (see below).

Then choose why: no longer used, lost, or someone else may have it.

What happens next:

- Your own sections get a **new key at once**. The removed device can't
  read anything written after that.
- **Sections owned by a colleague** get their new key from the
  colleague's Shared Tasks, automatically the next time it runs. Until
  then the removed device could still read new changes there. The result
  of the removal names these sections.
- If the device was offline and wrote something, that work is not
  accepted. It stays on that device, in its notes, nothing deleted; write
  it again from one of your other devices if you need it.
- The removed device, when it connects, shows "This device was removed
  from your identity" (or, where that cannot be proven, "This device no
  longer has access…"). Its notes keep their copy; nothing is deleted.
- A removed device is never added back under the same identity. To use
  that computer again, pair a new, empty vault there.

Removing a device needs the sync server: offline, removal is refused.
Removing does not delete what the device already copied or wrote.

**Lost or stolen device:** remove it as soon as you can, choosing "lost"
or "someone else may have it". Then check the result for colleagues'
sections that still wait for a new key.

**You can't remove a device from a device that depends on it.** If a
device was added by the one you want to remove, its own access passes
through it: remove it from your first device, or re-certify the device
from your first device first.

## 5. Change a device's access

Access is chosen once. To change it (for example, from Read to Full),
remove the device, then pair a new, empty vault on it with the access you
want. What the old device wrote stays in the history as yours.

## 6. Collaborators and older versions

- **Collaborators see you once.** Your devices are shown under your name,
  not as new participants, and a local name they give you applies to all
  your devices.
- **Older versions stop syncing.** Adding your first device changes each
  section you share so that your devices can open it. A collaborator on
  Shared Tasks 0.6.0 or earlier stops syncing that section (0.6.0 shows
  it as offline); Shared Tasks 0.6.1 says "This section now uses a
  person's linked devices… Update the plugin". After they update, it
  syncs again, with nothing lost on their side. Tell your collaborators
  before you add your first device.
- **A server without device support.** A section on a sync server that
  does not support devices yet is not changed. Your new device lists it
  as "on a server without device support" and gets it once the server
  is updated: your managing device adds it then, automatically.
- **When you remove a device**, the owner of each shared section changes
  its key the next time their Shared Tasks runs. Nothing is asked of them.

## 7. Known limits in this build

- A second device with Full access cannot see the requests of a link
  shown by another device: approve on the device that shows the link.
- **Device steps take their time.** Each step opens a connection to the
  sync server, and a server allows about 20 new connections a minute from
  one network. Shared Tasks paces them: a step may wait a few seconds for
  its turn, and an open dialog asks less often the longer it waits (after
  4, 8 and 15 seconds, then every 30 seconds). **Check now** asks at once.
- **`lfcp-node pair` does not start on Windows**: storing the bridge's
  keys fails there. Pair a bridge from Linux or macOS.
