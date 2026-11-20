// Revoking LFCP Bridge's installations (MVP 0.6 A§5.3, A§6.3, E21; E-024):
// only Principals of approval records this C holds, written by root or
// personal, that the SDK's controlRevocationTargets admits (kind 1 of this
// root, the approved leaf, no certificate issued: no cascade), and only for
// a cause — the human's Disconnect here, or `lifecycle` of this same C
// naming {binding, generation}. Each revocation is journaled before it is
// made (the operation of revokeDevice, then `approvals/<P>.revoked` with
// its `at`), so a restart finishes it with the same intents. Disconnect
// asks the bridge to `remove` every section first; if it does not answer,
// the human may disconnect anyway (no unbind).

import {
  type ControlRevocationCause,
  controlRevocationTargets,
  createdBy,
  type IdentityFlowOptions,
  principalOfRef,
  principalRefOf,
  type ServiceControlPort,
  type ServiceControlStateView,
} from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import type { ControlState } from "@openlfcp/wire";
import type { IdentityFlows } from "./flows";
import { uuid7 } from "./section-pairing";

/** Local state: revocations under way, by Principal (hex). */
export const REVOCATIONS_KEY = "reminders-revocations";
/** Local state: Disconnects under way, by C (hex). */
export const DISCONNECTS_KEY = "reminders-disconnects";
/** How long Disconnect waits for the bridge to remove its sections before offering "Disconnect anyway". */
export const DISCONNECT_WAIT_MS = 2 * 60_000;

interface Revocation {
  readonly c: string;
  /** `approvals/<ref>`. */
  readonly ref: string;
  /** revokeDevice's operation, made before it is called. */
  readonly operation: string;
  /** `approvals/<ref>.revoked.at`, the same on every repeat. */
  readonly at: string;
  /** Revoked in I: `approvals/<ref>.revoked` is written next. */
  readonly revoked?: true;
  /** Stopped: the server refused it (said, not repeated). */
  readonly message?: string;
}

export type DisconnectState =
  /** `remove` asked of the bridge for every section; waiting for its events. */
  | "removing"
  /** The bridge did not finish in time: "Disconnect anyway?" */
  | "silent"
  /** The installations are being revoked. */
  | "revoking"
  | "done"
  | "failed";

export interface Disconnect {
  readonly c: string;
  readonly startedAt: number;
  readonly state: DisconnectState;
  /** The `remove` requests, written as one change under `disconnect:<c>:<startedAt>`. */
  readonly requests: readonly { readonly rid: string; readonly intent: Record<string, unknown> }[];
  /** A `remove` the bridge refused or failed (its code), shown with "Disconnect anyway?". */
  readonly code?: string;
  readonly message?: string;
}

export interface BridgeRevocationDeps {
  readonly flows: Pick<IdentityFlows, "revokeDevice">;
  readonly flow: () => IdentityFlowOptions;
  readonly localState: () => {
    get(key: string): Promise<unknown>;
    update(key: string, change: (value: unknown) => unknown): Promise<void>;
  };
  /** The control Resources of the roster open here. */
  readonly controls: () => Promise<readonly ServiceControlPort[]>;
  /** I's verified state and its root; null when this device has no copy of it. */
  readonly identity: () => Promise<{
    readonly root: PrincipalId;
    readonly state: ControlState;
  } | null>;
  /** `requests[].client` (A§3.5a). */
  readonly client: { readonly app: string; readonly protocol: number };
}

/** The non-revoked base approvals of `C` written by root or personal for `C` itself. */
export function baseApprovals(
  port: Pick<ServiceControlPort, "state" | "creatorsOf">,
  resource: ResourceId,
): string[] {
  const state = port.state();
  if (state === undefined) return [];
  const C = toBase64url(resource);
  return Object.entries(state.approvals)
    .filter(
      ([ref, a]) =>
        !a.revoked &&
        a.role === "base" &&
        a.resource === C &&
        createdBy(port.creatorsOf("approvals", ref), ["root", "personal"]),
    )
    .map(([ref]) => ref);
}

/**
 * A§3.1: two non-revoked base approvals — no one is `service` of this C (its
 * writes are refused) until root or personal revokes one. Shown in Devices.
 */
export const baseConflict = (port: Pick<ServiceControlPort, "resource" | "state" | "creatorsOf">) =>
  baseApprovals(port, port.resource).length > 1;

const FINAL = new Set(["applied", "failed", "rejected", "stale", "cancelled"]);

