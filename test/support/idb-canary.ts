// Reading an IndexedDB database raw, for canary tests (LFCP-02-098): every
// value and key of every store, and a deep search for a canary in them.

/** Every value and key of every store of database `name`, as found. */
export async function dump(name: string): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const out: unknown[] = [];
  for (const store of Array.from(db.objectStoreNames)) {
    const tx = db.transaction(store, "readonly");
    const all = <T>(r: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    out.push(...(await all(tx.objectStore(store).getAll())));
    out.push(...(await all(tx.objectStore(store).getAllKeys())));
  }
  db.close();
  return out;
}

/** Whether `value` holds `canary` anywhere: in a string, or in bytes read as UTF-8. */
export function holds(value: unknown, canary: string): boolean {
  if (typeof value === "string") return value.includes(canary);
  if (value instanceof Uint8Array || ArrayBuffer.isView(value))
    return new TextDecoder("utf-8", { fatal: false }).decode(value as Uint8Array).includes(canary);
  if (value instanceof ArrayBuffer) return holds(new Uint8Array(value), canary);
  if (Array.isArray(value)) return value.some((v) => holds(v, canary));
  if (value instanceof Map)
    return [...value].some(([k, v]) => holds(k, canary) || holds(v, canary));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).some(([k, v]) => holds(k, canary) || holds(v, canary));
  return false;
}
