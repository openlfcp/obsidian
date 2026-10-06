// LFCP-065: the command handlers with a scripted prompter and in-memory
// notes, over a real runtime on an offline device.

import type { InvitationLink } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { SharedObjectsReplica, setStatus } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActiveNote,
  type Choice,
  CollabCommands,
  insertAtLine,
  type Prompter,
} from "../../../src/core/collab/commands";
import { PROJECT_SERVER_HINT } from "../../../src/core/collab/server-notice";
import { Collaboration, type ResourceStatus } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { MutationGuard } from "../../../src/core/projection/guard";
import { scanRefs } from "../../../src/core/refs";
import { PROJECT_SERVER, type RefPlacement } from "../../../src/core/settings";
import { Device, FakeLocal } from "../../support/lfcp-env";

const SERVER = "wss://offline.example.invalid/v1/ws";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of running.splice(0)) await r.stop();
});

/** Answers dialogs from a script: texts in order; choices by label. */
class ScriptedPrompter implements Prompter {
  readonly notices: string[] = [];
  readonly asked: string[] = [];
  readonly masked: boolean[] = [];
  readonly hints = new Map<string, (value: string) => unknown>();
  readonly progressLines: string[] = [];
  readonly invitations: { link: InvitationLink; preset: string; confirmed: boolean }[] = [];
  readonly statuses: { status: ResourceStatus; actions: string[] }[] = [];
  texts: (string | null)[] = [];
  picks: (string | null)[] = [];
  notice(message: string): void {
    this.notices.push(message);
  }
  async text(o: {
    title: string;
    masked?: boolean;
    hint?: (value: string) => unknown;
  }): Promise<string | null> {
    this.asked.push(o.title);
    if (o.hint !== undefined) this.hints.set(o.title, o.hint);
    this.masked.push(o.masked === true);
    return this.texts.shift() ?? null;
  }
  async choose<T>(o: { title: string; choices: readonly Choice<T>[] }): Promise<T | null> {
    this.asked.push(o.title);
    const label = this.picks.shift() ?? null;
    if (label === null) return null;
    const c = o.choices.find((x) => x.label === label);
    if (c === undefined)
      throw new Error(`no choice "${label}" in ${o.choices.map((x) => x.label)}`);
    return c.value;
  }
  async invitation(o: { link: InvitationLink; preset: string; confirmed: boolean }): Promise<void> {
    this.invitations.push(o);
  }
  async status(
    status: ResourceStatus,
    actions: readonly Choice<() => Promise<void>>[],
  ): Promise<void> {
    this.statuses.push({ status, actions: actions.map((a) => a.label) });
  }
  progress(title: string) {
    this.progressLines.push(title);
    return { update: (t: string) => this.progressLines.push(t), close: () => undefined };
  }
}

class Notes {
  readonly files = new Map<string, string>();
  cursor: ActiveNote | null = null;
  open(path: string, line: number): void {
    this.cursor = { path, line, text: this.files.get(path) ?? "" };
  }
  active(): ActiveNote | null {
    return this.cursor === null
      ? null
      : { ...this.cursor, text: this.files.get(this.cursor.path) ?? "" };
  }
  async rewrite(path: string, fn: (data: string) => string): Promise<void> {
    this.files.set(path, fn(this.files.get(path) ?? ""));
  }
}

async function setup(placement: RefPlacement = "child-line") {
  const device = new Device();
  const runtime = await LfcpRuntime.start(device.env(new FakeLocal()));
  running.push(runtime);
  const collab = new Collaboration(runtime, {
    connectTimeoutMs: 30,
    ackTimeoutMs: 30,
    joinTimeoutMs: 200,
  });
  const prompter = new ScriptedPrompter();
  const notes = new Notes();
  const guard = new MutationGuard();
  const settings = { placement };
  const commands = new CollabCommands({
    collab: () => collab,
    prompter,
    notes,
    guard,
    placement: () => settings.placement,
    defaultServer: () => SERVER,
  });
  return { device, runtime, collab, prompter, notes, guard, commands, settings };
}

