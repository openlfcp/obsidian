// Test 9 (LFCP-059): the plugin's storage stack conforms to the generic
// interfaces: IdbLfcpStorage (IndexedDB) and the SecretStore over Obsidian's
// secret slots pass the SDK's shared contract suite.

import "fake-indexeddb/auto";
import { runStorageContract } from "@openlfcp/storage/contract";
import { IdbLfcpStorage } from "@openlfcp/storage-idb";
import { describe, it } from "vitest";
import { SlotSecretStore } from "../../../src/core/lfcp/secrets";
import { FakeSecretSlots } from "../../support/lfcp-env";

let n = 0;
runStorageContract({ describe, it }, "Obsidian: IdbLfcpStorage + SlotSecretStore", async () => {
  const name = `obsidian-contract-${++n}`;
  const slots = new FakeSecretSlots();
  const installId = n.toString(16).padStart(32, "0");
  let storage = await IdbLfcpStorage.open(name);
  let secrets = new SlotSecretStore(slots, installId);
  const handle = {
    get storage() {
      return storage;
    },
    get secrets() {
      return secrets;
    },
    reopen: async () => {
      storage.close();
      storage = await IdbLfcpStorage.open(name);
      secrets = new SlotSecretStore(slots, installId);
      return handle;
    },
    close: async () => {
      storage.close();
      indexedDB.deleteDatabase(name);
    },
  };
  return handle;
});
