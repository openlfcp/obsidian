// LFCP-03-014 (U03-04, U03-05, U03-08, U03-26; F-02, F-07): Share and
// Invite as one journey in the pane. The real executor (SectionActions),
// the real invitation commands (CollabCommands) and the real dispatcher,
// on recording ports; the pane is what hostPane and paneModel make of the
// host's facts after each step, and each click is the pane's: the action
// its drawing offers, with the request that drawing gives.
//
//   pane (heading or exact selection: preview with the content policy and
//   the sync server) → Share section… → the share dialog → created: on its
//   server ("ready to invite") or on this device only (not invitable) →
//   Invite collaborator… → the role, chosen explicitly → the link, hidden
//   until Copy link / Show link → "Link copied".
//
// Also: a source changed under an open preview is reviewed again (heading)
// or refused (exact selection); one invitation at a time; 0.1 shared Tasks
// go through the explicit import only; nothing is widened, nothing is sent
// by itself.

import { fromBase64url, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import type { ActionId } from "../../../src/core/actions/catalog";
import { ActionDispatcher, coreHandlers } from "../../../src/core/actions/dispatcher";
import {
  type Choice,
  CollabCommands,
  ONE_TIME_LINK,
  type Prompter,
} from "../../../src/core/collab/commands";
import { hostPane, type PaneAccess } from "../../../src/core/pane/host-facts";
import { type PaneModel, paneModel, paneTexts } from "../../../src/core/pane/model";
import type {
  CreationService,
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TextChange,
} from "../../../src/core/sections/action-ports";
import { SectionActions } from "../../../src/core/sections/actions";
import type { CreationEntry, CreationResult } from "../../../src/core/sections/create";
import { applyChanges } from "../../../src/core/sections/engine";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { INVITE_STOPPED } from "../../../src/core/sections/invite-check";
import type { RegistrySnapshot } from "../../../src/core/sections/registry-view";
import type { SharePreview } from "../../../src/core/sections/share";
import type { TargetCapture, TextSelection } from "../../../src/core/sections/target";
import type { SectionCard } from "../../../src/core/status/card";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const KEY = `${R0}#${SID}`;
const REF = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
const SERVER = "wss://sync.example/v1/ws";
const PATH = "Plan.md";
const NOTE = [
  "# Notes",
  "",
  "## Plan",
  "- [ ] Alpha",
  "- [ ] Beta",
  "",
  "Private after.",
  "",
  "## Later",
  "Other text.",
  "",
].join("\n");
const PLAN = 2;

/** A dialog the test answers when it chooses: its result waits until then. */
class Dialog<T> {
  answered = false;
  forward = 0;
  #resolve: (v: T) => void = () => undefined;
  readonly result = new Promise<T>((r) => {
    this.#resolve = r;
  });
  constructor(
    readonly kind: string,
    readonly args: readonly unknown[],
  ) {}
  bringForward(): void {
    this.forward++;
  }
  answer(v: T): void {
    this.answered = true;
    this.#resolve(v);
  }
}

/** The section dialogs, left open until the test answers them. */
class Dialogs implements SectionPrompter {
  readonly notices: string[] = [];
  readonly all: Dialog<unknown>[] = [];
  #open<T>(kind: string, ...args: unknown[]): Dialog<T> {
    const d = new Dialog<T>(kind, args);
    this.all.push(d as Dialog<unknown>);
    return d;
  }
  open(kind: string): Dialog<unknown> {
    const d = this.all.find((x) => !x.answered && x.kind === kind);
    if (d === undefined) throw new Error(`no open ${kind} dialog`);
    return d;
  }
  kinds(): string[] {
    return this.all.map((d) => d.kind);
  }
  notice(m: string): void {
    this.notices.push(m);
  }
  announce(): void {}
  sharePreview(p: SharePreview, note?: string) {
    return this.#open<boolean>("share", p, note);
  }
  importPreview(title: string, p: unknown) {
    return this.#open<never>("import", title, p);
  }
  pickSection(c: readonly unknown[]) {
    return this.#open<never>("pick", c);
  }
  insertPreview(p: unknown) {
    return this.#open<boolean>("insert", p);
  }
  confirm(o: unknown) {
    return this.#open<boolean>("confirm", o);
  }
  async alias(): Promise<string | null> {
    return null;
  }
  repair() {
    return { result: Promise.resolve(), bringForward: () => undefined };
  }
  review(): void {}
  card() {
    return { update: () => undefined, close: () => undefined };
  }
}

