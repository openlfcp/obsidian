// LFCP-02-065 on a real runtime (offline, the real SDK and storage): a
// collaboration named with a canary, a Task titled with one, text kept as a
// local candidate with one, and an SDK error whose message carries one and
// an invitation link. The report, by default and detailed, holds none of
// them; the default one holds no identifier or server address either. The
// sections side is the journal the plugin's host reads (its mapping:
// reason and size only).

import { type ObjectId, toHex } from "@openlfcp/core";
import { createTask } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import { Collaboration } from "../../src/core/collab/service";
import { DiagnosticLog, diagnosticReport, safeEvent } from "../../src/core/diagnostics";
import { collectDiagnostics } from "../../src/core/diagnostics-collect";
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
          candidates: (await journal.allCandidates()).map((c) => ({
            reason: c.reason,
            characters: c.sourceText.length,
          })),
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
});
