// Forward compatibility (0.3.2): a stored Resource of another Data Profile,
// such as a newer plugin's shared sections, is never opened, merged,
// written or rendered here. It shows as "unsupported" and asks for a newer
// version; its data stays untouched.

import { toBase64url } from "@openlfcp/core";
import { afterEach, describe, expect, it } from "vitest";
import { statusView } from "../../../src/core/collab/view";
import {
  LfcpRuntime,
  NEEDS_NEWER_VERSION,
  UnsupportedProfileError,
} from "../../../src/core/lfcp/runtime";
import { ProjectionEngine } from "../../../src/core/projection/engine";
import { MutationGuard } from "../../../src/core/projection/guard";
import { ProjectionNotices } from "../../../src/core/projection/notices";
import { type NoteIO, ProjectionWriter } from "../../../src/core/projection/writer";
import { SECTIONS, storeForeign } from "../../support/foreign-resource";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL_ = "wss://offline.example.invalid/v1/ws";
const TASK = "019a2f85-7b31-7c42-b85a-fc843e2f40ad";

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});
const start = async (device = new Device()) => {
  const r = await LfcpRuntime.start(device.env(new FakeLocal()));
  running.push(r);
  return { r, device };
};

describe("a Resource of another Data Profile (0.3.2)", () => {
  it("is listed as unsupported and never opened, merged or written", async () => {
    const { r, device } = await start();
    const R = await storeForeign(r);
    const [entry] = await r.registry();
    expect(entry).toMatchObject({ profile: SECTIONS, state: "unsupported" });
    expect(await r.hasResource(R)).toBe(true);
    expect(await r.supportsResource(R)).toBe(false);
    await expect(r.openResource(R)).rejects.toBeInstanceOf(UnsupportedProfileError);
    await expect(r.profileOf(R)).rejects.toThrow(NEEDS_NEWER_VERSION);
    await expect(
      r.writeIntent(R, { type: "task.complete", object_id: TASK } as never),
    ).rejects.toBeInstanceOf(UnsupportedProfileError);
    // No session, no queued unit, and the runtime keeps working.
    expect(r.sessions).toBe(0);
    expect(device.sockets.opened.length).toBe(0);
    expect(await r.storage?.outbound.list(R)).toEqual([]);
    expect(r.status.kind).toBe("ready");
  });

  it("does not hide a Shared Objects Resource stored next to it", async () => {
    const { r } = await start();
    await storeForeign(r);
    const own = await r.createResource({ name: "Own", endpoints: [URL_], coordinatorUrl: URL_ });
    expect(await r.supportsResource(own)).toBe(true);
    await expect(r.profileOf(own)).resolves.toBeDefined();
  });

  it("its refs in a note send nothing, are never rewritten, and say why once", async () => {
    const { r } = await start();
    const R = await storeForeign(r);
    const note = `- [x] Prepare contract <!-- lfcp-ref: lfcp1:${toBase64url(R)}#task:${TASK} -->\n`;
    const files = new Map([["n.md", note]]);
    const io: NoteIO = {
      read: async (p) => files.get(p) ?? null,
      rewrite: async (p, fn) => {
        files.set(p, fn(files.get(p) ?? ""));
      },
      isBeingEdited: () => false,
    };
    const guard = new MutationGuard();
    const engine = new ProjectionEngine(() => r, guard);
    const writer = new ProjectionWriter(engine, guard, io, () => r);
    const out = await writer.syncNote("n.md");
    expect(out.projection?.sent).toEqual([]);
    expect(out.projection?.diagnostics.map((d) => d.code)).toEqual(["RESOURCE_UNSUPPORTED"]);
    expect(out.wrote).toBe(false);
    expect(files.get("n.md")).toBe(note);
    const notices = new ProjectionNotices();
    const first = notices.messages(out.projection as NonNullable<typeof out.projection>);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("newer version of Shared Tasks");
    const again = await writer.syncNote("n.md");
    expect(notices.messages(again.projection as NonNullable<typeof again.projection>)).toEqual([]);
  });

  it("the status view says it needs a newer version", () => {
    const view = statusView({
      localName: "Launch",
      resourceId: "R",
      profile: SECTIONS,
      state: "unsupported",
      refusal: null,
      blocked: false,
      phase: "CLOSED",
      hosting: "unknown",
      controlHead: null,
      controlSeq: null,
      dataEpoch: null,
      coordinator: URL_,
      endpoints: [URL_],
      participants: [],
      pendingOutbound: 0,
      conflicts: [],
    });
    expect(view.banner).toContain(NEEDS_NEWER_VERSION);
    expect(view.rows.find((row) => row.label === "Sync")?.value).toContain(
      "cannot read this collaboration",
    );
  });
});
