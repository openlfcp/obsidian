# OBSIDIAN-ARCHITECTURE-01

**Title:** OpenLFCP Obsidian Client Architecture  
**Status:** Working Draft 0.1  
**Date:** 2026-10-04  
**Protocol dependency:** LFCP / `LFCP-WIRE-01`  
**Primary repository:** `github.com/openlfcp/obsidian`  
**Primary SDK dependency:** `github.com/openlfcp/sdk-ts`

---

## 1. Purpose

This document defines the architecture of the first production-oriented LFCP client for Obsidian.

The initial product goal is intentionally narrower than "collaborative editing for all Markdown":

> Allow a user to keep ordinary local Markdown files while embedding and editing shared collaborative objects such as tasks inside those files.

The first supported shared object type is **Task**.

A local Markdown file remains owned by the local user. Only selected embedded objects become collaborative.

Example:

```md
# Launch notes

These paragraphs are private.

- [ ] Prepare API contract 📅 2026-10-10
  <!-- lfcp-ref: lfcp1:RESOURCE#task:OBJECT -->

These paragraphs are also private.
```

The Markdown document itself is not transmitted to the LFCP server.

Only the object referenced by:

```text
lfcp1:RESOURCE#task:OBJECT
```

is shared.

This produces a collaboration model where the boundary of sharing is an object, not necessarily a document or workspace.

---

# 2. Product principle

Traditional collaborative applications usually use a hierarchy like:

```text
Cloud service
    └── account
         └── workspace
              └── documents
                   └── objects
```

The OpenLFCP Obsidian client inverts this model:

```text
Local user vault
    │
    ├── private Markdown
    ├── private Markdown
    │     └── shared object reference
    ├── private Markdown
    │     ├── shared object reference
    │     └── shared object reference
    └── private Markdown
```

Shared objects may belong to unrelated LFCP Resources and may synchronize through unrelated servers.

A single local note may therefore contain:

```text
Task A       -> Resource X -> Server A
Task B       -> Resource Y -> Server B
Decision C   -> Resource Z -> Server C
```

The host note does not need to leave the device.

---

# 3. Goals

Version 0.1 of the Obsidian client MUST support:

1. local-first operation;
2. ordinary Markdown files;
3. creation of LFCP collaborative Resources;
4. joining LFCP Resources through invitations;
5. shared Task objects;
6. embedding a Task into a Markdown line;
7. editing a shared Task from Markdown;
8. receiving remote updates and projecting them back into Markdown;
9. the same shared Task appearing in multiple Markdown files;
10. compatibility with Obsidian Tasks-style checkbox syntax;
11. offline editing;
12. conflict detection and explicit conflict resolution;
13. multiple LFCP Resources in one vault;
14. different sync servers for different Resources;
15. no requirement for a global LFCP account;
16. local encrypted storage of LFCP secrets;
17. route migration without rewriting all Markdown files.

---

# 4. Non-goals for v0.1

The first release does NOT attempt to provide:

- full collaborative editing of an entire Markdown file;
- synchronized cursor positions;
- collaborative selections;
- Google Docs-style presence inside arbitrary text;
- arbitrary binary attachments;
- file-level ACL;
- vault synchronization;
- replacement for Obsidian Sync;
- replacement for Git;
- replacement for the Obsidian Tasks plugin;
- a global user directory;
- a central OpenLFCP account requirement;
- multi-owner LFCP governance;
- direct peer-to-peer transport.

Whole-document collaborative Markdown may be added later as a separate LFCP Data Profile and editor mode.

---

# 5. Architectural principle

The Obsidian plugin MUST be a thin application adapter over the reusable LFCP TypeScript SDK.

The plugin MUST NOT independently reimplement:

- LFCP wire framing;
- control-chain verification;
- capability evaluation;
- cryptographic key handling;
- route handling;
- sync negotiation;
- invite parsing;
- LFCP object signatures;
- encryption epochs.

The dependency structure is:

```text
Obsidian plugin
      │
      ▼
@openlfcp/client
      │
      ├── @openlfcp/core
      ├── @openlfcp/wire
      ├── @openlfcp/storage
      └── @openlfcp/profile-shared-objects
```

The same SDK should later support:

```text
VS Code extension
Browser examples
CLI tools
Electron clients
Other Markdown editors
```

---

# 6. Repository structure

Recommended repository:

```text
openlfcp/obsidian/
│
├── README.md
├── LICENSE
├── manifest.json
├── versions.json
├── package.json
├── tsconfig.json
│
├── docs/
│   ├── OBSIDIAN-ARCHITECTURE-01.md
│   ├── MARKDOWN-REFS-01.md
│   └── SECURITY.md
│
├── src/
│   ├── main.ts
│   │
│   ├── app/
│   │   ├── plugin-context.ts
│   │   ├── lifecycle.ts
│   │   └── commands.ts
│   │
│   ├── markdown/
│   │   ├── scanner.ts
│   │   ├── parser.ts
│   │   ├── refs.ts
│   │   ├── projection.ts
│   │   ├── diff.ts
│   │   └── mutation-guard.ts
│   │
│   ├── tasks/
│   │   ├── task-parser.ts
│   │   ├── task-renderer.ts
│   │   ├── task-intents.ts
│   │   └── task-conflicts.ts
│   │
│   ├── lfcp/
│   │   ├── client.ts
│   │   ├── resource-registry.ts
│   │   ├── route-store.ts
│   │   ├── secret-store.ts
│   │   └── resource-session.ts
│   │
│   ├── ui/
│   │   ├── resource-explorer.ts
│   │   ├── share-task-modal.ts
│   │   ├── create-resource-modal.ts
│   │   ├── join-resource-modal.ts
│   │   ├── invite-modal.ts
│   │   ├── conflict-widget.ts
│   │   └── settings-tab.ts
│   │
│   └── storage/
│       └── obsidian-store.ts
│
└── tests/
    ├── markdown/
    ├── projections/
    ├── conflicts/
    ├── integration/
    └── fixtures/
```

