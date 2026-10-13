// Other plugins changing a shared section (coverage gap 10), in Obsidian:
// vault A (real Obsidian, Live Preview) owns a section, the headless peer B
// is a member with it in a note of its own. Another plugin changes A's note
// the way such plugins do: a Linter-style rewrite of the whole note through
// vault.process (open and closed), a line deleted through the editor API
// with no user event, a Templater-style insertion at the cursor. The
// section may heal or need attention; it must never lose data or diverge
// silently: while A's badge is CURRENT, A's section shows what B's does,
// and nothing that was there before is gone. The reference server at
// LFCP_SERVER_BIN.
import { editorA, evidence, inA, lineOf, markerProblems, sectionOf, shareAndJoin, startPeers } from "./support/section-checks.mjs";

const badge = () =>
  inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null);
const fileA = (file) => inA(({ app }, file) => app.vault.adapter.read(file), file);

const MARK = /<!--[ \t]+\/?lfcp-(?:section|node|ref):[^>]*-->/;
/**
 * A section's lines as written, trailing spaces included; left out what is
 * local layout, not shared: markers, blank lines, and a list item's marker
 * ("*", "+" or "-": an item's Text is shared, each note renders "- ").
 */
const content = (md) =>
  sectionOf(md)
    .split("\n")
    .filter((l) => !MARK.test(l) && l.trim() !== "")
    .map((l) => l.replace(/^(\s*)[*+] (?!\[.\] )/, "$1- "));

const TEXT = (heading) =>
  [
    heading,
    "",
    "- [ ] Alpha",
    "- [ ] Beta",
    "- [ ] Gamma",
    "",
    "Notes paragraph.   ",
    "",
    "",
    "",
    "* item one",
    "* item two",
    "",
  ].join("\n");

