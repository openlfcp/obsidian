// @vitest-environment happy-dom
// LFCP-03-014 (U03-04, U03-05, U03-08): Share and Invite as one journey in
// the Shared Tasks pane, on the reference server. A shares a heading from
// the pane (its preview names the sync server), the pane tells it is on
// its server and ready to invite, A invites from the pane with an explicit
// role, and B claims the one-time link and holds the section. No palette
// command on A's side: every step is a pane button or the dialog it opens.
// Two real plugins (sections on, a CodeMirror editor for A). Skipped
// without the server unless LFCP_REQUIRE_LIVE=1 (then an error).

import { type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSections } from "../../src/core/sections/parser";
import { PANE_VIEW, type SharedTasksView } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";
import { answer, click, SECTION_NOTE, SoakPeer } from "../soak/peer";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

let server: E2EServer;
let A: SoakPeer;
let B: SoakPeer;

const NOTE = [
  "# Plan",
  "",
  "Private intro, never shared.",
  "",
  "## Work",
  "- [ ] a1 plan item",
  "- [ ] a2 draft item",
  "",
  "## After",
  "Private tail.",
  "",
].join("\n");
const WORK = 4;

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await SoakPeer.open("A", "a", server.url, 1);
  B = await SoakPeer.open("B", "b", server.url, 2);
}, 300_000);

afterAll(async () => {
  await A?.vault.close();
  await B?.vault.close();
  await server?.stop();
});

/** A's pane, drawn now: its text and its buttons. */
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

describe.skipIf(!live)("share → invite → claim from the pane (LFCP-03-014)", () => {
  it("A shares and invites from the pane; B claims the link and holds the section", async () => {
    // A's note, open in an editor, the cursor on "## Work".
    await A.vault.write(SECTION_NOTE, NOTE);
    A.openEditor();
    const ws = A.vault.app.workspace;
    const md = ws.views.at(-1) as mock.MarkdownView;
    (md.editor as unknown as { setCursor(p: { line: number; ch: number }): void }).setCursor({
      line: WORK,
      ch: 0,
    });
    ws.activeView = md;
    await A.vault.plugin.openPane();

    // The pane's preview: what is shared, and where it goes.
    const before = pane(A);
    expect(before.primary?.textContent).toBe("Share section…");
    expect(before.text).toContain("2 tasks, 0 paragraphs, 0 list items.");
    expect(before.text).toContain(`Sync server: ${server.url}.`);
    expect(before.text).not.toContain("Private intro");

    // Share section… → the share dialog (the review) → Share.
    const notices = mock.notices.length;
    before.primary?.click();
    await answer("the share preview", click("Share"));
    await until(
      "the section shared",
      () =>
        /(is shared|could not|stopped|was created on this device)/.test(
          mock.notices.slice(notices).join(" | "),
        )
          ? true
          : undefined,
      60_000,
    );
    expect(mock.notices.slice(notices).join(" | ")).toContain('section "Work" is shared.');

    // On its server and access checked: the pane says so, and its next step is Invite.
    const ready = await until(
      "the pane ready to invite",
      () => {
        const p = pane(A);
        return p.primary?.textContent === "Invite collaborator…" &&
          p.text.includes("Shared and on its sync server: ready to invite.")
          ? p
          : undefined;
      },
      60_000,
    );
    // Nothing was sent by itself.
    expect(A.vault.prompter.invitations).toHaveLength(0);

    // Invite collaborator… → the role, chosen explicitly → the link in its dialog.
    A.vault.prompter.script(["Read + write"]);
    ready.primary?.click();
    await until(
      "the invitation",
      () => (A.vault.prompter.invitations.length === 1 ? true : undefined),
      60_000,
    );
    expect(A.vault.prompter.pending).toBe(0);
    const link = A.vault.prompter.invitations[0]?.reveal() as string;
    expect(link.startsWith("lfcp://join/")).toBe(true);
    await until("the invitation flow ended", () =>
      pane(A).text.includes("Inviting a collaborator") ? undefined : true,
    );
    expect(pane(A).text).not.toContain(link);

    // B claims the one-time link and holds the section.
    const resource = parseSections(md.editor.getValue()).sections[0]?.ref.resourceId;
    if (resource === undefined) throw new Error("A's note has no section");
    await B.join(link, "Work");
    await until(
      "B holds the section",
      async () =>
        (await B.runtime.registry()).some((e) => toHex(e.resourceId) === toHex(resource))
          ? true
          : undefined,
      60_000,
    );
    // Privacy canary: what B received holds the section, never A's private text around it.
    await B.insert(toBase64url(resource));
    const received = [
      B.text(SECTION_NOTE),
      JSON.stringify(B.runtime.sectionProfile(resource as ResourceId)?.replica.toJSON() ?? null),
    ].join("\n");
    expect(received).toContain("a1 plan item");
    expect(received).toContain("a2 draft item");
    expect(received).not.toContain("Private intro");
    expect(received).not.toContain("Private tail");
  }, 240_000);
});
