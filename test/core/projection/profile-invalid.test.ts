// Follow-up (d) of LFCP-061: a real PROFILE_INVALID object, from bytes
// (test/fixtures/shared-objects), loaded only through the SDK.

import { readFileSync } from "node:fs";
import { fromHex, principalId, resourceId, toBase64url } from "@openlfcp/core";
import { SharedObjectsReplica } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { planIntents } from "../../../src/core/projection/intents";
import { renderNote } from "../../../src/core/projection/render";
import { parseTaskText } from "../../../src/core/projection/task-text";

describe("a real PROFILE_INVALID object (follow-up d)", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../fixtures/shared-objects/profile-invalid-text-title.json", import.meta.url),
      "utf8",
    ),
  ) as { save_hex: string; resource_hex: string; principal_hex: string; object_id: string };
  const replica = SharedObjectsReplica.fromSave(fromHex(fixture.save_hex), {
    resource: resourceId(fromHex(fixture.resource_hex)),
    principal: principalId(fromHex(fixture.principal_hex)),
  });
  const view = replica.task(fixture.object_id);

  it("loads through the SDK as profile_invalid", () => {
    expect(view?.status).toBe("profile_invalid");
    expect(view?.problems.map((p) => p.diagnostic)).toEqual(["INVALID_FIELD_TYPE"]);
  });

  it("sends no intents and is not rewritten", () => {
    const plan = planIntents({ status: "done", text: parseTaskText("Edited") }, view);
    expect(plan.intents).toEqual([]);
    expect(plan.issues.map((i) => i.code)).toContain("OBJECT_PROFILE_INVALID");
    const note = `- [x] Edited <!-- lfcp-ref: lfcp1:${toBase64url(fromHex(fixture.resource_hex))}#task:${fixture.object_id} -->\n`;
    const out = renderNote(note, () => ({ view }));
    expect(out).toMatchObject({ changed: false, text: note });
    expect(out.projections[0]?.issues.map((i) => i.code)).toEqual(["OBJECT_PROFILE_INVALID"]);
  });
});
