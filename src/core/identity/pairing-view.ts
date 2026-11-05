// What the device flows say (LFCP-04-413; IDENTITY-PROFILE-01 §5, §6, §8):
// every result kind of the SDK's identity flows, as an outcome the UI acts
// on and the words it shows. Pure. A result that is not complete never
// reads as success: an approval whose device entry was not written
// (`document-incomplete`) offers "Finish"; a removal whose display flag
// was not written offers "Try again"; a timeout is never a decision (§6).

import type {
  ApprovalResult,
  CancelResult,
  CandidateStatus,
  CreatedIdentityResource,
  DocumentWrite,
  MaskPreset,
  PairingOutcome,
  PairingReview,
  PairingSessionResult,
  RegistrationResult,
  RequestPairingResult,
  RevocationPreview,
  RevocationStatus,
  RevokeDeviceResult,
  RotationOutcome,
} from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { PRESET_LABEL } from "./device-list";

/** Names for what a message mentions: a Resource (hex) by its section name, a device (hex) by its label. */
export interface Names {
  readonly resource: (hex: string) => string;
  readonly device: (hex: string) => string;
}

const list = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(", ");

/** The commands, as the texts name them. */
export const ADD_DEVICE = "Add my other device…";
export const PAIR_THIS_DEVICE = "Pair this device with a link…";

/** The link's dialog: what to do with it (§5.2: a bearer secret). */
export const LINK_HELP = `On your other device, open Shared Tasks and choose "${PAIR_THIS_DEVICE}", then paste this link.`;

/** The link's dialog while no request came. */
export const WAITING_FOR_DEVICE =
  "Waiting for the other device. Closing this keeps the link working until you cancel it.";

/**
 * More than one installation used one link (§5.3 "Concurrency and
 * failure"): someone else may have it. Each is shown by its fingerprint;
 * cancelling the link ends every request.
 */
export const severalRequests = (n: number): string =>
  `${n} devices used this link. If you did not send it to each of them, someone else has it: approve only the one whose fingerprint your device shows, or cancel the link and make a new one.`;

/** The new device's dialog, before the link is pasted. */
export const PAIR_HELP = `This makes this vault a device of yours. On a device you already use, choose "${ADD_DEVICE}" and paste its link here.`;

/** The device list before the first pairing. */
export const NO_DEVICES = `This vault has no other devices yet. Use "${ADD_DEVICE}" to add one, or "${PAIR_THIS_DEVICE}" on a new vault to make it a device of another one.`;

/** §8.6: the local copy of a section a device no longer syncs (nothing is deleted). */
export const KEEP_COPY =
  'Your notes keep your copy. Use "Copy shared section" to take its text elsewhere.';

/** "this server does not support devices yet" (§5.1 step 1, §6). */
export const NO_DEVICE_SUPPORT =
  "Your server does not support adding devices yet. Ask its operator to update it, or choose another default server in Settings.";

/** The server could not be reached: nothing is decided (§6). */
export const OFFLINE =
  "The server could not be reached. Nothing was lost: try again when you are online.";

/** A forked device list (§9.7): nothing is decided on it. */
export const FORKED =
  "Your device list has two conflicting versions on the server, so devices cannot be added or removed now. Export diagnostics and contact the server's operator.";

/** What a step that cannot go on says, with a retry when it can resume. */
export interface Stop {
  readonly kind: "stop";
  readonly message: string;
}

/** §5.1: creating the person's device list on the first "Add my other device…". */
export type CreateView = { readonly kind: "created" } | Stop;

export function createView(r: CreatedIdentityResource): CreateView {
  switch (r.kind) {
    case "created":
      return { kind: "created" };
    case "unsupported":
      return { kind: "stop", message: NO_DEVICE_SUPPORT };
    case "refused":
      return {
        kind: "stop",
        message: `The server refused to keep your device list (${r.code}). Nothing was changed.`,
      };
    case "unavailable":
      return { kind: "stop", message: OFFLINE };
  }
}

/** §5.3 step 1: the session and its link, or why there is none. */
export type SessionView =
  | { readonly kind: "link"; readonly session: string; readonly result: PairingSessionResult }
  | Stop;