/** Create a collaboration through the command. */
async function created(s: Awaited<ReturnType<typeof setup>>, name = "Team") {
  s.prompter.texts.push(name, SERVER);
  await s.commands.createCollaboration();
  const entry = (await s.runtime.registry()).find((e) => e.localName === name);
  if (entry === undefined) throw new Error("not created");
  return entry.resourceId;
}

describe("LFCP-065 commands", () => {
  it("Create collaboration asks a name and a server, offers the default, and says who owns it", async () => {
    const s = await setup();
    await created(s);
    expect(s.prompter.asked).toEqual(["Create collaboration", "Sync server"]);
    // The server field explains the project server, and only it.
    const hint = s.prompter.hints.get("Sync server");
    expect(hint?.(PROJECT_SERVER)).toBe(PROJECT_SERVER_HINT);
    expect(hint?.(SERVER)).toBeNull();
    expect([...s.prompter.hints.keys()]).toEqual(["Sync server"]);
    expect(s.prompter.notices.at(-1)).toMatch(
      /^OpenLFCP: "Team" created on this device\. The server .* is not reachable now/,
    );
  });

  it("Share task under cursor: child-line ref by default, guarded, and a second share creates nothing", async () => {
    const s = await setup();
    const R = await created(s);
    s.notes.files.set("a.md", "# Plan\n- [ ] Prepare API contract 📅 2026-10-15\n- [ ] Other\n");
    s.notes.open("a.md", 1);
    s.prompter.picks.push("Team");
    await s.commands.shareTaskUnderCursor();
    const text = s.notes.files.get("a.md") as string;
    const [p] = scanRefs(text).projections;
    expect(p?.placement).toBe("child");
    expect(text.split("\n")[1]).toBe("- [ ] Prepare API contract 📅 2026-10-15");
    expect(text.split("\n")[3]).toBe("- [ ] Other");
    expect(toHex(p?.resourceId as Uint8Array)).toBe(toHex(R));
    expect(s.guard.consume("a.md", text)).toBe(true);
    expect(s.prompter.notices.at(-1)).toBe("OpenLFCP: task shared.");
    const objects = (await s.runtime.profileOf(R)).replica.objectIds();
    expect(objects).toEqual([p?.objectId]);

    // Already bound (cursor on the Task or on its ref line): nothing new.
    for (const line of [1, 2]) {
      s.notes.open("a.md", line);
      await s.commands.shareTaskUnderCursor();
      expect(s.prompter.notices.at(-1)).toBe(
        "OpenLFCP: this task is already shared; nothing new was created.",
      );
    }
    expect((await s.runtime.profileOf(R)).replica.objectIds()).toEqual(objects);
    expect(s.notes.files.get("a.md")).toBe(text);
  });

  it("Share task under cursor: inline when configured; CRLF kept", async () => {
    const s = await setup("inline");
    await created(s);
    s.notes.files.set("b.md", "- [x] Done thing\r\n");
    s.notes.open("b.md", 0);
    s.prompter.picks.push("Team");
    await s.commands.shareTaskUnderCursor();
    const text = s.notes.files.get("b.md") as string;
    expect(text).toMatch(
      /^- \[x\] Done thing <!-- lfcp-ref: lfcp1:[A-Za-z0-9_-]{43}#task:[0-9a-f-]{36} -->\r\n$/,
    );
  });

  it("Share task under cursor: not a task, and a malformed ref, are refused", async () => {
    const s = await setup();
    await created(s);
    s.notes.files.set("c.md", "Just text\n- [ ] T <!-- lfcp-ref: lfcp1:bad -->\n");
    s.notes.open("c.md", 0);
    await s.commands.shareTaskUnderCursor();
    expect(s.prompter.notices.at(-1)).toMatch(/put the cursor on a task line/);
    s.notes.open("c.md", 1);
    await s.commands.shareTaskUnderCursor();
    expect(s.prompter.notices.at(-1)).toMatch(/malformed or duplicated/);
  });

  it("Insert shared object: renders the shared Task; the same object may appear again", async () => {
    const s = await setup();
    const R = await created(s);
    s.notes.files.set("a.md", "- [/] Prepare API contract ⏫\n");
    s.notes.open("a.md", 0);
    s.prompter.picks.push("Team");
    await s.commands.shareTaskUnderCursor();
    const objectId = scanRefs(s.notes.files.get("a.md") as string).projections[0]?.objectId;

    s.notes.files.set("other.md", "# Elsewhere\n\n- [ ] Local\n");
    for (const line of [1, 2]) {
      s.notes.open("other.md", line);
      s.prompter.picks.push("Team", "Prepare API contract");
      await s.commands.insertSharedObject();
    }
    const text = s.notes.files.get("other.md") as string;
    const projections = scanRefs(text).projections;
    expect(projections.map((p) => p.objectId)).toEqual([objectId, objectId]);
    expect(scanRefs(text).diagnostics).toEqual([]);
    expect(text.startsWith("# Elsewhere\n- [/] Prepare API contract ⏫\n  <!-- lfcp-ref: ")).toBe(
      true,
    );
    expect(s.prompter.notices.filter((n) => /duplicate/i.test(n))).toEqual([]);
    expect(s.guard.consume("other.md", text)).toBe(true);
    // Inserting creates no object.
    expect((await s.runtime.profileOf(R)).replica.objectIds()).toEqual([objectId]);
  });

  it("Detach shared task: removes only the ref; the shared object and the queue are untouched", async () => {
    const s = await setup();
    const R = await created(s);
    const before = "- [x] Prepare API contract\n- [ ] Next\n";
    s.notes.files.set("d.md", before);
    s.notes.open("d.md", 0);
    s.prompter.picks.push("Team");
    await s.commands.shareTaskUnderCursor();
    const objectId = scanRefs(s.notes.files.get("d.md") as string).projections[0]
      ?.objectId as string;
    const queued = (await s.runtime.storage?.outbound.list(R))?.length;
    s.notes.open("d.md", 1); // the ref line
    await s.commands.detachSharedTask();
    expect(s.notes.files.get("d.md")).toBe(before);
    expect(s.guard.consume("d.md", before)).toBe(true);
    expect((await s.runtime.profileOf(R)).replica.task(objectId)?.task?.lifecycle).toBe("active");
    expect((await s.runtime.storage?.outbound.list(R))?.length).toBe(queued);
    expect(s.prompter.notices.at(-1)).toMatch(/shared task itself is unchanged/);
  });

  it("Invite collaborator: preset choice, the link only in the invitation dialog", async () => {
    const s = await setup();
    await created(s);
    s.prompter.picks.push("Team", "Read + Write");
    await s.commands.inviteCollaborator();
    const [shown] = s.prompter.invitations;
    expect(shown?.preset).toBe("Read + Write");
    expect(shown?.confirmed).toBe(false);
    const link = shown?.link.reveal() as string;
    expect(link.startsWith("lfcp://join/")).toBe(true);
    const secret = link.slice(link.indexOf("#secret=") + 8);
    for (const line of [...s.prompter.notices, ...s.prompter.progressLines]) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("lfcp://join");
    }
  });

  it("Join collaboration: masked link prompt, stages, plain failure, no secret anywhere", async () => {
    const owner = await setup();
    const R = await created(owner);
    owner.prompter.picks.push("Team", "Read");
    await owner.commands.inviteCollaborator();
    const link = owner.prompter.invitations[0]?.link.reveal() as string;
    const s = await setup();
    s.prompter.texts.push(link, "Their team");
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });
    await s.commands.joinCollaboration();
    expect(s.prompter.masked).toEqual([true, false]);
    expect(s.prompter.progressLines).toEqual([
      "Joining collaboration",
      "Connecting to the collaboration's server…",
    ]);
    expect(s.prompter.notices.at(-1)).toMatch(/^OpenLFCP: could not join\. .*needs a connection/);
    const secret = link.slice(link.indexOf("#secret=") + 8);
    for (const line of [...s.prompter.notices, ...s.prompter.progressLines, ...logged])
      expect(line).not.toContain(secret);
    expect(await s.runtime.hasResource(R)).toBe(false);
  });

  it("Resource status: the view with a host action while hosting is pending", async () => {
    const s = await setup();
    await created(s);
    s.prompter.picks.push("Team");
    await s.commands.resourceStatus();
    const [shown] = s.prompter.statuses;
    expect(shown?.status.localName).toBe("Team");
    expect(shown?.actions).toEqual(["Host on the server now"]);
  });

  it("Conflict hook: picks a field and a value and resolves; nothing else resolves", async () => {
    const s = await setup();
    const R = await created(s);
    s.notes.files.set("e.md", "- [ ] Ship it\n");
    s.notes.open("e.md", 0);
    s.prompter.picks.push("Team");
    await s.commands.shareTaskUnderCursor();
    const objectId = scanRefs(s.notes.files.get("e.md") as string).projections[0]
      ?.objectId as string;
    const profile = await s.runtime.profileOf(R);
    const other = SharedObjectsReplica.fromChanges(profile.replica.changes(), {
      resource: R,
      principal: Uint8Array.from({ length: 32 }, () => 7) as never,
    }).replica;
    const task = other.task(objectId)?.task;
    if (task === undefined) throw new Error("no task");
    const theirs = other.apply(setStatus(task, "cancelled").intent);
    await s.runtime.writeIntent(R, setStatus(task, "done").intent);
    profile.replica.receiveChange(theirs?.change as Uint8Array);
    expect(profile.replica.task(objectId)?.fields.status.conflicted).toBe(true);

    s.prompter.picks.push("status", "done");
    await s.commands.resolveConflictUnderCursor();
    expect(s.prompter.notices.at(-1)).toBe("OpenLFCP: status resolved.");
    expect(profile.replica.task(objectId)?.fields.status.values).toEqual(["done"]);
    await s.commands.resolveConflictUnderCursor();
    expect(s.prompter.notices.at(-1)).toBe("OpenLFCP: this shared task has no conflicts.");
  });

  it("reports not ready instead of acting", async () => {
    const prompter = new ScriptedPrompter();
    const commands = new CollabCommands({
      collab: () => null,
      prompter,
      notes: new Notes(),
      guard: new MutationGuard(),
      placement: () => "child-line",
      defaultServer: () => "",
    });
    await commands.createCollaboration();
    expect(prompter.notices).toEqual([
      "OpenLFCP: not ready yet (starting, or writing is paused on this device).",
    ]);
  });
});

describe("insertAtLine", () => {
  const unit = (indent: string, eol: string) => `${indent}- [ ] T${eol}${indent}  <!-- r -->${eol}`;
  it("replaces a blank line, or goes after the cursor line, keeping line endings and list indentation", () => {
    expect(insertAtLine("A\r\n\r\nB\r\n", 1, unit)).toBe("A\r\n- [ ] T\r\n  <!-- r -->\r\nB\r\n");
    expect(insertAtLine("A\n  - [ ] x\nB\n", 1, unit)).toBe(
      "A\n  - [ ] x\n  - [ ] T\n    <!-- r -->\nB\n",
    );
    expect(insertAtLine("A", 0, unit)).toBe("A\n- [ ] T\n  <!-- r -->");
    expect(insertAtLine("", 0, unit)).toBe("- [ ] T\n  <!-- r -->");
  });
});