---

# 7. Core concepts

The Obsidian client uses four separate concepts.

## 7.1 Host Document

An ordinary Markdown file in the user's vault.

Example:

```text
Projects/Alpha/Launch.md
```

It may be completely private.

## 7.2 LFCP Resource

The collaboration and security boundary.

A Resource defines:

- participants;
- control chain;
- encryption epoch;
- routing;
- LFCP Data Profile;
- shared state.

Example:

```text
Project Alpha
Resource ID:
lfcp1:8f...
```

The human-readable name `Project Alpha` is local or application metadata and is not the Resource identity.

## 7.3 Shared Object

An application-level object inside an LFCP Resource.

Initial types:

```text
task
decision
comment-thread
approval
project-status
```

Version 0.1 only requires the Task UI.

## 7.4 Projection

A representation of a Shared Object inside a Host Document.

For example:

```md
- [ ] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:BBB -->
```

The Task may have multiple projections in one or many local Markdown files.

---

# 8. Resource granularity

A single LFCP Resource SHOULD contain multiple related Shared Objects.

It is not recommended to create one LFCP Resource per Task unless a distinct ACL or sharing boundary is required.

Preferred:

```text
Resource: Project Alpha
│
├── task:01
├── task:02
├── task:03
├── decision:01
└── comment-thread:01
```

All objects in the Resource share:

- participants;
- encryption epoch;
- routes;
- authorization policy.

This avoids unnecessary LFCP Control Plane overhead.

A new Resource should normally be created when the user wants a different:

- participant set;
- owner;
- privacy boundary;
- server policy;
- collaboration context.

---

# 9. Shared Objects Data Profile

The first application profile is provisionally named:

```text
org.openlfcp.shared-objects.v1
```

The initial reference implementation SHOULD use Automerge as the CRDT engine.

The LFCP server remains unaware of Automerge because the LFCP Data Plane stores encrypted opaque Data Units.

Conceptual state:

```ts
type SharedObjectsDocument = {
  schema: "org.openlfcp.shared-objects.v1";

  objects: Record<ObjectId, SharedObject>;
};
```

Shared object:

```ts
type SharedObject =
  | TaskObject
  | DecisionObject
  | CommentThreadObject
  | ApprovalObject
  | ProjectStatusObject;
```

---

# 10. Object identifiers

Every Shared Object has an identifier unique within its LFCP Resource.

Recommended format:

```text
01K5Z0...
```

using a sortable random identifier such as UUIDv7 or ULID.

The exact identifier format belongs to the Shared Objects profile, not LFCP Core.

A complete object reference consists of:

```text
<Resource ID>#<object type>:<object ID>
```

Example:

```text
lfcp1:z4F8Kc...#task:01K5Z0TR8P...
```

This reference is stable across:

- Markdown file rename;
- Markdown file move;
- vault rename;
- LFCP server migration;
- owner transfer;
- route changes.

---

# 11. Task object schema

Initial conceptual schema:

```ts
type TaskObject = {
  type: "task";
  id: string;

  title: string;

  status:
    | "todo"
    | "in_progress"
    | "done"
    | "cancelled";

  assignees: string[];

  due?: string;

  scheduled?: string;

  priority?: "low" | "normal" | "high" | "urgent";

  tags: string[];

  createdAt?: string;
  completedAt?: string;

  comments?: string[];

  extensions?: Record<string, unknown>;
};
```

The exact CRDT representation MAY differ from this TypeScript shape.

Important fields such as `status` MUST preserve meaningful concurrent edits rather than silently discarding them.

The profile SHOULD allow the UI to distinguish:

```text
normal resolved state
```

from:

```text
concurrent conflicting values
```

---

# 12. Markdown reference syntax

Version 0.1 MUST follow `MARKDOWN-REFS-01`.

Two placements are conforming and semantically equivalent.

Compact inline form:

```md
- [ ] Prepare API contract <!-- lfcp-ref: lfcp1:RESOURCE#task:OBJECT -->
```

Compatibility-oriented child-line form:

```md
- [ ] Prepare API contract
  <!-- lfcp-ref: lfcp1:RESOURCE#task:OBJECT -->
```

For Obsidian, the plugin SHOULD emit the child-line form by default because Obsidian Tasks and other task-oriented plugins may attach semantics to the suffix of the Task line. If the user does not use suffix-sensitive task parsing, the plugin MAY expose the inline form as a compact preference.

The parser MUST accept both forms. Ordinary remote updates SHOULD preserve whichever valid placement the local projection already uses, so collaboration does not create gratuitous Markdown/Git diffs.

The examples in this architecture normally use child-line form because it is the safest default for Obsidian. Other clients may prefer inline form when it is known to be harmless.

`MARKDOWN-REFS-01` normatively defines:

- both placement grammars;
- whitespace and association rules;
- duplicate refs, including inline + child duplicates;
- invalid and orphan refs;
- supported block contexts;
- placement preservation;
- detach/copy behavior;
- serializer policy.

---

# 13. Why the route is not stored in Markdown

The Markdown reference MUST identify the LFCP Resource and object, but SHOULD NOT permanently encode the current sync server.

Bad:

```md
<!-- lfcp-ref: wss://server-a.example/resource/... -->
```

Preferred:

```md
<!-- lfcp-ref: lfcp1:RESOURCE#task:OBJECT -->
```

Routes live in:

