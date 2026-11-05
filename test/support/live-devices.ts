// Installations of the plugin against the reference server for the device
// scenarios of IDENTITY draft §7.4 (LFCP-04-414): each with its own
// runtime, storage and keys, the plugin's Collaboration and DeviceService
// on the SDK's real identity flows, sections created and hosted on the
// server, and edits written as the section engine writes them. The network
// is the platform WebSocket, which a test can take offline.
//
// Live: the server is $LFCP_SERVER_BIN (or the shared build, see
// live-server.ts). A test without one skips with its reason (ctx.skip);
// with LFCP_REQUIRE_LIVE=1 it fails instead.

import type { WebSocketFactory, WebSocketLike } from "@openlfcp/client";
import {
  fromBase64url,
  generateObjectId,
  type ResourceId,
  toBase64url,
  toHex,
} from "@openlfcp/core";
import { Collaboration } from "../../src/core/collab/service";
import { DeviceService } from "../../src/core/identity/service";
import { LfcpRuntime } from "../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "./lfcp-env";

/** The platform WebSocket; while `offline`, every socket fails and open ones close. */
export class LiveNetwork {
  readonly #open = new Set<{ close(code?: number, reason?: string): void }>();
  #offline = false;

  get offline(): boolean {
    return this.#offline;
  }

