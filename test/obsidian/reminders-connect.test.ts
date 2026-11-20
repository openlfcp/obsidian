// E-022d2 (MVP 0.6 A§4.1, U П1): "Connect Apple Reminders" in Obsidian. The
// adapter over a substituted attempt (BridgeConnect): the first tick, the
// link opened or retried while the server is not reached, LFCP Bridge's
// callbacks as hints only, Copy link and Download; and the settings
// section, every state of U П1, with no Cancel after [Yes].

import { describe, expect, it, vi } from "vitest";
import type { BridgeConnect } from "../../src/core/identity/connect";
import {
  type Attempt,
  type AttemptState,
  COPY_FAILED,
  LINK_COPIED,
  OFFLINE_LINK,
  OTHER_DEVICE_STEPS,
} from "../../src/core/identity/connect-attempt";
import { BRIDGE_DOWNLOAD_URL, RemindersConnect } from "../../src/obsidian/reminders-connect";
import { OpenLfcpSettingTab } from "../../src/obsidian/settings-tab";
import * as mock from "../mocks/obsidian";

const LINK = "lfcp-bridge://connect?attempt=a1&vault=Vault&c=cc&root=rr&j=jj#link=x";

const attempt = (state: AttemptState, extra: Partial<Attempt> = {}): Attempt => ({
  id: "a1",
  metaAt: "2026-11-20T10:00:00Z",
  vault: "Vault",
  root: "rr",
  c: "cc",
  url: "wss://x",
  createdAt: 0,
  state,
  ...extra,
});

/** A substituted attempt driver and the adapter's host. */
function setup(stored?: Attempt) {
  let current = stored;
  let link: string | null = LINK;
  const connector = {
    attempt: vi.fn(async () => current),
    code: vi.fn(() => (current?.state === "confirm-code" ? "k7qm-2xd4-rw5a-hn3e" : undefined)),
    tick: vi.fn(async () => current),
    start: vi.fn(async (vault: string) => {
      current = attempt("waiting-app", { vault });
      return current;
    }),
    link: vi.fn(async () => link),
    cancel: vi.fn(async () => {
      if (current !== undefined) current = attempt("cancelled");
      return true;
    }),
    confirm: vi.fn(async (yes: boolean) => {
      current = attempt(yes ? "committing" : "rejected");
      return current;
    }),
    // As BridgeConnect (d1): only this vault's attempt, by its identifiers.
    callback: vi.fn(async (c: { event: string; attempt?: string; vault?: string }) => ({
      reopen:
        c.event === "app-ready" &&
        current?.state === "waiting-app" &&
        c.attempt === current.id &&
        c.vault === current.vault,
    })),
  };
  const opened: string[] = [];
  const copied: string[] = [];
  let clipboardRefuses = false;
  const changed = vi.fn();
  const reminders = new RemindersConnect({
    connector: () => connector as unknown as BridgeConnect,
    vault: () => "Vault",
    open: (url) => {
      opened.push(url);
    },
    copy: async (text) => {
      if (clipboardRefuses) throw new Error("NotAllowedError");
      copied.push(text);
    },
    changed,
  });
  return {
    reminders,
    connector,
    opened,
    copied,
    changed,
    set: (a: Attempt | undefined) => {
      current = a;
    },
    offline: (off: boolean) => {
      link = off ? null : LINK;
    },
    refuseClipboard: () => {
      clipboardRefuses = true;
    },
  };
}

