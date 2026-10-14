// LFCP-03-009 (U03-04, U03-26, G03-D): private canaries checked before
// encryption. "Share section…" runs through the section actions and the
// real section creation (SectionCreation, the journal, the note binding);
// the SDK is replaced by a recording section port, so what is recorded is
// exactly what would be encrypted and sent: the Resource's name and every
// intent of the import. Text outside an exact selection, outside the
// heading section, and comments kept local (§4.5) never appear in it; the
// raw blocks the preview counts do, verbatim.

import type { PrincipalId, ResourceId } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import type {
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TextChange,
} from "../../../src/core/sections/action-ports";
import { SectionActions } from "../../../src/core/sections/actions";
import { type CreationDeps, SectionCreation } from "../../../src/core/sections/create";
import { applyChanges } from "../../../src/core/sections/engine";
import { parseSections } from "../../../src/core/sections/parser";
import type { SharePreview } from "../../../src/core/sections/share";
import type { KeyValue } from "../../../src/core/sections/stores";
import type { TargetCapture, TextSelection } from "../../../src/core/sections/target";
import { newSectionTask } from "../../../src/core/sections/task-fields";
import { FakeSectionPort } from "./fake-port";

const BEFORE = "PRIVATE_BEFORE_8f3a: budget.";
const TAIL = "PRIVATE_TAIL_c0ffee: after the selection, same heading.";
const COMMENT = "PRIVATE_COMMENT_7e57";
const NEXT = "PRIVATE_NEXT_beef: the next section.";
const CANARIES = [BEFORE, TAIL, COMMENT, NEXT];
const NOTE = [
  BEFORE, //                          0
  "", //                              1
  "## Launch", //                     2
  "- [ ] Prepare contract", //        3
  "  - [ ] Legal review", //          4
  "", //                              5
  "| Item | Cost |", //                6
  "| --- | --- |", //                  7
  "| Hall | 100 |", //                 8
  "", //                              9
  "```js", //                         10
  "const total = 100;", //            11
  "```", //                           12
  "", //                              13
  `%% ${COMMENT}: a comment kept on this device %%`, // 14
  "", //                              15
  TAIL, //                            16
  "", //                              17
  "## Other", //                      18
  NEXT, //                            19
  "",
].join("\n");
const PRINCIPAL = new Uint8Array(32).fill(7) as PrincipalId;

/** Answers every share preview with yes; records what was shown. */
class Approver implements SectionPrompter {
  readonly previews: SharePreview[] = [];
  readonly notices: string[] = [];
  notice(m: string): void {
    this.notices.push(m);
  }
  announce(): void {}
  sharePreview(p: SharePreview) {
    this.previews.push(p);
    return { result: Promise.resolve(true), bringForward: () => undefined };
  }
  confirm() {
    return { result: Promise.resolve(true), bringForward: () => undefined };
  }
  importPreview(): never {
    throw new Error("unexpected import");
  }
  pickSection(): never {
    throw new Error("unexpected");
  }
  insertPreview(): never {
    throw new Error("unexpected");
  }
  alias(): never {
    throw new Error("unexpected");
  }
  repair(): void {}
  review(): void {}
  card(): never {
    throw new Error("unexpected");
  }
}

function kv(): KeyValue {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k),
    put: async (k, v) => {
      m.set(k, v);
    },
    update: async (k, f) => {
      m.set(k, f(m.get(k)));
    },
  };
}