  set offline(value: boolean) {
    this.#offline = value;
    if (value) for (const s of [...this.#open]) s.close(4000, "offline (test)");
  }

  readonly factory: WebSocketFactory = (url, protocols) => {
    if (this.#offline) return failing();
    type Native = WebSocketLike & {
      onclose: ((ev: { code: number; reason: string }) => void) | null;
    };
    const Ctor = (globalThis as { WebSocket?: new (u: string, p: string[]) => Native }).WebSocket;
    if (Ctor === undefined) throw new Error("no platform WebSocket");
    const inner = new Ctor(url, [...protocols]);
    this.#open.add(inner);
    const outer: WebSocketLike = {
      get binaryType() {
        return inner.binaryType;
      },
      set binaryType(v: string) {
        inner.binaryType = v;
      },
      get protocol() {
        return inner.protocol;
      },
      send: (data) => inner.send(data),
      close: (code, reason) => inner.close(code, reason),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    inner.onopen = (ev) => outer.onopen?.(ev);
    inner.onerror = (ev) => outer.onerror?.(ev);
    inner.onmessage = (ev) => outer.onmessage?.(ev);
    inner.onclose = (ev) => {
      this.#open.delete(inner);
      outer.onclose?.(ev);
    };
    return outer;
  };
}

function failing(): WebSocketLike {
  const socket: WebSocketLike = {
    binaryType: "arraybuffer",
    protocol: "",
    send: () => undefined,
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  queueMicrotask(() => {
    socket.onerror?.({});
    socket.onclose?.({ code: 1006, reason: "offline (test)" });
  });
  return socket;
}

export interface LiveInstallation {
  readonly name: string;
  readonly runtime: LfcpRuntime;
  readonly collab: Collaboration;
  readonly service: DeviceService;
  readonly network: LiveNetwork;
  /** This installation's Principal (hex). */
  readonly me: string;
  /** A new shared section, created and hosted on the server, with its local name. */
  section(name: string): Promise<ResourceId>;
  /** One edit in section `R`: a paragraph `text`, committed and sent as the engine sends it. */
  write(R: ResourceId, text: string): Promise<void>;
  /** The paragraphs of section `R` as this installation's replica holds them. */
  texts(R: ResourceId): string[];
}

export interface InstallOptions {
  /** Obsidian on a phone (V3, ARCH §74): the device flows' platform, sections read-only. */
  readonly mobile?: boolean;
}

/** Installations of the plugin against one server; stops them all at the end. */
export class LiveDevices {
  readonly #running: LfcpRuntime[] = [];

  constructor(readonly url: string) {}

  async installation(name: string, o: InstallOptions = {}): Promise<LiveInstallation> {
    const network = new LiveNetwork();
    const runtime = await LfcpRuntime.start(
      new Device().env(new FakeLocal(), {
        webSocket: network.factory,
        tickMs: 20,
        ...(o.mobile === true ? { sectionsReadOnly: true } : {}),
      }),
    );
    this.#running.push(runtime);
    if (runtime.status.kind !== "ready") throw new Error(`${name}: ${runtime.status.kind}`);
    const me = runtime.status.principalId;
    const collab = new Collaboration(runtime, { connectTimeoutMs: 5000, sleep, sections: true });
    const service = new DeviceService({
      runtime: () => runtime,
      context: () => runtime.collaborationContext(),
      collab: () => collab,
      defaultServer: () => this.url,
      platform: o.mobile === true ? "mobile" : "desktop",
      sections: true,
      sleep,
      requestTimeoutMs: 15_000,
    });
    const url = this.url;
    const sections = new Set<string>();
    const opened = async (R: ResourceId) => {
      if (sections.has(toHex(R))) return;
      await runtime.openSection(R);
      sections.add(toHex(R));
    };
    return {
      name,
      runtime,
      collab,
      service,
      network,
      me: toHex(me),
      async section(title) {
        const R = await runtime.createSectionResource({
          name: title,
          endpoints: [url],
          coordinatorUrl: url,
        });
        await runtime.setLocalName(R, title);
        const hosted = await collab.host(R);
        if (hosted.kind !== "hosted")
          throw new Error(`${title} not hosted: ${JSON.stringify(hosted)}`);
        await opened(R);
        await runtime.commitSection(
          R,
          [{ intent: "section.create", sectionId: generateObjectId(), title, createdBy: me }],
          { operationId: crypto.randomUUID() },
        );
        return R;
      },
      async write(R, text) {
        await opened(R);
        const section = await until(`the section of ${toB64(R)} on ${name}`, () => {
          const profile = runtime.sectionProfile(R);
          return profile === undefined ? undefined : sectionNode(profile);
        });
        await runtime.commitSection(
          R,
          [
            {
              intent: "paragraph.create",
              id: generateObjectId(),
              parent: section,
              after: null,
              text,
              createdBy: me,
            },
          ],
          { operationId: crypto.randomUUID() },
        );
      },
      texts(R) {
        const profile = runtime.sectionProfile(R);
        return profile === undefined ? [] : paragraphs(profile);
      },
    };
  }

  async stop(): Promise<void> {
    for (const r of this.#running.splice(0)) await r.stop().catch(() => undefined);
  }
}

const toB64 = (R: ResourceId) => toBase64url(R);
type Profile = NonNullable<ReturnType<LfcpRuntime["sectionProfile"]>>;

/** The section ID of the Resource (its one section). */
const sectionNode = (profile: Profile): string | undefined => profile.replica.validate().sectionId;

/** The visible paragraphs of the section, by text. */
const paragraphs = (profile: Profile): string[] =>
  Object.values(profile.replica.snapshot().nodes)
    .filter((n) => n.kind === "paragraph" && !n.hidden)
    .map((n) => n.text ?? "");

/** Polls `f` until it gives a value other than undefined or false. */
export async function until<T>(
  what: string,
  f: () => T | undefined | false | Promise<T | undefined | false>,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The pairing of `b` by `a` (§5.3), as the dialogs drive it: both fingerprints, B's request. */
export interface Paired {
  readonly operation: string;
  /** What the new device shows. */
  readonly fingerprint: string;
  /** What the approving device shows for the request. */
  readonly reviewed: string;
}

/**
 * `a` shows a link ("Add my other device…"); `b` requests with it ("Pair
 * this device with a link…"); `a` approves the request with `preset`.
 */
export async function pairDevice(
  a: LiveInstallation,
  b: LiveInstallation,
  preset: "full" | "edit" | "read",
): Promise<Paired> {
  const session = await a.service.startSession(a.name);
  if (session.kind !== "link" || session.result.kind !== "created")
    throw new Error(`${a.name}: no link: ${JSON.stringify(session)}`);
  const requested = await b.service.request(session.result.link, b.name);
  if (requested.kind !== "requested") throw new Error(`${b.name}: ${requested.message}`);
  const reviews = await until(`${b.name}'s request on ${a.name}`, async () => {
    const r = await a.service.requests(session.session);
    return Array.isArray(r) && r.length > 0 ? r : undefined;
  });
  const review = reviews[0];
  if (review === undefined) throw new Error("no request");
  const approved = await a.service.approve(review, preset);
  if (approved.kind !== "done") throw new Error(`${a.name}: ${JSON.stringify(approved)}`);
  return {
    operation: requested.operation,
    fingerprint: requested.fingerprint,
    reviewed: review.fingerprint,
  };
}

/** Polls the new device's request until its result is final (§5.3 steps 8, 11). */
export async function settled(b: LiveInstallation, operation: string) {
  return until(`${b.name}'s pairing result`, async () => {
    const v = await b.service.progress(operation);
    return v.final ? v : undefined;
  });
}