describe("RemindersConnect", () => {
  it("the first tick reads the journal; without an attempt nothing is asked of the server", async () => {
    const p = setup();
    await p.reminders.tick();
    expect(p.connector.attempt).toHaveBeenCalledOnce();
    expect(p.connector.tick).not.toHaveBeenCalled();
    expect(p.reminders.view().actions).toEqual(["connect"]);
  });

  it("after a restart, the first tick carries an attempt under way on", async () => {
    const p = setup(attempt("committing"));
    await p.reminders.tick();
    expect(p.connector.tick).toHaveBeenCalledOnce();
    expect(p.reminders.view().lines[0]).toBe("Finishing connection…");
  });

  it("[Connect] starts an attempt for this vault and opens its link for LFCP Bridge", async () => {
    const p = setup();
    await p.reminders.connect();
    expect(p.connector.start).toHaveBeenCalledWith("Vault", "Mac");
    expect(p.opened).toEqual([LINK]);
    expect(p.reminders.view().state).toBe("waiting-app");
  });

  it("no link (the server not reached): the offline line, and the tick opens it once it can", async () => {
    const p = setup();
    p.offline(true);
    await p.reminders.connect();
    expect(p.opened).toEqual([]);
    expect(p.reminders.view().lines).toContain(OFFLINE_LINK);
    await p.reminders.tick();
    expect(p.opened).toEqual([]);
    p.offline(false);
    await p.reminders.tick();
    expect(p.opened).toEqual([LINK]);
    expect(p.reminders.view().lines).not.toContain(OFFLINE_LINK);
    // Opened once: the next tick does not open it again.
    await p.reminders.tick();
    expect(p.opened).toEqual([LINK]);
  });

  it("callbacks are hints for the core: unknown events dropped, app-ready reopens, nothing approved", async () => {
    const p = setup(attempt("waiting-app"));
    await p.reminders.tick();
    await p.reminders.callback({ event: "approve", attempt: "a1", vault: "Vault" });
    expect(p.connector.callback).not.toHaveBeenCalled();
    await p.reminders.callback({ event: "request-ready", attempt: "a1", vault: "Vault" });
    expect(p.connector.callback).toHaveBeenLastCalledWith({
      event: "request-ready",
      attempt: "a1",
      vault: "Vault",
    });
    expect(p.opened).toEqual([]);
    await p.reminders.callback({ event: "app-ready", attempt: "a1", vault: "Vault" });
    expect(p.opened).toEqual([LINK]);
    for (const event of ["already-connected", "other-account"])
      await p.reminders.callback({ event, attempt: "a1", vault: "Vault" });
    // The only decisions are the person's: no [Yes], no [No] from a callback.
    expect(p.connector.confirm).not.toHaveBeenCalled();
  });

  it("A§4.1 first start after Download: app-ready without vault or attempt opens the waiting link again", async () => {
    const p = setup();
    await p.reminders.connect();
    p.reminders.download();
    expect(p.opened).toEqual([LINK, BRIDGE_DOWNLOAD_URL]);
    // The app, installed and allowed, opens obsidian://openlfcp-bridge?event=app-ready.
    await p.reminders.callback({ action: "openlfcp-bridge", event: "app-ready" });
    expect(p.opened).toEqual([LINK, BRIDGE_DOWNLOAD_URL, LINK]);
    // A hint only: no step of the attempt follows from it.
    expect(p.connector.confirm).not.toHaveBeenCalled();
    expect(p.connector.cancel).not.toHaveBeenCalled();
  });

  it("app-ready never opens another attempt's link, nor one not waiting for the app", async () => {
    const p = setup(attempt("waiting-app"));
    await p.reminders.tick();
    await p.reminders.callback({ event: "app-ready", attempt: "another", vault: "Vault" });
    await p.reminders.callback({ event: "app-ready", vault: "Other vault" });
    expect(p.opened).toEqual([]);
    p.set(attempt("committing"));
    await p.reminders.callback({ event: "app-ready" });
    p.set(undefined);
    await p.reminders.callback({ event: "app-ready" });
    expect(p.opened).toEqual([]);
  });

  it("a clipboard that refuses: a notice, no success and no rejection, the link not shown", async () => {
    const p = setup(attempt("waiting-app"));
    p.refuseClipboard();
    const before = mock.notices.length;
    await expect(p.reminders.copyLink()).resolves.toBeUndefined();
    const said = mock.notices.slice(before);
    expect(said).toEqual([COPY_FAILED]);
    expect(said.join(" ")).not.toContain("lfcp-bridge://");
  });

  it("Copy link copies the link with a notice; Download opens the bridge's releases", async () => {
    const p = setup(attempt("waiting-app"));
    const notices = mock.notices.length;
    await p.reminders.copyLink();
    expect(p.copied).toEqual([LINK]);
    expect(mock.notices.slice(notices)).toEqual([LINK_COPIED]);
    p.reminders.download();
    expect(p.opened).toEqual([BRIDGE_DOWNLOAD_URL]);
  });
});

