import type { PendingUpload, PendingUploads } from "./submit";

/**
 * The browser's store of uploads to finish after a reload (intake spec,
 * "Upload path", step 3), in IndexedDB: the screenshots as prepared, by the
 * IDs the server gave them, and when the page stops trying. The share
 * target's worker (public/sw.js) keeps shares in the same database, and
 * opens it with the same version and stores; change both together.
 */

export const INTAKE_DB = "jobkit-intake";
const VERSION = 1;
const UPLOADS = "uploads";
const SHARES = "shares";

/** Opens the database, made with both stores on first use. */
export function openIntakeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INTAKE_DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(UPLOADS))
        db.createObjectStore(UPLOADS, { keyPath: "jobId" });
      if (!db.objectStoreNames.contains(SHARES)) db.createObjectStore(SHARES, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not open"));
  });
}

/** One request on a store, in its own transaction, closing the database after. */
export async function onStore<T>(
  store: string,
  mode: IDBTransactionMode,
  act: (objects: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openIntakeDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = act(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
    });
  } finally {
    db.close();
  }
}

export const pendingUploads: PendingUploads = {
  async save(upload) {
    await onStore(UPLOADS, "readwrite", (objects) => objects.put(upload));
  },
  async latest() {
    const all = await onStore<PendingUpload[]>(UPLOADS, "readonly", (objects) => objects.getAll());
    // The one started last has the latest deadline.
    return all.sort((a, b) => b.deadlineAt - a.deadlineAt)[0] ?? null;
  },
  async clear(jobId) {
    await onStore(UPLOADS, "readwrite", (objects) => objects.delete(jobId));
  },
};
