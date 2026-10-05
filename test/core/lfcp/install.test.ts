// The install and its three-way marker (LFCP-059, ST-3).

import { resourceId, toBase64url, toHex } from "@openlfcp/core";
import { exportSecretKeyBytes } from "@openlfcp/crypto";
import { describe, expect, it } from "vitest";
import {
  createInstall,
  databaseName,
  INSTALL_KEY,
  type Install,
  InstallLockedError,
  openInstall,
} from "../../../src/core/lfcp/install";
import { markerSlotId } from "../../../src/core/lfcp/secrets";
import { Device, deleteDatabase, FakeLocal } from "../../support/lfcp-env";

const R = resourceId(new Uint8Array(32).fill(9));
const ready = (i: Install) => {
  if (i.kind !== "ready") throw new Error(`locked: ${i.reason}`);
  return i;
};

describe("install (LFCP-059)", () => {
  it("creates a Principal on first use and keeps it across reloads (tests 1, 2)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const first = ready(await openInstall(device.env(local)));
    expect(first.persisted).toBe(true);
    first.storage.close();
    const again = ready(await openInstall(device.env(local)));
    expect(toHex(again.principal.id)).toBe(toHex(first.principal.id));
    expect(again.installId).toBe(first.installId);
    expect(again.persisted).toBe(true);
    again.storage.close();
  });

  it("keeps private keys out of the vault-local store and the database (test 3)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const i = ready(await openInstall(device.env(local)));
    const signing = exportSecretKeyBytes(i.principal.signer.key);
    const forms = [toHex(signing), toBase64url(signing)];
    const exposed = JSON.stringify([...local.values], (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    const meta = JSON.stringify(await i.storage.meta.get("install"));
    for (const f of forms) {
      expect(exposed).not.toContain(f);
      expect(meta).not.toContain(f);
    }
    expect(local.values.get(INSTALL_KEY)).toBe(i.installId); // only the install ID
    i.storage.close();
  });

  it("records a denied persistence request", async () => {
    const device = new Device();
    device.persistResult = false;
    const i = ready(await openInstall(device.env(new FakeLocal())));
    expect(i.persisted).toBe(false);
    i.storage.close();
  });

  it("mirrors every durable reservation into the marker", async () => {
    const device = new Device();
    const i = ready(await openInstall(device.env(new FakeLocal())));
    await i.storage.actorSequences.reserveNext(R, i.principal.id);
    await i.storage.actorSequences.reserveNext(R, i.principal.id);
    const marker = JSON.parse(device.slots.get(markerSlotId(i.installId)) as string);
    expect(Object.values(marker.hw)).toEqual(["2"]);
    i.storage.close();
  });

  it("gives a copied vault on the same device its own install and Principal", async () => {
    const device = new Device();
    const a = ready(await openInstall(device.env(new FakeLocal())));
    // The copy has the same vault files but a new vault-scoped local store.
    const b = ready(await openInstall(device.env(new FakeLocal())));
    expect(b.installId).not.toBe(a.installId);
    expect(toHex(b.principal.id)).not.toBe(toHex(a.principal.id));
    a.storage.close();
    b.storage.close();
  });

  describe("locks the Principal on partial or mismatched state", () => {
    async function made() {
      const device = new Device();
      const local = new FakeLocal();
      const i = ready(await openInstall(device.env(local)));
      return { device, local, i };
    }
    const lockedBy = async (device: Device, local: FakeLocal, reason: string) => {
      const again = await openInstall(device.env(local));
      expect(again.kind).toBe("locked");
      if (again.kind !== "locked") return;
      expect(again.reason).toBe(reason);
      await expect(
        again.storage?.actorSequences.reserveNext(R, again.principalId as never),
      ).rejects.toBeInstanceOf(InstallLockedError);
      again.storage?.close();
    };

    it("database wiped or evicted", async () => {
      const { device, local, i } = await made();
      i.storage.close();
      await deleteDatabase(databaseName(i.installId));
      await lockedBy(device, local, "database-missing");
    });

    it("marker secret missing (secret store reset, or the vault's local store came along)", async () => {
      const { device, local, i } = await made();
      i.storage.close();
      device.slots.values.delete(markerSlotId(i.installId));
      await lockedBy(device, local, "marker-missing");
    });

    it("both missing", async () => {
      const { device, local, i } = await made();
      i.storage.close();
      device.slots.values.delete(markerSlotId(i.installId));
      await deleteDatabase(databaseName(i.installId));
      await lockedBy(device, local, "state-missing");
    });

    it("keys missing", async () => {
      const { device, local, i } = await made();
      i.storage.close();
      for (const k of [...device.slots.values.keys()])
        if (!k.endsWith("-marker")) device.slots.set(k, "");
      await lockedBy(device, local, "keys-missing");
    });

    it("records naming different Principals", async () => {
      const { device, local, i } = await made();
      i.storage.close();
      const m = JSON.parse(device.slots.get(markerSlotId(i.installId)) as string);
      device.slots.set(
        markerSlotId(i.installId),
        JSON.stringify({ ...m, principal: "00".repeat(32) }),
      );
      await lockedBy(device, local, "mismatch");
    });

    it("a database behind its mirrored high-water mark (restored backup)", async () => {
      const { device, local, i } = await made();
      await i.storage.actorSequences.reserveNext(R, i.principal.id);
      const meta = await i.storage.meta.get("install");
      i.storage.close();
      // An older copy of the database: the install row, but no counters.
      await deleteDatabase(databaseName(i.installId));
      const { IdbLfcpStorage } = await import("@openlfcp/storage-idb");
      const restored = await IdbLfcpStorage.open(databaseName(i.installId));
      await restored.meta.put("install", meta);
      restored.close();
      await lockedBy(device, local, "database-behind");
    });
  });

  it("a new Principal after a lock uses a new namespace and leaves the old one", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const old = ready(await openInstall(device.env(local)));
    old.storage.close();
    await deleteDatabase(databaseName(old.installId));
    const fresh = ready(await createInstall(device.env(local)));
    expect(fresh.installId).not.toBe(old.installId);
    expect(device.slots.get(markerSlotId(old.installId))).not.toBeNull();
    expect(local.values.get(INSTALL_KEY)).toBe(fresh.installId);
    fresh.storage.close();
    expect((await openInstall(device.env(local))).kind).toBe("ready");
  });
});