export function sessionView(r: PairingSessionResult): SessionView {
  switch (r.kind) {
    case "created":
      return { kind: "link", session: r.session, result: r };
    case "limit":
      return {
        kind: "stop",
        message:
          "You already have the most devices a person can have (32). Remove one you no longer use, then add the new one.",
      };
    case "missing-material":
      return {
        kind: "stop",
        message:
          "This device does not hold all of your device list yet, so it cannot make a link. Try again when it has synced, or add the device from your first device.",
      };
    case "not-authorized":
      return {
        kind: "stop",
        message:
          "This device cannot add devices: only your first device and devices with Full access can.",
      };
    case "refused":
      return {
        kind: "stop",
        message: `The server refused the new link (${r.code}). Nothing was changed.`,
      };
    case "conflict":
      return { kind: "stop", message: FORKED };
    case "unavailable":
      return { kind: "stop", message: OFFLINE };
  }
}

const MOBILE = /mobile|phone|ios|android/i;

/** The preset offered first for a request (§5.4): Edit for a phone, Service for a service, else Full. */
export function defaultPreset(review: PairingReview): MaskPreset {
  const offered = (p: MaskPreset) => review.presets.some((o) => o.preset === p && o.offered);
  const wanted: MaskPreset =
    review.kind === 1 ? "service" : MOBILE.test(review.platform ?? "") ? "edit" : "full";
  if (offered(wanted)) return wanted;
  return review.presets.find((o) => o.offered)?.preset ?? wanted;
}

/** One request as the approve dialog shows it (§5.3 step 4). */
export interface ReviewView {
  readonly title: string;
  readonly label: string;
  readonly fingerprint: string;
  readonly details: readonly string[];
  readonly presets: readonly {
    readonly preset: MaskPreset;
    readonly label: string;
    readonly offered: boolean;
    readonly reason: string | null;
  }[];
  readonly preset: MaskPreset;
  /** Service: the requested sections, hex, each may be removed and none added. */
  readonly scope: readonly { readonly resource: string; readonly name: string }[];
}

export function reviewView(review: PairingReview, names: Names): ReviewView {
  const service = review.kind === 1;
  return {
    title: service ? "A service asks to join" : "A device asks to be added",
    label: review.label,
    fingerprint: review.fingerprint,
    details: [
      `Name: ${review.label}`,
      ...(review.platform === undefined ? [] : [`Platform: ${review.platform}`]),
      service
        ? `${review.label} (service) asks to join ${list(review.requestedScope.map((r) => names.resource(toHex(r))))}; access: read and write.`
        : "A device of yours: it gets every section you have.",
      // V3 (LFCP-02-095, §10 "Mobile"): a phone does not write shared sections in this version.
      ...(!service && MOBILE.test(review.platform ?? "")
        ? [
            "On a phone, shared sections stay read-only in this version of Shared Tasks, whatever access you give.",
          ]
        : []),
    ],
    presets: review.presets
      .filter((p) => (service ? p.preset === "service" : p.preset !== "service"))
      .map((p) => ({
        preset: p.preset,
        label: PRESET_LABEL[p.preset],
        offered: p.offered,
        reason: p.offered ? null : (p.reason ?? null),
      })),
    preset: defaultPreset(review),
    scope: review.requestedScope.map((r) => ({
      resource: toHex(r),
      name: names.resource(toHex(r)),
    })),
  };
}

/** Where a device was not registered right away (§5.3 step 10): left for later, listed. */
function pending(results: readonly RegistrationResult[], names: Names): string[] {
  const by = (s: RegistrationResult["status"][]) =>
    results.filter((r) => s.includes(r.status)).map((r) => names.resource(toHex(r.resource)));
  const later = by(["unreachable", "not-authorized", "conflict"]);
  const old = by(["unsupported"]);
  const refused = by(["refused", "superseded"]);
  return [
    ...(later.length === 0 ? [] : [`Not reached yet, added later: ${list(later)}.`]),
    ...(old.length === 0
      ? []
      : [`On a server without device support, added once it is updated: ${list(old)}.`]),
    ...(refused.length === 0 ? [] : [`Refused by the server: ${list(refused)}.`]),
  ];
}

/** The device list's key after a session closed (§5.3 step 9, §8.4). */
function rotationLine(r: RotationOutcome): string[] {
  switch (r.status) {
    case "awaiting-rotation":
      return [
        "Your device list's key changes when your first device or a Full device next opens it.",
      ];
    case "unreachable":
    case "refused":
      return ["Your device list's key could not be changed yet; it is retried later."];
    default:
      return [];
  }
}

/** §5.3 steps 4–10: what an approval did. */
export type ApprovalView =
  | { readonly kind: "done"; readonly message: string }
  /** Not complete: "Finish" resumes the operation (resumeApproval). */
  | { readonly kind: "finish"; readonly operation: string; readonly message: string }
  /** The request changed: show it again and compare the fingerprint again. */
  | {
      readonly kind: "reconfirm";
      readonly review: PairingReview | undefined;
      readonly message: string;
    }
  | Stop;

