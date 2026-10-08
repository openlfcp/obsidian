// LFCP-02-040: remote changes projected into the note as minimal,
// revision-checked patches (SDK-SECTIONS-INTEGRATION-01 §7.6). The MS02,
// MS12 and MS14 notes are copied from MARKDOWN-SECTIONS-FIXTURES-01
// (spec mvp-0.2-baseline.1), which the spec pin does not include yet.

import { fromBase64url, principalId, resourceId } from "@openlfcp/core";
import { complete, createTask, SharedObjectsReplica, type Task } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { markdownState, type SectionState } from "../../../src/core/sections/base";
import { parseSections } from "../../../src/core/sections/parser";
import type { ModelNode, SectionSnapshot } from "../../../src/core/sections/port";
import { applyRemote, planRemote, type RemotePatch } from "../../../src/core/sections/remote";

const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
const SECTION = `lfcp1:${R}#section:268a166f-4891-7243-840e-e7fea9fe6390`;
const TASK = "2372cd94-58dc-7fd0-bbc6-6e17c0aebc80";
const PARA = "84cf3237-3432-7041-881f-c34897689278";
const ITEM = "be46412d-1708-757e-ad18-e21fa7c61c68";
const REF = `<!-- lfcp-ref: lfcp1:${R}#task:${TASK} -->`;
const START = `<!-- lfcp-section: ${SECTION} -->`;
const END = `<!-- /lfcp-section: ${SECTION} -->`;
const BEFORE = "PRIVATE_BEFORE_8f3a: budget and personal thoughts.";
const AFTER = "PRIVATE_AFTER_71c2: do not transmit.";

/** MS12/MS14's note: a Task with a child paragraph and item. */
const nested = (eol: string, task = "Prepare contract", para = "Draft contract") =>
  [
    BEFORE,
    "",
    "## Joint launch",
    START,
    `- [ ] ${task}`,
    `  ${REF}`,
    `  <!-- lfcp-node: paragraph:${PARA} -->`,
    `  ${para}`,
    "",
    "  - Check details",
    `    <!-- lfcp-node: item:${ITEM} -->`,
    END,
    "",
    AFTER,
    "",
  ].join(eol);

const ME = principalId(new Uint8Array(32).fill(4));

/** A Task view of the fixture's Task, completed when `done`. */
function tasks(title: string, done: boolean) {
  const { replica } = SharedObjectsReplica.create({
    resource: resourceId(fromBase64url(R)),
    principal: ME,
  });
  replica.apply(createTask({ id: TASK as never, title, createdBy: ME }).intent);
  if (done) replica.apply(complete(replica.task(TASK)?.task as Task).intent);
  return (id: string) => (id === TASK ? { view: replica.task(TASK) } : undefined);
}

/** The model as the note's base shows it, with changes. */
function snapshot(
  base: SectionState,
  change: {
    title?: string;
    nodes?: Record<string, Partial<ModelNode> | null>;
    problems?: SectionSnapshot["problems"];
    ready?: boolean;
  } = {},
): SectionSnapshot {
  const nodes: Record<string, ModelNode> = {};
  for (const [id, n] of Object.entries(base.nodes))
    nodes[id] = {
      kind: n.kind,
      parent: n.parent,
      lifecycle: "active",
      ...(n.text === undefined ? {} : { text: n.text }),
    };
  for (const [id, n] of Object.entries(change.nodes ?? {})) {
    if (n === null) delete nodes[id];
    else nodes[id] = { ...(nodes[id] as ModelNode), ...n };
  }
  return {
    revision: "heads-2",
    title: change.title ?? base.title,
    ready: change.ready ?? true,
    nodes,
    order: base.order,
    problems: change.problems ?? [],
  };
}

const sectionOf = (md: string, at = 0) => {
  const s = parseSections(md).sections[at];
  if (s === undefined) throw new Error("no section");
  return s;
};
const baseOf = (md: string, at = 0) => markdownState(md, sectionOf(md, at)).state;

function patch(
  md: string,
  base: SectionState,
  model: SectionSnapshot,
  t = tasks("Prepare contract", false),
  at = 0,
) {
  const plan = planRemote(md, sectionOf(md, at), base, model, t);
  if (plan.kind !== "patch") throw new Error(`skipped: ${plan.reason}`);
  return plan;
}
const applied = (md: string, p: RemotePatch) => applyRemote(md, p) as string;