describe("the Apple Reminders section (U П1)", () => {
  /** The settings tab over a ready runtime and this adapter. */
  function render(reminders: RemindersConnect) {
    const plugin = {
      runtime: {
        status: { kind: "ready", persisted: true },
        earlierIdentities: () => [],
        localStateDiagnostics: async () => null,
        localStateSummary: () => "",
      },
      runtimeError: null,
      settings: { dismissedHints: [] },
      reminders,
      openDevices: vi.fn(),
    };
    const tab = new OpenLfcpSettingTab(new mock.App() as never, plugin as never);
    (tab as unknown as mock.PluginSettingTab).display();
    const rows = (tab as unknown as mock.PluginSettingTab).containerEl.settings;
    const row = (name: string) => rows.find((s) => s.name === name);
    const buttons = (name: string) => row(name)?.buttons.map((b) => b.text) ?? [];
    return { plugin, row, buttons };
  }

  it("each state shows U П1's text and buttons; none after [Yes]", async () => {
    const cases: [AttemptState | undefined, string[]][] = [
      [undefined, ["Connect Apple Reminders"]],
      ["waiting-app", ["Download for Mac", "Open LFCP Bridge again", "Cancel"]],
      ["confirm-code", ["No", "Yes, it matches"]],
      ["committing", []],
      ["registering", []],
      ["ready", []],
      ["rejected", ["Connect again"]],
      ["cancelled", ["Connect again"]],
      ["expired", ["Connect again"]],
      ["already-connected", ["Show it"]],
      ["other-account", []],
      ["insufficient-authority", []],
      ["capacity", ["Open Devices"]],
      ["failed", ["Connect again"]],
    ];
    for (const [state, expected] of cases) {
      const p = setup(state === undefined ? undefined : attempt(state));
      await p.reminders.tick();
      const r = render(p.reminders);
      expect(r.buttons("Apple Reminders"), String(state)).toEqual(expected);
      expect(r.buttons("Apple Reminders")).not.toContain(
        state === "committing" || state === "registering" ? "Cancel" : "—",
      );
    }
  });

  it("the code to compare leads the text, with [No] and [Yes, it matches]", async () => {
    const p = setup(attempt("confirm-code"));
    await p.reminders.tick();
    const r = render(p.reminders);
    expect(r.row("Apple Reminders")?.desc).toMatch(
      /^k7qm-2xd4-rw5a-hn3e Does your Mac show the same code\?/,
    );
    const yes = r.row("Apple Reminders")?.buttons.find((b) => b.text === "Yes, it matches");
    expect(yes?.cta).toBe(true);
    yes?.onClickHandler();
    await vi.waitFor(() => expect(p.connector.confirm).toHaveBeenCalledWith(true));
  });

  it("while LFCP Bridge is awaited, the other-computer path with Copy link", async () => {
    const p = setup(attempt("waiting-app"));
    await p.reminders.tick();
    const r = render(p.reminders);
    const other = r.row("Connect from another computer");
    expect(other?.desc).toBe(OTHER_DEVICE_STEPS.join(" "));
    expect(r.buttons("Connect from another computer")).toEqual(["Copy link"]);
    other?.button?.onClickHandler();
    await vi.waitFor(() => expect(p.copied).toEqual([LINK]));
    // Not shown in any other state.
    p.set(attempt("committing"));
    await p.reminders.tick();
    expect(render(p.reminders).row("Connect from another computer")).toBeUndefined();
  });

  it("[Cancel] while waiting cancels the attempt", async () => {
    const p = setup(attempt("waiting-app"));
    await p.reminders.tick();
    const r = render(p.reminders);
    r.row("Apple Reminders")
      ?.buttons.find((b) => b.text === "Cancel")
      ?.onClickHandler();
    await vi.waitFor(() => expect(p.connector.cancel).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(p.reminders.view().state).toBe("cancelled"));
  });

  it("on a phone: the status only, and no section before an attempt (U П6)", async () => {
    mock.Platform.isMobile = true;
    try {
      const none = setup();
      await none.reminders.tick();
      expect(render(none.reminders).row("Apple Reminders")).toBeUndefined();
      const p = setup(attempt("committing"));
      await p.reminders.tick();
      const r = render(p.reminders);
      expect(r.row("Apple Reminders")?.desc).toMatch(/^Finishing connection…/);
      expect(r.buttons("Apple Reminders")).toEqual([]);
    } finally {
      mock.Platform.isMobile = false;
    }
  });
});