export function approvalView(r: ApprovalResult, label: string, names: Names): ApprovalView {
  switch (r.kind) {
    case "approved":
      return {
        kind: "done",
        message: [
          `Added "${label}". It now gets your sections.`,
          ...pending(r.registrations, names),
          ...rotationLine(r.rotation),
        ].join(" "),
      };
    case "document-incomplete":
      return {
        kind: "finish",
        operation: r.operation,
        message: [
          `"${label}" is approved, but the server refused to save it in your device list (${r.code}), so adding it is not finished.`,
          ...pending(r.registrations, names),
        ].join(" "),
      };
    case "reconfirm":
      return {
        kind: "reconfirm",
        review: r.review,
        message: "The request changed since you saw it. Compare the fingerprint again.",
      };
    case "infeasible":
      return {
        kind: "stop",
        message: `This access cannot be given from this device: ${r.reason}. Choose another, or approve from your first device.`,
      };
    case "superseded":
      return {
        kind: "stop",
        message: "Another of your devices already answered this request. Nothing was signed here.",
      };
    case "limit":
      return {
        kind: "finish",
        operation: r.operation,
        message:
          "You already have the most devices a person can have (32). Remove one you no longer use, then finish adding this one.",
      };
    case "refused":
      return {
        kind: "stop",
        message: `The server refused a step of adding "${label}" (${r.code}).`,
      };
    case "conflict":
      return { kind: "stop", message: FORKED };
    case "unavailable":
      return r.operation === undefined
        ? { kind: "stop", message: OFFLINE }
        : {
            kind: "finish",
            operation: r.operation,
            message: `The server could not be reached, so adding "${label}" is not finished. Finish it when you are online.`,
          };
  }
}

/** §5.3 steps 4 and 9: a rejected request or a cancelled session. */
export type CancelView =
  | { readonly kind: "done"; readonly message: string }
  /** The session is closed but the request entry stays: the same call writes it again. */
  | { readonly kind: "retry"; readonly message: string }
  | Stop;

export function cancelView(r: CancelResult, rejected: boolean): CancelView {
  switch (r.kind) {
    case "cancelled":
      return {
        kind: "done",
        message: [
          rejected ? "Request rejected. The link no longer works." : "The link no longer works.",
          ...rotationLine(r.rotation),
        ].join(" "),
      };
    case "document-incomplete":
      return {
        kind: "retry",
        message: `The link no longer works, but the server refused to remove the request from your device list (${r.code}).`,
      };
    case "consumed":
      return {
        kind: "stop",
        message: "This request was already approved, so there is nothing to cancel.",
      };
    case "refused":
      return { kind: "stop", message: `The server refused to close the link (${r.code}).` };
    case "conflict":
      return { kind: "stop", message: FORKED };
    case "unavailable":
      return {
        kind: "retry",
        message:
          "The server could not be reached, so the link still works. Try again when you are online.",
      };
  }
}

/** §8.1: what removing a device does, before the human confirms. */
export interface RemovalView {
  /** Why it cannot be removed from here now, or null. */
  readonly blocked: string | null;
  readonly lines: readonly string[];
  /** Devices (hex) suspended with it: offered for re-certification first. */
  readonly suspended: readonly string[];
}

export function removalView(p: RevocationPreview, names: Names): RemovalView {
  if (p.selfDependent)
    return {
      blocked: `This device's own access passes through "${names.device(toHex(p.device))}". Re-certify this device from your first device first, then remove it.`,
      lines: [],
      suspended: [],
    };
  const suspended = [...new Set(p.resources.flatMap((r) => r.suspended.map((d) => toHex(d))))];
  const by = (s: (typeof p.resources)[number]["status"][]) =>
    p.resources.filter((r) => s.includes(r.status)).map((r) => names.resource(toHex(r.resource)));
  const awaiting = p.resources
    .filter((r) => r.status === "ok" && r.exposing && !r.rotator)
    .map((r) => names.resource(toHex(r.resource)));
  const later = by(["unreachable", "not-authorized", "unsupported", "conflict"]);
  const lines = [
    `"${names.device(toHex(p.device))}" loses access to all your sections. It is never added back under the same identity; a replacement is paired as a new device.`,
    ...(suspended.length === 0
      ? []
      : [
          `Devices it added stop too: ${list(suspended.map(names.device))}. Re-certify them first to keep them working.`,
        ]),
    ...(awaiting.length === 0
      ? []
      : [
          `The key of these sections is changed later by your first device or the section's owner, not by this device: ${list(awaiting)}. Until then, the removed device could still read new changes there.`,
        ]),
    ...(later.length === 0 ? [] : [`Not reachable now, removed there later: ${list(later)}.`]),
    "Removing does not delete what it already copied or wrote.",
  ];
  return { blocked: null, lines, suspended };
}