/** Notes in memory, all open in an editor. */
class Notes implements SectionNotes {
  readonly files = new Map<string, string>();
  cursor = PLAN;
  selections: TextSelection[] = [];
  capture(path: string): TargetCapture | null {
    const text = this.files.get(path);
    if (text === undefined) return null;
    return {
      path,
      text,
      mode: "source",
      cursorLine: this.cursor,
      selections: this.selections,
      composing: false,
    };
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async edit(path: string, fn: (c: string) => readonly TextChange[] | null): Promise<void> {
    const c = this.files.get(path);
    const changes = c === undefined ? null : fn(c);
    if (c !== undefined && changes !== null) this.files.set(path, applyChanges(c, changes));
  }
  async goToLine(): Promise<TargetCapture | null> {
    return null;
  }
}

/** The invitation dialogs and choices of CollabCommands, answered when the test chooses. */
class InvitePrompter implements Prompter {
  readonly notices: string[] = [];
  readonly choices: Choice<unknown>[][] = [];
  role: Dialog<unknown> | null = null;
  link: Dialog<void> | null = null;
  shown: { preset: string; confirmed: boolean; copied?: () => void; reveal: () => string } | null =
    null;
  notice(m: string): void {
    this.notices.push(m);
  }
  async text(): Promise<string | null> {
    return null;
  }
  choose<T>(o: { readonly choices: readonly Choice<T>[] }): Promise<T | null> {
    this.choices.push([...o.choices] as Choice<unknown>[]);
    this.role = new Dialog("role", []);
    return this.role.result as Promise<T | null>;
  }
  invitation(o: Parameters<Prompter["invitation"]>[0]): Promise<void> {
    this.shown = {
      preset: o.preset,
      confirmed: o.confirmed,
      ...(o.copied === undefined ? {} : { copied: o.copied }),
      reveal: () => o.link.reveal(),
    };
    this.link = new Dialog<void>("link", []);
    return this.link.result;
  }
  async status(): Promise<void> {}
  progress() {
    return { update: () => undefined, close: () => undefined };
  }
}

const healthy: StatusFacts = {
  session: "s",
  revision: 1,
  replica: "loaded",
  access: "writer",
  accessVerifiedAt: 1,
  accessCurrent: true,
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [],
  acceptanceEvidence: "available",
  projections: [],
};

/** The note as a creation binds it: the approved range between the section's markers. */
function bound(text: string, preview: SharePreview): string {
  const lines = text.split("\n");
  const { headingLine, lastLine } = preview.range;
  return [
    ...lines.slice(0, headingLine + 1),
    formatBoundary("start", REF),
    ...lines.slice(headingLine + 1, lastLine + 1),
    formatBoundary("end", REF),
    ...lines.slice(lastLine + 1),
  ].join("\n");
}

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function journey(o: { result?: "hosted" | "local" } = {}) {
  const calls: string[] = [];
  const dialogs = new Dialogs();
  const notes = new Notes();
  notes.files.set(PATH, NOTE);
  /** What the host knows of the section once created: its access list's facts. */
  let access: PaneAccess | undefined;
  /** The section's status facts, as the status pass would give them. */
  let facts: StatusFacts = healthy;
  let created = false;
  const creation: CreationService = {
    async current() {
      return undefined;
    },
    async prepare(path: string, _md: string, preview: SharePreview): Promise<CreationEntry> {
      calls.push(
        `prepare "${preview.title}" ${preview.range.headingLine}-${preview.range.lastLine}`,
      );
      return {
        operationId: "op-1",
        path,
        resource: R0,
        sectionId: SID,
        nodeIds: [],
        intents: [],
        preview,
        phase: "prepared" as CreationEntry["phase"],
      };
    },
    async prepareImport(): Promise<CreationEntry> {
      throw new Error("not in this test");
    },
    async run(e: CreationEntry): Promise<CreationResult> {
      calls.push(`run ${e.operationId}`);
      notes.files.set(e.path, bound(notes.files.get(e.path) ?? "", e.preview));
      created = true;
      const hosted = (o.result ?? "hosted") === "hosted";
      access = { canInvite: true, hosting: hosted ? "hosted" : "pending" };
      return hosted
        ? { kind: "hosted", entry: e }
        : { kind: "local", entry: e, reason: "The sync server is not reachable." };
    },
    async cancel(e: CreationEntry) {
      return e;
    },
    async imports() {
      return [];
    },
    async rollback(e: CreationEntry) {
      return { kind: "none" as const, entry: e };
    },
  };
  const services = {
    creation: () => creation,
    insertion: () => null,
    bases: () => null,
    candidates: () => null,
    model: () => null,
    readOnly: () => false,
    server: () => SERVER,
    refPlacement: () => "child-line",
    sectionChoices: async () => [],
    legacySource: async () => undefined,
    watch: async () => undefined,
    indexed: () => undefined,
    pass: () => undefined,
    forget: () => undefined,
    registryChanged: () => undefined,
    scheduleStatus: () => undefined,
    unavailable: () => null,
    known: () => true,
    // The card's facts: the same status and access list the pane reads.
    cardContent: async (key: string, title: string) =>
      created && key === KEY
        ? ({
            heading: title,
            view: statusView(facts),
            ...(access === undefined
              ? {}
              : {
                  access: { invite: access.canInvite, remove: null, removeNote: null },
                  hosting: access.hosting,
                }),
          } as unknown as SectionCard)
        : null,
    held: () => [],
    recoveryItems: () => [],
    resolveRecovery: async () => undefined,
    commands: () => null,
    aliases: async () => ({}),
    setAlias: async () => true,
    revokeAccess: async () => null,
  } as unknown as SectionServices;
  const actions = new SectionActions({ prompter: dialogs, notes, services });

  const invites: { R: string; preset: string }[] = [];
  const prompter = new InvitePrompter();
  const collab = {
    async checkInvitable(R: ResourceId) {
      calls.push(`checkInvitable ${toHex(R).slice(0, 8)}`);
    },
    async status() {
      return { profile: SECTIONS_PROFILE_ID };
    },
    // The palette's list: the section's Resource, once shared.
    async list() {
      return created
        ? [
            {
              resourceId: fromBase64url(R0),
              localName: "Plan",
              state: "available",
              routes: [SERVER],
              profile: SECTIONS_PROFILE_ID,
            },
          ]
        : [];
    },
    async invite(R: ResourceId, preset: string) {
      invites.push({ R: toHex(R), preset });
      return { link: { reveal: () => "lfcp://join/secret" }, confirmed: true };
    },
  };
  const commands = new CollabCommands({
    collab: () => collab as never,
    prompter,
    notes: { active: () => null, rewrite: async () => undefined },
    guard: {} as never,
    placement: () => "child-line",
    defaultServer: () => SERVER,
    sections: () => true,
    // As the plugin wires it (sections host): the card's invite descriptor, read now (LFCP-03-041).
    inviteRefusal: (R) => actions.inviteRefusal(`${toBase64url(R)}#${SID}`),
  });
  const dispatcher = new ActionDispatcher(
    coreHandlers({ sections: () => actions, collab: commands }),
  );

  const registry = (): RegistrySnapshot => ({
    version: 1,
    status: "ready",
    error: null,
    placementIndex: "complete",
    rows: created
      ? [
          {
            resource: R0,
            sectionId: SID,
            key: KEY,
            sharedTitle: "Plan",
            localAlias: null,
            registryState: "available",
            refusal: null,
            status: { watched: true, state: "CURRENT", label: null },
            placements: [{ path: PATH } as never],
            placementCount: 1,
            placed: "placed",
          },
        ]
      : [],
    sections: created ? 1 : 0,
    unplaced: 0,
  });
  let pinned: number | null = null;
  /** The pane now: one reading of the host's facts (the plugin's #pane, without Obsidian). */
  const pane = () => {
    const invitation = commands.invitation();
    const d = hostPane({
      note: notes.capture(PATH),
      registry: registry(),
      status: (key) => (created && key === KEY ? statusView(facts) : undefined),
      access: (key) => (key === KEY ? access : undefined),
      policy: { server: SERVER, comments: "local" },
      flows: actions.flows(),
      pinned,
      invitation:
        invitation === null
          ? null
          : {
              resource: R0,
              stage: invitation.stage,
              confirmed: invitation.confirmed,
            },
      journey: (key) => {
        const shared = actions.shareResult(key);
        const copied = commands.linkCopied(
          fromBase64url(key.slice(0, key.indexOf("#"))) as ResourceId,
        );
        return {
          ...(shared === undefined ? {} : { shared }),
          ...(copied ? { linkCopied: true } : {}),
        };
      },
    });
    pinned = d.pinned;
    const model = paneModel(d.facts);
    return { model, request: d.request, texts: paneTexts(model) };
  };
  /** A click on the pane's button `id`: only one the pane draws, enabled; through the dispatcher. */
  const click = (id: ActionId): Promise<void> => {
    const p = pane();
    const offered = [p.model.primary, ...p.model.secondary].find((a) => a?.id === id);
    if (offered?.enabled !== true)
      throw new Error(`${id} is not offered enabled: ${JSON.stringify(offered)}`);
    return dispatcher.run(id, p.request(id), "pane");
  };
  /** What the section's facts rest on changed: its access list, or its status. */
  const set = (o: { access?: PaneAccess | undefined; facts?: StatusFacts }) => {
    if ("access" in o) access = o.access;
    if (o.facts !== undefined) facts = o.facts;
  };
  return { calls, dialogs, notes, actions, commands, prompter, invites, pane, click, set };
}

const enabled = (m: PaneModel, id: ActionId) =>
  [m.primary, ...m.secondary].find((a) => a?.id === id);

describe("share → invite in the pane (LFCP-03-014)", () => {
  it("heading → preview with the policy and server → hosted → explicit invite → Link copied", async () => {
    const t = journey();
    // The pane before anything: the heading's preview, its content policy and the sync server.
    const first = t.pane();
    expect(first.model.primary?.id).toBe("share-section");
    expect(first.model.preview).toEqual([
      "Everything inside this section, including future additions, will be shared.",
      "2 tasks, 1 paragraph, 0 list items.",
      `Sync server: ${SERVER}. To use another one, change it in the settings first.`,
    ]);
    expect(enabled(first.model, "open-settings")?.enabled).toBe(true);

    const sharing = t.click("share-section");
    await flush();
    // The share dialog is the review; the pane shows the flow on its note, not a second preview.
    const preview = t.dialogs.open("share");
    expect(t.pane().model.flow?.title).toBe("Sharing a section");
    expect(t.pane().model.preview).toEqual([]);
    expect(t.calls).toEqual([]);
    preview.answer(true);
    await sharing;
    expect(t.calls).toEqual(['prepare "Plan" 2-6', "run op-1"]);

    // Created and on its server: ready to invite, and the next step is Invite collaborator….
    const after = t.pane();
    expect(after.texts).toContain("Shared and on its sync server: ready to invite.");
    expect(after.model.primary?.id).toBe("invite");
    // Nothing is sent by itself: no invitation before the click.
    expect(t.invites).toEqual([]);

    const inviting = t.click("invite");
    await flush();
    // The role is the user's choice, Read first; the pane says what the link does (D2).
    expect(t.prompter.choices[0]?.map((c) => c.label)).toEqual(["Read", "Read + write"]);
    for (const c of t.prompter.choices[0] ?? []) expect(c.description).toContain(ONE_TIME_LINK);
    const role = t.pane();
    expect(role.model.flow?.title).toBe("Inviting a collaborator");
    expect(role.texts).toContain(ONE_TIME_LINK);
    expect(role.model.primary).toBeNull();
    expect(role.model.primaryNone).toBe("Choose Read or Read + write in the invitation dialog.");
    expect(enabled(role.model, "invite")).toMatchObject({
      enabled: false,
      reason: "An invitation is open. Finish it in its dialog.",
    });
    t.prompter.role?.answer("read-write");
    await flush();
    expect(t.invites).toEqual([{ R: toHex(fromBase64url(R0)), preset: "read-write" }]);

    // The link: hidden until Copy link or Show link, the server's confirmation said.
    const link = t.pane();
    expect(link.texts).toContain("The server has the invitation: the link works now.");
    expect(link.texts.join(" ")).not.toContain("lfcp://join/");
    expect(link.model.primaryNone).toBe("Copy or show the link in the invitation dialog.");
    t.prompter.shown?.copied?.();
    expect(t.pane().model.notice).toBe("Link copied");
    t.prompter.link?.answer();
    await inviting;

    // Done: the section again, "Link copied", never "sent" or "invited".
    const done = t.pane();
    expect(done.model.flow).toBeNull();
    expect(done.model.notice).toBe("Link copied");
    expect(done.model.primary?.id).toBe("invite");
    for (const text of [...done.texts, ...link.texts, ...role.texts]) {
      expect(text.toLowerCase()).not.toContain("invitation sent");
      expect(text.toLowerCase()).not.toContain("invited");
    }
  });

  it("created on this device only: told apart, and not ready to invite (I4)", async () => {
    const t = journey({ result: "local" });
    const sharing = t.click("share-section");
    await flush();
    t.dialogs.open("share").answer(true);
    await sharing;
    const p = t.pane();
    expect(p.texts).toContain(
      "Created on this device only: not on its sync server yet, so nobody can join. The sync server is not reachable.",
    );
    expect(p.texts).not.toContain("Shared and on its sync server: ready to invite.");
    expect(p.model.primary?.id).not.toBe("invite");
    expect(enabled(p.model, "invite")).toMatchObject({
      enabled: false,
      reason: "Not on its server yet: nobody can join until it is hosted.",
    });
    expect(() => t.click("invite")).toThrow(/not offered enabled/);
    expect(t.invites).toEqual([]);
  });

  it("a heading's source changed under the open preview: reviewed again, nothing created before", async () => {
    const t = journey();
    const sharing = t.click("share-section");
    await flush();
    t.notes.files.set(PATH, NOTE.replace("- [ ] Beta", "- [ ] Beta\n- [ ] Gamma"));
    // The pane's own preview follows the note (drawn again for the flow's end).
    t.dialogs.open("share").answer(true);
    await flush();
    expect(t.calls).toEqual([]);
    const again = t.dialogs.open("share");
    expect(again.args[1]).toBe(
      "The note changed while the preview was open. Review the section again.",
    );
    expect((again.args[0] as SharePreview).counts.tasks).toBe(3);
    again.answer(true);
    await sharing;
    expect(t.calls).toEqual(['prepare "Plan" 2-7', "run op-1"]);
  });

  it("an exact selection: previewed as it is; changed under the preview, refused, never widened", async () => {
    const t = journey();
    // From the heading through "- [ ] Beta": the private paragraph after it stays out.
    t.notes.selections = [{ anchor: { line: 2, ch: 0 }, head: { line: 4, ch: 10 } }];
    t.notes.cursor = 4;
    const p = t.pane();
    expect(p.model.context.lines).toContain("Selection: lines 3–5");
    expect(p.model.preview).toContain("2 tasks, 0 paragraphs, 0 list items.");
    expect(p.model.preview).toContain(
      "The text after the section, under the same heading, stays private, but Obsidian folds, drags and embeds it with the heading.",
    );
    const sharing = t.click("share-section");
    await flush();
    expect((t.dialogs.open("share").args[0] as SharePreview).range).toEqual({
      headingLine: 2,
      lastLine: 4,
    });
    t.notes.files.set(PATH, NOTE.replace("- [ ] Alpha", "- [ ] Alpha edited"));
    t.dialogs.open("share").answer(true);
    await sharing;
    expect(t.calls).toEqual([]);
    expect(t.dialogs.notices).toContain(
      "Shared Tasks: the note changed while the preview was open. Nothing was shared; select the lines and share again.",
    );
  });

  it("an ineligible selection is not widened: only the explicit Share the whole section…", () => {
    const t = journey();
    t.notes.selections = [{ anchor: { line: 3, ch: 0 }, head: { line: 4, ch: 10 } }];
    t.notes.cursor = 4;
    const p = t.pane();
    expect(p.model.primary?.id).toBe("share-whole-section");
    expect(p.model.preview).toEqual([]);
    expect(enabled(p.model, "share-section")?.enabled).toBe(false);
  });

  it("one invitation at a time: a second Invite meanwhile creates none (single flight)", async () => {
    const t = journey();
    const sharing = t.click("share-section");
    await flush();
    t.dialogs.open("share").answer(true);
    await sharing;
    const first = t.click("invite");
    await flush();
    // The palette's entry (or a hotkey) meanwhile: the same lock, no second dialog.
    await t.commands.inviteTo(fromBase64url(R0) as ResourceId);
    expect(t.prompter.choices).toHaveLength(1);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: an invitation is being created. Its link appears when the server has it.",
    ]);
    // Cancelling the role choice creates nothing, and ends the flow in the pane.
    t.prompter.role?.answer(null);
    await first;
    expect(t.invites).toEqual([]);
    expect(t.pane().model.flow).toBeNull();
    expect(t.pane().model.notice).toBeNull();
  });

