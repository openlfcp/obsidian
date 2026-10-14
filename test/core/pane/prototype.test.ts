// The pane prototype's mock transitions (LFCP-03-007): every scenario has a
// model, an unknown result is checked and resumes the same flow (never a
// new one), Cancel before an effect goes back, and an effect started makes
// it "Continue later" and an unfinished flow.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paneTexts } from "../../../src/core/pane/model";
import { PanePrototype, type PrototypeFixture } from "../../../src/core/pane/prototype";

const fixtures = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../fixtures/ux-0.3/states.json"), "utf8"),
  ) as { states: PrototypeFixture[] }
).states;

describe("pane prototype", () => {
  it("lists the four layouts, the join start and every fixture, each with a model", () => {
    const proto = new PanePrototype(fixtures);
    const ids = proto.scenarios().map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual(["first-use", "just-joined", "healthy", "held-edits"]);
    expect(ids.filter((i) => i.startsWith("fixture:")).length).toBe(fixtures.length);
    for (const id of ids) {
      proto.select(id);
      expect(proto.model().title).toBe("Shared Tasks");
    }
  });

  it("gives the layouts of UX §3 their primary action", () => {
    const proto = new PanePrototype(fixtures);
    const primary = (id: string) => {
      proto.select(id);
      return proto.model().primary?.id ?? null;
    };
    expect(primary("first-use")).toBe("share-section");
    expect(primary("just-joined")).toBe("insert-into-note");
    expect(primary("healthy")).toBe("invite");
    expect(primary("held-edits")).toBe("repair-sections");
  });

  it("checks an unknown result and resumes the same flow at the same stage", () => {
    const proto = new PanePrototype(fixtures, "first-use");
    proto.act("share-section");
    proto.act("share-section");
    proto.control("result-unknown");
    expect(proto.model().primary?.id).toBe("check-result");
    expect(paneTexts(proto.model()).join("\n")).toContain("result is not known yet");
    proto.act("check-result");
    const flow = proto.model().flow;
    expect(flow?.outcome).toBe("running");
    expect(flow?.steps.find((s) => s.state === "current")?.label).toBe(
      "Create the shared section on this device",
    );
  });

  it("cancels before an effect, and only continues later after one", () => {
    const proto = new PanePrototype(fixtures, "first-use");
    proto.act("share-section");
    expect(proto.controls().map((c) => c.id)).toContain("cancel");
    proto.control("cancel");
    expect(proto.model().flow).toBeNull();
    expect(proto.model().notice).toBe("Cancelled. Nothing was changed.");

    proto.select("healthy");
    proto.act("invite");
    proto.act("invite");
    proto.control("finish-step");
    expect(proto.controls().map((c) => c.id)).toContain("later");
    proto.control("later");
    const m = proto.model();
    expect(m.primary?.id).toBe("continue-flow");
    expect(m.unfinished.map((u) => u.title)).toEqual(["Inviting a collaborator"]);
    proto.act("continue-flow");
    expect(proto.model().flow?.outcome).toBe("running");
  });

  it("runs nothing for an action outside a flow: it says what would open", () => {
    const proto = new PanePrototype(fixtures, "healthy");
    proto.act("detach-section");
    expect(proto.model().notice).toContain("Nothing runs here.");
  });
});
