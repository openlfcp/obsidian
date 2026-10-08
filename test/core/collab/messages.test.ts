// Plain-language text for §62 codes (LFCP-065).

import { describe, expect, it } from "vitest";
import { plainCode } from "../../../src/core/collab/messages";

describe("plainCode", () => {
  it("words UNKNOWN_PREVIOUS (ADR 0008) as a wait, not a failure", () => {
    const text = plainCode("UNKNOWN_PREVIOUS");
    expect(text).toBe(
      "Waiting for the server to catch up with earlier changes; they are sent again.",
    );
    expect(text).not.toMatch(/fail|error|refused|lost/i);
  });

  it("names an unknown code as it is", () => {
    expect(plainCode("SOMETHING_NEW")).toBe("The operation failed (SOMETHING_NEW).");
  });
});
