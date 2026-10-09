// The plugin's own local state sealed at rest (LFCP-02-098, .github
// docs/devel/design/local-state-encryption.md §5–§8): the values the plugin
// keeps in the install database's meta store under `plugin:` (0.1 projection
// bases, section journals, bases and candidates, creation and insertion
// journals) are stored as `lse1` envelopes; their keys stay in clear for
// lookups.
//
// The plugin keeps its own keyring next to the adapter's (the adapter's is
// private to it): its own install ID and key, in the same SecretStore
// namespace, its metadata under `plugin-local-state`. Opening it seals the
// plaintext rows of an older plugin in resumable batches; a lost key never
// crashes and never deletes a row: an unreadable row reads as absent (a
// projection base becomes unknown, a journal entry is resolved from its
// receipt or dropped), and the plugin says so once.

import {
  type LocalStateCipher,
  type LocalStateDiagnostics,
  LocalStateKeyring,
  type LocalStateMeta,
  type ResealRow,
  reseal,
  type SecretStore,
} from "@openlfcp/storage";

/** The meta store as the plugin's install database offers it. */
export interface MetaStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export const PLUGIN_PREFIX = "plugin:";
const META = "plugin-local-state";
/** The store name in every plugin row's AAD. */
const STORE = "plugin";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The values were structured clones before (IndexedDB): bytes, bigints and
// maps keep their types through the envelope's JSON with these tags.
const U8 = "\u0000u8";
const BIG = "\u0000n";
const MAP = "\u0000map";

function encode(value: unknown): Uint8Array {
  return encoder.encode(
    JSON.stringify(value, (_k, v: unknown) =>
      v instanceof Uint8Array
        ? { [U8]: Array.from(v) }
        : typeof v === "bigint"
          ? { [BIG]: v.toString() }
          : v instanceof Map
            ? { [MAP]: [...v] }
            : v,
    ),
  );
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes), (_k, v: unknown) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    if (U8 in o) return Uint8Array.from(o[U8] as number[]);
    if (BIG in o) return BigInt(o[BIG] as string);
    if (MAP in o) return new Map(o[MAP] as [unknown, unknown][]);
    return v;
  }) as unknown;
}

export interface SealedLocalStateOptions {
  readonly meta: MetaStore;
  readonly secrets: SecretStore;
  readonly cipher: LocalStateCipher;
  /** Every plugin key in the meta store, without the prefix (the store has no listing). */
  readonly keys: () => Promise<readonly string[]>;
  readonly now?: () => Date;
}

export class SealedLocalState {
  #keyring: LocalStateKeyring;
  #lost = 0;
  readonly #lostListeners = new Set<() => void>();

  private constructor(
    private readonly o: SealedLocalStateOptions,
    keyring: LocalStateKeyring,
  ) {
    this.#keyring = keyring;
  }

  /** Prepares the keyring (the key first, then the metadata) and finishes a migration or rotation. */
  static async open(o: SealedLocalStateOptions): Promise<SealedLocalState> {
    const stored = (await o.meta.get(META)) as LocalStateMeta | undefined;
    const keyring = await LocalStateKeyring.prepare(
      o.cipher,
      o.secrets,
      stored ?? undefined,
      now(o),
    );
    if (JSON.stringify(keyring.meta) !== JSON.stringify(stored))
      await o.meta.put(META, keyring.meta);
    const sealed = new SealedLocalState(o, keyring);
    if (keyring.meta.phase !== "ready") await sealed.#finishPhase();
    return sealed;
  }

  /** A value; undefined when absent or unreadable (a lost key). */
  async get(key: string): Promise<unknown> {
    const raw = await this.o.meta.get(PLUGIN_PREFIX + key);
    if (!(raw instanceof Uint8Array)) return raw ?? undefined;
    const opened = this.#keyring.open(STORE, key, raw);
    if (opened.kind === "unreadable") {
      this.#unreadable();
      return undefined;
    }
    return decode(opened.bytes) ?? undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (value === null || value === undefined) {
      await this.o.meta.put(PLUGIN_PREFIX + key, null);
      return;
    }
    const bytes = encode(value);
    await this.o.meta.put(PLUGIN_PREFIX + key, this.#keyring.seal(STORE, key, bytes));
  }

  /** Rotation (§8): the next generation's key, every row sealed again, the old key removed. */
  async rotate(): Promise<void> {
    this.#keyring = await this.#keyring.rotate(this.o.secrets, now(this.o));
    await this.o.meta.put(META, this.#keyring.meta);
    await this.#finishPhase();
  }

  /** The plugin rows' status (§8): never key bytes, envelopes or plaintext. */
  async diagnostics(): Promise<LocalStateDiagnostics> {
    const rows = { sealed: 0, plaintext: 0, unreadable: 0 };
    for (const key of await this.o.keys()) {
      const raw = await this.o.meta.get(PLUGIN_PREFIX + key);
      if (raw === null || raw === undefined) continue;
      if (!(raw instanceof Uint8Array)) rows.plaintext++;
      else if (this.#keyring.open(STORE, key, raw).kind === "unreadable") rows.unreadable++;
      else rows.sealed++;
    }
    const m = this.#keyring.meta;
    return {
      scheme: m.scheme,
      generation: m.generation,
      keyPresent: this.#keyring.keyPresent,
      phase: m.phase,
      rows,
      lastEvent: m.lastEvent,
    };
  }

  /** Called once per run, at the first row that could not be read (§7). */
  onUnreadable(listener: () => void): () => void {
    this.#lostListeners.add(listener);
    if (this.#lost > 0) listener();
    return () => this.#lostListeners.delete(listener);
  }

  #unreadable(): void {
    if (this.#lost++ > 0) return;
    for (const l of this.#lostListeners) l();
  }

  /** Seals every plugin row the phase needs, in batches; then records it as ready. */
  async #finishPhase(): Promise<void> {
    const keys = [...(await this.o.keys())].sort();
    const scan = async (after: string | null, limit: number): Promise<ResealRow[]> => {
      const from = after === null ? 0 : keys.findIndex((k) => k > after);
      if (from < 0) return [];
      const rows: ResealRow[] = [];
      for (const key of keys.slice(from, from + limit)) {
        const raw = await this.o.meta.get(PLUGIN_PREFIX + key);
        const bytes = raw instanceof Uint8Array ? raw : encode(raw ?? null);
        rows.push({ store: STORE, key, bytes });
      }
      return rows;
    };
    const write = async (rows: readonly ResealRow[]) => {
      for (const r of rows) await this.o.meta.put(PLUGIN_PREFIX + r.key, r.bytes);
    };
    await reseal(this.#keyring, scan, write);
    const retired = this.#keyring.retired;
    this.#keyring = this.#keyring.finished(now(this.o));
    await this.o.meta.put(META, this.#keyring.meta);
    // The old key goes last: a crash before this line leaves it, harmlessly.
    if (retired !== null) await this.o.secrets.delete(retired);
  }
}

const now = (o: SealedLocalStateOptions) => (o.now?.() ?? new Date()).toISOString();

/** The keys under `prefix` of the `meta` store of IndexedDB database `name`, without the prefix. */
export async function idbMetaKeys(
  name: string,
  prefix: string,
  factory: IDBFactory = indexedDB,
): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error(`IndexedDB ${name} could not be opened`));
  });
  try {
    if (!Array.from(db.objectStoreNames).includes("meta")) return [];
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = db
        .transaction("meta", "readonly")
        .objectStore("meta")
        .getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("the meta keys could not be read"));
    });
    return keys
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.slice(prefix.length));
  } finally {
    db.close();
  }
}
