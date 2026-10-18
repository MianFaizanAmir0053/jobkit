// jobkit's service worker (platform spec B5; intake spec, "Inputs"). It
// exists because installing the app and the share target need one. It caches
// nothing: a share's screenshots and text rest in IndexedDB only until the
// New job page takes them, which deletes them.
//
// Android's share sheet posts to /share-target. The worker refuses a share
// larger than jobkit takes, one with nothing in it, one holding only a link
// (with a few words around it, as LinkedIn's share sends), and every share
// while the server's switch is off (asked at most once an hour). It keeps any
// other under a share ID, in place of any share no page took, and opens New
// job with it. It counts each time New job opens with that ID through the
// worker: the page starts a share with no tap only on its first opening, and
// only when the owner or jobkit's own page sent it.
// src/core/intake/shareWorker.test.ts runs this file's rules on a share.

// The database, its version and its stores, as src/app/(app)/jobs/new/pendingUploads.ts has them.
const INTAKE_DB = "jobkit-intake";
const VERSION = 1;
const SWITCH_KEPT_MS = 60 * 60 * 1000;
// How long the server may take to say whether it takes shares.
const SWITCH_WAIT_MS = 5000;

// Intake's limits (src/core/intake/limits.ts): 8 screenshots and 20,000 characters of text. A
// screenshot as shared is not yet encoded, so it may be larger than an encoded one's 10 MB.
const MAX_IMAGES = 8;
const MAX_SHARED_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_TEXT = 20000;
// A longer url field is not kept as a link, as no longer link is (src/core/intake/links.ts).
const MAX_URL = 2000;

// Links as src/core/intake/links.ts finds them, which a worker cannot import: an address ends at
// a space, an invisible character, a mark that sets the text's direction, or Chinese and Japanese
// punctuation; it leaves out sentence marks and closing quotes after it, and a closing bracket it
// did not open; one inside an email address or a longer domain is no link, nor is the start of an
// address alone. Change both together: the worker's tests hold them to the same answers.
const chars = (...codes) => String.fromCharCode(...codes);
const INVISIBLE =
  chars(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x200e, 0x200f, 0x061c) +
  chars(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069);
const CJK_MARKS = chars(0x3001, 0x3002, 0xff0c, 0xff0e, 0xff01, 0xff1f, 0xff1a, 0xff1b);
const LINK = `(?:(?<![@\\w])https?:\\/\\/|(?<![@\\w.])www\\.)[^\\s<>"\`${INVISIBLE}${CJK_MARKS}]+`;
const TRAILING =
  ".,;:!?'\"}*~" + chars(0x060c, 0x061b, 0x061f, 0x06d4, 0x2026, 0x2019, 0x201d, 0x00bb, 0x203a);
const BRACKETS = { ")": "(", "]": "[" };
const MAX_LINK_LENGTH = 2000;
const BETWEEN_WORDS = new RegExp(`[\\s${INVISIBLE}${CJK_MARKS}]+`);
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// How many words besides a link a share's text needs to be a post: LinkedIn's share of a job
// sends "Check out this job at", the company and the title around its link.
const FEW_WORDS = 8;
const FEW_WORDS_AROUND_LINKEDIN = 25;
const LINKEDIN = /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:linkedin\.com|lnkd\.in)(?:[/:?#]|$)/i;

let shareSwitch = null;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(takeShare(event.request));
  } else if (
    event.request.mode === "navigate" &&
    url.pathname === "/jobs/new" &&
    url.searchParams.has("share")
  ) {
    // Counted and left to the network, which sends the page's own request: a request the worker
    // made instead would always say it came from jobkit's own page. A reload that skips the
    // worker is not counted; the page checks how it was reached too.
    event.waitUntil(countOpening(url.searchParams.get("share")).catch(() => undefined));
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
    const response = await fetch("/api/share-target", {
      cache: "no-store",
      signal: AbortSignal.timeout(SWITCH_WAIT_MS),
    });
    const body = response.ok ? await response.json() : null;
    if (typeof body?.on !== "boolean") return true;
    shareSwitch = { on: body.on, at: Date.now() };
    return body.on;
  } catch {
    return true;
  }
}

const count = (text, char) => text.split(char).length - 1;

function trimmed(link) {
  let out = link;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    const opener = BRACKETS[last];
    if (TRAILING.includes(last)) out = out.slice(0, -1);
    else if (opener !== undefined && count(out, opener) < count(out, last)) out = out.slice(0, -1);
    else return out;
  }
}

/** The links in one of a share's fields, each once, and how many words it holds besides them. */
function linksIn(text) {
  const links = new RegExp(LINK, "gi");
  const found = [];
  for (const match of text.matchAll(links)) {
    const link = trimmed(match[0]);
    if (link.length > MAX_LINK_LENGTH || /^(?:https?:\/\/|www\.)$/i.test(link)) continue;
    if (!found.includes(link)) found.push(link);
  }
  const rest = text.replace(links, " ");
  return { found, rest, words: rest.split(BETWEEN_WORDS).filter(Boolean).length };
}

/** The text a share keeps: its title, when the text does not already hold it, then its text. */
function joined(title, text) {
  return title !== "" && !text.includes(title) ? [title, text].filter(Boolean).join("\n") : text;
}

/**
 * Whether a share with no screenshots is a link alone: a link in its title,
 * text or url field, with fewer than eight words besides in its text, or
 * fewer than 25 around a LinkedIn link, and no email address there, since a
 * post naming one is a post jobkit can apply to, however short. The title's
 * words do not count: a title around a link is no post either.
 */
function onlyALink(title, text, url) {
  const inText = linksIn(text);
  const links = [...inText.found, ...linksIn(title).found, ...linksIn(url).found];
  if (links.length === 0 || EMAIL.test(inText.rest)) return false;
  const needed = links.some((link) => LINKEDIN.test(link)) ? FEW_WORDS_AROUND_LINKEDIN : FEW_WORDS;
  return inText.words < needed;
}

/**
 * Why the worker refuses a share, or null to keep it: "big" past intake's
 * limits, "empty" with nothing in it, "link" for a link alone. Sizes come
 * first, so no text past the limit is searched; the browser has read the
 * whole body by then, whatever its size.
 */
function refusalOf({ images, title, text, url }) {
  if (
    images.length > MAX_IMAGES ||
    images.some((image) => image.size > MAX_SHARED_IMAGE_BYTES) ||
    joined(title, text).length > MAX_TEXT
  ) {
    return "big";
  }
  if (images.length > 0) return null;
  if (title === "" && text === "" && linksIn(url).found.length === 0) return "empty";
  return onlyALink(title, text, url) ? "link" : null;
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
  const shared = String(form.get("url") ?? "").trim();
  const url = shared.length > MAX_URL ? "" : shared;
  const refused = refusalOf({ images, title, text: body, url });
  if (refused) return newJob({ refused });
  const id = self.crypto.randomUUID();
  try {
    await putShare({ id, images, text: joined(title, body), url, arrivedAt, openings: 0 });
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

/** Work on the shares store in one transaction, closing the database after. */
async function onShares(act) {
  const db = await openIntakeDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("shares", "readwrite");
      act(transaction.objectStore("shares"));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps the share in place of any share no page took, so posts from another site never pile up. */
function putShare(share) {
  return onShares((shares) => {
    shares.clear();
    shares.put(share);
  });
}

/** Counts one more opening of New job with the share's ID. */
function countOpening(id) {
  return onShares((shares) => {
    const request = shares.get(id);
    request.onsuccess = () => {
      const share = request.result;
      if (share) shares.put({ ...share, openings: (share.openings ?? 0) + 1 });
    };
  });
}