describe("other plugins changing a shared section", () => {
  let server;
  let b;

  before(async () => {
    ({ server, b } = await startPeers());
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  async function shared(heading) {
    for (let i = 0; i < 4 && (await inA(() => document.querySelectorAll(".modal-container").length)) > 0; i++) {
      await browser.keys(["Escape"]);
      await browser.pause(200);
    }
    const file = `${heading.slice(3)}.md`;
    const s = await shareAndJoin(b, file, heading, TEXT(heading));
    await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    await b.pass(s.bFile);
    return { ...s, file, before: content(await fileA(file)) };
  }

  /**
   * After the other plugin's change: A settles (CURRENT or ATTENTION, the
   * same for 3 s), B passes. CURRENT must mean A's section is B's, with
   * nothing of `keep` missing; ATTENTION is evidence (the card's text).
   */
  async function verdict(id, s, keep) {
    let last = null;
    let same = 0;
    await browser
      .waitUntil(
        async () => {
          await b.pass(s.bFile);
          const now = await badge();
          same = now === last && (now === "CURRENT" || now === "ATTENTION") ? same + 1 : 0;
          last = now;
          return same >= 6;
        },
        { timeout: 60_000, interval: 500 },
      )
      .catch(() => false);
    await b.pass(s.bFile);
    const a = content(await fileA(s.file));
    const bb = content(b.files.get(s.bFile));
    const card =
      last === "ATTENTION"
        ? await inA(async ({ app }) => {
            app.commands.executeCommandById("shared-tasks:open-section-details");
            let m;
            for (let i = 0; i < 100 && m === undefined; i++) {
              await new Promise((r) => setTimeout(r, 50));
              m = document.querySelector(".modal-container .modal");
            }
            const text = m?.textContent ?? "";
            for (const x of document.querySelectorAll(".modal-container .modal-close-button")) x.click();
            return text.slice(0, 600);
          })
        : null;
    const out = {
      badge: last,
      a,
      b: bb,
      // What should stay, whatever a rewrite did to its line's end.
      missingA: keep.filter((l) => !a.some((x) => x.trimEnd() === l)),
      missingB: keep.filter((l) => !bb.some((x) => x.trimEnd() === l)),
      problems: markerProblems(await fileA(s.file)).problems,
      card,
    };
    evidence(id, out);
    expect(["CURRENT", "ATTENTION"]).toContain(out.badge);
    // Never lost: what should stay is in A's note, whatever the badge.
    expect(out.missingA).toEqual([]);
    if (out.badge === "CURRENT") {
      expect(out.a).toEqual(out.b);
      expect(out.missingB).toEqual([]);
      expect(out.problems).toEqual([]);
    }
    return out;
  }

  /** The Linter's rewrite: trailing spaces off, "*" and "+" list markers to "-", blank lines collapsed. */
  const lint = (file) =>
    inA(
      ({ app }, file) =>
        app.vault.process(app.vault.getFileByPath(file), (text) =>
          text
            .split("\n")
            .map((l) => l.replace(/[ \t]+$/, "").replace(/^(\s*)[*+] /, "$1- "))
            .join("\n")
            .replace(/\n{3,}/g, "\n\n"),
        ),
      file,
    );

  it("a Linter-style rewrite of the open note (vault.process): nothing lost, never silently different", async () => {
    const s = await shared("## Linted open");
    expect(s.before).toContain("Notes paragraph.   ");
    expect(await fileA(s.file)).toContain("* item one");
    await lint(s.file);
    const linted = content(await fileA(s.file));
    evidence("LINT-OPEN linted", { before: s.before, linted });
    expect(linted).toContain("Notes paragraph.");
    expect(await fileA(s.file)).toContain("- item one");
    await verdict("LINT-OPEN", s, ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "Notes paragraph.", "- item one", "- item two"]);
  });

  it("a Linter-style rewrite of the note while another note is open", async () => {
    const s = await shared("## Linted closed");
    await inA(async ({ app }) => {
      await app.vault.create("Other.md", "# Other\n");
      await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath("Other.md"));
    });
    await lint(s.file);
    await browser.pause(2000);
    await inA(async ({ app }, file) => {
      await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(file));
    }, s.file);
    await verdict("LINT-CLOSED", s, ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "Notes paragraph.", "- item one", "- item two"]);
  });

  it("a plugin deletes a Task's line through the editor API (no user event): never silently gone", async () => {
    const s = await shared("## Deleted by a plugin");
    const at = await lineOf("Beta");
    await editorA((e, at) => e.replaceRange("", { line: at, ch: 0 }, { line: at + 1, ch: 0 }), at);
    const out = await verdict("DELETE-LINE", s, ["- [ ] Alpha", "- [ ] Gamma", "Notes paragraph."]);
    // Gone from A's note while the section says it is current: B must not have it either.
    if (out.badge === "CURRENT") expect(out.a.includes("- [ ] Beta")).toBe(out.b.includes("- [ ] Beta"));
  });

  it("a plugin deletes a Task's line and its ref line through the editor API (no user event)", async () => {
    const s = await shared("## Deleted with ref");
    const at = await lineOf("Beta");
    await editorA((e, at) => e.replaceRange("", { line: at, ch: 0 }, { line: at + 2, ch: 0 }), at);
    await verdict("DELETE-WITH-REF", s, ["- [ ] Alpha", "- [ ] Gamma", "Notes paragraph."]);
  });

  it("a Templater-style insertion on an empty line of the section", async () => {
    const s = await shared("## Templated blank");
    const at = await editorA((e) => e.getValue().split("\n").findIndex((l, i, L) => l === "" && L[i - 1]?.includes("lfcp-ref") && L.slice(i).some((x) => x.includes("Notes paragraph"))));
    await editorA(
      (e, at) => {
        e.setCursor({ line: at, ch: 0 });
        e.replaceSelection("- [ ] Templated task\nTemplated text.\n");
      },
      at,
    );
    await editorA((e) => e.cm.contentDOM.blur());
    const out = await verdict("TEMPLATE-BLANK", s, ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "Notes paragraph.", "- [ ] Templated task", "Templated text."]);
    if (out.badge === "CURRENT") expect(out.b).toContain("- [ ] Templated task");
  });

  it("a Templater-style insertion at the end of a Task's line (before its hidden ref)", async () => {
    const s = await shared("## Templated end");
    const at = await lineOf("Beta");
    await editorA(
      (e, at) => {
        e.setCursor({ line: at, ch: e.getLine(at).length });
        e.replaceSelection("\n- [ ] Templated after Beta");
      },
      at,
    );
    await editorA((e) => e.cm.contentDOM.blur());
    const out = await verdict("TEMPLATE-END", s, ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "- [ ] Templated after Beta"]);
    if (out.badge === "CURRENT") expect(out.b).toContain("- [ ] Templated after Beta");
  });

  it("a Templater-style insertion through a CodeMirror transaction with no user event", async () => {
    const s = await shared("## Templated dispatch");
    const at = await lineOf("Gamma");
    await editorA((e, at) => {
      const cm = e.cm;
      const line = cm.state.doc.line(at + 1);
      // After Gamma's ref line: Gamma's line, then its ref.
      const ref = cm.state.doc.line(at + 2);
      cm.dispatch({ changes: { from: ref.to, insert: "\n- [ ] Dispatched task" } });
      return line.text;
    }, at);
    const out = await verdict("TEMPLATE-DISPATCH", s, ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "- [ ] Dispatched task"]);
    if (out.badge === "CURRENT") expect(out.b).toContain("- [ ] Dispatched task");
  });
});
