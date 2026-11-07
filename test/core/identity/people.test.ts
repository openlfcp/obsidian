import { fromHex, type PrincipalId } from "@openlfcp/core";
import { principalRef } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import {
  aliasKey,
  aliasOf,
  assignedPeople,
  assigneeRef,
  authorOf,
  deviceDetail,
  fingerprintOf,
  isAssignedTo,
  peopleOf,
  shortId,
} from "../../../src/core/identity/people";
import { P, stateOfX, X } from "./x-chain";

const ref = (hex: string) => principalRef(fromHex(hex) as PrincipalId);
const label = (hex: string) => Object.entries(X.principals).find(([, h]) => h === hex)?.[0] ?? hex;

describe("people of a Resource (IDENTITY-PROFILE-01 §10, W §80.1)", () => {
  it("rootOf matches the root_of_corpus vector at every head", () => {
    for (const [head, at] of Object.entries(X.rootOf)) {
      const people = peopleOf(stateOfX(at.records), P("OWNER"));
      for (const [name, want] of Object.entries(at.expected)) {
        expect(`${head} ${name} → ${label(people.root(P(name)))}`).toBe(
          `${head} ${name} → ${want.rootOf}`,
        );
        // A device is shown active exactly when the SDK's activeDevice says so.
        expect(`${head} ${name} active ${people.device(P(name))?.status === "active"}`).toBe(
          `${head} ${name} active ${want.active}`,
        );
      }
    }
  });

  it("lists each person's registered devices with their status, the cascade and revocation included", () => {
    const people = peopleOf(stateOfX(), P("DEV_B"));
    const owner = new Map(people.devices(P("OWNER")).map((d) => [label(d.principal), d]));
    expect([...owner.keys()].sort()).toEqual(["DEV_A", "DEV_B"]);
    // I9: DEV_A revoked; I10: DEV_B re-certified by the owner, active.
    expect(owner.get("DEV_A")).toMatchObject({ kind: "personal", status: "removed" });
    expect(owner.get("DEV_B")).toMatchObject({ kind: "personal", status: "active" });
    const bob = new Map(people.devices(P("BOB")).map((d) => [label(d.principal), d]));
    // I13: the owner expels DEV_C; DEV_E (issued by DEV_C) is suspended; BRIDGE stays active.
    expect(bob.get("DEV_C")?.status).toBe("removed");
    expect(bob.get("DEV_E")?.status).toBe("suspended");
    expect(bob.get("BRIDGE")).toMatchObject({ kind: "service", status: "active" });
    expect(people.devices(P("CAROL"))).toEqual([]);
    expect(people.device(P("OWNER"))).toBeUndefined();
  });

  it("the reader's person is its root, and all of its devices are the reader's", () => {
    const people = peopleOf(stateOfX(), P("DEV_B"));
    expect(people.me).toBe(P("OWNER"));
    for (const p of ["OWNER", "DEV_A", "DEV_B"]) expect(people.mine(P(p))).toBe(true);
    for (const p of ["BOB", "DEV_C", "BRIDGE", "CAROL"]) expect(people.mine(P(p))).toBe(false);
  });

  it("without a validated state every Principal is its own person", () => {
    const people = peopleOf(null, P("DEV_B"));
    expect(people.root(P("DEV_B"))).toBe(P("DEV_B"));
    expect(people.me).toBe(P("DEV_B"));
    expect(people.devices(P("OWNER"))).toEqual([]);
  });

  it("attributes a change to rootOf(actor), the device as detail, a revoked one included", () => {
    const people = peopleOf(stateOfX(), P("OWNER"));
    expect(authorOf(people, P("OWNER"))).toEqual({ root: P("OWNER"), device: null });
    const a = authorOf(people, P("DEV_A"));
    expect(a.root).toBe(P("OWNER"));
    expect(a.device?.status).toBe("removed");
    expect(deviceDetail(a.device)).toBe(`from ${fingerprintOf(P("DEV_A"))}`);
    expect(deviceDetail(a.device, { [P("DEV_A")]: "Laptop" })).toBe("from Laptop");
    expect(deviceDetail(authorOf(people, P("BRIDGE")).device)).toBe(
      `via ${fingerprintOf(P("BRIDGE"))}`,
    );
    // Never bound here: itself.
    expect(authorOf(people, P("DEV_F"))).toEqual({ root: P("DEV_F"), device: null });
  });

  it("a fingerprint is the §5.2 form", () => {
    expect(fingerprintOf(P("DEV_B"))).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    expect(fingerprintOf("not hex")).toBe("not hex".slice(0, 8));
  });

  it("aliases are keyed by the root: a device shows, and names, its person", () => {
    const people = peopleOf(stateOfX(), P("CAROL"));
    const aliases = { [shortId(P("OWNER"))]: "Olga" };
    expect(aliasOf(people, aliases, P("DEV_B"))).toBe("Olga");
    expect(aliasOf(people, aliases, P("DEV_A"))).toBe("Olga");
    expect(aliasOf(people, aliases, P("BOB"))).toBeUndefined();
    expect(aliasKey(people, P("BRIDGE"))).toBe(shortId(P("BOB")));
  });
});

describe("assignees as people (decision I6, vector assignee_root_ref)", () => {
  const people = peopleOf(stateOfX(X.assignees.records), P("CAROL"));

  it("merges p:<D> and p:<rootOf(D)> in display only; the set is unchanged", () => {
    const set = [...X.assignees.set];
    const humans = assignedPeople(people, set);
    expect(humans.map((h) => label(h.root))).toEqual(X.assignees.expected.display_humans);
    const merged = humans.find((h) => h.root === P("OWNER"));
    expect([...(merged?.refs ?? [])].sort()).toEqual(
      [...(X.assignees.expected.merged.OWNER ?? [])].sort(),
    );
    expect(set).toEqual(X.assignees.set);
  });

  it("filters by the human: a device's reference counts for its root, and the other way round", () => {
    const set = [ref(P("DEV_B"))];
    expect(isAssignedTo(people, set, P("OWNER"))).toBe(true);
    expect(isAssignedTo(people, set, P("DEV_A"))).toBe(true);
    expect(isAssignedTo(people, set, P("BOB"))).toBe(false);
  });

  it("keeps a legacy installation reference as its own human until a chain binds it", () => {
    const before = peopleOf(stateOfX(3), P("CAROL")); // J0..J2: no device records yet
    const legacy = ref(P("DEV_B"));
    expect(assignedPeople(before, [legacy]).map((h) => h.root)).toEqual([P("DEV_B")]);
    expect(assignedPeople(people, [legacy]).map((h) => h.root)).toEqual([P("OWNER")]);
  });

  it("keeps a reference that is not a Principal as it is", () => {
    expect(assignedPeople(people, ["p:short", "p:short"])).toEqual([
      { root: "p:short", refs: ["p:short"] },
    ]);
  });

  it("an identity-aware writer assigns the root, never a device", () => {
    expect(assigneeRef(people, P("DEV_B"))).toBe(ref(P("OWNER")));
    expect(assigneeRef(people, P("BRIDGE"))).toBe(ref(P("BOB")));
    expect(assigneeRef(people, P("CAROL"))).toBe(ref(P("CAROL")));
  });
});
