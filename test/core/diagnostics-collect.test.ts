// LFCP-02-065 on a real runtime (offline, the real SDK and storage): a
// collaboration named with a canary, a Task titled with one, text kept as a
// local candidate with one, and an SDK error whose message carries one and
// an invitation link. The report, by default and detailed, holds none of
// them; the default one holds no identifier or server address either. The
// sections side is the journal the plugin's host reads, with its mapping
// (keptCandidates: reason, size and refusal code only).

import { type ObjectId, toHex } from "@openlfcp/core";
import { createTask } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import { Collaboration } from "../../src/core/collab/service";
import { DiagnosticLog, diagnosticReport, safeEvent } from "../../src/core/diagnostics";
import {
  collectDiagnostics,
  keptCandidates,
  saveFailedConditions,
} from "../../src/core/diagnostics-collect";
import { LfcpRuntime } from "../../src/core/lfcp/runtime";
import { KeyValueSectionJournalStore } from "../../src/core/sections/stores";
import { Device, FakeLocal, sleep } from "../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const NAME = "PRIVATE_COLLAB_NAME 7e1f";
const TITLE = "PRIVATE_TASK_TITLE 2b9c";
const KEPT = "PRIVATE_KEPT_TEXT 41d0";
const INVITE = "https://openlfcp.example/join#secret=SECRET_INVITE_6a3e";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

describe("diagnostics from a real runtime (LFCP-02-065)", () => {
  it("a shared section: its profile named, its state as its session sees it, not unsupported", async () => {
    const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(runtime);
    await runtime.createSectionResource({ name: NAME, endpoints: [URL], coordinatorUrl: URL });
    const input = await collectDiagnostics({
      runtime,
      collab: new Collaboration(runtime, { connectTimeoutMs: 100, sleep, sections: true }),
      sections: null,
      events: [],
      plugin: "0.4.0",
      obsidian: "1.13.4",
      platform: "desktop-macos",
      needsRestart: false,
    });
    expect(diagnosticReport(input, false)).toContain(
      "1. org.openlfcp.shared-sections.v1 · state offline · phase CLOSED",
    );
  });

  it("leaves out names, Task text, kept text, error messages, invitations, identifiers and addresses", async () => {
    const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(runtime);
    const R = await runtime.createResource({ name: NAME, endpoints: [URL], coordinatorUrl: URL });
    const status = runtime.status;
    if (status.kind !== "ready") throw new Error(status.kind);
    const { intent } = createTask({
      id: "017f22e2-79b0-7cc3-98c4-dc0c0c07398f" as ObjectId,
      title: TITLE,
      createdBy: status.principalId,
    });
    await runtime.writeIntent(R, intent);
    const journal = new KeyValueSectionJournalStore(runtime.localState);
    await journal.putCandidate({
      candidateId: "c1",
      projectionId: "pending:Private/Notes.md#x#0",
      reason: "rejected",
      sourceText: `## Launch\n${KEPT}\n`,
    });
    const log = new DiagnosticLog();
    log.add(
      safeEvent(Date.now(), "error", {
        code: "AUTHORIZATION_FAILED",
        message: `${NAME} refused at ${URL}: ${INVITE}`,
      }),
    );
    const input = await collectDiagnostics({
      runtime,
      collab: new Collaboration(runtime, { connectTimeoutMs: 100, sleep }),
      sections: {
        diagnostics: async () => ({
          sections: [],
          candidates: await keptCandidates(journal),
        }),
      },
      events: log.events,
      plugin: "0.4.0",
      obsidian: "1.13.4",
      platform: "desktop-macos",
      needsRestart: false,
    });
    const plain = diagnosticReport(input, false);
    const detailed = diagnosticReport(input, true);
    for (const text of [plain, detailed])
      for (const c of ["PRIVATE_", "SECRET_INVITE", "Notes.md", "#secret="])
        expect(text).not.toContain(c);
    for (const c of [toHex(R), URL, "offline.example.invalid"]) expect(plain).not.toContain(c);
    expect(detailed).toContain(toHex(R));
    expect(detailed).toContain(URL);
    expect(plain).toContain("Collaborations: 1");
    expect(plain).toMatch(/pending outbound 2/);
    expect(plain).toContain("Text kept on this device, not shared: 1 (rejected 1)");
    expect(plain).toContain("error code=AUTHORIZATION_FAILED");
    expect(plain).toMatch(/^Local encryption: lse-v1/m);
  });

  it("a refused edit kept on this device names its code; a save failure names it too", async () => {
    const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(runtime);
    const journal = new KeyValueSectionJournalStore(runtime.localState);
    const projectionId = "pending:Private/Notes.md#x#0";
    const ops: string[] = [];
    for (let i = 0; i < 7; i++) {
      const operationId = `op-${i}`;
      ops.push(operationId);
      await journal.put({
        operationId,
        projectionId,
        resource: "UkVTT1VSQ0U",
        phase: "abandoned",
        sourceHash: "0".repeat(64),
        allocatedIds: {},
        reason: "INVALID_INTENT",
      });
      // A refused edit's candidate has its operation's ID (sections-host #flushed).
      await journal.putCandidate({
        candidateId: operationId,
        projectionId,
        reason: "rejected",
        sourceText: `## Launch\n${KEPT}\n`,
      });
    }
    // An operation abandoned for a local reason, and one never recorded: no code.
    await journal.put({
      operationId: "op-local",
      projectionId,
      resource: "UkVTT1VSQ0U",
      phase: "abandoned",
      sourceHash: "0".repeat(64),
      allocatedIds: {},
      reason: "flush-failed",
    });
    await journal.putCandidate({
      candidateId: "base-unknown:x",
      projectionId,
      reason: "base-unknown",
      sourceText: `${KEPT}\n`,
    });
    const conditions = await saveFailedConditions(journal, ops);
    expect(conditions).toEqual(["save-failed:INVALID_INTENT"]);
    expect(await saveFailedConditions(journal, ["op-local", "op-missing"])).toEqual([
      "save-failed",
    ]);
    const input = await collectDiagnostics({
      runtime,
      collab: null,
      sections: {
        diagnostics: async () => ({
          sections: [{ key: "k", state: "LOCAL_SAVE_FAILED", conditions, pendingBatches: 7 }],
          candidates: await keptCandidates(journal),
        }),
      },
      events: [],
      plugin: "0.4.0",
      obsidian: "1.13.4",
      platform: "desktop-linux",
      needsRestart: false,
    });
    const plain = diagnosticReport(input, false);
    expect(plain).toContain(
      "Text kept on this device, not shared: 8 (base-unknown 1, rejected 7: INVALID_INTENT 7)",
    );
    expect(plain).toContain(
      "1. state LOCAL_SAVE_FAILED · pending batches 7 · conditions save-failed:INVALID_INTENT",
    );
    expect(plain).not.toContain("PRIVATE_");
  });

  it("only codes pass: a recorded reason that is free text is not shown as one", async () => {
    const journal = {
      allCandidates: async () => [
        {
          candidateId: "op",
          projectionId: "p",
          sectionKey: "R#S",
          reason: "rejected" as const,
          sourceText: "x",
        },
      ],
      get: async () => ({
        operationId: "op",
        projectionId: "p",
        resource: "R",
        phase: "abandoned" as const,
        sourceHash: "",
        allocatedIds: {},
        reason: `${KEPT} refused`,
      }),
    };
    expect(await keptCandidates(journal)).toEqual([{ reason: "rejected", characters: 1 }]);
    expect(await saveFailedConditions(journal, ["op"])).toEqual(["save-failed"]);
  });
});