export class BridgeRevocations {
  readonly #d: BridgeRevocationDeps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: BridgeRevocationDeps) {
    this.#d = deps;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #all<T>(key: string): Promise<Record<string, T>> {
    return ((await this.#d.localState().get(key)) ?? {}) as Record<string, T>;
  }

  async #put<T>(key: string, id: string, value: T | undefined): Promise<void> {
    await this.#d.localState().update(key, (all) => {
      const next = { ...((all ?? {}) as Record<string, T>) };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }

  /** The Disconnect of C (hex) under way or ended here, if any. */
  async disconnect(c: string): Promise<Disconnect | undefined> {
    return (await this.#all<Disconnect>(DISCONNECTS_KEY))[c];
  }

  /**
   * One step: revocations journaled are finished, `lifecycle` of each C is
   * acted on (A§5.3 (b)), and Disconnects under way go on.
   */
  tick(): Promise<void> {
    return this.#serial(async () => {
      const ports = await this.#d.controls();
      for (const port of ports) await this.#step(port);
    });
  }

  async #step(port: ServiceControlPort): Promise<void> {
    const c = toHex(port.resource);
    for (const r of Object.values(await this.#all<Revocation>(REVOCATIONS_KEY)))
      if (r.c === c && r.message === undefined) await this.#finish(port, r);
    // A§3.1: in a conflict, nothing written by a service is acted on.
    if (!baseConflict(port)) await this.#revokeAll(port, { kind: "lifecycle" });
    const d = await this.disconnect(c);
    if (d !== undefined) await this.#disconnectStep(port, d);
  }

  /**
   * [Disconnect…] (U П1, П5; A§6.3): `remove` for every section the bridge
   * has from this C (its section approvals), then the revocations once the
   * bridge has applied them.
   */
  start(port: ServiceControlPort): Promise<Disconnect> {
    return this.#serial(async () => {
      const c = toHex(port.resource);
      const known = await this.disconnect(c);
      if (known !== undefined && known.state !== "done" && known.state !== "failed") return known;
      // "Try again" after a refusal: its revocations are tried once more.
      if (known?.state === "failed")
        await this.#d.localState().update(REVOCATIONS_KEY, (all) =>
          Object.fromEntries(
            Object.entries((all ?? {}) as Record<string, Revocation>).map(([k, r]) => {
              if (r.c !== c) return [k, r];
              const { message: _, ...rest } = r;
              return [k, rest];
            }),
          ),
        );
      const state = port.state();
      const now = this.#d.flow().now();
      const at = iso(now);
      const requests = Object.entries(state?.approvals ?? {})
        .filter(
          ([ref, a]) =>
            !a.revoked &&
            a.role === "section" &&
            createdBy(port.creatorsOf("approvals", ref), ["root", "personal"]),
        )
        .map(([, a]) => {
          const rid = uuid7(now);
          return {
            rid,
            intent: {
              intent: "request.create",
              rid,
              request: {
                op: "remove",
                binding: a.resource,
                generation: a.generation,
                args: {},
                client: this.#d.client,
                at,
              },
            },
          };
        });
      const d: Disconnect = {
        c,
        startedAt: now,
        state: requests.length === 0 ? "revoking" : "removing",
        requests,
      };
      await this.#put(DISCONNECTS_KEY, c, d);
      return this.#disconnectStep(port, d);
    });
  }

  /** [Disconnect anyway]: the installations are revoked without the bridge's unbind. */
  anyway(port: ServiceControlPort): Promise<Disconnect | undefined> {
    return this.#serial(async () => {
      const d = await this.disconnect(toHex(port.resource));
      if (d === undefined || d.state === "done") return d;
      const next: Disconnect = { ...d, state: "revoking" };
      await this.#put(DISCONNECTS_KEY, d.c, next);
      return this.#disconnectStep(port, next);
    });
  }

  /** [Cancel] while the bridge is awaited: this device stops; what the bridge removes stays removed. */
  forget(c: string): Promise<void> {
    return this.#serial(() => this.#put<Disconnect>(DISCONNECTS_KEY, c, undefined));
  }

  /** A§3.1 conflict: the human revokes one base installation (cause (a)). */
  revokeOne(port: ServiceControlPort, principal: PrincipalId): Promise<string | null> {
    return this.#serial(() => this.#revokeAll(port, { kind: "human", principal }));
  }

  async #disconnectStep(port: ServiceControlPort, d: Disconnect): Promise<Disconnect> {
    let next = d;
    if (d.state === "removing") {
      const out = await port.commit(
        d.requests.map((r) => r.intent),
        `disconnect:${d.c}:${d.startedAt}`,
      );
      if (out.kind === "rejected") next = { ...d, state: "silent", code: out.code };
      else {
        const events = ((
          port.state() as { events?: Record<string, { state?: unknown; code?: unknown }> }
        )?.events ?? {}) as Record<string, { state?: unknown; code?: unknown }>;
        const ev = d.requests.map((r) => events[r.rid]);
        const bad = ev.find(
          (e) => e !== undefined && FINAL.has(String(e.state)) && e.state !== "applied",
        );
        if (bad !== undefined)
          next = { ...d, state: "silent", code: String(bad.code ?? bad.state) };
        else if (ev.every((e) => e?.state === "applied")) next = { ...d, state: "revoking" };
        else if (this.#d.flow().now() - d.startedAt >= DISCONNECT_WAIT_MS)
          next = { ...d, state: "silent" };
      }
    }
    if (next.state === "revoking") {
      const message = await this.#revokeAll(port, { kind: "everything" });
      const left = Object.values(await this.#all<Revocation>(REVOCATIONS_KEY)).some(
        (r) => r.c === d.c && r.message === undefined,
      );
      if (message !== null) next = { ...next, state: "failed", message };
      else if (!left) next = { ...next, state: "done" };
    }
    if (next !== d) await this.#put(DISCONNECTS_KEY, d.c, next);
    return next;
  }

  /**
   * Revokes what `cause` names in C and A§5.3 admits (sections first, the
   * base last); "everything" is the human's Disconnect: every approval of
   * this C. The first refusal of the server, else null.
   */
  async #revokeAll(
    port: ServiceControlPort,
    cause: ControlRevocationCause | { readonly kind: "everything" },
  ): Promise<string | null> {
    const I = await this.#d.identity();
    const state = port.state();
    if (I === null || state === undefined) return null;
    const causes: ControlRevocationCause[] =
      cause.kind === "everything"
        ? live(state).map((ref) => ({
            kind: "human",
            principal: principalOfRef(ref) as PrincipalId,
          }))
        : [cause];
    const targets: PrincipalId[] = [];
    for (const k of causes)
      targets.push(
        ...controlRevocationTargets({ root: I.root, identity: I.state, control: port, cause: k })
          .targets,
      );
    const order = [...targets].sort((a, b) => Number(isBase(state, a)) - Number(isBase(state, b)));
    const journal = await this.#all<Revocation>(REVOCATIONS_KEY);
    for (const P of order) {
      const known = journal[toHex(P)];
      if (known?.message !== undefined) return known.message;
      const r: Revocation = known ?? {
        c: toHex(port.resource),
        ref: principalRefOf(P),
        operation: `revoke-device.${toHex(crypto.getRandomValues(new Uint8Array(8)))}`,
        at: iso(this.#d.flow().now()),
      };
      if (known === undefined) await this.#put(REVOCATIONS_KEY, toHex(P), r);
      const message = await this.#finish(port, r);
      if (message !== null) return message;
    }
    return null;
  }

  /** Revoked in I, then `approvals/<ref>.revoked`; the server's refusal, else null (done or later). */
  async #finish(port: ServiceControlPort, r: Revocation): Promise<string | null> {
    const P = principalOfRef(r.ref) as PrincipalId;
    let step = r;
    if (step.revoked !== true) {
      const out = await this.#d.flows.revokeDevice({
        ...this.#d.flow(),
        device: P,
        reason: 0n,
        operation: step.operation,
      });
      if (out.kind === "unavailable") return null;
      if (out.kind !== "revoked" && out.kind !== "superseded") {
        const message = `The bridge's installation could not be removed (${out.kind}).`;
        await this.#put(REVOCATIONS_KEY, toHex(P), { ...step, message });
        return message;
      }
      step = { ...step, revoked: true };
      await this.#put(REVOCATIONS_KEY, toHex(P), step);
    }
    const out = await port.commit(
      [{ intent: "approval.revoke", principal: step.ref, at: step.at }],
      `${step.ref}:revoke`,
    );
    if (out.kind === "queued") return null;
    // Acknowledged, or refused because it is revoked already: nothing more to do.
    await this.#put<Revocation>(REVOCATIONS_KEY, toHex(P), undefined);
    return null;
  }
}

/** The non-revoked approvals of a state (the cause "Disconnect" names each). */
const live = (state: ServiceControlStateView): string[] =>
  Object.entries(state.approvals)
    .filter(([, a]) => !a.revoked)
    .map(([ref]) => ref);

/** RFC 3339 without fractions, as C's `at` values are. */
const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

const isBase = (state: ServiceControlStateView, P: PrincipalId): boolean =>
  state.approvals[principalRefOf(P)]?.role === "base";
