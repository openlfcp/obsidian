// The LFCP-065 command handlers, Obsidian-free. An editor adapter supplies
// a Prompter (dialogs and notices) and NoteAccess (the active note and
// atomic writes); the handlers decide what to ask and call the flows in
// service.ts. Every Markdown write goes through guard.expect, so the
// projection engine skips it as the plugin's own echo and reindexes it.
//
// Secrets: the join link is read through a masked prompt and handed to the
// SDK; an invitation link is shown only in the invitation dialog (with a
// copy action). Neither is ever put in a notice, a log or settings.

import type { InvitationLink } from "@openlfcp/client";
import { resourceId as asResourceId, type ObjectId, type ResourceId, toHex } from "@openlfcp/core";
import type { ScalarField } from "@openlfcp/shared-objects";
import type { RegistryEntry } from "../lfcp/runtime";
import type { MutationGuard } from "../projection/guard";
import { renderNewTaskLine } from "../projection/render";
import type { ObjectRef } from "../refs";
import { splitLines } from "../refs/lines";
import type { RefPlacement } from "../settings";
import { attachToTask, detachExact, taskAt, unitPlacement } from "./markdown";
import { plainError } from "./messages";
import { INVITE_PRESETS, type InvitePreset } from "./presets";
import type { Collaboration, JoinStage, ResourceStatus } from "./service";

export interface Choice<T> {
  readonly label: string;
  readonly description?: string;
  readonly value: T;
}

/** Dialogs and notices of the editor (Obsidian: Modal, SuggestModal, Notice). */
export interface Prompter {
  notice(message: string): void;
  /** A text field; `masked` hides what is typed (invitation links). Null when cancelled. */
  text(options: {
    readonly title: string;
    readonly description?: string;
    readonly placeholder?: string;
    readonly value?: string;
    readonly masked?: boolean;
  }): Promise<string | null>;
  choose<T>(options: {
    readonly title: string;
    readonly choices: readonly Choice<T>[];
  }): Promise<T | null>;
  /** Shows a new invitation with a copy action. The only place a link is revealed. */
  invitation(options: {
    readonly link: InvitationLink;
    readonly preset: string;
    readonly confirmed: boolean;
  }): Promise<void>;
  /** The Resource status view; `actions` are offered as buttons. */
  status(status: ResourceStatus, actions: readonly Choice<() => Promise<void>>[]): Promise<void>;
  /** A progress line for a long step; update() replaces its text. */
  progress(title: string): { update(text: string): void; close(): void };
}

export interface ActiveNote {
  readonly path: string;
  /** 0-based line of the cursor. */
  readonly line: number;
  /** The note's current text, unsaved editor changes included. */
  readonly text: string;
}

/** The notes of the vault, as the commands need them. */
export interface NoteAccess {
  active(): ActiveNote | null;
  /** Atomic read-modify-write of a note (Obsidian: vault.process); `fn` may throw to abort. */
  rewrite(path: string, fn: (data: string) => string): Promise<void>;
}

export interface CommandEnv {
  /** The flows, or null while OpenLFCP is not ready. */
  readonly collab: () => Collaboration | null;
  readonly prompter: Prompter;
  readonly notes: NoteAccess;
  readonly guard: MutationGuard;
  readonly placement: () => RefPlacement;
  readonly defaultServer: () => string;
}

const STAGE_TEXT: Readonly<Record<JoinStage, string>> = {
  connecting: "Connecting to the collaboration's server…",
  "validating invitation": "Checking the invitation…",
  "retrieving key": "Receiving the collaboration's key…",
  "claiming capability": "Claiming access…",
  synchronizing: "Synchronizing…",
};

const STATE_TEXT: Readonly<Record<RegistryEntry["state"], string>> = {
  available: "in sync",
  offline: "offline (changes are kept and sent later)",
  locked: "writing paused on this device",
  error: "sync error",
  control_conflict: "BLOCKED: history forked",
};

/** Object Refs name the raw Resource ID (MARKDOWN-REFS-01 §7). */
const refOf = (R: ResourceId, objectId: string): ObjectRef => ({
  resourceId: R,
  objectType: "task",
  objectId,
});

class Abort extends Error {}

export class CollabCommands {
  readonly #env: CommandEnv;

  constructor(env: CommandEnv) {
    this.#env = env;
  }