1. signed LFCP Route Manifests;
2. local route cache;
3. optional temporary invitation/bootstrap data.

This permits:

```text
server A
   ↓ migration
server B
```

without rewriting every Markdown file.

---

# 14. Projection ownership model

After a normal local Task is converted to a shared LFCP Task, the collaborative object becomes the shared semantic source of truth.

The Markdown line remains:

- a user-visible editing surface;
- a local projection;
- interoperable text.

The relationship is:

```text
            Shared CRDT Task
                   │
           semantic state
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
Markdown projection A   Markdown projection B
```

The plugin MUST support edits flowing in both directions.

---

# 15. Markdown to CRDT flow

Example initial projection:

```md
- [ ] Prepare API contract 📅 2026-10-10
  <!-- lfcp-ref: ... -->
```

The user edits it manually:

```md
- [x] Prepare API contract 📅 2026-10-10
  <!-- lfcp-ref: ... -->
```

The plugin performs:

```text
Markdown changed
      │
      ▼
parse affected projection
      │
      ▼
resolve LFCP ref
      │
      ▼
load current Shared Object
      │
      ▼
compute semantic diff
      │
      ▼
status: todo -> done
      │
      ▼
create application intent
      │
      ▼
Automerge transaction
      │
      ▼
LFCP Data Unit
      │
      ▼
local store + sync
```

The plugin SHOULD reason in semantic changes, not raw line diffs.

---

# 16. CRDT to Markdown flow

A remote collaborator changes:

```text
status: todo -> done
```

The local client receives LFCP Data Units:

```text
LFCP sync
   │
   ▼
validate + decrypt
   │
   ▼
Automerge merge
   │
   ▼
Shared Object changed
   │
   ▼
Projection Engine
   │
   ▼
find local projections
   │
   ▼
update Markdown
```

Example:

```md
- [ ] Prepare API contract
  <!-- lfcp-ref: ... -->
```

becomes:

```md
- [x] Prepare API contract
  <!-- lfcp-ref: ... -->
```

The plugin MUST prevent this generated Markdown write from being interpreted as a new local user intent.

---

# 17. Mutation guard

Projection writes require an internal mutation guard.

Without it:

```text
remote update
   ↓
plugin rewrites Markdown
   ↓
vault modification event
   ↓
plugin thinks user changed Markdown
   ↓
creates duplicate CRDT update
```

Recommended internal flow:

```ts
mutationGuard.run(filePath, async () => {
  await vault.modify(file, newContent);
});
```

The scanner identifies guarded mutations and avoids producing redundant application intents.

The design MUST tolerate Obsidian emitting multiple file events for one logical modification.

---

# 18. Projection index

The plugin needs a local index:

```text
Shared Object Ref
      ↓
all local Markdown projections
```

Conceptually:

```ts
type ProjectionLocation = {
  filePath: string;
  line?: number;
  blockOffset?: number;
};

Map<CanonicalObjectRef, ProjectionLocation[]>
```

The index MUST be reconstructable by scanning the vault.

It MUST NOT be the sole durable source of truth.

This allows recovery if plugin metadata is deleted.

---

# 19. Multiple projections

The same shared Task MAY appear in several notes.

Example:

```text
Dashboard.md
Today.md
Project Alpha.md
Pavel.md
```

Each contains:

```md
- [ ] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:123 -->
```

When one projection changes, the Shared Object changes.

The plugin then updates all other projections.

```text
Projection A edited
      ↓
Task object changes
      ↓
Projection B updated
Projection C updated
Projection D updated
```

This is a core product feature, not an edge case.

---

# 20. Duplicate projection policy

Multiple projections are legitimate.

However, accidental duplicate refs on the same line or malformed refs are not.

The plugin SHOULD detect:

- duplicate identical ref metadata on one line;
- one line referencing incompatible object types;
- missing object;
- Resource unavailable;
- invalid Resource ID;
- invalid object ID.

These conditions SHOULD produce non-destructive editor diagnostics rather than silently rewriting user text.

---

# 21. Task parsing

The Task adapter should initially support common Obsidian task syntax.

Minimum:

```md
- [ ] Title
- [x] Title
```

Recommended compatibility fields:

```text
due date
scheduled date
priority
tags
completion date
```

Example:

```md
- [ ] Prepare API contract 🔺 📅 2026-10-10 #backend
```

The parser MUST preserve unknown text and metadata whenever possible.

The plugin MUST NOT aggressively normalize the user's entire Task line after every remote update.

---

# 22. Minimal-diff projection updates

When changing a Markdown projection, the plugin SHOULD modify only the semantic part that changed.

Example:

Current local line:

```md
- [ ] API contract #important some-local-marker
  <!-- lfcp-ref: ... -->
```

Remote update:

```text
status = done
```

Preferred output:

```md
- [x] API contract #important some-local-marker
  <!-- lfcp-ref: ... -->
```

Not:

```md
- [x] API contract
  <!-- lfcp-ref: ... -->
```

Local formatting outside LFCP-owned semantics should survive.

This requires token-aware line rewriting rather than full regeneration whenever possible.

---

# 23. Field ownership

For v0.1, fields represented directly in the Markdown Task line are collaborative.

Recommended collaborative fields:

```text
title
status
due
scheduled
priority
tags
```

Potentially collaborative later:

```text
assignee
comments
relationships
```

Unknown Markdown syntax remains local unless a future adapter explicitly claims ownership.

---

# 24. Local-only projection metadata

A user may want local presentation without changing the collaborative object.

Examples:

- indentation;
- surrounding heading;
- local backlinks;
- local aliases;
- local annotations outside the Task-owned tokens.

This distinction is important:

```text
Shared semantics
      !=
Local presentation
```

---

# 25. Creating a shared Task

Command:

