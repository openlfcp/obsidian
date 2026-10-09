// LFCP-02-065: the diagnostics report keeps every synthetic private or
// secret canary out by default, whatever field carries it (a name, a path,
// an error message, an invitation, a key, a ref), keeps versions, codes,
// counts and safe transitions, and adds identifiers and server addresses
// only when the user chose them. Unit evidence on synthetic inputs.

import { describe, expect, it } from "vitest";
import {
  type DiagnosticInput,
  DiagnosticLog,
  diagnosticReport,
  redact,
  safeEvent,
} from "../../src/core/diagnostics";

const RESOURCE = "a1".repeat(32);
const ROUTE = "wss://sync.example.org/v1/ws";
const CANARIES = {
  name: "PRIVATE_NAME_3f9a",
  note: "PRIVATE_NOTE_TEXT_77c1",
  path: "Private Folder/PRIVATE_PATH_51b2.md",
  invite: "https://openlfcp.example/join#secret=SECRET_INVITE_0d4e",
  key: "key=SECRET_KEY_9e21",
  ref: `lfcp1:${"QUJD".repeat(10)}xyz#task:0192e4a0-0000-7000-8000-000000000001`,
};

function input(events: DiagnosticLog): DiagnosticInput {
  return {
    generatedAt: Date.UTC(2026, 9, 9, 12, 0, 0),
    plugin: "0.4.0",
    obsidian: "1.13.4",
    platform: "desktop-macos",
    runtime: "ready",
    localEncryption: "Local encryption: lse-v1, generation 1, key present.",
    resources: [
      {
        id: RESOURCE,
        profile: "org.openlfcp.shared-sections/1",
        state: "available",
        phase: "LIVE",
        hosting: "hosted",
        // A refusal "code" that is really free text: never shown as it is.
        refusalCode: `${CANARIES.name} could not be hosted`,
        routes: [ROUTE],
        controlSeq: "4",
        dataEpoch: "1",
        pendingOutbound: 2,
        conflicts: 1,
        blockedCollaborators: 0,
      },
    ],
    sections: [
      {
        key: `${"QUJD".repeat(10)}xyz#0192e4a0-0000-7000-8000-000000000009`,
        state: "ATTENTION",
        conditions: ["scalar-conflict", "rejected:INVALID_INTENT", CANARIES.note],
        pendingBatches: 3,
      },
    ],
    candidates: [
      { reason: "rejected", characters: 120 },
      { reason: "base-unknown", characters: 40 },
      { reason: "rejected", characters: 9 },
    ],
    events: events.events,
  };
}

function log(): DiagnosticLog {
  const l = new DiagnosticLog();
  // An SDK error: its code is kept, its message never.
  l.add(
    safeEvent(Date.UTC(2026, 9, 9, 11, 59), "error", {
      code: "AUTHORIZATION_FAILED",
      message: `${CANARIES.name} at ${ROUTE} ${CANARIES.invite}`,
    }),
  );
  l.add(
    safeEvent(Date.UTC(2026, 9, 9, 11, 59), "connection", {
      state: "offline",
      reason: CANARIES.path,
    }),
  );
  l.add(safeEvent(Date.UTC(2026, 9, 9, 11, 59), "checkpoint-rebuilt", {}));
  l.add(safeEvent(Date.UTC(2026, 9, 9, 11, 59), CANARIES.note, { code: CANARIES.key }));
  return l;
}

describe("diagnostics (LFCP-02-065)", () => {
  it("by default: versions, states, codes, counts and safe events; no canary, identifier or address", () => {
    const text = diagnosticReport(input(log()), false);
    for (const c of [
      ...Object.values(CANARIES),
      "SECRET_INVITE",
      "SECRET_KEY",
      RESOURCE,
      ROUTE,
      "sync.example.org",
    ])
      expect(text).not.toContain(c);
    expect(text).not.toMatch(/0192e4a0|QUJDQUJD/);
    expect(text).toContain("Plugin: 0.4.0 · Obsidian: 1.13.4");
    expect(text).toContain("state available · phase LIVE · hosting hosted · refusal (text)");
    expect(text).toContain("pending outbound 2 · conflicts 1");
    expect(text).toContain("conditions scalar-conflict, rejected:INVALID_INTENT, (text)");
    expect(text).toContain("Text kept on this device, not shared: 3 (rejected 2, base-unknown 1)");
    expect(text).toContain("error code=AUTHORIZATION_FAILED");
    expect(text).toContain("connection state=offline");
    expect(text).toContain("checkpoint-rebuilt");
    expect(text).toContain("Identifiers, server addresses, names, notes and paths are left out.");
  });

  it("detailed, by the user's choice: identifiers and routes; still no secret, name, note or path", () => {
    const text = diagnosticReport(input(log()), true);
    expect(text).toContain(`id ${RESOURCE}`);
    expect(text).toContain(`route ${ROUTE}`);
    for (const c of [CANARIES.name, CANARIES.note, "PRIVATE_PATH", "SECRET_INVITE", "SECRET_KEY"])
      expect(text).not.toContain(c);
  });

  it("the last pass removes secrets, refs and paths from any text; identifiers unless detailed", () => {
    const s = `${CANARIES.invite} ${CANARIES.key} ${CANARIES.ref} ${CANARIES.path} ${RESOURCE} ${ROUTE}`;
    const plain = redact(s, false);
    for (const c of ["SECRET_INVITE", "SECRET_KEY", "QUJD", "PRIVATE_PATH", RESOURCE, ROUTE])
      expect(plain).not.toContain(c);
    const detailed = redact(s, true);
    expect(detailed).toContain(RESOURCE);
    expect(detailed).toContain(ROUTE);
    expect(detailed).not.toContain("SECRET_INVITE");
  });

  it("keeps a bounded log", () => {
    const l = new DiagnosticLog(3);
    for (let i = 0; i < 10; i++) l.add(safeEvent(i, "tick", {}));
    expect(l.events.map((e) => e.at)).toEqual([7, 8, 9]);
  });
});
