// LFCP-064: projection writes are surgical. Each test renders one change and
// asserts the exact span that differs between the note before and after
// (common prefix and suffix), so anything outside the owned token range is
// proven byte-identical.

import { principalId, resourceId, toBase64url } from "@openlfcp/core";
import {
  addTag,
  complete,
  createTask,
  type ReplicaIntent,
  removeTag,
  SharedObjectsReplica,
  setDue,
  setPriority,
  setTitle,
  type Task,
} from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { renderNote } from "../../../src/core/projection/render";

const R = resourceId(new Uint8Array(32).fill(3));
const ME = principalId(new Uint8Array(32).fill(4));
const A = "019a2f85-7b31-7c42-b85a-fc843e2f40ad";
const B = "019a2f85-7b31-7c42-9f24-8f933f2a91c0";
const ref = (id: string) => `<!-- lfcp-ref: lfcp1:${toBase64url(R)}#task:${id} -->`;

function setup(
  tasks: Record<
    string,
    Parameters<typeof createTask>[0] extends infer T ? Omit<T & object, "createdBy" | "id"> : never
  >,
) {
  const { replica } = SharedObjectsReplica.create({ resource: R, principal: ME });
  for (const [id, t] of Object.entries(tasks))
    replica.apply(createTask({ id: id as never, createdBy: ME, ...t }).intent);
  const task = (id: string) => replica.task(id)?.task as Task;
  const apply = (intent: ReplicaIntent) => replica.apply(intent);
  const render = (note: string) =>
    renderNote(note, (key) => {
      const id = key.split("#")[1] as string;
      return replica.task(id) === undefined ? undefined : { view: replica.task(id) };
    });
  return { task, apply, render };
}

/** The span that differs: [removed, inserted], with everything else identical. */
function changed(before: string, after: string): [string, string] {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  )
    s++;
  return [before.slice(p, before.length - s), after.slice(p, after.length - s)];
}

describe("minimal-diff projection writes (LFCP-064)", () => {
  it("1. checkbox only: one character", () => {
    // A mid-text #tag is title text (ruling a), so it is part of the shared title.
    const x = setup({ [A]: { title: "API contract #important some-local-marker" } });
    const note = `- [ ] API contract #important some-local-marker ${ref(A)}\n`;
    x.apply(complete(x.task(A)).intent);
    expect(changed(note, x.render(note).text)).toEqual([" ", "x"]);
  });

  it("2. Unicode titles: only the title span, no broken surrogates", () => {
    const x = setup({ [A]: { title: "合同 🧾 café" } });
    const note = `  - [ ] 合同 🧾 café 📅 2026-10-10\n    ${ref(A)}\n`;
    x.apply(setTitle(x.task(A), "合同 📝 café").intent);
    x.apply(setDue(x.task(A), "2026-10-10").intent);
    const after = x.render(note).text;
    expect(changed(note, after)).toEqual(["🧾", "📝"]);
    expect(after).not.toContain("�");
    expect(after).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("3. title + due: each change touches only its own span", () => {
    const x = setup({ [A]: { title: "Prepare API contract", due: "2026-10-10" } });
    const note = `- [ ] Prepare API contract 📅 2026-10-10\n  ${ref(A)}\n`;
    x.apply(setDue(x.task(A), "2026-10-12").intent);
    expect(changed(note, x.render(note).text)).toEqual(["0", "2"]);
    x.apply(setTitle(x.task(A), "Prepare the API contract").intent);
    const after = x.render(note).text;
    expect(after).toBe(`- [ ] Prepare the API contract 📅 2026-10-12\n  ${ref(A)}\n`);
  });

  it("4. unknown suffix tokens and a VS16 date keep their bytes", () => {
    const x = setup({ [A]: { title: "Water", due: "2026-10-10" } });
    const note = `- [ ] Water 🔼 🔁 every week custom 🛫 2026-10-01 📅️ 2026-10-10 ^w1\n  ${ref(A)}\n`;
    x.apply(setDue(x.task(A), "2026-10-11").intent);
    expect(changed(note, x.render(note).text)).toEqual(["0", "1"]);
  });

  it("5. inline: the ref is untouched and stays the last element", () => {
    const x = setup({ [A]: { title: "T" } });
    const note = `- [ ] T ${ref(A)}  \n`;
    x.apply(setDue(x.task(A), "2026-10-10").intent);
    x.apply(setPriority(x.task(A), "high").intent);
    const after = x.render(note).text;
    expect(after).toBe(`- [ ] T ⏫ 📅 2026-10-10 ${ref(A)}  \n`);
    expect(after.trimEnd().endsWith(ref(A))).toBe(true);
  });

  it("6, 7. child: the ref line and nested indentation are untouched", () => {
    const x = setup({ [A]: { title: "Nested" } });
    const note = `- [ ] Parent\n\t- [ ] Nested\n\t  ${ref(A)}\n`;
    x.apply(complete(x.task(A), "2026-10-03").intent);
    expect(changed(note, x.render(note).text)).toEqual([" ] Nested", "x] Nested ✅ 2026-10-03"]);
  });

  it("8, 9. CRLF and the presence or absence of a final newline are kept", () => {
    const x = setup({ [A]: { title: "T" } });
    x.apply(complete(x.task(A)).intent);
    for (const note of [
      `a\r\n- [ ] T\r\n  ${ref(A)}\r\n`,
      `a\r\n- [ ] T\r\n  ${ref(A)}`,
      `- [ ] T ${ref(A)}`,
    ]) {
      expect(changed(note, x.render(note).text)).toEqual([" ", "x"]);
    }
  });

  it("10, 11, 12. changing Task B leaves Task A and the prose exact", () => {
    const x = setup({ [A]: { title: "A task" }, [B]: { title: "B task" } });
    const note = `Intro *prose*.\n\n- [ ] A task ${ref(A)}\n\nMiddle.\n- [ ] B task\n  ${ref(B)}\nEnd.`;
    x.apply(setTitle(x.task(B), "B task renamed").intent);
    expect(changed(note, x.render(note).text)).toEqual(["", " renamed"]);
  });

  it("tags: added after the user's last tag, removed in place, order kept", () => {
    const x = setup({ [A]: { title: "T", tags: ["web", "release"] } });
    const note = `- [ ] T #web #release 📅 2026-10-10 ${ref(A)}\n`;
    x.apply(setDue(x.task(A), "2026-10-10").intent);
    x.apply(addTag(x.task(A), "ops").intent);
    expect(x.render(note).text).toBe(`- [ ] T #web #release #ops 📅 2026-10-10 ${ref(A)}\n`);
    x.apply(removeTag(x.task(A), "web").intent);
    expect(x.render(note).text).toBe(`- [ ] T #release #ops 📅 2026-10-10 ${ref(A)}\n`);
  });

  it("priority: only the emoji changes", () => {
    const x = setup({ [A]: { title: "T", priority: "high" } });
    const note = `- [ ] T ⏫ 📅 2026-10-10 ${ref(A)}\n`;
    x.apply(setDue(x.task(A), "2026-10-10").intent);
    x.apply(setPriority(x.task(A), "low").intent);
    expect(changed(note, x.render(note).text)).toEqual(["⏫", "🔽"]);
  });

  it("14. a second identical render is a no-op", () => {
    const x = setup({ [A]: { title: "T" } });
    x.apply(complete(x.task(A), "2026-10-03").intent);
    const once = x.render(`- [ ] T ${ref(A)}\n`);
    expect(x.render(once.text)).toMatchObject({ changed: false, text: once.text });
  });
});
