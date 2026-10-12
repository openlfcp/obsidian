// What a join that did not finish tells the user: a refusal by the server
// is not a connection problem.

import { describe, expect, it } from "vitest";
import { joinUnavailableMessage } from "../../../src/core/collab/service";

describe("joinUnavailableMessage", () => {
  it("a request the server refused: no advice to go online", () => {
    const text = joinUnavailableMessage("RESOURCE_OPEN was refused: AUTHORIZATION_FAILED", false);
    expect(text).toContain("refused the join (RESOURCE_OPEN was refused: AUTHORIZATION_FAILED)");
    expect(text).toContain("join again with the same link");
    expect(text).not.toMatch(/connection|online/i);
  });

  it("no answer: joining needs a connection", () => {
    const text = joinUnavailableMessage("the connection closed", false);
    expect(text).toContain("Joining needs a connection; try again when online.");
  });

  it("a claim sent without an answer is kept on this device", () => {
    const text = joinUnavailableMessage("CONTROL_PUT got no answer", true);
    expect(text).toContain("It is kept on this device");
  });
});