/** The actions on the real creation; the port and the host record what leaves the note. */
function setup() {
  const files = new Map([["Plan.md", NOTE]]);
  const port = new FakeSectionPort();
  const names: string[] = [];
  const edit = async (path: string, fn: (c: string) => readonly TextChange[] | null) => {
    const current = files.get(path);
    if (current === undefined) return;
    const changes = fn(current);
    if (changes === null) return;
    files.set(path, applyChanges(current, changes));
  };
  let n = 0;
  const deps: CreationDeps = {
    host: {
      createSectionResource: async (o) => {
        names.push(o.name);
        return o.resourceId;
      },
      openSection: async () => undefined,
      host: async () => ({ kind: "hosted" }),
      discard: async () => ({ kind: "deleted" }),
    },
    port,
    edit,
    journal: kv(),
    createdBy: PRINCIPAL,
    server: () => "wss://sync.example/v1/ws",
    newResourceId: () => new Uint8Array(32).fill(++n) as ResourceId,
    newNodeId: () => `0192e4a0-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
    newOperationId: () => `create-${++n}`,
    newTask: (line, id) => newSectionTask(line, PRINCIPAL, id),
  };
  const creation = new SectionCreation(deps);
  const notes: SectionNotes = {
    capture: () => null,
    read: async (path) => files.get(path) ?? null,
    edit,
    goToLine: async () => null,
  };
  const none = () => null;
  const services = {
    creation: () => creation,
    insertion: none,
    bases: none,
    candidates: none,
    model: none,
    readOnly: () => false,
    server: () => "wss://sync.example/v1/ws",
    refPlacement: () => "child-line",
    watch: async () => undefined,
    indexed: () => undefined,
    pass: () => undefined,
    registryChanged: () => undefined,
  } as unknown as SectionServices;
  const prompter = new Approver();
  const actions = new SectionActions({ prompter, notes, services });
  const at = (selections: TextSelection[], cursorLine = 2): TargetCapture => ({
    path: "Plan.md",
    text: files.get("Plan.md") ?? "",
    mode: "live-preview",
    cursorLine,
    selections,
    composing: false,
  });
  /** Everything handed to the SDK for encryption: the Resource's name and the intents. */
  const sent = () => JSON.stringify({ names, changes: port.changes });
  return { files, port, prompter, actions, at, sent };
}

describe("private canaries before encryption (LFCP-03-009)", () => {
  it("an exact selection: only the selected lines are committed; the tail, the comment and other sections are not", async () => {
    const t = setup();
    // The heading through the fence (line 12), ending at column 0 of line 13.
    await t.actions.share(t.at([{ anchor: { line: 2, ch: 0 }, head: { line: 13, ch: 0 } }]));
    expect(t.prompter.notices).toEqual(['Shared Tasks: section "Launch" is shared.']);
    const sent = t.sent();
    expect(sent).toContain("Prepare contract");
    expect(sent).toContain("Legal review");
    expect(sent).toContain("| Hall | 100 |");
    expect(sent).toContain("const total = 100;");
    for (const c of CANARIES) expect(sent, c).not.toContain(c.slice(0, 18));
    // The note is bound around exactly the selection: the private tail stays after the end marker.
    const text = t.files.get("Plan.md") ?? "";
    const [section] = parseSections(text).sections;
    expect(section?.heading.title).toBe("Launch");
    const lines = text.split("\n");
    const end = lines.findIndex((l) => l.includes("/lfcp-section"));
    expect(lines.slice(end + 1).join("\n")).toContain(TAIL);
    expect(lines.slice(0, end).join("\n")).not.toContain(TAIL);
  });

  it("the whole heading section: raw blocks verbatim, the comment kept local, the next section out", async () => {
    const t = setup();
    await t.actions.share(t.at([], 3));
    const [preview] = t.prompter.previews;
    expect(preview?.counts).toMatchObject({ tasks: 2, raw: 2 });
    expect(preview?.warnings).toContain("local-comments");
    const sent = t.sent();
    expect(sent).toContain("| Item | Cost |");
    expect(sent).toContain("```js");
    // The private paragraph under the heading is content of the whole section (C4): shared.
    expect(sent).toContain("PRIVATE_TAIL_c0ffee");
    expect(sent).not.toContain(COMMENT);
    expect(sent).not.toContain("PRIVATE_BEFORE");
    expect(sent).not.toContain("PRIVATE_NEXT");
  });

  it("an ineligible selection commits nothing until its fallback is previewed and approved", async () => {
    const t = setup();
    t.prompter.confirm = () => ({ result: Promise.resolve(false), bringForward: () => undefined });
    await t.actions.share(t.at([{ anchor: { line: 3, ch: 0 }, head: { line: 4, ch: 20 } }]));
    expect(t.prompter.previews).toEqual([]);
    expect(t.port.changes).toEqual([]);
    expect(t.files.get("Plan.md")).toBe(NOTE);
  });
});