```text
LFCP: Share task under cursor
```

Input:

```md
- [ ] Prepare API contract 📅 2026-10-10
```

UI:

```text
Share task via:

● Project Alpha
○ Founders
○ Family
○ Create new collaboration...
```

If the user selects `Project Alpha`, the plugin:

1. parses the local Task;
2. creates a new Task Object ID;
3. creates the Task inside the Resource CRDT;
4. commits locally;
5. writes an `lfcp-ref` using the configured conforming placement, child-line by default in Obsidian;
6. updates the local projection index;
7. begins or continues LFCP synchronization.

Result:

```md
- [ ] Prepare API contract 📅 2026-10-10
  <!-- lfcp-ref: lfcp1:AAA#task:BBB -->
```

The user should perceive this as "this Task is now shared."

---

# 26. Creating a collaboration Resource

Command:

```text
LFCP: Create collaboration
```

Minimal dialog:

```text
Name:
[ Project Alpha ]

Server:
[ sync.example.org           ▼ ]

Data profile:
[ Shared Objects             ]

[ Create ]
```

The human-readable name is application metadata.

The plugin creates:

- LFCP Resource ID;
- Genesis Control Record;
- initial encryption epoch;
- Shared Objects CRDT document;
- route information;
- local Resource registration.

The user becomes owner according to LFCP Control Plane rules.

---

# 27. Resource registry

The plugin keeps a local registry of known Resources.

Conceptual model:

```ts
type LocalResourceEntry = {
  resourceId: string;

  localName?: string;

  profile: string;

  routes: string[];

  lastKnownControlHead?: string;

  state:
    | "available"
    | "offline"
    | "locked"
    | "error"
    | "control_conflict";
};
```

This registry is local convenience metadata and does not override signed LFCP Control Plane state.

---

# 28. Joining a Resource

Command:

```text
LFCP: Join collaboration
```

User pastes:

```text
lfcp://join/...
```

Flow:

```text
parse invitation
      ↓
validate Resource ID
      ↓
discover bootstrap route
      ↓
connect LFCP client
      ↓
obtain Control Chain
      ↓
validate authorization
      ↓
claim invite if required
      ↓
obtain Key Package
      ↓
decrypt Resource key
      ↓
obtain snapshot / Data Units
      ↓
construct local CRDT replica
      ↓
register Resource locally
```

After joining, the user does not need the inviter to remain online.

---

# 29. Inserting an existing shared Task

Command:

```text
LFCP: Insert shared object
```

UI:

```text
Project Alpha

Tasks
[ ] Prepare API contract
[ ] Production deploy
[x] Pricing review
```

Selecting an object inserts a projection into the current Markdown file.

Example:

```md
- [ ] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:BBB -->
```

The same object may already be projected elsewhere.

That is valid.

---

# 30. Resource Explorer

The plugin SHOULD provide one sidebar view:

```text
LFCP
│
├── Project Alpha
│   ├── 12 tasks
│   ├── 2 decisions
│   └── online
│
├── Founders
│   ├── 3 tasks
│   └── offline
│
└── Family
    ├── 6 tasks
    └── sync error
```

Selecting a Resource shows:

```text
Participants
Routes
Sync status
Encryption epoch
Shared objects
Invitations
Conflicts
```

This view is secondary to Markdown.

The primary user experience remains working inside ordinary notes.

---

# 31. Invitations

Inside Resource Explorer:

```text
Project Alpha
  Members

  You       Owner
  Pavel     Writer
  Masha     Reader

  [ Invite ]
```

Initial permissions:

```text
Read
Read + Write
```

The plugin delegates invitation generation and LFCP Control Plane operations to the SDK.

It returns a portable:

```text
lfcp://join/...
```

invitation.

The plugin MAY render it as:

- copyable text;
- QR code;
- OS share sheet.

---

# 32. Identity

The Obsidian plugin MUST NOT require a global OpenLFCP account.

On first use it creates or imports an LFCP Principal.

For the initial implementation:

```text
Obsidian installation
      ↓
LFCP operational Principal
```

A later identity layer may support:

```text
human root identity
    ├── Obsidian desktop
    ├── mobile
    └── VS Code
```

but WIRE-01 does not require this.

Keys MUST remain local unless the user explicitly configures a secure backup mechanism.

---

# 33. Local storage architecture

The plugin requires local durable state for:

```text
LFCP Control Records
encrypted Data Units
snapshots
route cache
Resource registry
CRDT state/cache
principal keys
DEKs / Key Packages
projection index
sync cursors
```

Recommended architecture:

```text
Obsidian plugin
    │
    ▼
LFCPStore interface
    │
    ├── structured metadata
    ├── encrypted object store
    └── secret store
```

The generic SDK MUST depend on the storage interface, not on Obsidian APIs.

---

# 34. Obsidian storage adapter

Recommended plugin data area:

```text
<vault>/
└── .obsidian/
    └── plugins/
        └── openlfcp/
            ├── data.json
            └── lfcp/
                ├── control/
                ├── data/
                ├── snapshots/
                ├── replicas/
                └── indexes/
```

Exact layout is implementation-specific.

Sensitive key material SHOULD be encrypted at rest where the runtime and platform make this practical.

Secrets MUST NOT be embedded into Markdown.

---

# 35. Route cache

Local route information should look conceptually like:

```json
{
  "lfcp1:AAA": [
    "wss://sync.andrey.example/v1/ws",
    "wss://sync.backup.example/v1/ws"
  ],
  "lfcp1:BBB": [
    "wss://company.example/v1/ws"
  ]
}
```

A signed newer LFCP Route Manifest supersedes stale cache entries.

Markdown refs do not need modification when routes change.

---

# 36. Resource sessions