describe("remote Task changes (MS02, MS12)", () => {
  it("MS02: a remote completion keeps both projections' ref placements", () => {
    const md = [
      BEFORE,
      "",
      "## Joint launch",
      START,
      "- [ ] Prepare contract",
      `  ${REF}`,
      END,
      "",
      "## Joint launch",
      START,
      `- [ ] Prepare contract ${REF}`,
      END,
      "",
      AFTER,
      "",
    ].join("\n");
    const done = tasks("Prepare contract", true);
    let out = md;
    for (const at of [0, 1]) {
      const base = baseOf(md, at);
      out = applied(out, patch(out, base, snapshot(base), done, at));
    }
    expect(out).toBe(md.replaceAll("- [ ] Prepare", "- [x] Prepare"));
  });

  it("MS12: one character changes; CRLF, Cyrillic, emoji and private text stay", () => {
    const md = nested("\r\n", "Договор 😀");
    const base = baseOf(md);
    const p = patch(md, base, snapshot(base), tasks("Договор 😀", true));
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]?.insert).toBe("x");
    expect((p.changes[0]?.to ?? 0) - (p.changes[0]?.from ?? 0)).toBe(1);
    expect(applied(md, p)).toBe(md.replace("- [ ] Договор", "- [x] Договор"));
  });

  it("leaves a Task line the user changed since the base", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const edited = md.replace("Prepare contract", "Prepare the contract");
    const p = patch(edited, base, snapshot(base), tasks("Prepare contract", true));
    expect(p.changes).toEqual([]);
    expect(p.deferred).toEqual([{ nodeId: TASK, reason: "local-edit" }]);
  });
});

describe("remote Text changes", () => {
  it("patches only the changed span of a paragraph, in UTF-16 offsets", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const p = patch(
      md,
      base,
      snapshot(base, { nodes: { [PARA]: { text: "Draft the contract 🦔" } } }),
    );
    // One edit after "Draft ", in the note's UTF-16 offsets (🦔 is two units).
    const at = md.indexOf("Draft contract");
    expect(p.changes).toEqual([{ from: at + 6, to: at + 14, insert: "the contract 🦔" }]);
    expect(applied(md, p)).toBe(nested("\n", "Prepare contract", "Draft the contract 🦔"));
    expect(p.base.nodes[PARA]?.text).toBe("Draft the contract 🦔");
  });

  it("writes a new line of Text with the note's line ending and the node's indentation", () => {
    const md = nested("\r\n");
    const base = baseOf(md);
    const p = patch(
      md,
      base,
      snapshot(base, { nodes: { [PARA]: { text: "Draft contract\nand sign" } } }),
    );
    expect(applied(md, p)).toBe(
      md.replace("  Draft contract\r\n", "  Draft contract\r\n  and sign\r\n"),
    );
  });

  it("never overwrites concurrent local typing: the local edit goes first", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const typed = md.replace("Draft contract", "Draft contract v2");
    const p = patch(
      typed,
      base,
      snapshot(base, { nodes: { [PARA]: { text: "Draft agreement" } } }),
    );
    expect(p.changes).toEqual([]);
    expect(p.deferred).toEqual([{ nodeId: PARA, reason: "local-edit" }]);
    expect(p.base.nodes[PARA]?.text).toBe("Draft contract");
  });

  it("does not write a blank line into a paragraph (it would split it)", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const p = patch(md, base, snapshot(base, { nodes: { [PARA]: { text: "One\n\nTwo" } } }));
    expect(p.changes).toEqual([]);
    expect(p.deferred).toEqual([{ nodeId: PARA, reason: "unrenderable" }]);
  });

  it("advances the base when the note already shows the model's Text", () => {
    const md = nested("\n", "Prepare contract", "Same here");
    const base = baseOf(nested("\n"));
    const p = patch(md, base, snapshot(base, { nodes: { [PARA]: { text: "Same here" } } }));
    expect(p.changes).toEqual([]);
    expect(p.base.nodes[PARA]?.text).toBe("Same here");
  });
});

describe("the title", () => {
  it("changes only the title, keeping the heading level and closing hashes", () => {
    const md = nested("\n").replace("## Joint launch", "##  Joint launch ##");
    const base = baseOf(md);
    const p = patch(md, base, snapshot(base, { title: "Joint launch plan" }));
    expect(applied(md, p)).toBe(md.replace("##  Joint launch ##", "##  Joint launch plan ##"));
    expect(p.base.title).toBe("Joint launch plan");
  });

  it("leaves a title the user is editing", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const p = patch(
      md.replace("Joint launch", "Joint lunch"),
      base,
      snapshot(base, { title: "Launch" }),
    );
    expect(p.changes).toEqual([]);
    expect(p.deferred).toEqual([{ nodeId: null, reason: "local-edit" }]);
  });
});

