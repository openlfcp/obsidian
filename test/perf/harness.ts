// The plugin's section flows over a real offline runtime, for the
// performance runs (LFCP-02-067/068): the runtime on its storage, the SDK
// port, the creation flow and the engine as the plugin runs them, with the
// notes in memory. Test support only.

import { generateObjectId, generateResourceId } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { Collaboration } from "../../src/core/collab/service";
import { LfcpRuntime } from "../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../src/core/lfcp/section-port";
import { SectionCreation } from "../../src/core/sections/create";
import { applyChanges, SectionEngine } from "../../src/core/sections/engine";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../src/core/sections/stores";
import { newSectionTask } from "../../src/core/sections/task-fields";
import { type Device, type FakeLocal, sleep } from "../support/lfcp-env";

export const PATH = "Workload.md";
const URL = "wss://offline.example.invalid/v1/ws";

/** A vault: the runtime on its storage and the section flows the plugin runs. */
export async function vault(device: Device, local: FakeLocal) {
  const runtime = await LfcpRuntime.start(device.env(local));
  const status = runtime.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  const port = new SdkSectionPort({
    profile: (r) => runtime.sectionProfile(r),
    commit: (r, intents, o) => runtime.commitSection(r, intents, o),
    storage: runtime.storage as LfcpStorage,
    canWrite: (r) => runtime.canWriteSection(r),
  });
  const files = new Map<string, string>();
  const edit = async (
    path: string,
    fn: (current: string) => readonly { from: number; to: number; insert: string }[] | null,
  ) => {
    const current = files.get(path);
    if (current === undefined) return;
    const changes = fn(current);
    if (changes !== null) files.set(path, applyChanges(current, changes));
  };
  const collab = new Collaboration(runtime, { connectTimeoutMs: 50, sleep, sections: true });
  const creation = new SectionCreation({
    host: {
      createSectionResource: (o) => runtime.createSectionResource(o),
      openSection: (R) => runtime.openSection(R),
      host: async (R) => {
        const h = await collab.host(R).catch(() => ({ kind: "offline" as const }));
        return h.kind === "hosted" ? { kind: "hosted" } : (h as never);
      },
    },
    port,
    edit,
    journal: runtime.localState,
    createdBy: status.principalId,
    server: () => URL,
    newResourceId: () => generateResourceId(),
    newNodeId: () => generateObjectId(),
    newOperationId: () => crypto.randomUUID(),
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  });
  const engine = new SectionEngine({
    port,
    journal: new KeyValueSectionJournalStore(runtime.localState),
    bases: new KeyValueSectionBaseStore(runtime.localState),
    newNodeId: () => generateObjectId(),
    newOperationId: () => crypto.randomUUID(),
    createdBy: status.principalId,
    newProjectionId: () => crypto.randomUUID(),
    tasks: (r, taskId) => ({ view: port.taskView(r, taskId) }),
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  });
  const pass = async (path: string, caretLine: number | null = null) => {
    const md = files.get(path) as string;
    const p = await engine.pass(path, md, {
      caretLine,
      deletedIds: new Set<string>(),
      origin: "other",
    });
    const out = applyChanges(md, p.changes);
    files.set(path, out);
    await engine.written(p, out);
    return p;
  };
  return { runtime, port, files, creation, pass, principal: status.principalId };
}
