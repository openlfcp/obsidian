// The card of a section whose status this device has not computed (review
// of obsidian#104, R1): loading, or never while Shared Tasks can't open its
// local data here. It says only what is known: the sync queue and the
// access were not read, so they are unknown. A locked install can still
// hold changes it did not send, so "No local changes waiting" (an empty
// queue checked) or "You can edit" would be false. Checked on a real
// runtime that kept an outbound item and then lost its secrets.

import { toBase64url } from "@openlfcp/core";
import { afterEach, describe, expect, it } from "vitest";
import { lockedText } from "../../../src/core/lfcp/install";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { notLoadedCard, sectionCard } from "../../../src/core/status/card";
import { unknownStatus } from "../../../src/core/status/reducer";
import { Device, FakeLocal } from "../../support/lfcp-env";

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => undefined);
});

/** Facts a card may only state from a status it read. */
const CHECKED = [
  "No local changes waiting.",
  "No updates waiting in the sync queue",
  "You can edit this section.",
  "You can read this section, not edit it.",
];

describe("the card of a section not loaded (obsidian#104 review R1)", () => {
  it("locked with an unsent change kept: the queue and the access are unknown, never empty", async () => {
    const local = new FakeLocal();
    const first = await LfcpRuntime.start(new Device().env(local));
    running.push(first);
    const status = first.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const url = "wss://offline.example.invalid/v1/ws";
    const R = await first.createSectionResource({
      name: "Launch",
      endpoints: [url],
      coordinatorUrl: url,
    });
    const sectionId = "0192e4a0-0000-7000-8000-000000000001";
    await first.commitSection(
      R,
      [{ intent: "section.create", sectionId, title: "Launch", createdBy: status.principalId }],
      { operationId: "create" },
    );
    await first.stop();
    // The same install on a device whose secret store lost its slots.
    const locked = await LfcpRuntime.start(new Device().env(local));
    running.push(locked);
    expect(locked.status).toMatchObject({ kind: "locked", reason: "marker-missing" });
    expect((await locked.storage?.outbound.list(R))?.length).toBeGreaterThan(0);

    const input = { title: "Launch", resource: toBase64url(R), sectionId };
    const card = notLoadedCard(input, lockedText("marker-missing"));
    expect(card.status).toBe("Not available on this device");
    expect(card.problems[0]).toBe(lockedText("marker-missing"));
    expect(card.facts).toEqual([
      "Changes from this device waiting to sync: unknown while Shared Tasks is not available on this device.",
      "Not checked with the server.",
      "Your access to this section: unknown while Shared Tasks is not available on this device.",
    ]);
    for (const claim of CHECKED) expect(card.facts.join("\n"), claim).not.toContain(claim);

    // Loading (nothing read yet): the same facts, "not checked yet".
    const loading = notLoadedCard(input, null);
    expect(loading.status).toBe("Loading shared section");
    expect(loading.problems).toEqual([]);
    expect(loading.facts).toEqual([
      "Changes from this device waiting to sync: not checked yet.",
      "Not checked with the server yet.",
      "Your access to this section: not checked yet.",
    ]);
    for (const claim of CHECKED) expect(loading.facts.join("\n"), claim).not.toContain(claim);
    // The rest of the card is the reducer's own "no evidence" card.
    const plain = sectionCard({ ...input, view: unknownStatus() });
    expect({ ...loading, facts: plain.facts }).toEqual(plain);
  });
});