  #collab(): Collaboration | null {
    const c = this.#env.collab();
    if (c === null)
      this.#env.prompter.notice(
        "OpenLFCP: not ready yet (starting, or writing is paused on this device).",
      );
    return c;
  }

  async #run(what: string, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (e) {
      if (e instanceof Abort) return;
      this.#env.prompter.notice(`OpenLFCP: ${what} failed. ${plainError(e)}`);
    }
  }

  async #pickResource(
    collab: Collaboration,
    title: string,
    options: { readonly allowCreate?: boolean; readonly blockedOk?: boolean } = {},
  ): Promise<ResourceId | null> {
    const entries = await collab.list();
    const choices: Choice<ResourceId | "new">[] = entries.map((e) => ({
      label: e.localName ?? "(unnamed collaboration)",
      description: `${STATE_TEXT[e.state]} · ${e.routes[0] ?? "no server"}`,
      value: e.resourceId,
    }));
    if (options.allowCreate === true)
      choices.push({ label: "Create a new collaboration…", value: "new" });
    if (choices.length === 0) {
      this.#env.prompter.notice(
        'OpenLFCP: no collaboration yet. Use "Create collaboration" or "Join collaboration" first.',
      );
      return null;
    }
    const picked = await this.#env.prompter.choose({ title, choices });
    if (picked === null) return null;
    if (picked === "new") return (await this.#create(collab))?.resourceId ?? null;
    const entry = entries.find((e) => toHex(e.resourceId) === toHex(picked));
    if (entry?.state === "control_conflict" && options.blockedOk !== true) {
      this.#env.prompter.notice(
        'OpenLFCP: this collaboration\'s history has forked. Sharing and invitations are blocked until it is resolved; see "Resource status".',
      );
      return null;
    }
    return picked;
  }

  async #create(collab: Collaboration): Promise<{ resourceId: ResourceId } | null> {
    const p = this.#env.prompter;
    const name = await p.text({
      title: "Create collaboration",
      description: "A name for this collaboration on this device. Only you see it.",
      placeholder: "Team tasks",
    });
    if (name === null) return null;
    const server = await p.text({
      title: "Sync server",
      description:
        "The server that relays this collaboration. It is not your identity and does not own the collaboration: you do. Your identity is a key pair on this device.",
      placeholder: "wss://sync.example.com/v1/ws",
      value: this.#env.defaultServer(),
    });
    if (server === null) return null;
    const created = await collab.create({ name, server });
    const h = created.hosting;
    p.notice(
      h.kind === "hosted"
        ? `OpenLFCP: "${name.trim()}" created and hosted. You own it.`
        : h.kind === "pending"
          ? `OpenLFCP: "${name.trim()}" created on this device. ${h.reason}`
          : `OpenLFCP: "${name.trim()}" created on this device, but the server refused to host it. ${h.message}`,
    );
    return { resourceId: created.resourceId };
  }

  createCollaboration(): Promise<void> {
    return this.#run("Creating the collaboration", async () => {
      const collab = this.#collab();
      if (collab !== null) await this.#create(collab);
    });
  }

  joinCollaboration(): Promise<void> {
    return this.#run("Joining", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const link = await p.text({
        title: "Join collaboration",
        description:
          "Paste the invitation link (lfcp://join/…). It works once, and only for you: treat it like a password.",
        placeholder: "lfcp://join/…",
        masked: true,
      });
      if (link === null || link.trim() === "") return;
      const name = await p.text({
        title: "Name this collaboration",
        description: "A name for it on this device. Only you see it.",
        placeholder: "Shared tasks",
      });
      if (name === null) return;
      const progress = p.progress("Joining collaboration");
      try {
        const outcome = await collab.join(link, {
          name,
          onStage: (s) => progress.update(STAGE_TEXT[s]),
        });
        p.notice(
          outcome.kind === "joined"
            ? `OpenLFCP: joined "${name.trim() || "Shared collaboration"}" (${outcome.abilities.includes("data/write") ? "read and write" : "read only"}).`
            : outcome.kind === "already-member"
              ? "OpenLFCP: this device is already in that collaboration."
              : `OpenLFCP: could not join. ${outcome.message}`,
        );
      } finally {
        progress.close();
      }
    });
  }

  shareTaskUnderCursor(): Promise<void> {
    return this.#run("Sharing the task", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const note = this.#env.notes.active();
      const at = note === null ? { kind: "none" as const } : taskAt(note.text, note.line);
      if (note === null || at.kind === "none") {
        p.notice("OpenLFCP: put the cursor on a task line (- [ ] …) to share it.");
        return;
      }
      if (at.kind === "bound") {
        p.notice("OpenLFCP: this task is already shared; nothing new was created.");
        return;
      }
      if (at.kind === "blocked") {
        p.notice(
          "OpenLFCP: this task's lfcp-ref is malformed or duplicated. Fix or remove it first.",
        );
        return;
      }
      const R = await this.#pickResource(collab, "Share the task in…", { allowCreate: true });
      if (R === null) return;
      const lineText = splitLines(note.text)[at.state.task.line]?.text ?? "";
      const shared = await collab.share(R, at.state);
      const placement = this.#env.placement();
      let attached = true;
      await this.#env.notes.rewrite(note.path, (data) => {
        const next = attachToTask(
          data,
          lineText,
          at.state.task.line,
          refOf(R, shared.objectId),
          placement,
        );
        if (next === null) {
          attached = false;
          return data;
        }
        this.#env.guard.expect(note.path, next);
        return next;
      });
      const warnings = shared.warnings.length === 0 ? "" : ` ${shared.warnings.join(" ")}`;
      p.notice(
        attached
          ? `OpenLFCP: task shared.${warnings}`
          : `OpenLFCP: the task was shared, but the note changed meanwhile, so no ref was added. Use "Insert shared object" to place it.${warnings}`,
      );
    });
  }

  insertSharedObject(): Promise<void> {
    return this.#run("Inserting the shared task", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const note = this.#env.notes.active();
      if (note === null) {
        p.notice("OpenLFCP: open a note to insert a shared task into.");
        return;
      }
      const R = await this.#pickResource(collab, "Insert a task from…", { blockedOk: true });
      if (R === null) return;
      const tasks = await collab.tasks(R);
      if (tasks.length === 0) {
        p.notice("OpenLFCP: this collaboration has no shared tasks yet.");
        return;
      }
      const objectId = await p.choose({
        title: "Insert shared task",
        choices: tasks.map((t) => ({ label: t.title, description: t.status, value: t.objectId })),
      });
      if (objectId === null) return;
      const task = (await collab.profileTask(R, objectId)) ?? null;
      if (task === null) throw new Abort();
      await this.#env.notes.rewrite(note.path, (data) => {
        const next = insertAtLine(data, note.line, (indent, eol) =>
          renderNewTaskLine(task, {
            placement: unitPlacement(this.#env.placement()),
            ref: refOf(R, objectId),
            indent,
            eol,
          }),
        );
        this.#env.guard.expect(note.path, next);
        return next;
      });
      p.notice("OpenLFCP: shared task inserted.");
    });
  }

  inviteCollaborator(): Promise<void> {
    return this.#run("Creating the invitation", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const R = await this.#pickResource(collab, "Invite to…");
      if (R === null) return;
      const preset = await p.choose<InvitePreset>({
        title: "What may they do?",
        choices: (Object.keys(INVITE_PRESETS) as InvitePreset[]).map((k) => ({
          label: INVITE_PRESETS[k].label,
          description: `${INVITE_PRESETS[k].description} One-time link.`,
          value: k,
        })),
      });
      if (preset === null) return;
      const progress = p.progress("Creating invitation");
      let invitation: Awaited<ReturnType<Collaboration["invite"]>>;
      try {
        progress.update("Recording the invitation and sending it to the server…");
        invitation = await collab.invite(R, preset);
      } finally {
        progress.close();
      }
      await p.invitation({
        link: invitation.link,
        preset: INVITE_PRESETS[preset].label,
        confirmed: invitation.confirmed,
      });
    });
  }

  resourceStatus(): Promise<void> {
    return this.#run("Showing the status", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const R = await this.#pickResource(collab, "Status of…", { blockedOk: true });
      if (R === null) return;
      const status = await collab.status(R);
      const actions: Choice<() => Promise<void>>[] = [];
      if (status.hosting !== "hosted" && !status.blocked)
        actions.push({
          label: "Host on the server now",
          value: async () => {
            const h = await collab.host(R);
            this.#env.prompter.notice(
              h.kind === "hosted"
                ? "OpenLFCP: hosted."
                : h.kind === "pending"
                  ? `OpenLFCP: ${h.reason}`
                  : `OpenLFCP: the server refused. ${h.message}`,
            );
          },
        });
      await this.#env.prompter.status(status, actions);
    });
  }

  detachSharedTask(): Promise<void> {
    return this.#run("Detaching", async () => {
      const p = this.#env.prompter;
      const note = this.#env.notes.active();
      const at = note === null ? { kind: "none" as const } : taskAt(note.text, note.line);
      if (note === null || at.kind !== "bound") {
        p.notice("OpenLFCP: put the cursor on a shared task (one with an lfcp-ref) to detach it.");
        return;
      }
      const key = `${toHex(at.ref.resourceId)}#${at.ref.objectId}`;
      await this.#env.notes.rewrite(note.path, (data) => {
        const now = taskAt(data, at.ref.taskLine);
        if (now.kind !== "bound" || `${toHex(now.ref.resourceId)}#${now.ref.objectId}` !== key)
          throw new Error("The note changed; nothing was detached.");
        const next = detachExact(data, now.ref);
        this.#env.guard.expect(note.path, next);
        return next;
      });
      p.notice(
        "OpenLFCP: the task is no longer shared in this note. The shared task itself is unchanged.",
      );
    });
  }

  /**
   * The conflict hook: the competing values of a conflicted field of the
   * shared task under the cursor, resolved with task.resolve_field_conflict.
   * Editing or ticking the task is not a resolution (LFCP-061 item 8).
   */
  resolveConflictUnderCursor(): Promise<void> {
    return this.#run("Resolving the conflict", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const note = this.#env.notes.active();
      const at = note === null ? { kind: "none" as const } : taskAt(note.text, note.line);
      if (note === null || at.kind !== "bound") {
        p.notice("OpenLFCP: put the cursor on a shared task to resolve its conflicts.");
        return;
      }
      const R = asResourceId(at.ref.resourceId);
      const conflicts = await collab.conflicts(R, at.ref.objectId);
      if (conflicts.length === 0) {
        p.notice("OpenLFCP: this shared task has no conflicts.");
        return;
      }
      const field = await p.choose<ScalarField>({
        title: "Which field?",
        choices: conflicts.map((c) => ({
          label: c.field,
          description: c.values.map((v) => v ?? "(none)").join(" · "),
          value: c.field,
        })),
      });
      if (field === null) return;
      const values = conflicts.find((c) => c.field === field)?.values ?? [];
      const pick = await p.choose<{ v: string | null }>({
        title: `Keep which ${field}?`,
        choices: values.map((v) => ({ label: v ?? "(clear)", value: { v } })),
      });
      if (pick === null) return;
      await collab.resolve(R, at.ref.objectId as ObjectId, field, pick.v);
      p.notice(`OpenLFCP: ${field} resolved.`);
    });
  }
}

