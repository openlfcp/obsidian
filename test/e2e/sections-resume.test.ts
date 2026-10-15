// @vitest-environment happy-dom
// LFCP-03-017 (U03-10, U03-13, U03-14): unfinished journeys across a
// process crash, on the reference server, real plugins. A crash here is
// the E2E harness's: the plugin instance dies (nothing stopped or flushed)
// and a new one starts over the same vault, local store and IndexedDB.
//
//   1. An insert into a closed note whose write failed (the note was not
//      written): after the crash the pane lists it as unfinished on that
//      note, "Continue" shows the same preview, and Insert writes one
//      block. A's later deletion reaches the copy: it was registered.
//   2. An insert whose note was written and whose registration failed:
//      after the crash the copy is registered with no second block.
//   3. A claim whose answer was lost, then a crash while offline: the pane
//      shows the claim as unknown with "Check the result"; back online, the
//      same claim settles (no new claim; the link is not asked again), the
//      section is inserted, and a fourth vault is refused the used link.
//      The link is in no setting, notice or pane.
//
// Skipped without the server unless LFCP_REQUIRE_LIVE=1 (then an error).

import { fromBase64url, type ResourceId, toBase64url } from "@openlfcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSections } from "../../src/core/sections/parser";
import { PANE_VIEW, type SharedTasksView } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";
import { answer, click, SECTION_NOTE, SoakPeer } from "../soak/peer";
import { isControlPutAckFrame } from "../support/drop-tap";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

let server: E2EServer;
let A: SoakPeer;
let B: SoakPeer;
let resource: string;

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await SoakPeer.open("A", "a", server.url, 1);
  B = await SoakPeer.open("B", "b", server.url, 2);
  ({ resource } = await A.share(6, ["a", "b"]));
  await B.join(await A.invite(resource), "Soak");
  await until(
    "the section loaded on B",
    () =>
      B.runtime.sectionLoad(fromBase64url(resource) as ResourceId)?.loaded === true
        ? true
        : undefined,
    120_000,
  );
  A.openEditor();
}, 300_000);

afterAll(async () => {
  await A?.vault.close();
  await B?.vault.close();
  await server?.stop();
});

/** A peer's pane, drawn now. */
function pane(p: SoakPeer) {
  const leaf = p.vault.app.workspace.getLeavesOfType(PANE_VIEW)[0] as
    | mock.WorkspaceLeaf
    | undefined;
  const view = leaf?.view as unknown as SharedTasksView | undefined;
  if (view === undefined) throw new Error("no pane");
  view.render();
  const el = view.contentEl as unknown as HTMLElement;
  const primary = el.querySelector<HTMLButtonElement>(".openlfcp-pane-primary button");
  return { el, text: el.textContent ?? "", primary };
}

/** `path` as the active note, closed (no editor: writes go through its file); the pane open. */
async function showPane(p: SoakPeer, path: string): Promise<void> {
  const md = new mock.MarkdownView(new mock.TFile(path), p.vault.read(path));
  md.cursorLine = 2;
  p.vault.app.workspace.activeView = md;
  await p.vault.plugin.openPane();
}

/** The process dies and a new plugin instance starts over the same state (no pane yet). */
async function crash(p: SoakPeer): Promise<void> {
  const leaves = p.vault.app.workspace.leaves;
  for (let i = leaves.length - 1; i >= 0; i--)
    if (leaves[i]?.type === PANE_VIEW) leaves.splice(i, 1);
  await p.vault.shutdown("crash");
  await p.vault.boot(false);
}

/** The next write of `path` through its file fails: before it is applied, or after. */
function failNextWrite(p: SoakPeer, path: string, when: "before" | "after"): () => void {
  const vault = p.vault.app.vault;
  const original = vault.process.bind(vault);
  let armed = true;
  vault.process = async (file, fn) => {
    if (!armed || file.path !== path) return original(file, fn);
    armed = false;
    if (when === "before") throw new Error("disk full (test)");
    await original(file, fn);
    throw new Error("write reported lost (test)");
  };
  return () => {
    vault.process = original;
  };
}