/** §8.2–8.5: what a removal did. */
export type RevokeView =
  | { readonly kind: "done"; readonly message: string }
  /** Not complete: "Try again" resumes the operation (revokeDevice with it). */
  | { readonly kind: "retry"; readonly operation: string; readonly message: string }
  | Stop;

function documentLine(d: DocumentWrite): string | null {
  return d.state === "refused"
    ? `The server refused to mark it as removed in your device list (${d.code ?? "refused"}).`
    : d.state === "unreachable"
      ? "The server could not be reached to mark it as removed in your device list."
      : null;
}

export function revokeView(r: RevokeDeviceResult, label: string, names: Names): RevokeView {
  switch (r.kind) {
    case "revoked": {
      const by = (s: (typeof r.results)[number]["revoke"][]) =>
        r.results.filter((x) => s.includes(x.revoke)).map((x) => names.resource(toHex(x.resource)));
      const later = by([
        "unreachable",
        "not-authorized",
        "unsupported",
        "conflict",
        "self-dependent",
      ]);
      const refused = by(["refused"]);
      const key = (s: RotationOutcome["status"]) =>
        r.results.filter((x) => x.rotation?.status === s);
      const named = (xs: readonly { readonly resource: ResourceId }[]) =>
        list(xs.map((x) => names.resource(toHex(x.resource))));
      const awaiting = key("awaiting-rotation");
      // §8.1, §8.4: a key change that did not happen is never hidden behind "Removed".
      const keyRefused = key("refused");
      const keyUnreachable = key("unreachable");
      const keyHolder = key("awaiting-key-holder");
      const codes = [...new Set(keyRefused.map((x) => x.rotation?.code ?? "refused"))].join(", ");
      const document = documentLine(r.document);
      const lines = [
        `Removed "${label}".`,
        ...(later.length === 0 ? [] : [`Removed there later: ${list(later)}.`]),
        ...(refused.length === 0 ? [] : [`Refused by the server: ${list(refused)}.`]),
        ...(keyRefused.length === 0
          ? []
          : [
              `The server refused the new key of ${named(keyRefused)} (${codes}): until it is changed, the removed device could still read new changes there.`,
            ]),
        ...(keyUnreachable.length === 0
          ? []
          : [
              `The key of ${named(keyUnreachable)} is not changed yet: the server could not be reached.`,
            ]),
        ...(keyHolder.length === 0
          ? []
          : [`The new key of ${named(keyHolder)} is not passed on to your other devices yet.`]),
        ...(awaiting.length === 0
          ? []
          : [
              `The key of ${named(awaiting)} is changed by your first device or the section's owner, not by this device.`,
            ]),
      ];
      const unfinished =
        document !== null || keyRefused.length + keyUnreachable.length + keyHolder.length > 0;
      return unfinished
        ? {
            kind: "retry",
            operation: r.operation,
            message: [...lines, ...(document === null ? [] : [document])].join(" "),
          }
        : { kind: "done", message: lines.join(" ") };
    }
    case "self-dependent":
      return {
        kind: "stop",
        message:
          "This device's own access passes through that device. Re-certify this device from your first device first.",
      };
    case "not-authorized":
      return {
        kind: "stop",
        message:
          "This device cannot remove devices: only your first device and devices with Full access can.",
      };
    case "superseded":
      return {
        kind: "stop",
        message:
          "That device was already handled by another of your devices. Nothing more was done here.",
      };
    case "unavailable":
      return r.operation === undefined
        ? {
            kind: "stop",
            message: "Removing a device needs the server. Try again when you are online.",
          }
        : {
            kind: "retry",
            operation: r.operation,
            message: `The server could not be reached, so removing "${label}" is not finished.`,
          };
    case "conflict":
      return { kind: "stop", message: FORKED };
  }
}

/** §6: a section's status on the new device. */
export const CANDIDATE_TEXT: Readonly<Record<CandidateStatus, string>> = {
  ready: "ready",
  "waiting-for-keys": "waiting for keys",
  "pending-registration": "waiting to be added",
  "not-granted": "not granted",
  unproven: "approval not provable here",
  unreachable: "unreachable, retrying",
  unsupported: "on a server without device support",
};