/**
 * Inserts the lines `make(indent, eol)` returns at a cursor line: in place
 * of it when blank, else after it, in the note's line ending style. A
 * list item's indentation is kept, so the task joins that list.
 */
export function insertAtLine(
  markdown: string,
  line: number,
  make: (indent: string, eol: string) => string,
): string {
  const lines = splitLines(markdown);
  const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  const at = Math.min(Math.max(line, 0), lines.length - 1);
  const current = lines[at] ?? { text: "", eol: "" };
  const blank = /^[ \t]*$/.test(current.text);
  const indent = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]/.exec(current.text)?.[1] ?? "";
  const unit = make(indent, eol);
  const before = lines
    .slice(0, at)
    .map((l) => l.text + l.eol)
    .join("");
  if (blank) {
    const after = lines
      .slice(at + 1)
      .map((l) => l.text + l.eol)
      .join("");
    // A blank last line without an ending: the unit ends the note without one either.
    const body =
      current.eol === "" && after === "" ? unit.slice(0, unit.length - eol.length) : unit;
    return before + body + after;
  }
  const head = before + current.text + (current.eol === "" ? eol : current.eol);
  const after = lines
    .slice(at + 1)
    .map((l) => l.text + l.eol)
    .join("");
  const body = current.eol === "" && after === "" ? unit.slice(0, unit.length - eol.length) : unit;
  return head + body + after;
}