  it("0.1 shared Tasks: Share section… opens the explicit import (new identities), not a share", async () => {
    const t = journey();
    const ref = `<!-- lfcp-ref: lfcp1:${R0}#task:0192e4a0-0000-7000-8000-000000000001 -->`;
    t.notes.files.set(PATH, NOTE.replace("- [ ] Alpha", `- [ ] Alpha ${ref}`));
    const p = t.pane();
    expect(p.model.primary?.id).toBe("share-section");
    expect(p.model.preview).toContain(
      "1 task here is already shared in another collaboration. Share section… opens the import: it makes new shared tasks with new identities, and the existing collaborations continue separately.",
    );
    // An exact selection over it: the same explicit import, offered.
    t.notes.selections = [{ anchor: { line: 2, ch: 0 }, head: { line: 4, ch: 10 } }];
    t.notes.cursor = 4;
    expect(t.pane().model.primary?.id).toBe("share-section");
    const importing = t.click("share-section");
    await flush();
    expect(t.dialogs.kinds()).toEqual(["import"]);
    t.dialogs.open("import").answer(null as never);
    await importing;
    expect(t.calls).toEqual([]);
  });
});

describe("the palette's Invite collaborator… re-checks access (I4, LFCP-03-041)", () => {
  /** A shared, hosted section with its access current: the pane offers Invite. */
  async function shared() {
    const t = journey();
    const sharing = t.click("share-section");
    await flush();
    t.dialogs.open("share").answer(true);
    await sharing;
    expect(t.pane().model.primary?.id).toBe("invite");
    return t;
  }
  /** "Invite collaborator…" from the palette: the section picked; the dialogs it opened after. */
  async function palette(t: Awaited<ReturnType<typeof shared>>) {
    const before = t.prompter.choices.length;
    const run = t.commands.inviteCollaborator();
    await flush();
    expect(t.prompter.choices[before]?.map((c) => c.label)).toEqual(["Plan"]);
    t.prompter.role?.answer(fromBase64url(R0));
    await flush();
    return { run, roles: t.prompter.choices.slice(before + 1) };
  }
  const reason = (t: Awaited<ReturnType<typeof shared>>) => {
    const invite = enabled(t.pane().model, "invite");
    expect(invite?.enabled).toBe(false);
    return (invite as { reason: string }).reason;
  };

  const offline: StatusFacts = { ...healthy, connection: "offline", accessCurrent: false };
  const blocked: readonly [string, { access?: PaneAccess | undefined; facts?: StatusFacts }][] = [
    // Not read yet (just started, or offline before any check): unknown is no grant.
    ["access unknown", { access: undefined }],
    ["access unknown, read", { access: { canInvite: null, hosting: "hosted" } }],
    // Offline: the access list still says yes, from before; the status says it is not current.
    ["offline, access as last verified", { facts: offline }],
    ["no invite right", { access: { canInvite: false, hosting: "hosted" } }],
    ["not on its server", { access: { canInvite: true, hosting: "pending" } }],
  ];

  it.each(blocked)("%s: no role dialog; the pane's reason, said once", async (_name, change) => {
    const t = await shared();
    t.set(change);
    const why = reason(t);
    const { run, roles } = await palette(t);
    await run;
    expect(roles).toEqual([]);
    expect(t.prompter.notices).toEqual([`Shared Tasks: ${why}`]);
    expect(t.invites).toEqual([]);
    expect(t.commands.invitation()).toBeNull();
    expect(t.pane().model.flow).toBeNull();
  });

  it("offline before any check: says inviting waits for the server's check", async () => {
    const t = await shared();
    t.set({ access: undefined, facts: offline });
    const { run } = await palette(t);
    await run;
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: Inviting waits until this device has checked access with the server.",
    ]);
  });

  it("access current again: the palette opens the role dialog, as the pane offers it", async () => {
    const t = await shared();
    t.set({ access: undefined, facts: offline });
    await (await palette(t)).run;
    t.set({ access: { canInvite: true, hosting: "hosted" }, facts: healthy });
    expect(enabled(t.pane().model, "invite")?.enabled).toBe(true);
    const { run, roles } = await palette(t);
    expect(roles.map((c) => c.map((x) => x.label))).toEqual([["Read", "Read + write"]]);
    t.prompter.role?.answer("read");
    await flush();
    t.prompter.link?.answer();
    await run;
    expect(t.invites).toEqual([{ R: toHex(fromBase64url(R0)), preset: "read" }]);
  });

  it("access removed after an invitation: the next palette Invite is refused", async () => {
    const t = await shared();
    const first = await palette(t);
    expect(first.roles).toHaveLength(1);
    t.prompter.role?.answer("read");
    await flush();
    t.prompter.link?.answer();
    await first.run;
    expect(t.invites).toHaveLength(1);
    // This vault's invite right is gone (removed on another device): no second dialog.
    t.set({ access: { canInvite: false, hosting: "hosted" } });
    const second = await palette(t);
    await second.run;
    expect(second.roles).toEqual([]);
    expect(t.invites).toHaveLength(1);
    expect(t.prompter.notices).toEqual(["Shared Tasks: You can't invite others to this section."]);
  });

  it("the section's card entry (inviteTo) re-checks too: the executor, not the surface", async () => {
    const t = await shared();
    t.set({ access: { canInvite: false, hosting: "hosted" } });
    await t.commands.inviteTo(fromBase64url(R0) as ResourceId);
    expect(t.prompter.choices).toEqual([]);
    expect(t.prompter.notices).toEqual(["Shared Tasks: You can't invite others to this section."]);
  });

  it("no access reading wired: a section is not invited to (fails closed)", async () => {
    const prompter = new InvitePrompter();
    const commands = new CollabCommands({
      collab: () =>
        ({
          checkInvitable: async () => undefined,
          status: async () => ({ profile: SECTIONS_PROFILE_ID }),
        }) as never,
      prompter,
      notes: { active: () => null, rewrite: async () => undefined },
      guard: {} as never,
      placement: () => "child-line",
      defaultServer: () => SERVER,
      sections: () => true,
    });
    await commands.inviteTo(fromBase64url(R0) as ResourceId);
    expect(prompter.choices).toEqual([]);
    expect(prompter.notices).toEqual([
      "Shared Tasks: Inviting waits until this device has checked access with the server.",
    ]);
  });
  it("the plugin unloaded while the check waited: no role dialog and no notice (LFCP-03-046)", async () => {
    const prompter = new InvitePrompter();
    const commands = new CollabCommands({
      collab: () =>
        ({
          checkInvitable: async () => undefined,
          status: async () => ({ profile: SECTIONS_PROFILE_ID }),
        }) as never,
      prompter,
      notes: { active: () => null, rewrite: async () => undefined },
      guard: {} as never,
      placement: () => "child-line",
      defaultServer: () => SERVER,
      sections: () => true,
      inviteRefusal: async () => INVITE_STOPPED,
    });
    await commands.inviteTo(fromBase64url(R0) as ResourceId);
    expect(prompter.choices).toEqual([]);
    expect(prompter.notices).toEqual([]);
    expect(commands.invitation()).toBeNull();
  });
});
