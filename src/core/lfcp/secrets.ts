// A SecretStore (@openlfcp/storage) over a synchronous string slot store,
// such as Obsidian's app.secretStorage (LFCP-059). Obsidian-free: the
// adapter supplies the slots.
//
// Slot IDs: `openlfcp-<55 hex of SHA-256(installId "\n" ref)>`, 64 chars.
// Obsidian's secret IDs are 1-64 lowercase letters, digits and dashes, and
// its store is shared by every vault on the device, so each install has its
// own namespace (the install ID is hashed in) and a SecretRef (which has
// colons, dots and capitals) is hashed. The marker slot is
// `openlfcp-<installId>-marker`, 48 chars.
// The slot store has no delete: an empty string marks a deleted secret.
// Values are "v1:" + unpadded base64url, so an empty secret is not "".

import { fromBase64url, LfcpError, toBase64url, toHex } from "@openlfcp/core";
import { sha256 } from "@openlfcp/crypto";
import { isSecretRef, type SecretRef, type SecretStore } from "@openlfcp/storage";

/** A synchronous string store with no delete (Obsidian's SecretStorage shape). */
export interface SecretSlots {
  get(id: string): string | null;
  set(id: string, value: string): void;
}

const INSTALL_ID = /^[0-9a-f]{32}$/;
const PREFIX = "v1:";

/** An install ID: 128 random bits as lowercase hex. */
export const isInstallId = (value: unknown): value is string =>
  typeof value === "string" && INSTALL_ID.test(value);

/** The slot of `ref` in an install's namespace. */
export function secretSlotId(installId: string, ref: SecretRef): string {
  if (!isInstallId(installId)) throw new LfcpError("UNSUPPORTED_VALUE", "not an install ID");
  const digest = sha256(new TextEncoder().encode(`${installId}\n${ref}`));
  return `openlfcp-${toHex(digest).slice(0, 55)}`;
}

/** The slot of an install's marker (not a SecretRef: it holds no key material). */
export const markerSlotId = (installId: string): string => `openlfcp-${installId}-marker`;

export class SlotSecretStore implements SecretStore {
  readonly #slots: SecretSlots;
  readonly #installId: string;

  constructor(slots: SecretSlots, installId: string) {
    if (!isInstallId(installId)) throw new LfcpError("UNSUPPORTED_VALUE", "not an install ID");
    this.#slots = slots;
    this.#installId = installId;
  }

  put(ref: SecretRef, value: Uint8Array): Promise<void> {
    try {
      if (!isSecretRef(ref)) throw new LfcpError("UNSUPPORTED_VALUE", "not a secret reference");
      this.#slots.set(secretSlotId(this.#installId, ref), PREFIX + toBase64url(value));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  get(ref: SecretRef): Promise<Uint8Array | undefined> {
    try {
      if (!isSecretRef(ref)) return Promise.resolve(undefined);
      const raw = this.#slots.get(secretSlotId(this.#installId, ref));
      if (raw === null || raw === "") return Promise.resolve(undefined);
      if (!raw.startsWith(PREFIX))
        throw new LfcpError("UNSUPPORTED_VALUE", "a stored secret has an unknown format");
      return Promise.resolve(fromBase64url(raw.slice(PREFIX.length)));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  delete(ref: SecretRef): Promise<void> {
    try {
      if (isSecretRef(ref)) this.#slots.set(secretSlotId(this.#installId, ref), "");
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Never renders secrets (JSON, diagnostics). */
  toJSON(): string {
    return "[SlotSecretStore]";
  }
}
