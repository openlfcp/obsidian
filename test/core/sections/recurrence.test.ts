// MS43 (MARKDOWN-SECTIONS-01 §4.1, host fact H8): the Obsidian Tasks
// plugin completes a recurring Task whose inline ref precedes its fields,
// and writes the next occurrence above with a copy of the ref. The copy
// becomes a new Task with a new identity; the completed Task keeps its ref.
// The notes are copied from MARKDOWN-SECTIONS-FIXTURES-01 (spec
// mvp-0.2-baseline.1).

import { fromBase64url, principalId, resourceId } from "@openlfcp/core";
import { createTask, SharedObjectsReplica } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { planShare } from "../../../src/core/collab/markdown";
import { scanRefs } from "../../../src/core/refs";
import { MemorySectionBaseStore, markdownState } from "../../../src/core/sections/base";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { MemorySectionJournalStore } from "../../../src/core/sections/journal";
import { parseSections } from "../../../src/core/sections/parser";
import { FakeSectionPort } from "./fake-port";

const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
const SECTION_ID = "268a166f-4891-7243-840e-e7fea9fe6390";
const SECTION = `lfcp1:${R}#section:${SECTION_ID}`;
const TASK = "2372cd94-58dc-7fd0-bbc6-6e17c0aebc80";
const NEXT = "e9a163ea-76d2-7b98-ad10-1a0e7fbb278a";
const REF = (id: string) => `<!-- lfcp-ref: lfcp1:${R}#task:${id} -->`;
const note = (...lines: string[]) =>
  [
    "PRIVATE_BEFORE_8f3a: budget and personal thoughts.",
    "",
    "## Joint launch",
    `<!-- lfcp-section: ${SECTION} -->`,
    ...lines,
    `<!-- /lfcp-section: ${SECTION} -->`,
    "",
    "PRIVATE_AFTER_71c2: do not transmit.",
    "",
  ].join("\n");
const BEFORE = note(`- [ ] Water plants ${REF(TASK)} 🔁 every week 📅 2026-10-08`);
const OBSERVED = note(
  `- [ ] Water plants ${REF(TASK)} 🔁 every week 📅 2026-10-15`,
  `- [x] Water plants ${REF(TASK)} 🔁 every week 📅 2026-10-08 ✅ 2026-10-08`,
);
const AFTER = note(
  `- [ ] Water plants ${REF(NEXT)} 🔁 every week 📅 2026-10-15`,
  `- [x] Water plants ${REF(TASK)} 🔁 every week 📅 2026-10-08 ✅ 2026-10-08`,
);
const me = principalId(new Uint8Array(32).fill(4));

async function setup() {
  const port = new FakeSectionPort();
  const s = parseSections(BEFORE).sections[0];
  if (s === undefined) throw new Error("no section");
  port.host(R, SECTION_ID, markdownState(BEFORE, s).state);
  const { replica } = SharedObjectsReplica.create({
    resource: resourceId(fromBase64url(R)),
    principal: me,
  });
  replica.apply(
    createTask({ id: TASK as never, title: "Water plants", createdBy: me, due: "2026-10-08" })
      .intent,
  );
  port.onTaskIntents = (intents) => {
    for (const i of intents) replica.apply(i as never);
  };
  const engine = new SectionEngine({
    port,
    journal: new MemorySectionJournalStore(),
    bases: new MemorySectionBaseStore(),
    newNodeId: () => NEXT,
    newOperationId: () => "op-1",
    createdBy: me,
    newProjectionId: () => "projection",
    tasks: (_r, id) => (id === TASK ? { view: replica.task(TASK) } : undefined),
    newTask: (line, id) => {
      const state = scanRefs(line).tasks[0];
      const create = state === undefined ? undefined : planShare(state, me, id as never).intents[0];
      if (create?.intent !== "task.create") throw new Error("no task");
      return create.task;
    },
    refPlacement: () => "inline",
  });
  const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
  const seed = await engine.pass("Garden.md", BEFORE, ctx);
  await engine.written(seed, BEFORE);
  return { port, engine, ctx, replica };
}

describe("MS43: a recurring Task's next occurrence", () => {
  it("the copied ref becomes a new Task in the configured placement; the original is completed", async () => {
    const { port, engine, ctx, replica } = await setup();
    const pass = await engine.pass("Garden.md", OBSERVED, { ...ctx, external: true });
    const out = applyChanges(OBSERVED, pass.changes);
    await engine.written(pass, out);
    expect(out).toBe(AFTER);
    expect(port.changes).toHaveLength(1);
    const [create, complete] = port.changes[0]?.intents ?? [];
    expect(create).toMatchObject({
      intent: "task.create_in_section",
      task: { id: NEXT, title: "Water plants", due: "2026-10-15" },
      parent: SECTION_ID,
    });
    expect(complete).toEqual({ intent: "task.complete", id: TASK, completionDate: "2026-10-08" });
    expect(replica.task(TASK)?.task?.status).toBe("done");
    const again = await engine.pass("Garden.md", out, ctx);
    expect(again.changes).toEqual([]);
  });

  it("a copy the user made (not an external edit) stays a duplicate: the section pauses", async () => {
    const { port, engine, ctx } = await setup();
    const pass = await engine.pass("Garden.md", OBSERVED, ctx);
    expect(pass.changes).toEqual([]);
    expect(pass.sections[0]?.skipped).toBe("blocked");
    expect(port.changes).toEqual([]);
  });
});
