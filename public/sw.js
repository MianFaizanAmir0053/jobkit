// jobkit's service worker (platform spec B5; intake spec, "Inputs"). It
// exists because installing the app and the share target need one. It caches
// nothing: a share's screenshots and text rest in IndexedDB only until the
// New job page takes them, which deletes them.
//
// Android's share sheet posts to /share-target. The worker refuses a share
// with nothing in it, one holding only a link, and every share while the
// server's switch is off (asked at most once an hour); it keeps any other
// under a share ID and opens New job with it, which starts the upload with
// no further tap.

// The database, its version and its stores, as src/app/(app)/jobs/new/pendingUploads.ts has them.
const INTAKE_DB = "jobkit-intake";
const VERSION = 1;
const SWITCH_KEPT_MS = 60 * 60 * 1000;
const ONLY_A_LINK = /^(?:https?:\/\/|www\.)\S+$/i;

let shareSwitch = null;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method === "POST" &&
    url.origin === self.location.origin &&
    url.pathname === "/share-target"
  ) {
    event.respondWith(takeShare(event.request));
  }
});

function newJob(search) {
  const target = new URL("/jobs/new", self.location.origin);
  target.search = new URLSearchParams(search).toString();
  return Response.redirect(target.href, 303);
}

/** Whether the server takes shares; when it cannot be asked, the share is kept and the page decides. */
async function switchOn() {
  if (shareSwitch && Date.now() - shareSwitch.at < SWITCH_KEPT_MS) return shareSwitch.on;
  try {
    const response = await fetch("/api/share-target", { cache: "no-store" });
    const body = await response.json();
    shareSwitch = { on: body.on === true, at: Date.now() };
    return shareSwitch.on;
  } catch {
    return true;
  }
}

async function takeShare(request) {
  const arrivedAt = Date.now();
  let form;
  try {
    form = await request.formData();
  } catch {
    return newJob({ refused: "empty" });
  }
  if (!(await switchOn())) return newJob({ refused: "off" });
  const images = form.getAll("images").filter((part) => typeof part === "object" && part.size > 0);
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("text") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  const text =
    title !== "" && !body.includes(title) ? [title, body].filter(Boolean).join("\n") : body;
  if (images.length === 0) {
    if (text === "" && url === "") return newJob({ refused: "empty" });
    if (text === "" || ONLY_A_LINK.test(text)) return newJob({ refused: "link" });
  }
  const id = self.crypto.randomUUID();
  try {
    await putShare({ id, images, text, url, arrivedAt });
  } catch {
    return newJob({ refused: "unkept" });
  }
  return newJob({ share: id });
}

function openIntakeDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INTAKE_DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("uploads")) {
        db.createObjectStore("uploads", { keyPath: "jobId" });
      }
      if (!db.objectStoreNames.contains("shares"))
        db.createObjectStore("shares", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putShare(share) {
  const db = await openIntakeDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("shares", "readwrite");
      transaction.objectStore("shares").put(share);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
