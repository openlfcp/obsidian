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
import { resourceId as asResourceId, type ResourceId, toHex } from "@openlfcp/core";
import type { ScalarField, Task } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { NEEDS_NEWER_VERSION, type RegistryEntry } from "../lfcp/runtime";
import type { MutationGuard } from "../projection/guard";
import { renderNewTaskLine } from "../projection/render";
import type { ObjectRef } from "../refs";
import { splitLines } from "../refs/lines";
import { type SectionContext, sectionContext } from "../sections/context";
import type { RefPlacement } from "../settings";
import {
  attachAll,
  headingSection,
  type LineRange,
  MAX_BATCH,
  planBatchShare,
  tasksToInsert,
} from "./batch";
import { attachToTask, detachExact, taskAt, unitPlacement } from "./markdown";
import { plainError } from "./messages";
import { INVITE_PRESETS, type InvitePreset } from "./presets";
import { type Hint, serverHint } from "./server-notice";
import type { Collaboration, JoinStage, ResourceStatus } from "./service";

export interface Choice<T> {
  readonly label: string;
  readonly description?: string;
  readonly value: T;
}

/** Dialogs and notices of the editor (Obsidian: Modal, SuggestModal, Notice). */
export interface Prompter {
  notice(message: string): void;
  /**
   * A text field; `masked` hides what is typed (invitation links). `hint`
   * gives a line shown under the field for its current value, updated as
   * it changes (null: none). Null when cancelled.
   */
  text(options: {
    readonly title: string;
    readonly description?: string;
    readonly placeholder?: string;
    readonly value?: string;
    readonly masked?: boolean;
    readonly hint?: (value: string) => Hint | null;
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
  /** The lines of the editor selection, if text is selected (POST-018). */
  readonly selection?: LineRange;
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
  /** Shared sections (the `sectionsPreview` flag): their Resources can be invited to. */
  readonly sections?: () => boolean;
  /**
   * A command wrote `markdown` to `path`: the projection records it as the
   * note's index and bases at once, without waiting for the vault's echo,
   * which a quick edit can merge with (and hide) inside the change debounce.
   */
  readonly wrote?: (path: string, markdown: string) => void;
}

const STAGE_TEXT: Readonly<Record<JoinStage, string>> = {
  connecting: "Connecting to the collaboration's server…",
  "validating invitation": "Checking the invitation…",
  "retrieving key": "Receiving the collaboration's key…",
  "claiming capability": "Claiming access…",
  synchronizing: "Synchronizing…",
  "loading section": "Loading the shared section…",
};

const STATE_TEXT: Readonly<Record<RegistryEntry["state"], string>> = {
  available: "in sync",
  offline: "offline (changes are kept and sent later)",
  locked: "writing paused on this device",
  error: "sync error",
  refused: "not syncing: the server refused it",
  recovering: "waiting for the server to recover access",
  control_conflict: "BLOCKED: history forked",
  unsupported: "needs a newer version of Shared Tasks",
};

/** Object Refs name the raw Resource ID (MARKDOWN-REFS-01 §7). */
/** "1 task", "3 tasks". */
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What a batch left alone, for its notice: "" or " 1 already shared, 2 refused (…)." */
function skippedText(plan: { readonly skipped: number; readonly refused: number }): string {
  const out: string[] = [];
  if (plan.skipped > 0) out.push(`${plan.skipped} already shared`);
  if (plan.refused > 0)
    out.push(`${plan.refused} refused (a malformed or duplicated ref, or no title)`);
  return out.length === 0 ? "" : ` ${out.join(", ")}.`;
}

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
        "Shared Tasks: not ready yet (starting, or writing is paused on this device).",
      );
    return c;
  }

  /**
   * Task 100 (shared sections): the 0.1 commands act outside sections only.
   * True, after one notice, when `line`…`to` is inside a section, crosses
   * its boundary, or touches a damaged one. Checked before any dialog.
   */
  #refuseInSection(text: string, from: number, to: number, inside: string): boolean {
    const ctx: SectionContext = sectionContext(text, { from, to });
    if (ctx === "outside") return false;
    this.#env.prompter.notice(
      ctx === "inside"
        ? `Shared Tasks: ${inside}`
        : ctx === "crossing"
          ? "Shared Tasks: the selection crosses a shared section's boundary. Select lines on one side of it."
          : "Shared Tasks: a shared section's boundary here needs repair first. Nothing was changed.",
    );
    return true;
  }

  /**
   * Rewrites a note through the mutation guard: `next` returns the new
   * content, or null to leave the note as it is. Resolves to what was
   * written, or null.
   */
  async #rewrite(path: string, next: (data: string) => string | null): Promise<string | null> {
    let written: string | null = null;
    await this.#env.notes.rewrite(path, (data) => {
      const out = next(data);
      if (out === null) return data;
      this.#env.guard.expect(path, out);
      written = out;
      return out;
    });
    if (written !== null) this.#env.wrote?.(path, written);
    return written;
  }

  async #run(what: string, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (e) {
      if (e instanceof Abort) return;
      this.#env.prompter.notice(`Shared Tasks: ${what} failed. ${plainError(e)}`);
    }
  }

  async #pickResource(
    collab: Collaboration,
    title: string,
    options: {
      readonly allowCreate?: boolean;
      readonly blockedOk?: boolean;
      /** Status only: a collaboration this version cannot read can still be inspected. */
      readonly unsupportedOk?: boolean;
      /** A shared section's Resource (sections preview): the flow checks it is hosted and ready. */
      readonly sectionsOk?: boolean;
    } = {},
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
        'Shared Tasks: no collaboration yet. Use "Create collaboration" or "Join collaboration" first.',
      );
      return null;
    }
    const picked = await this.#env.prompter.choose({ title, choices });
    if (picked === null) return null;
    if (picked === "new") return (await this.#create(collab))?.resourceId ?? null;
    const entry = entries.find((e) => toHex(e.resourceId) === toHex(picked));
    const section = entry?.profile === SECTIONS_PROFILE_ID && options.sectionsOk === true;
    if (entry?.state === "unsupported" && options.unsupportedOk !== true && !section) {
      this.#env.prompter.notice(`Shared Tasks: ${NEEDS_NEWER_VERSION}.`);
      return null;
    }
    if (entry?.state === "control_conflict" && options.blockedOk !== true) {
      this.#env.prompter.notice(
        'Shared Tasks: this collaboration\'s history has forked. Sharing and invitations are blocked until it is resolved; see "Resource status".',
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
      // The project server says who runs it and links its privacy note.
      hint: serverHint,
    });
    if (server === null) return null;
    const created = await collab.create({ name, server });
    const h = created.hosting;
    p.notice(
      h.kind === "hosted"
        ? `Shared Tasks: "${name.trim()}" created and hosted. You own it.`
        : h.kind === "pending"
          ? `Shared Tasks: "${name.trim()}" created on this device. ${h.reason}`
          : `Shared Tasks: "${name.trim()}" created on this device, but the server refused to host it. ${h.message}`,
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
            ? outcome.section !== undefined
              ? `Shared Tasks: joined the shared section "${name.trim() || "Shared collaboration"}" (${outcome.abilities.includes("data/write") ? "read and write" : "read only"}). ${outcome.section.loaded ? 'Use "Insert shared section…" to place it in a note.' : 'It is still arriving: use "Insert shared section…" once it has loaded.'}`
              : `Shared Tasks: joined "${name.trim() || "Shared collaboration"}" (${outcome.abilities.includes("data/write") ? "read and write" : "read only"}).`
            : outcome.kind === "already-member"
              ? "Shared Tasks: this device is already in that collaboration."
              : outcome.kind === "needs-newer-version"
                ? `Shared Tasks: could not join. ${NEEDS_NEWER_VERSION}, then join again with the same link: it has not been used.`
                : `Shared Tasks: could not join. ${outcome.message}`,
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
        p.notice("Shared Tasks: put the cursor on a task line (- [ ] …) to share it.");
        return;
      }
      if (
        this.#refuseInSection(
          note.text,
          note.line,
          note.line,
          "this task is in a shared section: everything inside it is shared, including new tasks.",
        )
      )
        return;
      if (at.kind === "bound") {
        p.notice("Shared Tasks: this task is already shared; nothing new was created.");
        return;
      }
      if (at.kind === "blocked") {
        p.notice(
          "Shared Tasks: this task's lfcp-ref is malformed or duplicated. Fix or remove it first.",
        );
        return;
      }
      const R = await this.#pickResource(collab, "Share the task in…", { allowCreate: true });
      if (R === null) return;
      const lineText = splitLines(note.text)[at.state.task.line]?.text ?? "";
      const shared = await collab.share(R, at.state);
      const placement = this.#env.placement();
      const attached =
        (await this.#rewrite(note.path, (data) =>
          attachToTask(data, lineText, at.state.task.line, refOf(R, shared.objectId), placement),
        )) !== null;
      const warnings = shared.warnings.length === 0 ? "" : ` ${shared.warnings.join(" ")}`;
      p.notice(
        attached
          ? `Shared Tasks: task shared.${warnings}`
          : `Shared Tasks: the task was shared, but the note changed meanwhile, so no ref was added. Use "Insert shared object" to place it.${warnings}`,
      );
    });
  }

  /**
   * "Share selected tasks" (POST-018): every Task line of the selection, or
   * else of the heading section at the cursor, in one collaboration. Each
   * Task becomes its own task.create; all refs go in in one write.
   */
  shareSelectedTasks(): Promise<void> {
    return this.#run("Sharing the tasks", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const note = this.#env.notes.active();
      const range = note === null ? null : (note.selection ?? headingSection(note.text, note.line));
      if (note === null || range === null) {
        p.notice(
          "Shared Tasks: select task lines, or put the cursor under a heading, to share its tasks.",
        );
        return;
      }
      const inside = "these lines are in a shared section: everything inside it is shared already.";
      if (
        note.selection !== undefined
          ? this.#refuseInSection(note.text, range.from, range.to, inside)
          : this.#refuseInSection(note.text, note.line, note.line, inside)
      )
        return;
      const plan = planBatchShare(note.text, range);
      const n = plan.share.length;
      if (n === 0) {
        p.notice(`Shared Tasks: no task to share here.${skippedText(plan)}`);
        return;
      }
      if (n > MAX_BATCH) {
        p.notice(
          `Shared Tasks: ${n} tasks are more than ${MAX_BATCH} at once. Select fewer; nothing was shared.`,
        );
        return;
      }
      const R = await this.#pickResource(
        collab,
        `Share ${plural(n, "task")} in… (everyone invited to it sees every task in it)`,
        { allowCreate: true },
      );
      if (R === null) return;
      const lines = splitLines(note.text);
      const result = await collab.shareAll(R, plan.share);
      const pending = result.shared.map((s, i) => {
        const line = plan.share[i]?.task.line ?? 0;
        return { lineText: lines[line]?.text ?? "", near: line, ref: refOf(R, s.objectId) };
      });
      let attached = 0;
      if (pending.length > 0)
        await this.#rewrite(note.path, (data) => {
          const out = attachAll(data, pending, this.#env.placement());
          attached = out.attached;
          return out.attached === 0 ? null : out.markdown;
        });
      const shared = result.shared.length;
      const warnings = [...new Set(result.shared.flatMap((s) => s.warnings))];
      const parts = [`Shared Tasks: ${plural(shared, "task")} shared.${skippedText(plan)}`];
      if (attached < shared)
        parts.push(
          `${plural(shared - attached, "task")} got no ref because the note changed meanwhile; use "Insert all tasks from collaboration" to place them.`,
        );
      if (result.error !== undefined)
        parts.push(`Stopped after ${shared} of ${n}: ${plainError(result.error)}`);
      parts.push(...warnings);
      p.notice(parts.join(" "));
    });
  }

  /**
   * "Insert all tasks from collaboration" (POST-018): a projection of every
   * live Task of a collaboration this note does not show yet, at the
   * cursor, in created_at and Object ID order.
   */
  insertAllTasks(): Promise<void> {
    return this.#run("Inserting the shared tasks", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const note = this.#env.notes.active();
      if (note === null) {
        p.notice("Shared Tasks: open a note to insert shared tasks into.");
        return;
      }
      if (
        this.#refuseInSection(
          note.text,
          note.line,
          note.line,
          "put the cursor outside the shared section to insert tasks here.",
        )
      )
        return;
      const R = await this.#pickResource(collab, "Insert all tasks from…", { blockedOk: true });
      if (R === null) return;
      const all = await collab.insertCandidates(R);
      if (all.length === 0) {
        p.notice("Shared Tasks: this collaboration has no shared tasks yet.");
        return;
      }
      const missing = tasksToInsert(note.text, R, all);
      if (missing.length === 0) {
        p.notice("Shared Tasks: every task of this collaboration is already in this note.");
        return;
      }
      if (missing.length > MAX_BATCH) {
        p.notice(
          `Shared Tasks: ${missing.length} tasks are more than ${MAX_BATCH} at once; nothing was inserted.`,
        );
        return;
      }
      const tasks: { objectId: string; task: Task }[] = [];
      for (const t of missing) {
        const task = await collab.profileTask(R, t.objectId);
        if (task !== undefined) tasks.push({ objectId: t.objectId, task });
      }
      let inserted = 0;
      await this.#rewrite(note.path, (data) => {
        // Tasks placed while this command ran are not inserted twice.
        const still = new Set(tasksToInsert(data, R, missing).map((t) => t.objectId));
        const units = tasks.filter((t) => still.has(t.objectId));
        inserted = units.length;
        if (inserted === 0) return null;
        return insertAtLine(data, note.line, (indent, eol) =>
          units
            .map((t) =>
              renderNewTaskLine(t.task, {
                placement: unitPlacement(this.#env.placement()),
                ref: refOf(R, t.objectId),
                indent,
                eol,
              }),
            )
            .join(""),
        );
      });
      p.notice(`Shared Tasks: ${plural(inserted, "shared task")} inserted.`);
    });
  }

  insertSharedObject(): Promise<void> {
    return this.#run("Inserting the shared task", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const note = this.#env.notes.active();
      if (note === null) {
        p.notice("Shared Tasks: open a note to insert a shared task into.");
        return;
      }
      if (
        this.#refuseInSection(
          note.text,
          note.line,
          note.line,
          "put the cursor outside the shared section to insert tasks here.",
        )
      )
        return;
      const R = await this.#pickResource(collab, "Insert a task from…", { blockedOk: true });
      if (R === null) return;
      const tasks = await collab.tasks(R);
      if (tasks.length === 0) {
        p.notice("Shared Tasks: this collaboration has no shared tasks yet.");
        return;
      }
      const objectId = await p.choose({
        title: "Insert shared task",
        choices: tasks.map((t) => ({ label: t.title, description: t.status, value: t.objectId })),
      });
      if (objectId === null) return;
      const task = (await collab.profileTask(R, objectId)) ?? null;
      if (task === null) throw new Abort();
      await this.#rewrite(note.path, (data) =>
        insertAtLine(data, note.line, (indent, eol) =>
          renderNewTaskLine(task, {
            placement: unitPlacement(this.#env.placement()),
            ref: refOf(R, objectId),
            indent,
            eol,
          }),
        ),
      );
      p.notice("Shared Tasks: shared task inserted.");
    });
  }

  inviteCollaborator(): Promise<void> {
    return this.#run("Creating the invitation", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const p = this.#env.prompter;
      const R = await this.#pickResource(collab, "Invite to…", {
        sectionsOk: this.#env.sections?.() === true,
      });
      if (R === null) return;
      await this.#inviteTo(collab, R);
    });
  }

  /** "Invite collaborator" for one Resource (a section's details card, LFCP-02-059). */
  inviteTo(R: ResourceId): Promise<void> {
    return this.#run("Creating the invitation", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      await this.#inviteTo(collab, R);
    });
  }

  async #inviteTo(collab: Collaboration, R: ResourceId): Promise<void> {
    const p = this.#env.prompter;
    // A section not hosted or not ready is refused before any question.
    await collab.checkInvitable(R);
    // A shared section's invitation speaks of the section, not of tasks.
    const section = (await collab.status(R)).profile === SECTIONS_PROFILE_ID;
    const preset = await p.choose<InvitePreset>({
      title: "What may they do?",
      choices: (Object.keys(INVITE_PRESETS) as InvitePreset[]).map((k) => ({
        label: INVITE_PRESETS[k].label,
        description: `${section ? INVITE_PRESETS[k].sectionDescription : INVITE_PRESETS[k].description} One-time link.`,
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
  }

  resourceStatus(): Promise<void> {
    return this.#run("Showing the status", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      const R = await this.#pickResource(collab, "Status of…", {
        blockedOk: true,
        unsupportedOk: true,
      });
      if (R === null) return;
      await this.#statusOf(collab, R);
    });
  }

  /** "Resource status" for one Resource (a section's details card, LFCP-02-059). */
  resourceStatusOf(R: ResourceId): Promise<void> {
    return this.#run("Showing the status", async () => {
      const collab = this.#collab();
      if (collab === null) return;
      await this.#statusOf(collab, R);
    });
  }

  async #statusOf(collab: Collaboration, R: ResourceId): Promise<void> {
    const status = await collab.status(R);
    const actions: Choice<() => Promise<void>>[] = [];
    // A shared section (sections preview) is hosted like a collaboration.
    const section =
      this.#env.sections?.() === true &&
      (await collab.list()).find((e) => toHex(e.resourceId) === toHex(R))?.profile ===
        SECTIONS_PROFILE_ID;
    if (
      status.hosting !== "hosted" &&
      !status.blocked &&
      (status.state !== "unsupported" || section)
    )
      actions.push({
        label: "Host on the server now",
        value: async () => {
          const h = await collab.host(R);
          this.#env.prompter.notice(
            h.kind === "hosted"
              ? "Shared Tasks: hosted."
              : h.kind === "pending"
                ? `Shared Tasks: ${h.reason}`
                : `Shared Tasks: the server refused. ${h.message}`,
          );
        },
      });
    await this.#env.prompter.status(status, actions);
  }

  detachSharedTask(): Promise<void> {
    return this.#run("Detaching", async () => {
      const p = this.#env.prompter;
      const note = this.#env.notes.active();
      const at = note === null ? { kind: "none" as const } : taskAt(note.text, note.line);
      if (note === null || at.kind !== "bound") {
        p.notice(
          "Shared Tasks: put the cursor on a shared task (one with an lfcp-ref) to detach it.",
        );
        return;
      }
      if (
        this.#refuseInSection(
          note.text,
          note.line,
          note.line,
          "inside a shared section, a single task cannot be made private. Delete it to remove it for everyone, or detach the whole section here.",
        )
      )
        return;
      const key = `${toHex(at.ref.resourceId)}#${at.ref.objectId}`;
      await this.#rewrite(note.path, (data) => {
        const now = taskAt(data, at.ref.taskLine);
        if (now.kind !== "bound" || `${toHex(now.ref.resourceId)}#${now.ref.objectId}` !== key)
          throw new Error("The note changed; nothing was detached.");
        return detachExact(data, now.ref);
      });
      p.notice(
        "Shared Tasks: the task is no longer shared in this note. The shared task itself is unchanged.",
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
        p.notice("Shared Tasks: put the cursor on a shared task to resolve its conflicts.");
        return;
      }
      const R = asResourceId(at.ref.resourceId);
      const conflicts = await collab.conflicts(R, at.ref.objectId);
      if (conflicts.length === 0) {
        p.notice("Shared Tasks: this shared task has no conflicts.");
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
      await collab.resolve(R, at.ref.objectId, field, pick.v);
      p.notice(`Shared Tasks: ${field} resolved.`);
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
