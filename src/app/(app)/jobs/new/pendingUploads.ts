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

/**
 * Work on a store in one transaction, closing the database after. `act`
 * starts the requests and gives what to read once the transaction commits.
 */
async function inTransaction<T>(
  store: string,
  mode: IDBTransactionMode,
  act: (objects: IDBObjectStore) => () => T,
): Promise<T> {
  const db = await openIntakeDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const result = act(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(result());
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
    });
  } finally {
    db.close();
  }
}

/** How long a share no page took stays: one opened while signed out, or whose page never loaded. */
const SHARE_KEPT_MS = 24 * 60 * 60_000;

export const pendingUploads: PendingUploads = {
  async save(upload) {
    await inTransaction(UPLOADS, "readwrite", (objects) => {
      objects.put(upload);
      return () => undefined;
    });
  },
  async latest() {
    return inTransaction(UPLOADS, "readonly", (objects) => {
      const request = objects.getAll() as IDBRequest<PendingUpload[]>;
      // The one started last has the latest deadline.
      return () =>
        request.result.reduce<PendingUpload | null>(
          (latest, upload) => (!latest || upload.deadlineAt > latest.deadlineAt ? upload : latest),
          null,
        );
    });
  },
  async get(jobId) {
    return inTransaction(UPLOADS, "readonly", (objects) => {
      const request = objects.get(jobId) as IDBRequest<PendingUpload | undefined>;
      return () => request.result ?? null;
    });
  },
  async clear(jobId) {
    await inTransaction(UPLOADS, "readwrite", (objects) => {
      objects.delete(jobId);
      return () => undefined;
    });
  },
  async clearUpTo(deadlineAt) {
    await inTransaction(UPLOADS, "readwrite", (objects) => {
      const request = objects.getAll() as IDBRequest<PendingUpload[]>;
      request.onsuccess = () => {
        for (const upload of request.result) {
          if (upload.deadlineAt <= deadlineAt) objects.delete(upload.jobId);
        }
      };
      return () => undefined;
    });
  },
};

/** A share the service worker kept (public/sw.js), for New job to start. */
export interface Share {
  id: string;
  images: File[];
  text: string;
  url: string;
  /** When the share arrived, by the wall clock: the job's clock starts there. */
  arrivedAt: number;
  /**
   * How many times New job opened with the share's ID, as the worker counts
   * them; none from a worker older than the count. A share starts with no
   * tap only on its first opening.
   */
  openings?: number;
  /** Why the share waits for the owner's tap, once New job holds it for the tap. */
  held?: string;
}

/** Takes a kept share out of the store: it is read and deleted at once, so it starts one job. */
export async function takeShare(id: string): Promise<Share | null> {
  return inTransaction(SHARES, "readwrite", (objects) => {
    const request = objects.get(id) as IDBRequest<Share | undefined>;
    request.onsuccess = () => {
      if (request.result) objects.delete(id);
    };
    return () => request.result ?? null;
  });
}

/**
 * Keeps a share New job holds for the owner's tap, with why, so leaving the
 * page or reloading it loses nothing; Start takes it out again.
 */
export async function holdShare(share: Share, reason: string): Promise<void> {
  await inTransaction(SHARES, "readwrite", (objects) => {
    objects.put({ ...share, held: reason });
    return () => undefined;
  });
}

/** The share waiting for the owner's tap, if any: the newest, as the worker keeps one at a time. */
export async function heldShare(): Promise<Share | null> {
  return inTransaction(SHARES, "readonly", (objects) => {
    const request = objects.getAll() as IDBRequest<Share[]>;
    return () =>
      request.result
        .filter((share) => share.held)
        .reduce<Share | null>(
          (newest, share) => (!newest || share.arrivedAt > newest.arrivedAt ? share : newest),
          null,
        );
  });
}

/** Forgets a share the owner cleared. */
export async function dropShare(id: string): Promise<void> {
  await inTransaction(SHARES, "readwrite", (objects) => {
    objects.delete(id);
    return () => undefined;
  });
}

/**
 * Forgets a share no page took within a day, or held for the tap that
 * long: one opened while signed out, whose page never loaded, or never tapped.
 */
export async function sweepShares(): Promise<void> {
  await inTransaction(SHARES, "readwrite", (objects) => {
    const request = objects.getAll() as IDBRequest<Share[]>;
    request.onsuccess = () => {
      const now = Date.now();
      for (const share of request.result) {
        if (share.arrivedAt + SHARE_KEPT_MS < now) objects.delete(share.id);
      }
    };
    return () => undefined;
  });
}
