// @vitest-environment happy-dom
// LFCP-03-015 (U03-10, U03-11; F-02, F-C02, F-C07): Join in the Shared
// Tasks pane, on the real plugin and its dispatcher, against the recording
// Obsidian mock. The collaboration's join is scripted (the live journey is
// test/e2e/sections-join-pane.test.ts); the sections host is a fake whose
// registry lists the section once the join tells it to.
//
//   paste (masked) → explicit Join → claim → access → loaded → Not inserted yet → Insert…
//
// Also: a section already joined is reached without a new claim; a used
// link, a removal and offline are told apart and kept in view; a claim whose
// answer was lost is checked from its journal ("Check the result"), never
// sent again; the link is never in the page, a notice or the console; the
// clipboard is never read.

import { fromBase64url, type ResourceId } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOVED_REJOIN } from "../../src/core/collab/messages";
import { Collaboration, type JoinOutcome, type JoinStage } from "../../src/core/collab/service";
import type { RegistryRow, RegistrySnapshot } from "../../src/core/sections/registry-view";
import type { TargetCapture } from "../../src/core/sections/target";
import { type StatusView, statusView } from "../../src/core/status/reducer";
import OpenLfcpPlugin from "../../src/main";
import { PANE_VIEW, type SharedTasksView } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };
const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const R = fromBase64url(R0) as ResourceId;
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const KEY = `${R0}#${SID}`;
const SECRET = Buffer.from([
  0xa3,
  0x00,
  0x01,
  0x01,
  0x58,
  0x20,
  ...new Array(32).fill(7),
  0x02,
  0x58,
  0x20,
  ...new Array(32).fill(9),
]).toString("base64url");
const LINK = `lfcp://join/${R0}?endpoint=ws%3A%2F%2F127.0.0.1%3A9&grant=${R0}#secret=${SECRET}`;
const NOTE = ["# Notes", "My own text.", ""].join("\n");

const current: StatusView = statusView({
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
});

const sprint: RegistryRow = {
  resource: R0,
  sectionId: SID,
  key: KEY,
  sharedTitle: "Sprint",
  localAlias: null,
  registryState: "available",
  refusal: null,
  status: { watched: true, state: current.state, label: current.label },
  placements: [],
  placementCount: 0,
  placed: "unplaced",
};

