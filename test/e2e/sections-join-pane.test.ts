// @vitest-environment happy-dom
// LFCP-03-015 (U03-10, U03-11): Join in the Shared Tasks pane, on the
// reference server, two real plugins. A shares a section and invites; B
// pastes the one-time link in its pane (masked) and chooses Join: the pane
// shows the claim, the access and the load, each confirmed; the section is
// listed as not inserted yet, and "Insert into a note…" runs the existing
// insert into B's note. The same link pasted again reaches the section
// without a new claim; a third vault is refused the used link. No palette
// command on B's side. Skipped without the server unless
// LFCP_REQUIRE_LIVE=1 (then an error).

import { toHex } from "@openlfcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSections } from "../../src/core/sections/parser";
import { PANE_VIEW, type SharedTasksView } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";
import { answer, click, SoakPeer } from "../soak/peer";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

let server: E2EServer;
let A: SoakPeer;
let B: SoakPeer;
let C: SoakPeer;

const JOINED = "Joined.md";

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await SoakPeer.open("A", "a", server.url, 1);
  B = await SoakPeer.open("B", "b", server.url, 2);
  C = await SoakPeer.open("C", "c", server.url, 3);
}, 300_000);

afterAll(async () => {
  await A?.vault.close();
  await B?.vault.close();
  await C?.vault.close();
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
  const button = (label: string) =>
    Array.from(el.querySelectorAll("button")).find((b) => b.textContent === label);
  return { el, text: el.textContent ?? "", primary, button };
}

/** Pastes `link` in a peer's pane field and chooses Join (no palette). */
async function joinInPane(p: SoakPeer, link: string): Promise<void> {
  pane(p).button("Join with a link…")?.click();
  const el = await until("the join field", () => {
    const e = pane(p).el;
    return e.querySelector("input.openlfcp-pane-join-input") === null ? undefined : e;
  });
  const input = el.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input");
  if (input === null) throw new Error("no join field");
  expect(input.type).toBe("password");
  input.value = link;
  el.querySelector<HTMLFormElement>("form.openlfcp-pane-join-form")?.requestSubmit();
}

describe.skipIf(!live)("share → invite → join from the pane (LFCP-03-015)", () => {
  it("B joins from its pane, sees each stage confirmed, then inserts; again: no new claim; C: used", async () => {
    const shared = await A.share(3, ["a"]);
    const link = await A.invite(shared.resource);
    expect(link.startsWith("lfcp://join/")).toBe(true);
    const secret = link.slice(link.indexOf("#secret=") + 8);

    // B's own note, active; its pane, from the plugin's entry.
    await B.vault.write(JOINED, ["# B's note", "", "My own text.", ""].join("\n"));
    const md = new mock.MarkdownView(new mock.TFile(JOINED), B.vault.read(JOINED));
    md.cursorLine = 2;
    B.vault.app.workspace.activeView = md;
    await B.vault.plugin.openPane();

    await joinInPane(B, link);
    const stages: string[] = [];
    const joined = await until(
      "B joined and the section loaded",
      () => {
        const p = pane(B);
        const current = p.el.querySelector(".openlfcp-pane-step.is-current")?.textContent;
        if (current !== undefined && current !== null && stages.at(-1) !== current)
          stages.push(current);
        expect(p.el.innerHTML).not.toContain(secret);
        return p.primary?.textContent === "Insert into a note…" &&
          p.text.includes("Not inserted yet")
          ? p
          : undefined;
      },
      120_000,
    );
    expect(stages.at(-1)).toBe("Choose a note to insert it into");
    expect(joined.text).toContain("The server accepted the claim.");
    expect(joined.text).toContain("Access: read and write.");
    expect(joined.text).toContain("Loaded on this device.");
    // N5: no name asked, none shown besides the shared title.
    expect(joined.text).toContain("Work");
    expect(joined.text).not.toContain("Shared collaboration");
    expect(B.vault.prompter.pending).toBe(0);

    // Insert into a note…: the existing insert (its section choice, its preview) into B's note.
    joined.primary?.click();
    await until(
      "the section choice",
      () => {
        const open = mock.modals.filter((m) => m.isOpen).at(-1) as
          | (mock.Modal & {
              choices?: readonly { resource: Uint8Array }[];
              onChooseSuggestion?: (c: unknown) => void;
            })
          | undefined;
        const c = open?.choices?.find(
          (x) => toHex(x.resource) === toHex(Buffer.from(shared.resource, "base64url")),
        );
        if (open === undefined || c === undefined || open.onChooseSuggestion === undefined)
          return undefined;
        open.onChooseSuggestion(c);
        open.close();
        return true;
      },
      30_000,
    );
    await answer("the insert preview", click("Insert"));
    await until(
      "the section in B's note",
      () => (parseSections(B.vault.read(JOINED)).sections.length === 1 ? true : undefined),
      60_000,
    );
    expect(B.vault.read(JOINED)).toContain("My own text.");
    expect(pane(B).text).not.toContain("Joining with a link");

    // The same link again: the section, without a new claim.
    await joinInPane(B, link);
    await until(
      "already joined",
      () =>
        pane(B).text.includes("This vault had already joined this section. No new claim was made.")
          ? true
          : undefined,
      30_000,
    );
    // Already held: the service answers before any claim (service.ts join), so none was sent.

    // A third vault: the link was used.
    await C.vault.plugin.openPane();
    await joinInPane(C, link);
    await until(
      "C refused",
      () => (pane(C).text.includes("this link was already used") ? true : undefined),
      60_000,
    );
    expect(pane(C).text).not.toContain("Not inserted yet");
    for (const p of [B, C]) expect(pane(p).el.innerHTML).not.toContain(secret);
    expect(mock.notices.join("\n")).not.toContain(secret);
  }, 300_000);
});