The plugin SHOULD lazily activate Resource sessions.

Opening a vault containing refs to 300 Resources MUST NOT necessarily create 300 WebSocket connections immediately.

Suggested states:

```text
UNKNOWN
  ↓
LOCAL_ONLY
  ↓
CONNECTING
  ↓
SYNCING
  ↓
READY
  ↓
IDLE
```

Error states:

```text
OFFLINE
AUTH_FAILED
KEY_UNAVAILABLE
CONTROL_CONFLICT
ROUTE_UNAVAILABLE
PROFILE_UNSUPPORTED
```

Sessions may be activated by:

- visible projection;
- user opening Resource Explorer;
- local Task edit;
- background sync policy.

---

# 37. Connection pooling

Several Resources may use the same LFCP server.

The SDK SHOULD pool connections:

```text
Resource A ─┐
Resource B ─┼── one WebSocket session -> server X
Resource C ─┘
```

This belongs in `@openlfcp/client`, not in the Obsidian plugin.

---

# 38. Offline behavior

Offline operation is a first-class mode.

If a Resource is already available locally:

```text
network unavailable
      ↓
user edits shared task
      ↓
local CRDT transaction
      ↓
LFCP Data Unit stored locally
      ↓
projection immediately updates
```

Later:

```text
network restored
      ↓
Have Vector exchange
      ↓
missing Data Units exchanged
      ↓
CRDT merge
```

The UI SHOULD distinguish:

```text
saved locally
```

from:

```text
confirmed by remote server
```

without blocking local work.

---

# 39. Conflict model

CRDT convergence does not imply application-level semantic agreement.

Example:

```text
Andrey offline:
status = done

Pavel offline:
status = cancelled
```

The Shared Objects profile SHOULD preserve this as a semantic conflict.

The plugin MUST NOT silently hide the conflict.

Editor UI:

```text
- [x] Prepare API contract   ⚠
```

Decoration:

```text
Status conflict

Andrey:
done

Pavel:
cancelled

[ Done ]
[ Cancelled ]
[ Reopen ]
```

Choosing one creates a new causal update resolving the conflict.

---

# 40. Conflict rendering

Conflicts SHOULD be rendered as CodeMirror decorations or contextual widgets.

They SHOULD NOT normally write conflict markup into Markdown such as:

```text
<<<<<<<
=======
>>>>>>>
```

because the Markdown file is a projection surface, not a raw CRDT merge representation.

If the plugin is disabled, the user should still see valid ordinary Markdown.

---

# 41. Unavailable Resource behavior

A projection can remain in Markdown even when the Resource cannot currently be opened.

Example:

```md
- [ ] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:BBB -->
```

Possible reasons:

```text
offline and no local replica
missing decryption key
revoked access
server unavailable
unknown route
unsupported profile
```

The plugin MUST NOT delete or overwrite the Markdown line.

It SHOULD decorate it with an explanatory state.

---

# 42. Deleted or tombstoned object

If the referenced object is deleted at the application layer, the Markdown projection SHOULD not disappear automatically.

Recommended UI:

```text
- [ ] Prepare API contract   ⚠ shared object deleted
```

User actions:

```text
Remove reference
Convert to local task
Restore object, if authorized
```

Destructive Markdown deletion MUST require explicit user intent.

---

# 43. Convert shared Task back to local

Command:

```text
LFCP: Detach shared task
```

The current visible Task state is retained, but the ref is removed.

Before:

```md
- [x] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:BBB -->
```

After:

```md
- [x] Prepare API contract
```

This does NOT delete the remote Task.

A separate authorized command may exist:

```text
Delete shared object
```

---

# 44. Compatibility with Obsidian Tasks

The plugin SHOULD coexist with the Tasks community plugin.

Design requirement:

```text
Tasks sees:
ordinary Markdown task syntax

OpenLFCP sees:
ordinary Markdown task syntax
+
hidden LFCP reference
```

Example:

```md
- [ ] API contract 📅 2026-10-10
  <!-- lfcp-ref: ... -->
```

The OpenLFCP plugin MUST avoid introducing syntax before the checkbox that could prevent Tasks from recognizing the line.

Where Tasks rewrites a line, OpenLFCP SHOULD preserve or repair the LFCP ref when practical.

---

# 45. External file edits

Markdown may be modified outside Obsidian:

```text
VS Code
Git checkout
shell script
mobile sync
another plugin
```

Therefore the Obsidian client cannot assume all changes pass through CodeMirror.

It MUST monitor vault-level file changes and rescan affected projections.

This is another reason refs need to live in portable Markdown rather than only in an internal database.

---

# 46. Startup reconciliation

On plugin startup:

```text
load local LFCP state
      ↓
scan or incrementally validate Markdown refs
      ↓
rebuild projection index
      ↓
compare projections with local CRDT state
      ↓
resolve obvious stale projections
      ↓
schedule Resource sync
```

The plugin MUST avoid immediately rewriting the entire vault.

Reconciliation should be incremental and conservative.

---

# 47. File rename and move

Since refs are inside Markdown and object identity is independent of file path:

```text
Projects/Alpha.md
      ↓ rename
Archive/Alpha-2026.md
```

requires no LFCP operation.

Only the local projection index changes.

---

# 48. Vault duplication

Copying a vault may duplicate projections and plugin local state.

This is acceptable, but principal handling requires care.

The plugin SHOULD detect cases where the same principal state appears to have been copied to a second independent installation.

Because LFCP actor sequences are scoped to a Principal, unsafe sequence duplication can create equivocation.

Safer behavior:

```text
detected copied installation
      ↓
generate new operational Principal
      ↓
retain Resource access through re-authorization or identity delegation
```

The exact migration flow should be specified later.

