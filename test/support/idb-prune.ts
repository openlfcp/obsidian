// fake-indexeddb 6.2.5 keeps every transaction in its Database.transactions
// and scans them all to schedule the next one (lib/Database.js,
// processTransactions). A long-lived process slows down per transaction
// (0.05 ms at 1k transactions, 5-7 ms at 40k) and keeps every finished
// transaction with its requests and results in memory (about 3 KB each).
// A soak peer runs for hours at tens of transactions per second: importing
// this module drops each transaction from that list once it has finished,
// after fake-indexeddb's own listeners have scheduled the next one.
// Import it after "fake-indexeddb/auto".

type Raw = { readonly transactions: unknown[] };
const IDB = (globalThis as unknown as { IDBDatabase?: { prototype: Record<string, unknown> } })
  .IDBDatabase;
if (IDB === undefined) throw new Error("idb-prune: import fake-indexeddb/auto first");
const original = IDB.prototype.transaction as (...a: unknown[]) => EventTarget;
IDB.prototype.transaction = function (this: { _rawDatabase: Raw }, ...a: unknown[]) {
  const tx = original.apply(this, a);
  const raw = this._rawDatabase;
  const drop = () => {
    const i = raw.transactions.indexOf(tx);
    if (i >= 0) raw.transactions.splice(i, 1);
  };
  tx.addEventListener("complete", () => setTimeout(drop, 0));
  tx.addEventListener("abort", () => setTimeout(drop, 0));
  return tx;
};
