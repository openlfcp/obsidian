// @vitest-environment happy-dom
// LFCP-03-065 (from 064): the sections host's own timers end with stop()
// (the plugin unloads): the retries the stale-work port sets through it and
// the drifted note's next pass (2 s). None fires after, none is set after.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotePass } from "../../src/core/sections/engine";
import type { StaleWorkController } from "../../src/core/sections/stale-work";
import type { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { SectionsHost } from "../../src/obsidian/sections-host";
import * as mock from "../mocks/obsidian";
// The DOM helpers Obsidian adds, local-only sockets, and the mock's gaps for the sections host.
import "../soak/peer";
import { E2EVault } from "../support/e2e-vault";

type StaleOptions = ConstructorParameters<typeof StaleWorkController>[0];
type EditorOptions = Parameters<typeof sectionEditorExtension>[0];

/** What the host hands the stale-work controller and the editor extension, as it hands them. */
const handed = vi.hoisted(() => ({
  stale: [] as unknown[],
  editor: [] as unknown[],
}));

vi.mock("../../src/core/sections/stale-work", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/core/sections/stale-work")>();
  class Recorded extends m.StaleWorkController {
    constructor(o: StaleOptions) {
      super(o);
      handed.stale.push(o);
    }
  }
  return { ...m, StaleWorkController: Recorded };
});

vi.mock("../../src/obsidian/section-editor", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/obsidian/section-editor")>();
  return {
    ...m,
    sectionEditorExtension: (o: EditorOptions) => {
      handed.editor.push(o);
      return m.sectionEditorExtension(o);
    },
  };
});

const SERVER = "ws://127.0.0.1:9/v1/ws";
type Mock = typeof import("../mocks/obsidian");

const intervals: number[] = [];
function sectionsOn(m: Mock): void {
  const P = m.Plugin.prototype as unknown as Record<string, unknown>;
  P.loadData = async function (this: { stored: unknown }) {
    return this.stored ?? { sectionsDisabled: false, defaultServer: SERVER, settingsVersion: 2 };
  };
  P.register = () => undefined;
  P.registerInterval = (id: number) => {
    intervals.push(id);
    return id;
  };
  P.registerMarkdownPostProcessor = () => undefined;
  const W = m.Workspace.prototype as unknown as Record<string, unknown>;
  W.on = () => ({});
  W.onLayoutReady = (fn: () => void) => fn();
}

let vault: E2EVault | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await vault?.close().catch(() => undefined);
  vault = null;
  for (const id of intervals.splice(0)) window.clearInterval(id);
  E2EVault.onModules = null;
  handed.stale.length = 0;
  handed.editor.length = 0;
});

describe("the sections host's timers and stop() (LFCP-03-065)", () => {
  it("a retry the stale-work port set does not fire after stop(), and none is set after", async () => {
    E2EVault.onModules = sectionsOn;
    vault = await E2EVault.open("host-timers", { tickMs: 50 });
    vault.network.offline = true;
    const sections = vault.plugin.sections;
    if (sections === null) throw new Error("sections off");
    const o = handed.stale.at(-1) as StaleOptions | undefined;
    if (o === undefined) throw new Error("no stale-work controller");
    let fired = 0;
    o.setTimer(() => fired++, 20);
    sections.stop();
    o.setTimer(() => fired++, 0);
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(0);
  });

  it("a drifted note's next pass does not fire after stop(), and none is set after", async () => {
    vi.useFakeTimers();
    const h = new SectionsHost(
      new mock.App() as never,
      () => undefined,
      () => "child-line",
      () => "local",
      () => null,
      () => "wss://sync.example/v1/ws",
    );
    const o = handed.editor.at(-1) as EditorOptions | undefined;
    if (o?.onPass === undefined) throw new Error("no pass listener");
    const drifted = (path: string) =>
      ({
        path,
        source: "",
        sourceRevision: "",
        changes: [],
        sections: [
          {
            projectionId: "p",
            section: { resourceId: new Uint8Array(32), sectionId: "s" },
            lost: [],
            held: [],
            base: { drifted: ["n"] },
          },
        ],
      }) as unknown as NotePass;
    // The status pass has its own test (sections-host-invite.test.ts): only the next pass counts here.
    vi.spyOn(h, "scheduleStatus").mockImplementation(() => undefined);
    const remote = vi.spyOn(h.editor, "remoteChanged");
    o.onPass("A.md", drifted("A.md"));
    expect(vi.getTimerCount()).toBe(1);
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
    o.onPass("B.md", drifted("B.md"));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(remote).not.toHaveBeenCalled();
  });
});