---

# 49. Obsidian desktop and mobile

The architecture should not assume desktop-only APIs.

However, v0.1 implementation MAY target Obsidian desktop first.

Shared code SHOULD isolate:

```text
filesystem/storage adapter
secure key storage
WebSocket runtime
background behavior
```

so mobile support can be added without rewriting the collaboration model.

---

# 50. Commands

Recommended v0.1 command set:

```text
LFCP: Create collaboration
LFCP: Join collaboration
LFCP: Share task under cursor
LFCP: Insert shared object
LFCP: Detach shared task
LFCP: Open resource
LFCP: Invite collaborator
LFCP: Resolve conflict
LFCP: Sync now
LFCP: Copy object reference
LFCP: Show object information
```

Developer commands:

```text
LFCP: Inspect control chain
LFCP: Inspect object state
LFCP: Rebuild projection index
LFCP: Export diagnostics
```

---

# 51. Settings

Minimal settings:

```text
Identity
  Current Principal
  Export public descriptor

Default server
  wss://...

Synchronization
  Background sync
  Connection idle timeout

Markdown
  Ref syntax version
  Auto-update projections

Diagnostics
  Logging level
  Export diagnostic bundle
```

The UI SHOULD make clear that:

```text
Default server != account owner != LFCP identity
```

---

# 52. Server configuration UX

The Obsidian plugin should allow users to remember server endpoints.

Example:

```text
LFCP Servers

Personal
wss://sync.andrey.dev/v1/ws

Company
wss://lfcp.company.example/v1/ws

[ Add server ]
```

Adding a server MAY involve:

```text
endpoint
hosting credential
server account token
```

These are hosting credentials only.

They do not replace Resource-level LFCP capabilities.

---

# 53. Initial self-hosted flow

Expected developer/user flow:

```text
1. Run openlfcp/server
2. Open server /setup
3. Pair LFCP Principal
4. Add server to Obsidian
5. Create collaboration Resource
6. Share Task
7. Invite second user
8. Second user joins
9. Both edit same Task offline/online
```

This is the primary end-to-end MVP scenario.

---

# 54. Sync architecture

Complete path:

```text
                     OBSIDIAN VAULT

             Markdown files / Tasks
                       │
                       ▼
              Markdown Scanner
                       │
                       ▼
             Projection Registry
                       │
                       ▼
                Task Adapter
                       │
                       ▼
        Shared Objects CRDT Profile
                       │
                       ▼
             @openlfcp/client
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
       Local        Route       Control
       Store        Manager      Validator
          │            │            │
          └────────────┼────────────┘
                       ▼
                 Sync Manager
                       │
               WebSocket LFCP
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
       LFCP Server A         LFCP Server B
```

---

# 55. Data boundaries

The following data remains local unless separately shared:

```text
Markdown file contents
vault structure
headings
private paragraphs
backlinks
other notes
unreferenced tasks
Obsidian settings
```

LFCP servers may receive encrypted LFCP objects and LFCP metadata according to the wire protocol.

The plugin MUST NOT upload a host Markdown document merely because it contains one LFCP ref.

---

# 56. Privacy invariant

A fundamental invariant:

> Sharing a Task MUST NOT implicitly share the Markdown document containing that Task.

This should be enforced both architecturally and through tests.

Example test:

```text
Host document contains:

SECRET-PARAGRAPH-ABC

and one shared Task.

Assert:
No outgoing LFCP payload contains
SECRET-PARAGRAPH-ABC.
```

---

# 57. Shared object security boundary

All objects inside one LFCP Resource share the Resource security boundary.

Therefore users MUST understand that:

```text
same Resource
    =>
same participants may potentially receive Resource Data Plane state
```

If Task A and Task B require different participant sets, they should normally belong to different Resources.

---

# 58. Application schema evolution

Shared Objects profile data SHOULD include a schema version.

Example:

```ts
{
  schema: "org.openlfcp.shared-objects.v1",
  objects: { ... }
}
```

New fields SHOULD be additive where possible.

Older clients MUST preserve unknown extension fields even if they cannot render them.

This prevents an old Obsidian plugin from destroying state introduced by a newer VS Code client.

---

# 59. Intent layer

The application layer SHOULD represent user actions as semantic intents before changing CRDT state.

Examples:

```text
create_task
rename_task
complete_task
reopen_task
cancel_task
change_due_date
add_tag
remove_tag
assign_task
```

Flow:

```text
Markdown semantic diff
      ↓
Task Intent
      ↓
Shared Objects transaction
      ↓
CRDT change
```

This makes it easier to:

- test behavior;
- audit local actions;
- implement multiple UIs;
- add business rules;
- display meaningful conflicts.

LFCP Core does not understand these intents.

---

# 60. Event history

The Shared Objects profile MAY retain application-level action history.

This is separate from LFCP's immutable Data Units.

Example:

```text
09:11 created by Andrey
09:17 assigned to Pavel
11:04 started by Pavel
14:31 completed by Pavel
```

This history is useful for tasks but should not be required by LFCP Core.

---

# 61. Object UI outside Markdown

A Shared Task should also be editable through a structured modal or sidebar.

This is useful for fields poorly represented in one Markdown line:

```text
assignee
comments
history
participants
conflicts
object diagnostics
```

Markdown remains the fast primary surface.

Structured UI is supplementary.

---

# 62. Full document collaboration later

Future mode:

```yaml
---
lfcp:
  resource: lfcp1:ABC
  mode: document
---
```

Possible architecture:

```text
CodeMirror
    │
    ▼
text CRDT
    │
    ▼
LFCP Data Units
```

This mode introduces harder problems:

