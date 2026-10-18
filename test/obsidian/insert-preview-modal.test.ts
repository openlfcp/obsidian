// LFCP-03-020 (U03-27, F-09): the insert preview on the Obsidian mock shows
// the readable text first, the exact lines in a collapsed part, and draws
// remote content as text only. Insert writes the block it was given. The
// choice before it names sections by their shared title (F-10).

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../src/core/sections/grammar";
import {
  choiceLabel,
  InsertSectionModal,
  PickSectionModal,
} from "../../src/obsidian/ui/insert-section";
import { App, FakeElement } from "../mocks/obsidian";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;

const BLOCK = [
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Prepare contract",
  `  <!-- lfcp-ref: lfcp1:${R}#task:${id(2)} -->`,
  "",
  formatNodeMarker("raw", id(3)),
  '<img src="x" onerror="alert(1)">',
  "",
  formatNodeMarker("paragraph", id(4)),
  "![[remote.png]] and %% a local comment %%",
  formatBoundary("end", S),
  "",
].join("\n");

const preview = {
  resource: R,
  sectionId: id(1),
  title: "Launch",
  block: BLOCK,
  readOnly: false,
  revision: "r",
};

describe("the insert preview", () => {
  it("shows the readable text, the exact lines collapsed, and only text nodes", async () => {
    const m = new InsertSectionModal(new App() as never, preview);
    m.open();
    const el = m.contentEl as unknown as FakeElement;
    const boxes = el.children.filter((c) => c.cls === "openlfcp-share-content");
    expect(boxes).toHaveLength(1);
    const readable = boxes[0]?.text ?? "";
    expect(readable).not.toContain("lfcp-");
    expect(readable).toContain('<img src="x" onerror="alert(1)">');
    expect(readable).toContain("![[remote.png]] and %% a local comment %%");
    const details = el.findAll("details");
    expect(details).toHaveLength(1);
    expect(details[0]?.attrs.has("open")).toBe(false);
    expect(details[0]?.findAll("summary")[0]?.text).toBe("Technical details: the lines as written");
    expect(details[0]?.children.find((c) => c.cls === "openlfcp-share-content")?.text).toBe(BLOCK);
    // Nothing of the section is an element: no img, script, iframe or embed is drawn.
    for (const tag of ["img", "script", "iframe", "embed", "object"])
      expect(el.findAll(tag)).toEqual([]);
    expect(el.findAll("p").some((p) => p.cls === "openlfcp-share-problem")).toBe(false);
    el.findAll("button")
      .find((b) => b.text === "Insert")
      ?.click();
    expect(await m.result).toBe(true);
    // The block the insertion writes is the one previewed, untouched.
    expect(preview.block).toBe(BLOCK);
  });

  it("says when metadata could not be read, and hides none of it", () => {
    const broken = BLOCK.replace(formatBoundary("end", S), "");
    const m = new InsertSectionModal(new App() as never, { ...preview, block: broken });
    m.open();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.findAll("p").find((p) => p.cls === "openlfcp-share-problem")?.text).toBe(
      "The boundary of these lines could not be read, so nothing is hidden: they are shown exactly as they would be written.",
    );
    expect(el.children.find((c) => c.cls === "openlfcp-share-content")?.text).toBe(broken);
    m.close();
  });
});

describe("the insert preview's copies line (LFCP-03-061)", () => {
  it("follows the index while the dialog is open, and lets go on close", () => {
    let found: readonly string[] | null = null;
    const listeners = new Set<() => void>();
    const place = {
      where: "into this note",
      get placements() {
        return found;
      },
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const m = new InsertSectionModal(new App() as never, preview, place);
    m.open();
    const el = m.contentEl as unknown as FakeElement;
    const line = () => el.findAll("p").find((p) => p.cls === "setting-item-description")?.text;
    expect(line()).toBe("Looking for copies in your notes…");
    found = [];
    for (const l of listeners) l();
    expect(line()).toBe("Not inserted in any note yet.");
    found = ["Source.md"];
    for (const l of listeners) l();
    expect(line()).toBe("Already in: Source. Inserting adds another copy.");
    m.close();
    expect(listeners.size).toBe(0);
  });
});

describe("the insert choice (UX contract N1–N3, F-10)", () => {
  const sprint = { resource: new Uint8Array([1]), sectionId: "s1", title: "Sprint" };
  const rendered = (m: PickSectionModal, q = "") =>
    m.getSuggestions(q).map((c) => {
      const el = new FakeElement("div");
      m.renderSuggestion(c, el as never);
      return el.textContent;
    });

  it("names a section by its shared title; the name on this device only below it, when it differs", () => {
    const m = new PickSectionModal(new App() as never, [
      { ...sprint, alias: "Sprint (from B)" },
      { ...sprint, sectionId: "s2", title: "Launch", alias: "Launch" },
      { ...sprint, sectionId: "s3", title: "", alias: "Ideas" },
      { ...sprint, sectionId: "s4", title: "Plan" },
    ]);
    expect(rendered(m)).toEqual([
      "Sprint\nOn this device: Sprint (from B)",
      "Launch",
      "Ideas (name on this device)",
      "Plan",
    ]);
    expect(rendered(m, "from b")).toEqual(["Sprint\nOn this device: Sprint (from B)"]);
  });

  it("two sections with one title stay two choices", () => {
    const m = new PickSectionModal(new App() as never, [sprint, { ...sprint, sectionId: "s2" }]);
    expect(rendered(m)).toEqual(["Sprint", "Sprint"]);
    expect(choiceLabel({ ...sprint, title: "", alias: null }).primary).toBe("Untitled section");
  });
});
