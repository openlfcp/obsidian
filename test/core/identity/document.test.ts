// The Identity Resource's document port (src/core/identity/document.ts):
// the SDK's IdentityDocumentPort contract says receive answers false for a
// unit it refuses, so an unreadable unit in the device list is refused, not
// thrown at the flow that loads it (review obsidian#109b P2).

import { generateResourceId, type PrincipalId } from "@openlfcp/core";
import { expect, it } from "vitest";
import { identityDocument } from "../../../src/core/identity/document";

it("refuses, does not throw, a unit whose plaintext is no identity change", () => {
  const root = new Uint8Array(32).fill(7) as PrincipalId;
  const doc = identityDocument(generateResourceId(), root);
  const author = { signer: root, actorSeq: 3n, writerClass: "root" as const };
  expect(doc.receive(new TextEncoder().encode("not an identity change"), author)).toBe(false);
  expect(doc.initialized()).toBe(false);
});
