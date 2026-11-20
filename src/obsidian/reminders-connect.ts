// "Connect Apple Reminders" in Obsidian (MVP 0.6 A§4.1, U П1; E-022d2):
// the settings section's state, its buttons, the obsidian://openlfcp-bridge
// callback, and the attempt's tick (first at load, then periodic). The
// attempt itself is the core's (BridgeConnect); this file only opens links,
// copies the "other device" link and keeps the view current.

import { Notice } from "obsidian";
import type { BridgeConnect } from "../core/identity/connect";
import {
  ACTIVE,
  type Attempt,
  COPY_FAILED,
  type ConnectView,
  connectView,
  LINK_COPIED,
  parseCallback,
} from "../core/identity/connect-attempt";

/**
 * [Download for Mac]: the bridge's releases, where its DMG is published
 * (E-005, E-057) until the download page of the website (E-060).
 */
export const BRIDGE_DOWNLOAD_URL = "https://github.com/openlfcp/bridge/releases/latest";

/** How often an attempt under way is stepped (deadline, request under J, phases A1–A4). */
export const CONNECT_TICK_MS = 5000;

export interface RemindersHost {
  /** The attempt's driver, null until Shared Tasks is ready. */
  connector(): BridgeConnect | null;
  /** This vault's name, as obsidian:// URLs carry it. */
  vault(): string;
  /** Opens a URL outside Obsidian (lfcp-bridge://, the download page). */
  open(url: string): void;
  copy(text: string): Promise<void>;
  /** The view changed: the settings section renders again. */
  changed(): void;
}

export class RemindersConnect {
  readonly #host: RemindersHost;
  #attempt: Attempt | undefined;
  #code: string | undefined;
  /** The server was not reached (the link, or a step after [Yes]). */
  #offline = false;
  /** The link is still to be opened for LFCP Bridge (it could not be made yet). */
  #pendingOpen = false;
  #loaded = false;

  constructor(host: RemindersHost) {
    this.#host = host;
  }

  /** The state, text and actions of the section (U П1). */
  view(): ConnectView & { readonly state: Attempt["state"] | undefined } {
    return {
      ...connectView(this.#attempt, {
        ...(this.#code === undefined ? {} : { code: this.#code }),
        offline: this.#offline,
      }),
      state: this.#attempt?.state,
    };
  }

  /** Whether an attempt was made here before ("Connect again" rather than "Connect"). */
  hasAttempt(): boolean {
    return this.#attempt !== undefined;
  }

  #set(c: BridgeConnect, a: Attempt | undefined): void {
    this.#attempt = a;
    this.#code = c.code();
    this.#host.changed();
  }

  /**
   * The periodic step, and the first one at load (arbiter d1): the attempt
   * read from the journal, stepped while under way, and its link opened once
   * it can be made. Nothing is asked of the server without an attempt.
   */
  async tick(): Promise<void> {
    const c = this.#host.connector();
    if (c === null) return;
    if (!this.#loaded) {
      this.#loaded = true;
      this.#set(c, await c.attempt());
    }
    if (this.#attempt === undefined || !ACTIVE.has(this.#attempt.state)) return;
    try {
      const a = await c.tick();
      this.#offline = false;
      this.#set(c, a);
    } catch {
      this.#offline = true;
      this.#host.changed();
    }
    if (this.#pendingOpen) await this.openLink();
  }

  /** [Connect Apple Reminders] / [Connect again]: a new attempt, its link opened on this Mac. */
  async connect(): Promise<void> {
    const c = this.#host.connector();
    if (c === null) return;
    const a = await c.start(this.#host.vault(), "Mac");
    this.#loaded = true;
    this.#set(c, a);
    if (a.state === "waiting-app") await this.openLink();
  }

  /**
   * [Open LFCP Bridge again], and app-ready. When the link cannot be made
   * (the server is not reached), the section says so and the tick tries again.
   */
  async openLink(): Promise<void> {
    const link = await this.#link();
    this.#pendingOpen = link === null;
    if (link !== null) this.#host.open(link);
  }

  /** [Copy link]: "another device" (U П1), the same link pasted into LFCP Bridge there. */
  async copyLink(): Promise<void> {
    const link = await this.#link();
    if (link === null) return;
    try {
      await this.#host.copy(link);
    } catch {
      // The clipboard refused (e.g. no permission): said, the link itself never shown.
      new Notice(COPY_FAILED);
      return;
    }
    new Notice(LINK_COPIED);
  }

  async #link(): Promise<string | null> {
    const c = this.#host.connector();
    const link = c === null ? null : await c.link().catch(() => null);
    this.#offline = link === null;
    this.#host.changed();
    return link;
  }

  download(): void {
    this.#host.open(BRIDGE_DOWNLOAD_URL);
  }

  /** [Cancel]: before [Yes] only (the core refuses after it). */
  async cancel(): Promise<void> {
    const c = this.#host.connector();
    if (c === null) return;
    await c.cancel();
    this.#pendingOpen = false;
    this.#set(c, await c.attempt());
  }

  /** [Yes, it matches] / [No]. */
  async confirm(matches: boolean): Promise<void> {
    const c = this.#host.connector();
    if (c === null) return;
    this.#set(c, await c.confirm(matches));
  }

  /**
   * obsidian://openlfcp-bridge?vault&attempt&event (A§4.1): unauthenticated,
   * a hint for this vault's current attempt only (BridgeConnect.callback);
   * app-ready opens the link again. Nothing is approved here.
   */
  async callback(params: Readonly<Record<string, string | undefined>>): Promise<void> {
    const c = this.#host.connector();
    const cb = parseCallback(params);
    if (c === null || cb === null) return;
    if (cb.event === "app-ready") {
      // A§4.1 "Отложенный handoff": the app's first start opens
      // obsidian://openlfcp-bridge?event=app-ready, with no vault or attempt (no secrets).
      // This vault's own attempt waiting for the app opens its link again; identifiers,
      // when given, must be its own. Nothing else follows from it.
      const a = await c.attempt();
      this.#set(c, a);
      if (
        a?.state === "waiting-app" &&
        (cb.attempt === undefined || cb.attempt === a.id) &&
        (cb.vault === undefined || cb.vault === a.vault)
      )
        await this.openLink();
      return;
    }
    const r = await c.callback(cb);
    this.#set(c, await c.attempt());
    if (r.reopen) await this.openLink();
  }
}
