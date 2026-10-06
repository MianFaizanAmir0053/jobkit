// jobkit's service worker (platform spec B5). It exists because installing the
// app and the share target need one. It caches nothing, so no personal data
// ever rests in it.
//
// Task 8's spike: a share to /share-target is answered with a report of what
// Chrome delivered (counts and sizes only, never the content), so the owner's
// phone shows whether the share target works. Intake (Task 13) replaces this
// with the real flow: refusals, the server's switch, and the upload.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method === "POST" &&
    url.origin === self.location.origin &&
    url.pathname === "/share-target"
  ) {
    event.respondWith(reportShare(event.request));
  }
});

async function reportShare(request) {
  const report = {};
  try {
    const form = await request.formData();
    const images = form.getAll("images").filter((part) => typeof part === "object");
    report.parts = String([...form.keys()].length);
    report.images = String(images.length);
    report.bytes = String(images.reduce((sum, image) => sum + image.size, 0));
    report.types = [...new Set(images.map((image) => image.type || "unknown"))].join(",");
    report.text = String(String(form.get("text") ?? "").length);
    report.url = form.get("url") ? "1" : "0";
  } catch (error) {
    report.error = (error && error.name) || "unreadable";
  }
  const target = new URL("/spike/share", self.location.origin);
  target.search = new URLSearchParams(report).toString();
  return Response.redirect(target.href, 303);
}