describe("deletions and structure (MS14)", () => {
  it("removes a node deleted in the model, its marker and one blank line with it", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const p = patch(md, base, snapshot(base, { nodes: { [PARA]: { lifecycle: "deleted" } } }));
    expect(applied(md, p)).toBe(
      md.replace(`  <!-- lfcp-node: paragraph:${PARA} -->\n  Draft contract\n\n`, ""),
    );
    expect(p.base.nodes[PARA]).toBeUndefined();
    expect(p.base.order[TASK]).toEqual([ITEM]);
  });

  it("keeps a deleted node that was edited here, or that holds a local comment", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const deleted = snapshot(base, { nodes: { [PARA]: { lifecycle: "deleted" } } });
    const edited = patch(md.replace("Draft contract", "Draft contract!"), base, deleted);
    expect(edited.changes).toEqual([]);
    expect(edited.deferred).toEqual([{ nodeId: PARA, reason: "edited-under-deletion" }]);
    // A local comment among a deleted Task's children.
    const commented = md.replace("  - Check details", "  %% mine %%\n\n  - Check details");
    const cbase = baseOf(commented);
    expect(sectionOf(commented).localBlocks).toHaveLength(1);
    const local = patch(
      commented,
      cbase,
      snapshot(cbase, { nodes: { [TASK]: { lifecycle: "deleted" } } }),
    );
    expect(local.changes).toEqual([]);
    expect(local.deferred).toEqual([{ nodeId: TASK, reason: "private-text" }]);
  });

  it("MS14: a remote parent cycle keeps the last safe source and projects nothing structural", () => {
    const md = nested("\n");
    const base = baseOf(md);
    // The effective tree omits the cycle's nodes; one of them is also deleted.
    const p = patch(
      md,
      base,
      snapshot(base, {
        nodes: { [PARA]: null, [ITEM]: { lifecycle: "deleted" } },
        problems: [{ code: "PARENT_CYCLE", nodeIds: [PARA, ITEM] }],
      }),
    );
    expect(p.frozen).toBe(true);
    expect(p.changes).toEqual([]);
    expect(applied(md, p)).toBe(md);
    expect(p.base).toEqual(base);
  });

  it("never deletes a node only because the model's tree omits it", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const p = patch(md, base, snapshot(base, { nodes: { [ITEM]: null } }));
    expect(p.changes).toEqual([]);
    expect(p.base.nodes[ITEM]).toBeDefined();
  });

  it("lists created and moved nodes for the structural writer", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const NEW = "019a2f85-7b31-7c42-b85a-fc843e2f4fff";
    const p = patch(
      md,
      base,
      snapshot(base, {
        nodes: {
          [NEW]: { kind: "paragraph", parent: null, lifecycle: "active", text: "New" },
          [ITEM]: { parent: null },
        },
      }),
    );
    expect(p.unprojected).toEqual([ITEM, NEW].sort());
    expect(p.changes).toEqual([]);
  });
});

describe("revision checks and skips", () => {
  it("refuses to apply to another revision of the note", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const p = patch(md, base, snapshot(base, { nodes: { [PARA]: { text: "Draft agreement" } } }));
    expect(applyRemote(`${md}typed`, p)).toBeNull();
  });

  it("is idempotent once its base is recorded", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const model = snapshot(base, { title: "Plan", nodes: { [PARA]: { text: "Signed" } } });
    const done = tasks("Prepare contract", true);
    const first = patch(md, base, model, done);
    const out = applied(md, first);
    const again = patch(out, first.base, model, done);
    expect(again.changes).toEqual([]);
    expect(again.base).toEqual(first.base);
  });

  it("projects nothing while importing, without a base (MS11) or in a paused section", () => {
    const md = nested("\n");
    const base = baseOf(md);
    const t = tasks("Prepare contract", false);
    expect(planRemote(md, sectionOf(md), base, snapshot(base, { ready: false }), t)).toEqual({
      kind: "skip",
      reason: "importing",
    });
    expect(planRemote(md, sectionOf(md), undefined, snapshot(base), t)).toEqual({
      kind: "skip",
      reason: "no-base",
    });
    const paused = md.replace("  Draft contract", "  Draft contract\n### Nested");
    expect(planRemote(paused, sectionOf(paused), base, snapshot(base), t)).toEqual({
      kind: "skip",
      reason: "blocked",
    });
  });
});
