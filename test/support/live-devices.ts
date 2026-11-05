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

import {
  connectionNetwork,
  type LinearChain,
  syncChain,
  type WebSocketFactory,
  type WebSocketLike,
} from "@openlfcp/client";
import { generateObjectId, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { InMemoryLfcpStorage } from "@openlfcp/storage";
import { Collaboration } from "../../src/core/collab/service";
import { DeviceService } from "../../src/core/identity/service";
import { LfcpRuntime } from "../../src/core/lfcp/runtime";
import { Platform } from "../mocks/obsidian";
import { Device, FakeLocal, sleep } from "./lfcp-env";

/** The platform WebSocket; while `offline`, every socket fails and open ones close. */
export class LiveNetwork {
  readonly #open = new Set<{ close(code?: number, reason?: string): void }>();
  #offline = false;
  /** WebSockets this installation opened (sessions and device flows alike). */
  opened = 0;
  /** Of those, the ones that failed before they opened (refused by the server, e.g. HTTP 429). */
  failed = 0;
  /** When each was opened (ms since the epoch). */
  readonly openedAt: number[] = [];

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
    this.opened++;
    this.openedAt.push(Date.now());
    let connected = false;
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
    inner.onopen = (ev) => {
      connected = true;
      outer.onopen?.(ev);
    };
    inner.onerror = (ev) => outer.onerror?.(ev);
    inner.onmessage = (ev) => outer.onmessage?.(ev);
    inner.onclose = (ev) => {
      if (!connected) this.failed++;
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

/**
 * What an installation keeps on its device besides IndexedDB (shared by
 * every test of the process): its secret slots and its vault-scoped local
 * store. Starting on another installation's state is updating its plugin.
 */
export interface InstallationState {
  readonly slots: ReadonlyMap<string, string>;
  readonly local: FakeLocal;
}

export interface LiveInstallation {
  readonly name: string;
  /** The server every installation of the test uses. */
  readonly url: string;
  readonly runtime: LfcpRuntime;
  readonly collab: Collaboration;
  readonly service: DeviceService;
  readonly network: LiveNetwork;
  /** What it keeps besides IndexedDB: started on again, it is the same installation. */
  readonly state: InstallationState;
  /** This installation's Principal (hex). */
  readonly me: string;
  /** A new shared section, created and hosted on the server (or `on`), with its local name. */
  section(name: string, on?: string): Promise<ResourceId>;
  /** One edit in section `R`: a paragraph `text`, committed and sent as the engine sends it. */
  write(R: ResourceId, text: string): Promise<void>;
  /** The paragraphs of section `R` as this installation's replica holds them. */
  texts(R: ResourceId): string[];
}

/** Installations of the plugin against one server; stops them all at the end. */
export class LiveDevices {
  readonly #running: LfcpRuntime[] = [];

  constructor(readonly url: string) {}

  /**
   * A new installation. On a phone (the mock's Platform.isMobile, as a
   * test sets it) it is wired as plugin.ts and lfcp-env.ts wire it there:
   * sections read-only (V3), the device flows' platform "mobile".
   */
  async installation(name: string, state?: InstallationState): Promise<LiveInstallation> {
    const mobile = Platform.isMobile;
    const network = new LiveNetwork();
    const device = new Device();
    for (const [k, v] of state?.slots ?? []) device.slots.values.set(k, v);
    const local = state?.local ?? new FakeLocal();
    const runtime = await LfcpRuntime.start(
      device.env(local, {
        webSocket: network.factory,
        tickMs: 20,
        sectionsReadOnly: mobile,
      }),
    );
    this.#running.push(runtime);
    if (runtime.status.kind !== "ready") throw new Error(`${name}: ${runtime.status.kind}`);
    const me = runtime.status.principalId;
    const collab = new Collaboration(runtime, {
      connectTimeoutMs: 5000,
      sleep,
      sections: true,
      sectionsReadOnly: mobile,
    });
    const service = new DeviceService({
      runtime: () => runtime,
      context: () => runtime.collaborationContext(),
      collab: () => collab,
      defaultServer: () => this.url,
      platform: mobile ? "mobile" : "desktop",
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
      url,
      runtime,
      collab,
      service,
      network,
      state: { slots: device.slots.values, local },
      me: toHex(me),
      async section(title, on = url) {
        const R = await runtime.createSectionResource({
          name: title,
          endpoints: [on],
          coordinatorUrl: on,
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

/** Polls the new device's request until its result is final (§5.3 steps 8, 11), each second. */
export async function settled(b: LiveInstallation, operation: string) {
  return until(`${b.name}'s pairing result`, async () => {
    await sleep(1000);
    const v = await b.service.progress(operation);
    if (process.env.LFCP_LIVE_DEBUG === "1") console.log("PROGRESS", b.name, JSON.stringify(v));
    return v.final ? v : undefined;
  });
}

/** `R`'s chain as the server gives it to `who` now (validated; a fresh store, nothing kept). */
export async function serverChain(who: LiveInstallation, R: ResourceId): Promise<LinearChain> {
  const c = who.runtime.collaborationContext();
  if (c === null) throw new Error(`${who.name} is not ready`);
  const network = connectionNetwork({
    now: c.now,
    ...(c.webSocket === undefined ? {} : { webSocket: c.webSocket }),
    timeout: () => sleep(15_000),
  });
  const channel = await network.connect(c.principal.signer, who.url);
  try {
    return await syncChain(new InMemoryLfcpStorage(), channel, R);
  } finally {
    channel.close();
  }
}

/** `who` joins `owner`'s section `R` through an invitation with read and write. */
export async function invite(owner: LiveInstallation, who: LiveInstallation, R: ResourceId) {
  const invitation = await owner.collab.invite(R, "read-write");
  const joined = await who.collab.join(invitation.link.reveal(), { name: `${owner.name}'s` });
  if (joined.kind !== "joined") throw new Error(`${who.name}: ${JSON.stringify(joined.kind)}`);
}

// --- Older versions of the plugin ---------------------------------------------

/** The parts of an older runtime and Collaboration these tests use (their own SDK types). */
interface OlderRuntime {
  readonly status: { readonly kind: string; readonly principalId?: Uint8Array };
  registry(): Promise<{ readonly resourceId: ResourceId; readonly localName: string | null }[]>;
  createSectionResource(o: {
    name: string;
    endpoints: string[];
    coordinatorUrl: string;
  }): Promise<ResourceId>;
  setLocalName(R: ResourceId, name: string): Promise<void>;
  openSection(R: ResourceId): Promise<unknown>;
  sectionProfile(R: ResourceId): Profile | undefined;
  commitSection(R: ResourceId, intents: unknown[], o: { operationId: string }): Promise<unknown>;
  phase(R: ResourceId): string;
  identityBlock?(R: ResourceId): unknown;
  on(listener: (e: { type: string; code?: string; resourceId?: ResourceId }) => void): () => void;
  stop(): Promise<void>;
}

interface OlderCollaboration {
  host(R: ResourceId): Promise<{ kind: string }>;
  invite(R: ResourceId, preset: string): Promise<{ link: { reveal(): string } }>;
  join(uri: string, o: { name: string }): Promise<{ kind: string }>;
  status(R: ResourceId): Promise<Record<string, unknown>>;
}

/** An older Shared Tasks from its checkout (built deps installed): its runtime, flows and test env. */
export interface OlderPlugin {
  readonly version: string;
  start(
    name: string,
    state?: InstallationState,
  ): Promise<{
    readonly name: string;
    readonly runtime: OlderRuntime;
    readonly collab: OlderCollaboration;
    readonly state: InstallationState;
    section(title: string): Promise<ResourceId>;
    write(R: ResourceId, text: string): Promise<void>;
    texts(R: ResourceId): string[];
  }>;
}

/**
 * Loads the plugin at `root` (a checkout of an older version with its
 * node_modules: its own @openlfcp/* SDK) from its sources, as its tests
 * run it: LfcpRuntime, Collaboration and its test env (lfcp-env.ts).
 */
export async function olderPlugin(
  version: string,
  root: string,
  url: string,
): Promise<OlderPlugin> {
  // Its test env imports its own fake-indexeddb/auto, which would replace the
  // IndexedDB globals: kept as they are, so every version shares one IndexedDB,
  // as on a device (a database opened before would otherwise get foreign key ranges).
  const saved = Object.getOwnPropertyNames(globalThis)
    .filter((k) => k === "indexedDB" || k.startsWith("IDB"))
    .map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  const [rt, co, env] = (await Promise.all([
    import(/* @vite-ignore */ `${root}/src/core/lfcp/runtime.ts`),
    import(/* @vite-ignore */ `${root}/src/core/collab/service.ts`),
    import(/* @vite-ignore */ `${root}/test/support/lfcp-env.ts`),
  ])) as [
    { LfcpRuntime: { start(env: unknown): Promise<OlderRuntime> } },
    { Collaboration: new (runtime: OlderRuntime, o: unknown) => OlderCollaboration },
    {
      Device: new () => {
        slots: { values: Map<string, string> };
        env(local: unknown, extra?: unknown): Record<string, unknown>;
      };
      FakeLocal: new () => FakeLocal;
    },
  ];
  for (const [k, d] of saved) if (d !== undefined) Object.defineProperty(globalThis, k, d);
  return {
    version,
    async start(name, state) {
      const device = new env.Device();
      for (const [k, v] of state?.slots ?? []) device.slots.values.set(k, v);
      const local = state?.local ?? new env.FakeLocal();
      // The platform WebSocket: online.
      const { webSocket: _offline, ...online } = device.env(local, { tickMs: 20 });
      const runtime = await rt.LfcpRuntime.start(online);
      if (runtime.status.kind !== "ready")
        throw new Error(`${name} (${version}): ${runtime.status.kind}`);
      const me = runtime.status.principalId;
      const collab = new co.Collaboration(runtime, {
        connectTimeoutMs: 5000,
        sleep,
        sections: true,
      });
      return {
        name,
        runtime,
        collab,
        state: { slots: device.slots.values, local },
        async section(title) {
          const R = await runtime.createSectionResource({
            name: title,
            endpoints: [url],
            coordinatorUrl: url,
          });
          await runtime.setLocalName(R, title);
          const hosted = await collab.host(R);
          if (hosted.kind !== "hosted") throw new Error(`${title} not hosted: ${hosted.kind}`);
          await runtime.openSection(R);
          await runtime.commitSection(
            R,
            [{ intent: "section.create", sectionId: generateObjectId(), title, createdBy: me }],
            { operationId: crypto.randomUUID() },
          );
          return R;
        },
        async write(R, text) {
          await runtime.openSection(R);
          const section = await until(`the section on ${name}`, () => {
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
    },
  };
}