/** §5.3 steps 2–3 on the new device. */
export type RequestView =
  | { readonly kind: "requested"; readonly operation: string; readonly fingerprint: string }
  | Stop;

export function requestView(r: RequestPairingResult): RequestView {
  switch (r.kind) {
    case "requested":
      return { kind: "requested", operation: r.operation, fingerprint: r.fingerprint };
    case "invalid-link":
    case "not-a-session":
      return {
        kind: "stop",
        message:
          "This link does not work: it is not a link to add a device, or it was already used or cancelled. Ask your other device for a new one.",
      };
    case "unknown-sections":
      return { kind: "stop", message: "Some requested sections are not in your list." };
    case "missing-material":
      return {
        kind: "stop",
        message:
          "Your other device has not finished making this link. Wait a moment and try again.",
      };
    case "refused":
      return {
        kind: "stop",
        message:
          r.code === "ACTOR_EQUIVOCATION"
            ? "Another device used this link at the same time. Ask your other device for a new link."
            : `The server refused the request (${r.code}).`,
      };
    case "unavailable":
      return { kind: "stop", message: OFFLINE };
  }
}

/** §5.3 step 8 and §6 on the new device. */
export interface ProgressView {
  /** Final: rejected, or approved with every section ready or not granted. */
  readonly final: boolean;
  readonly approved: boolean;
  readonly headline: string;
  readonly sections: readonly { readonly name: string; readonly status: string }[];
  /**
   * The person's device list (the Identity Resource, §5.3 step 8) on this
   * device: its own line, never one of the sections. Null until known.
   */
  readonly deviceList: string | null;
}

/** A ready section this device could not open here (§5.3 step 11): kept, and tried again. */
export interface OpenFailure {
  /** The Resource (hex). */
  readonly resource: string;
  /** This version cannot open its kind of data: final until the plugin is updated. */
  readonly newerVersion: boolean;
  readonly reason: string;
}

/**
 * The new device's result. `identity` is the Identity Resource (hex) of
 * the request: a personal device is registered there too, and the SDK
 * lists it among the candidates, but it is not a section.
 */
export function progressView(
  o: PairingOutcome,
  names: Names,
  identity: string,
  failures: readonly OpenFailure[] = [],
): ProgressView {
  switch (o.kind) {
    case "waiting":
      return {
        final: false,
        approved: false,
        headline: "Waiting for your other device to approve…",
        sections: [],
        deviceList: null,
      };
    case "rejected":
      return {
        final: true,
        approved: false,
        headline: "Your other device rejected this request. Nothing was added.",
        sections: [],
        deviceList: null,
      };
    case "unknown":
    case "unavailable":
      return {
        final: false,
        approved: false,
        headline: `Waiting: ${o.reason}. Retrying.`,
        sections: [],
        deviceList: null,
      };
    case "approved": {
      const list = o.candidates.find((c) => toHex(c.resource) === identity);
      const candidates = o.candidates.filter((c) => c !== list);
      const failed = new Map(failures.map((f) => [f.resource, f]));
      const sections = candidates.map((c) => {
        const f = failed.get(toHex(c.resource));
        return {
          name: c.name ?? names.resource(toHex(c.resource)),
          status:
            f === undefined
              ? CANDIDATE_TEXT[c.status]
              : f.newerVersion
                ? "needs a newer version of Shared Tasks"
                : `could not be opened here (${f.reason}), retrying`,
        };
      });
      // A section that could not be opened here is not done: it is tried again.
      const retrying = failures.some((f) => !f.newerVersion);
      const final =
        o.certificate !== null &&
        !retrying &&
        o.candidates.every((c) => c.status === "ready" || c.status === "not-granted");
      return {
        final,
        approved: true,
        headline:
          o.certificate === null
            ? "Approved, waiting to be added…"
            : retrying
              ? "Approved. Some sections could not be opened here yet; trying again."
              : final
                ? "Approved. Your sections are on this device."
                : "Approved. Getting your sections…",
        sections,
        deviceList: list === undefined ? null : CANDIDATE_TEXT[list.status],
      };
    }
  }
}

/** §8.6: why a section no longer syncs on a device that may have been removed. */
export function accessView(s: RevocationStatus): string | null {
  switch (s.kind) {
    case "active":
    case "unreachable":
      return null;
    case "access-refused":
      return "This device no longer has access to this section; it may have been removed from your identity.";
    case "revocation-proven":
      return "This device was removed from your identity.";
  }
}