- text selections;
- undo semantics;
- external filesystem edits;
- concurrent block moves;
- cursor presence;
- plugin-generated Markdown rewrites;
- large document performance.

It should be implemented after shared-object collaboration is stable.

---

# 63. VS Code portability requirement

Everything below this line:

```text
Markdown parser adapter
Obsidian UI
Obsidian file events
```

should be editor-specific.

Everything below:

```text
object refs
Shared Objects profile
LFCP client
Control Plane
crypto
sync
routing
storage interfaces
```

should be reusable.

The future VS Code extension should be able to interpret the same:

```md
<!-- lfcp-ref: lfcp1:AAA#task:BBB -->
```

without conversion.

---

# 64. Example two-vault scenario

Andrey:

```text
Vault A

Projects/
  Alpha/
    Launch.md
```

Pavel:

```text
Vault B

Work/
  Todos.md
```

Andrey's note:

```md
# Launch

Some private notes.

- [ ] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:123 -->
```

Pavel's note:

```md
# This week

- [ ] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:123 -->
```

They are different files.

There is no shared Markdown document.

There is one shared Task object.

Pavel edits:

```md
- [x] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:123 -->
```

Result:

```text
Pavel Markdown edit
      ↓
Shared Task status = done
      ↓
LFCP Data Unit
      ↓
server
      ↓
Andrey client
      ↓
CRDT merge
      ↓
Andrey projection updated
```

Andrey sees:

```md
- [x] Prepare API contract
  <!-- lfcp-ref: lfcp1:AAA#task:123 -->
```

His surrounding private text never moved.

---

# 65. Example multi-server note

A single note:

```md
# Today

- [ ] API contract
  <!-- lfcp-ref: lfcp1:AAA#task:1 -->

- [ ] Review family booking
  <!-- lfcp-ref: lfcp1:BBB#task:9 -->

- [ ] Investor response
  <!-- lfcp-ref: lfcp1:CCC#task:4 -->
```

Routing:

```text
AAA -> company LFCP server

BBB -> family self-hosted server

CCC -> founder personal server
```

The user experiences one local task list.

The network underneath is federated.

---

# 66. Failure isolation

If server `BBB` is unavailable:

```text
Task 1 -> normal
Task 9 -> offline / locally cached
Task 4 -> normal
```

The whole note MUST NOT become unavailable.

Each LFCP Resource fails independently.

This is a major architectural benefit of object/resource-level federation.

---

# 67. Performance requirements

The plugin SHOULD avoid:

- full vault rescans on every edit;
- rewriting complete files for one Task change;
- one WebSocket per object;
- one Resource per Task by default;
- loading all Resource CRDT documents eagerly.

Preferred techniques:

```text
incremental Markdown scanning
projection index
resource-level batching
connection pooling
lazy Resource activation
debounced file reconciliation
minimal-diff projection writes
```

---

# 68. Logging

Logs MUST NOT contain:

```text
private LFCP keys
DEKs
invite fragment secrets
plaintext object content at normal log levels
hosting passwords/tokens
```

Diagnostic logging may include:

```text
Resource ID
Object ID
Data Unit ID
Control Head
route endpoint
state transitions
error codes
```

A special explicit developer mode MAY log decrypted application content.

---

# 69. Diagnostics bundle

The plugin SHOULD support:

```text
LFCP: Export diagnostics
```

Bundle:

```text
plugin version
SDK version
WIRE profile
Resource IDs
route information
Control Head IDs
Have Vectors
sync errors
projection locations
sanitized logs
```

It MUST omit private keys and invitation secrets.

This will be extremely useful during early interoperability work.

---

# 70. Test layers

The Obsidian project should have four testing levels.

## 70.1 Unit tests

```text
Task parser
ref parser
projection rewrite
semantic diff
mutation guard
conflict renderer model
```

## 70.2 Shared Objects profile tests

```text
create task
concurrent status updates
due date updates
unknown fields
multi-projection state
```

## 70.3 LFCP integration tests

Use official `LFCP-TEST-VECTORS`.

Verify TypeScript implementation against the protocol.

## 70.4 End-to-end Obsidian tests

Two isolated vaults:

```text
Vault A
Vault B
LFCP server
```

Test:

```text
create Resource
invite
join
share task
edit A
observe B
disconnect B
edit both
reconnect
resolve conflict
migrate server
```

---

# 71. Critical privacy tests

At minimum:

### Test A

A note contains private paragraphs plus one shared Task.

Assert that private text never enters LFCP Data Units.

### Test B

Two shared objects from two Resources live in one note.

Assert each operation is sent only to the correct Resource.

### Test C

A Task is detached.

Assert future local edits no longer generate LFCP changes.

### Test D

Access is revoked and epoch rotated.

Assert the client cannot decrypt future authorized state without a new key.

---

# 72. MVP acceptance scenario

The first MVP is considered successful when the following can be demonstrated with two clean Obsidian vaults.

### Setup

```text
Andrey Vault
Pavel Vault
one self-hosted LFCP server
```

### Flow

1. Andrey starts the LFCP server.
2. Andrey installs the OpenLFCP Obsidian plugin.
3. Pavel installs the same plugin.
4. Both obtain local LFCP Principals.
5. Andrey creates `Project Alpha`.
6. Andrey writes:

```md
- [ ] Prepare API contract
```

7. Andrey runs `LFCP: Share task under cursor`.
8. The plugin attaches an LFCP ref.
9. Andrey creates an invitation.
10. Pavel joins.
11. Pavel inserts the shared Task into a different note.
12. Pavel checks the Task as completed.
13. Andrey's Markdown line becomes completed.
14. Pavel goes offline.
15. Andrey changes another field.
16. Pavel changes the Task offline.
17. Pavel reconnects.
18. CRDT state converges.
19. If the edits semantically conflict, both clients show a conflict UI.
20. A user resolves the conflict.
21. Both Markdown projections converge.
22. The surrounding Markdown in both vaults remains private and unchanged.