/** A sections host as the pane reads it; the registry lists Sprint once a join says so. */
function fakeSections() {
  const rows: RegistryRow[] = [];
  const listeners = new Set<() => void>();
  const inserts: TargetCapture[] = [];
  /** The section each insert was given: the pane's subject needs no choice (LFCP-03-016). */
  const insertKeys: (string | undefined)[] = [];
  /** Whether an insert gets as far as its journal (else its preview is left, nothing written). */
  const journaled = { value: false };
  const snapshot = (): RegistrySnapshot => ({
    version: 1,
    status: "ready",
    error: null,
    placementIndex: "complete",
    rows: [...rows],
    sections: rows.length,
    unplaced: rows.filter((r) => r.placed === "unplaced").length,
  });
  return {
    rows,
    inserts,
    insertKeys,
    journaled,
    registry: {
      snapshot,
      onChange: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    // A join finished: the registry is read again and lists the section.
    registryChanged: () => {
      if (!rows.some((r) => r.key === KEY)) rows.push(sprint);
      for (const l of [...listeners]) l();
    },
    onStatusChange: () => () => undefined,
    sectionStatus: (key: string) => (key === KEY ? current : undefined),
    paneAccess: (key: string) =>
      key === KEY ? { canInvite: false, hosting: "hosted" as const } : undefined,
    recoveryItems: () => [],
    hostFacts: () => ({ unavailable: null, starting: false, readOnly: false, server: true }),
    sharePolicy: () => ({ server: "wss://sync.example/v1/ws", comments: "local" as const }),
    actions: {
      paneEntry: () => undefined,
      shareResult: () => undefined,
      flows: () => [],
      onFlowsChange: () => () => undefined,
      insertSection: async (
        at: TargetCapture,
        section?: string,
        started?: (key: string) => void,
      ) => {
        inserts.push(at);
        insertKeys.push(section);
        if (journaled.value && section !== undefined) started?.(section);
      },
    },
    noteRenamed: () => undefined,
    noteDeleted: () => undefined,
  };
}

/** A join scripted step by step: each stage waits until the test lets it go. */
function gate() {
  let open: () => void = () => undefined;
  let p = new Promise<void>((r) => {
    open = r;
  });
  return {
    wait: () => p,
    next: () => {
      const o = open;
      p = new Promise<void>((r) => {
        open = r;
      });
      o();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

async function setup(opts: { note?: boolean } = {}) {
  const app = new mock.App();
  const plugin = new OpenLfcpPlugin(app as never, manifest as never);
  await plugin.onload();
  await plugin.whenRuntimeStarted();
  plugin.runtimeError = null;
  plugin.runtime = {} as never;
  const sections = fakeSections();
  (plugin as unknown as { sections: unknown }).sections = sections;
  if (opts.note !== false) {
    const view = new mock.MarkdownView(new mock.TFile("Notes.md"), NOTE);
    view.cursorLine = 1;
    app.workspace.views.push(view);
    app.workspace.activeView = view;
  }
  await plugin.openPane();
  const leaf = app.workspace.getLeavesOfType(PANE_VIEW)[0] as mock.WorkspaceLeaf;
  const view = leaf.view as unknown as SharedTasksView;
  const el = () => {
    view.render();
    return view.contentEl as unknown as HTMLElement;
  };
  const text = () => el().textContent ?? "";
  const primary = () => el().querySelector<HTMLButtonElement>(".openlfcp-pane-primary button");
  const none = () => el().querySelector(".openlfcp-pane-none")?.textContent ?? null;
  const button = (label: string) => {
    const b = Array.from(el().querySelectorAll("button")).find((x) => x.textContent === label);
    if (b === undefined) throw new Error(`no button ${label} in ${text()}`);
    return b;
  };
  /**
   * A disabled button's reason: next to it in the same drawing, or for an icon button of the
   * header the tooltip's "label — reason", which is also its accessible name.
   */
  const reason = (b: HTMLButtonElement) => {
    const id = b.getAttribute("aria-describedby");
    if (id !== null) return b.parentElement?.querySelector(`#${id}`)?.textContent ?? null;
    const name = b.getAttribute("aria-label");
    const at = name?.indexOf(" — ") ?? -1;
    return name === null || at < 0 ? null : name.slice(at + 3);
  };
  /** Pastes `link` in the field (masked) and chooses Join. */
  const paste = async (link: string, name = "") => {
    const root = el();
    const input = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input");
    const nameInput = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-name");
    if (input === null || nameInput === null) throw new Error(`no join field in ${text()}`);
    expect(input.type).toBe("password");
    input.value = link;
    nameInput.value = name;
    root.querySelector<HTMLFormElement>("form.openlfcp-pane-join-form")?.requestSubmit();
    expect(input.value).toBe("");
    await settle();
  };
  /** Every place a link could leak to: the page, the notices, the console. */
  const leaks: string[] = [];
  const page = () => [el().innerHTML, ...mock.notices, ...leaks].join("\n");
  return {
    app,
    plugin,
    sections,
    view,
    el,
    text,
    primary,
    none,
    button,
    reason,
    paste,
    page,
    leaks,
  };
}

let join: ReturnType<typeof vi.spyOn>;
let resume: ReturnType<typeof vi.spyOn>;
let list: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mock.notices.length = 0;
  mock.modals.length = 0;
  join = vi.spyOn(Collaboration.prototype, "join");
  resume = vi.spyOn(Collaboration.prototype, "resumeJoin");
  list = vi.spyOn(Collaboration.prototype, "list").mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const CLAIM: JoinStage[] = [
  "connecting",
  "validating invitation",
  "retrieving key",
  "claiming capability",
];

/** A join that answers `outcome` at once, after the stages. */
const answers = (outcome: JoinOutcome, stages: JoinStage[] = CLAIM) =>
  join.mockImplementation(async (_l: string, o: { onStage?: (s: JoinStage) => void }) => {
    for (const s of stages) o.onStage?.(s);
    return outcome;
  });

describe("Join in the pane (LFCP-03-015)", () => {
  it("paste → Join → claim → access → loaded → not inserted yet → Insert…, the link never shown", async () => {
    const t = await setup();
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        t.leaks.push(a.map(String).join(" "));
      });
    const read = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: read, writeText: vi.fn() },
      configurable: true,
    });
    const g = gate();
    join.mockImplementation(async (_l: string, o: { onStage?: (s: JoinStage) => void }) => {
      for (const s of CLAIM) o.onStage?.(s);
      await g.wait();
      o.onStage?.("synchronizing");
      await g.wait();
      o.onStage?.("loading section");
      await g.wait();
      return {
        kind: "joined",
        resourceId: R,
        abilities: ["data/read", "data/write"],
        section: { loaded: true },
      } satisfies JoinOutcome;
    });

    // Nothing joins by itself: the entry opens a field, and sends nothing.
    expect(t.el().querySelector("input.openlfcp-pane-join-input")).toBeNull();
    t.button("Join with a link…").click();
    await settle();
    expect(t.text()).toContain("Paste the invitation link");
    expect(t.text()).toContain("One-time link, does not expire; whoever opens it first joins.");
    expect(t.text()).toContain("Name on this device (optional)");
    expect(t.none()).toBe("Paste the invitation link above and choose Join.");
    expect(join).not.toHaveBeenCalled();

    // The explicit Join: the claim is under way; no next step, only progress.
    await t.paste(LINK);
    expect(join).toHaveBeenCalledTimes(1);
    expect(join.mock.calls[0]?.[1]).toMatchObject({ name: "" });
    expect(t.text()).toContain("Claim the invitation with the server…");
    expect(t.primary()).toBeNull();
    expect(t.reason(t.button("Join with a link…"))).toBe("A join is in progress. Finish it first.");
    expect(t.page()).not.toContain(SECRET);

    // Access: only once the server accepted the claim.
    g.next();
    await settle();
    expect(t.text()).toContain("The server accepted the claim.");
    expect(t.text()).toContain("Open the section with the access granted…");
    g.next();
    await settle();
    expect(t.text()).toContain("Load the section…");
    g.next();
    await settle();

    // Joined and loaded: the section, not inserted yet, and its next step.
    const after = t.text();
    expect(after).toContain("Access: read and write.");
    expect(after).toContain("Loaded on this device.");
    expect(after).toContain("Joined. Choose a note to insert it into, now or later.");
    expect(after).toContain("Sprint");
    expect(after).toContain("Not inserted yet");
    expect(after).not.toContain("On this device:");
    expect(t.el().querySelector(".openlfcp-pane-step.is-current")?.textContent).toBe(
      "Choose a note to insert it into",
    );
    expect(t.primary()?.textContent).toBe("Insert into a note…");

    // Insert…: the existing insert, into the note in view. Its preview left, nothing
    // journaled: the join flow stays at its place choice (LFCP-03-017).
    t.primary()?.click();
    await settle();
    expect(t.sections.inserts.map((x) => x.path)).toEqual(["Notes.md"]);
    // The joined section, the pane's subject: no section choice (LFCP-03-016).
    expect(t.sections.insertKeys).toEqual([KEY]);
    expect(t.text()).toContain("Joined. Choose a note to insert it into, now or later.");
    // Nothing inserted: still listed, still the next step.
    expect(t.text()).toContain("Not inserted yet");
    expect(t.primary()?.textContent).toBe("Insert into a note…");

    // Again, approved: once the insertion is journaled, the join flow hands over.
    t.sections.journaled.value = true;
    t.primary()?.click();
    await settle();
    expect(t.sections.insertKeys).toEqual([KEY, KEY]);
    expect(t.text()).not.toContain("Joining with a link");

    expect(t.page()).not.toContain(SECRET);
    expect(t.page()).not.toContain(LINK.slice(0, 40));
    expect(read).not.toHaveBeenCalled();
    expect(mock.modals).toEqual([]);
  });

  it("Later: the flow ends; the section stays listed as not inserted yet", async () => {
    const t = await setup();
    answers(
      { kind: "joined", resourceId: R, abilities: ["data/read"], section: { loaded: true } },
      [...CLAIM, "synchronizing", "loading section"],
    );
    t.button("Join with a link…").click();
    await settle();
    await t.paste(LINK, "From Ann");
    expect(join.mock.calls[0]?.[1]).toMatchObject({ name: "From Ann" });
    expect(t.text()).toContain("Access: read only.");
    t.button("Later").click();
    await settle();
    expect(t.text()).not.toContain("Joining with a link");
    expect(t.text()).toContain("Not inserted yet");
    expect(t.primary()?.textContent).toBe("Insert into a note…");
  });

  it("already joined: the pane leads to the section, no new claim", async () => {
    const t = await setup();
    answers({ kind: "already-member", resourceId: R }, []);
    list.mockResolvedValue([
      {
        resourceId: R,
        localName: null,
        profile: SECTIONS_PROFILE_ID,
        routes: [],
        lastKnownControlHead: null,
        state: "available",
        refusal: null,
      },
    ]);
    t.sections.registryChanged();
    t.button("Join with a link…").click();
    await settle();
    await t.paste(LINK);
    expect(t.text()).toContain(
      "This vault had already joined this section. No new claim was made.",
    );
    expect(t.text()).toContain("Sprint");
    expect(t.primary()?.textContent).toBe("Insert into a note…");
    expect(join).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  });

  it("a used link, a removal and offline are told apart, kept in view; the field stays for another link", async () => {
    const cases: [JoinOutcome, string][] = [
      [
        { kind: "refused", code: "AUTHORIZATION_FAILED", message: "" },
        "this link was already used, or it no longer grants access",
      ],
      [{ kind: "removed", resourceId: R }, REMOVED_REJOIN],
      [
        {
          kind: "unavailable",
          message:
            "The server could not complete the join (timeout). Joining needs a connection; try again when online.",
          resourceId: R,
        },
        "Joining needs a connection; try again when online.",
      ],
    ];
    for (const [outcome, said] of cases) {
      const t = await setup();
      answers(outcome);
      t.button("Join with a link…").click();
      await settle();
      await t.paste(LINK);
      expect(t.text(), said).toContain(said);
      expect(t.text().toLowerCase()).not.toContain("expired");
      expect(t.el().querySelector("input.openlfcp-pane-join-input")).not.toBeNull();
      expect(t.text()).not.toContain("Not inserted yet");
      expect(t.page()).not.toContain(SECRET);
      // Still in view at the next redraw: not a passing notice.
      expect(t.text()).toContain(said);
    }
  });

  it("a malformed link: told apart, nothing sent", async () => {
    const t = await setup();
    t.button("Join with a link…").click();
    await settle();
    await t.paste("https://example.org/not-a-link");
    expect(t.text()).toContain("This is not an invitation link.");
    expect(join).not.toHaveBeenCalled();
  });

  it("a lost claim: Check the result settles the same claim from its journal, never a new join", async () => {
    const t = await setup();
    answers({
      kind: "unavailable",
      message: "The server did not confirm the claim.",
      claimSent: true,
      resourceId: R,
    });
    resume.mockResolvedValue({
      kind: "joined",
      resourceId: R,
      abilities: ["data/read", "data/write"],
      section: { loaded: true },
    });
    t.button("Join with a link…").click();
    await settle();
    await t.paste(LINK);
    expect(t.text()).toContain(
      "The server did not confirm the claim. The claim is kept on this device.",
    );
    expect(t.primary()?.textContent).toBe("Check the result");
    expect(t.reason(t.button("Join with a link…"))).toBe("A join is in progress. Finish it first.");
    // The palette may not start another one meanwhile.
    await t.plugin.actions.run("join-with-link", {}, "palette");
    expect(mock.notices.at(-1)).toBe("Shared Tasks: a join is in progress. Finish it first.");
    t.primary()?.click();
    await settle();
    expect(resume).toHaveBeenCalledWith(R);
    expect(join).toHaveBeenCalledTimes(1);
    expect(t.primary()?.textContent).toBe("Insert into a note…");
  });

  it("no note open: the joined section's Insert says to open one", async () => {
    const t = await setup({ note: false });
    answers(
      { kind: "joined", resourceId: R, abilities: ["data/read"], section: { loaded: true } },
      [...CLAIM, "synchronizing", "loading section"],
    );
    t.button("Join with a link…").click();
    await settle();
    await t.paste(LINK);
    expect(t.primary()).toBeNull();
    expect(t.none()).toBe("Open a note to insert the section into.");
  });
});
