// "Review conflicts…" as the user works through it (owner check of
// 0.4.0-beta.6): a choice made on one question and not yet applied must
// survive the list's re-render after another question's Apply, and nothing
// is ever chosen for the user, least of all a deletion. Apply waits for a
// choice.

import { describe, expect, it } from "vitest";
import type { RecoveryChoice, RecoveryItem } from "../../src/core/sections/recovery";
import { RecoveryModal } from "../../src/obsidian/ui/recovery";
import { App, type FakeElement } from "../mocks/obsidian";

const TASK = "019a2f85-7b31-7c42-b85a-fc843e2f4101";
const SECTION = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const PLACEMENT: RecoveryItem = {
  kind: "placement",
  key: `placement:${TASK}`,
  nodeId: TASK,
  label: 'Task "Third task"',
  choices: [
    { parent: SECTION, label: "First in the section" },
    { parent: SECTION, label: 'After Task "First task"' },
  ],
};
const LIFECYCLE: RecoveryItem = {
  kind: "lifecycle",
  key: `lifecycle:${TASK}`,
  nodeId: TASK,
  label: 'Task "Third task"',
};

type Input = FakeElement & { checked?: boolean; disabled?: boolean; name?: string };

/** The rendered questions: each with its radios and its Apply button. */
function questions(m: RecoveryModal) {
  return (m.contentEl as unknown as FakeElement).findAll("div").flatMap((box) => {
    if (!box.cls.includes("openlfcp-recovery-item")) return [];
    const radios = box.findAll("input") as Input[];
    const apply = box.findAll("button")[0] as Input;
    return [{ text: box.textContent, radios, apply }];
  });
}

const choose = (radio: Input) => {
  radio.checked = true;
  radio.trigger("change");
};

function open(items: readonly RecoveryItem[], after: readonly RecoveryItem[]) {
  const applied: [string, RecoveryChoice][] = [];
  const m = new RecoveryModal(new App() as never, "IME test", items, async (item, choice) => {
    applied.push([item.key, choice]);
    return { items: after, note: "Applied." };
  });
  m.open();
  return { m, applied };
}

describe("Review conflicts: the user's choices", () => {
  it("nothing is preselected and Apply waits for a choice, even with one option", () => {
    const single: RecoveryItem = { ...PLACEMENT, choices: [PLACEMENT.choices[0] as never] };
    const { m } = open([PLACEMENT, LIFECYCLE, single], []);
    for (const q of questions(m)) {
      expect(q.radios.every((r) => r.checked !== true)).toBe(true);
      expect(q.apply.disabled).toBe(true);
    }
  });

  it("a choice not yet applied survives another question's Apply; no deletion appears chosen", async () => {
    const { m, applied } = open([PLACEMENT, LIFECYCLE], [LIFECYCLE]);
    const [q1, q2] = questions(m);
    if (q1 === undefined || q2 === undefined) throw new Error("two questions");
    choose(q1.radios[0] as Input);
    choose(q2.radios[0] as Input); // Keep it
    q1.apply.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(applied).toEqual([[PLACEMENT.key, { parent: SECTION }]]);
    expect((m.contentEl as unknown as FakeElement).textContent).toContain("Applied.");
    const [left] = questions(m);
    if (left === undefined) throw new Error("the lifecycle question stays");
    expect(left.text).toContain("Keep it");
    expect(left.radios.map((r) => r.checked === true)).toEqual([true, false]);
    expect(left.apply.disabled).toBe(false);
    left.apply.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(applied[1]).toEqual([LIFECYCLE.key, { keep: true }]);
  });

  it("a question that changed meanwhile is asked again with nothing chosen", async () => {
    const changed: RecoveryItem = { ...LIFECYCLE, values: ["active", "active"] };
    const { m } = open([PLACEMENT, LIFECYCLE], [changed]);
    const [q1, q2] = questions(m);
    if (q1 === undefined || q2 === undefined) throw new Error("two questions");
    choose(q2.radios[1] as Input);
    choose(q1.radios[1] as Input);
    q1.apply.click();
    await new Promise((r) => setTimeout(r, 0));
    const [left] = questions(m);
    expect(left?.radios.every((r) => r.checked !== true)).toBe(true);
    expect(left?.apply.disabled).toBe(true);
  });

  it("each question's radios are one group of their own, apart from another modal's", () => {
    const a = questions(open([PLACEMENT, LIFECYCLE], []).m);
    const b = questions(open([PLACEMENT, LIFECYCLE], []).m);
    const names = [...a, ...b].map((q) => new Set(q.radios.map((r) => r.name)));
    for (const n of names) expect(n.size).toBe(1);
    expect(new Set(names.map((n) => [...n][0])).size).toBe(4);
  });
});