No entire Markdown file is uploaded.

No central OpenLFCP account is required.

---

# 73. MVP implementation order

Recommended order:

## Phase 0 - protocol plumbing

```text
sdk-ts passes LFCP test vectors
basic client opens Resource
server sync works
```

## Phase 1 - local Shared Objects

```text
Automerge Shared Objects profile
Task schema
Task intents
no network required
```

## Phase 2 - Markdown projection

```text
parse Task
attach ref
project Task
two projections in one vault
```

## Phase 3 - two clients

```text
invite
join
sync
remote update
```

## Phase 4 - offline and conflicts

```text
offline edits
concurrent changes
conflict UI
resolution
```

## Phase 5 - product polish

```text
Resource Explorer
settings
server list
diagnostics
Tasks plugin compatibility
```

---

# 74. Open questions

The following should be resolved through implementation experiments.

2. Whether refs use HTML comments, block IDs, or both.
3. Exact Shared Objects CRDT schema.
4. Whether `status` is represented as explicit conflict-preserving values or derived from Automerge conflicts.
5. How much Obsidian Tasks syntax should v0.1 parse.
6. How remote updates preserve unusual local Task formatting.
7. Secure secret storage on desktop and mobile.
8. Resource naming and local metadata.
9. Copied-vault Principal safety.
10. Whether deleted shared objects remain tombstoned indefinitely.
11. How comments are projected, if at all.
12. How assignees map to human-friendly names without requiring global identity.
13. Mobile background synchronization.
14. How future VS Code and Obsidian implementations share the Markdown projection parser.
15. Whether the Shared Objects profile belongs in `sdk-ts` initially or deserves its own repository later.

---

# 75. Repository dependency map

Recommended dependency graph:

```text
openlfcp/spec
      │
      ├───────────────┐
      ▼               ▼
openlfcp/sdk-ts   openlfcp/sdk-rs
      │               │
      │               ▼
      │         openlfcp/server
      │
      ├───────────────┐
      ▼               ▼
openlfcp/obsidian  openlfcp/vscode
      │
      ▼
openlfcp/examples
```

The Obsidian repository MUST NOT become the place where protocol semantics are defined.

Protocol changes go to:

```text
openlfcp/spec
```

Reusable implementation logic goes to:

```text
openlfcp/sdk-ts
```

Obsidian-specific behavior goes to:

```text
openlfcp/obsidian
```

---

# 76. Architectural invariant summary

The first OpenLFCP Obsidian client is built around these invariants:

```text
1. Markdown remains local.

2. Sharing is explicit.

3. A shared object is identified independently of its Markdown location.

4. LFCP Resource identity is independent of server identity.

5. One note may reference objects from many Resources.

6. One shared object may have many local projections.

7. CRDT state is collaborative; Markdown is an editing projection.

8. Remote updates must not destroy unrelated local Markdown formatting.

9. The LFCP server does not need to understand Tasks or Markdown.

10. The Obsidian plugin does not implement LFCP cryptography itself.

11. Offline editing is normal.

12. Semantic conflicts are shown rather than silently discarded.

13. Routes may change without changing object references.

14. No global account is required for protocol correctness.

15. The same refs and Shared Objects should later work in VS Code and other editors.
```

---

# 77. Core product statement

The product should not be described merely as:

> collaborative Tasks for Obsidian.

The deeper model is:

> **OpenLFCP allows shared collaborative objects to live inside personal local-first documents without turning those documents into someone else's cloud workspace.**

For Obsidian, Tasks are the first concrete implementation of that model.

The architecture should preserve this property even as future clients add:

```text
Decisions
Approvals
Comments
Projects
Whole-document collaboration
Other editors
Multiple independent servers
Direct peer synchronization
```

---

# 78. Reference architecture

```text
                                  OPENLFCP

                          ┌──────────────────┐
                          │      SPEC        │
                          │ LFCP-WIRE        │
                          │ profiles         │
                          │ test vectors     │
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │    SDK-TS        │
                          │                  │
                          │ crypto           │
                          │ control          │
                          │ sync             │
                          │ routing          │
                          │ storage API      │
                          └────────┬─────────┘
                                   │
                                   ▼
                    ┌───────────────────────────┐
                    │     OBSIDIAN PLUGIN       │
                    │                           │
                    │ Markdown Scanner          │
                    │ Projection Engine         │
                    │ Task Adapter              │
                    │ Resource Explorer         │
                    │ Conflict UI               │
                    └────────────┬──────────────┘
                                 │
                 ┌───────────────┼────────────────┐
                 │               │                │
                 ▼               ▼                ▼

           private note     private note      private note
                 │               │                │
                 │               │                │
           shared task      shared task       shared decision
                 │               │                │
                 ▼               ▼                ▼
            Resource A       Resource B        Resource C
                 │               │                │
                 ▼               ▼                ▼
            Server A          Server B           Server C
```

The top half is reusable infrastructure.

The middle is the editor adapter.

The bottom is the federated local-first world visible through the user's personal vault.

---

# 79. Next specification documents

The next architecture/specification documents should be:

```text
MARKDOWN-REFS-01.md
SHARED-OBJECTS-PROFILE-01.md
OBSIDIAN-MVP-UX-01.md
```

Recommended order:

1. `SHARED-OBJECTS-PROFILE-01.md`
2. `MARKDOWN-REFS-01.md`
3. `OBSIDIAN-MVP-UX-01.md`

Once those are stable enough, implementation can begin without embedding unresolved protocol design directly into the plugin code.