/** "Insert shared section…" into `path` (closed), the section picked and the preview approved. */
async function insertInto(p: SoakPeer, path: string): Promise<void> {
  const md = new mock.MarkdownView(new mock.TFile(path), p.vault.read(path));
  md.cursorLine = 2;
  const sections = p.vault.plugin.sections;
  if (sections === null) throw new Error("no sections host");
  const done = sections.insertSection(md.editor as never, path);
  await answer("the section choice", (m) => {
    const choices = (m as { choices?: readonly { resource: Uint8Array }[] }).choices;
    const c = choices?.find((x) => toBase64url(x.resource) === resource);
    const choose = (m as { onChooseSuggestion?: (c: unknown) => void }).onChooseSuggestion;
    if (c === undefined || choose === undefined) return false;
    choose.call(m, c);
    m.close();
    return true;
  });
  await answer("the insert preview", click("Insert"));
  await done;
}

const copies = (p: SoakPeer, path: string) =>
  parseSections(p.vault.read(path)).sections.filter(
    (s) => toBase64url(s.ref.resourceId) === resource,
  ).length;

describe.skipIf(!live)("unfinished journeys across a crash (LFCP-03-017)", () => {
  it("1. an insert that wrote nothing: unfinished after the crash; Continue inserts it once", async () => {
    const path = "Resume one.md";
    await B.vault.write(path, "# B's first note\n\nMy own text.\n");
    const restore = failNextWrite(B, path, "before");
    await insertInto(B, path);
    restore();
    expect(copies(B, path)).toBe(0);
    expect(B.vault.plugin.sections?.actions.flows()).toEqual([
      expect.objectContaining({ kind: "insert", path, outcome: "unknown" }),
    ]);

    await crash(B);
    await until("the unfinished insert", () =>
      B.vault.plugin.sections?.actions.flows().some((f) => f.outcome === "unfinished")
        ? true
        : undefined,
    );
    expect(copies(B, path)).toBe(0);
    await showPane(B, path);
    const shown = pane(B);
    expect(shown.text).toContain("Unfinished");
    expect(shown.primary?.dataset.action).toBe("continue-flow");
    expect(shown.text).toContain("An insert into this note is unfinished: continue it.");

    shown.primary?.click();
    await answer("the same preview", (m) => {
      if (!(m.contentEl.textContent ?? "").includes("where it was chosen before")) return false;
      return click("Insert")(m);
    });
    await until("the section in B's note", () => (copies(B, path) === 1 ? true : undefined));
    await until("the flow ended", () =>
      B.vault.plugin.sections?.actions.flows().length === 0 ? true : undefined,
    );
    expect(B.vault.read(path)).toContain("My own text.");

    // Registered: a deletion on A reaches this copy.
    A.deleteTask("a3 review item");
    await until(
      "B's resumed copy without a3",
      () => (B.vault.read(path).includes("a3 review item") ? undefined : true),
      60_000,
    );
    expect(copies(B, path)).toBe(1);
  }, 180_000);

  it("2. an insert written but not registered: the crash registers it, with no second block", async () => {
    const path = "Resume two.md";
    await B.vault.write(path, "# B's second note\n\nMore text.\n");
    const restore = failNextWrite(B, path, "after");
    await insertInto(B, path);
    restore();
    expect(copies(B, path)).toBe(1);
    const notices = mock.notices.length;

    await crash(B);
    await until("the insertion finished", () =>
      mock.notices
        .slice(notices)
        .some(
          (n) => n.includes("inserted into") && n.includes("Inserting had not finished before."),
        )
        ? true
        : undefined,
    );
    expect(copies(B, path)).toBe(1);
    expect(B.vault.plugin.sections?.actions.flows()).toEqual([]);

    A.deleteTask("a5 call item");
    await until(
      "B's registered copy without a5",
      () => (B.vault.read(path).includes("a5 call item") ? undefined : true),
      60_000,
    );
    expect(copies(B, path)).toBe(1);
  }, 180_000);

  it("3. a lost claim, then a crash offline: Check the result settles the same claim; the link is spent once", async () => {
    const link = await A.invite(resource);
    const secret = link.slice(link.indexOf("#secret=") + 8);
    const C = await SoakPeer.open("C", "c", server.url, 3);
    let D: SoakPeer | null = null;
    try {
      C.vault.network.dropNextIn(isControlPutAckFrame);
      const notices = mock.notices.length;
      await C.join(link, "");
      expect(C.vault.network.dropped).toBe(1);
      expect(await C.runtime.registry()).toEqual([]);

      C.vault.network.offline = true;
      await crash(C);
      await until("the restart's notice", () =>
        mock.notices.slice(notices).some((n) => n.includes("The Shared Tasks pane shows it."))
          ? true
          : undefined,
      );
      await C.vault.write(SECTION_NOTE, "# C's note\n\nMine.\n");
      await showPane(C, SECTION_NOTE);
      const unknown = pane(C);
      expect(unknown.primary?.dataset.action).toBe("check-result");
      expect(unknown.text).toContain("The server did not confirm the claim.");
      expect(unknown.el.querySelector("input.openlfcp-pane-join-input")).toBeNull();

      C.vault.network.offline = false;
      unknown.primary?.click();
      await until(
        "C joined",
        () => (pane(C).primary?.textContent === "Insert into a note…" ? true : undefined),
        120_000,
      );
      expect((await C.runtime.registry()).length).toBe(1);
      await until(
        "the section loaded on C",
        () =>
          C.runtime.sectionLoad(fromBase64url(resource) as ResourceId)?.loaded === true
            ? true
            : undefined,
        120_000,
      );
      // Listed on this device with its section ID, so the pane's next step is about it (D9).
      // A row listed before its model is read has no key yet: the pane's "Insert into a
      // note…" then names no section and the insert asks which one (the section picker,
      // not the preview; macOS smoke, LFCP-03-038).
      await until(
        "the section listed on C with its key",
        () => {
          const rows = C.vault.plugin.sections?.registry.snapshot().rows ?? [];
          return rows.length === 1 && rows[0]?.key?.startsWith(`${resource}#`) === true
            ? true
            : undefined;
        },
        120_000,
      );
      const before = pane(C);
      const said = mock.notices.length;
      before.primary?.click();
      await answer("the insert preview", click("Insert")).catch((e: unknown) => {
        const open = mock.modals.filter((m) => m.isOpen);
        throw new Error(
          `${String(e)}; ${JSON.stringify({
            clicked: before.primary?.dataset.action ?? null,
            clickedText: before.primary?.textContent ?? null,
            notices: mock.notices.slice(said),
            modals: open.map((m) =>
              `${m.constructor.name}: ${m.contentEl.textContent ?? ""}`.slice(0, 300),
            ),
            pane: pane(C).text.slice(0, 600),
            load: C.runtime.sectionLoad(fromBase64url(resource) as ResourceId) ?? null,
          })}`,
        );
      });
      await until("the section in C's note", () =>
        copies(C, SECTION_NOTE) === 1 ? true : undefined,
      );

      // Spent once: a fourth vault is refused.
      D = await SoakPeer.open("D", "d", server.url, 4);
      await D.vault.plugin.openPane();
      pane(D).el.querySelector<HTMLButtonElement>("button[data-action='join-with-link']")?.click();
      const field = await until("D's join field", () => {
        const e = pane(D as SoakPeer).el;
        return e.querySelector("input.openlfcp-pane-join-input") === null ? undefined : e;
      });
      const input = field.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input");
      if (input === null) throw new Error("no join field");
      input.value = link;
      field.querySelector<HTMLFormElement>("form.openlfcp-pane-join-form")?.requestSubmit();
      await until(
        "D refused",
        () => (pane(D as SoakPeer).text.includes("this link was already used") ? true : undefined),
        60_000,
      );

      // The link is kept nowhere: no setting, notice or pane.
      expect(JSON.stringify(C.vault.plugin.settings)).not.toContain(secret);
      expect(mock.notices.join("\n")).not.toContain(secret);
      expect(pane(C).el.innerHTML).not.toContain(secret);
    } finally {
      await D?.vault.close();
      await C.vault.close();
    }
  }, 300_000);
});
