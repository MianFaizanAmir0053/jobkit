import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";

/**
 * The share target, end to end with a synthetic POST (intake AC4): what
 * Android's share sheet sends goes to the service worker, which keeps the
 * screenshots and opens New job, where the upload starts with no further
 * tap; an empty share, a share holding only a link, and every share while
 * the server's switch is off are refused with their messages, and start no
 * job. A share another site sends waits for the owner's tap on Start. The
 * real test of the share sheet is the owner's phone (spikes.md).
 */

test.beforeEach(async ({ request, page }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
  await page.goto("/login");
  const status = await page.evaluate(
    async () => (await fetch("/api/test/signin", { method: "POST" })).status,
  );
  expect(status).toBe(204);
});

/** A page the service worker controls: one loaded before the worker became active is not. */
async function controlled(page: Page) {
  await page.goto("/jobs/new");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/** Real screenshots, as base64, one shade each so no two hash alike. */
async function screenshots(count: number): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) =>
      (
        await sharp({
          create: {
            width: 1080,
            height: 1920,
            channels: 3,
            background: { r: 30 + i * 90, g: 30, b: 30 },
          },
        })
          .png()
          .toBuffer()
      ).toString("base64"),
    ),
  );
}

/** A screenshot with no opaque pixel at all, as base64: what it holds shows only on a backing. */
async function transparent(): Promise<string> {
  return (
    await sharp({
      create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()
  ).toString("base64");
}

/** The colour of a held screenshot's preview at its top left, as the page draws it. */
async function previewCorner(page: Page, name: string): Promise<number[]> {
  const image = page.getByRole("img", { name });
  await expect(image).toHaveJSProperty("complete", true);
  return image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(element, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
}

/**
 * What Android's share sheet sends: a multipart POST to the manifest's share
 * target, from the page open now unless `action` names another origin's.
 */
async function share(
  page: Page,
  parts: { images?: string[]; title?: string; text?: string; url?: string },
  action = "/share-target",
) {
  await page.evaluate(
    ({ images, title, text, url, action }) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = action;
      form.enctype = "multipart/form-data";
      const input = document.createElement("input");
      input.type = "file";
      input.name = "images";
      input.multiple = true;
      const files = new DataTransfer();
      images.forEach((base64, i) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        files.items.add(new File([bytes], "shot-" + String(i) + ".png", { type: "image/png" }));
      });
      input.files = files.files;
      form.append(input);
      for (const [name, value] of [
        ["title", title],
        ["text", text],
        ["url", url],
      ] as const) {
        const field = document.createElement("input");
        field.name = name;
        field.value = value;
        form.append(field);
      }
      document.body.append(form);
      form.submit();
    },
    {
      images: parts.images ?? [],
      title: parts.title ?? "",
      text: parts.text ?? "",
      url: parts.url ?? "",
      action,
    },
  );
}

/** The same POST from another site's page, as Playwright serves one: jobkit cannot tell who sent it. */
async function shareFromAnotherSite(
  page: Page,
  baseURL: string | undefined,
  parts: { images?: string[]; text?: string; url?: string },
) {
  await page.route("http://another-site.example/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Another site</title>" }),
  );
  await page.goto("http://another-site.example/");
  await share(page, parts, `${baseURL}/share-target`);
}

const FROM_ANOTHER_SITE = "This share may have come from another site. Check it, then press Start.";
const OPENED_BEFORE =
  "This share was opened before, so it waits for your tap. Check it, then press Start.";

/** How many shares the browser keeps for New job to take. */
async function sharesKept(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const opened = indexedDB.open("jobkit-intake");
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const counted = db.transaction("shares").objectStore("shares").count();
          counted.onerror = () => reject(counted.error);
          counted.onsuccess = () => {
            db.close();
            resolve(counted.result);
          };
        };
      }),
  );
}

async function noJobs(page: Page) {
  await page.goto("/jobs");
  await expect(page.getByText("No jobs yet.")).toBeVisible();
}

test("starts the upload from shared screenshots with no further tap, and opens the job", async ({
  page,
}) => {
  await controlled(page);

  await share(page, {
    images: await screenshots(2),
    text: "Northwind is hiring",
    url: "https://lnkd.in/x",
  });

  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
});

test("holds a share another site sent, showing what came, until the owner taps Start", async ({
  page,
  baseURL,
}) => {
  await controlled(page);

  await shareFromAnotherSite(page, baseURL, {
    images: [await transparent()],
    text: "Northwind is hiring",
    url: "https://lnkd.in/x",
  });

  // The share's ID leaves the address, and the form shows what came as Start will send it: the
  // screenshot as prepared, on white, the text and the link, which is never opened.
  await expect(page).toHaveURL(/\/jobs\/new$/);
  await expect(page.getByRole("status")).toHaveText(FROM_ANOTHER_SITE);
  await expect(page.getByRole("img", { name: "shot-0.png" })).toBeVisible();
  expect(await previewCorner(page, "shot-0.png")).toEqual([255, 255, 255, 255]);
  await expect(page.getByLabel("Paste text")).toHaveValue("Northwind is hiring");
  await expect(page.getByText("Link: https://lnkd.in/x")).toBeVisible();
  await expect(page.getByRole("link", { name: /lnkd/ })).toHaveCount(0);
  await expect(page.getByLabel("Choose screenshots")).toBeDisabled();
  const jobs = await page.context().newPage();
  await noJobs(jobs);
  await jobs.close();

  // Start opens once the page has had no tap for two seconds.
  await page.getByRole("button", { name: "Start" }).click();

  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
});

test("keeps a held share when the owner leaves New job, and shows it again on coming back", async ({
  page,
  baseURL,
}) => {
  await controlled(page);
  await shareFromAnotherSite(page, baseURL, {
    images: await screenshots(1),
    text: "Northwind is hiring",
  });
  await expect(page.getByRole("status")).toHaveText(FROM_ANOTHER_SITE);

  await page.goto("/jobs");
  await page.goto("/jobs/new");

  await expect(page.getByRole("status")).toHaveText(FROM_ANOTHER_SITE);
  await expect(page.getByRole("img", { name: "shot-0.png" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  // Started, the share is held no longer.
  expect(await sharesKept(page)).toBe(0);
});

test("clears a held share at the owner's word, leaving nothing to start", async ({
  page,
  baseURL,
}) => {
  await controlled(page);
  await shareFromAnotherSite(page, baseURL, {
    images: await screenshots(1),
    text: "Northwind is hiring",
    url: "https://lnkd.in/x",
  });
  await expect(page.getByRole("status")).toHaveText(FROM_ANOTHER_SITE);

  await page.getByRole("button", { name: "Clear the share" }).click();

  await expect(page.getByRole("img", { name: "shot-0.png" })).toHaveCount(0);
  await expect(page.getByText("Link: https://lnkd.in/x")).toHaveCount(0);
  await expect(page.getByLabel("Paste text")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Start" })).toBeDisabled();
  // Gone from the browser too: coming back shows nothing.
  await expect.poll(() => sharesKept(page)).toBe(0);
  await page.goto("/jobs/new");
  await expect(page.getByRole("img", { name: "shot-0.png" })).toHaveCount(0);
});

test("holds a share whose first page load failed, when a reload brings the page", async ({
  page,
}) => {
  await controlled(page);
  // The page the worker's redirect opens fails once, as when the tunnel or the server is down.
  await page.route(
    /\/jobs\/new\?share=/,
    (route) => route.fulfill({ status: 502, contentType: "text/plain", body: "Bad gateway" }),
    { times: 1 },
  );

  await share(page, { images: await screenshots(1), text: "Northwind is hiring" });
  await expect(page.getByText("Bad gateway")).toBeVisible();
  await page.reload();

  // The reload's request looks like the owner's own, but the share was opened once already.
  await expect(page.getByRole("status")).toHaveText(OPENED_BEFORE);
  await expect(page.getByRole("img", { name: "shot-0.png" })).toBeVisible();
});

test("refuses an empty share and a share holding only a link, starting no job", async ({
  page,
}) => {
  await controlled(page);

  await share(page, {});
  await expect(page).toHaveURL(/\/jobs\/new\?refused=empty$/);
  await expect(page.getByRole("alert")).toHaveText(
    "Nothing arrived from the share. Use Choose screenshots instead.",
  );

  await share(page, { text: "https://www.linkedin.com/posts/northwind-hiring-123" });
  await expect(page).toHaveURL(/\/jobs\/new\?refused=link$/);
  await expect(page.getByRole("alert")).toHaveText(
    "LinkedIn's share sends only a link, which jobkit never opens. Take screenshots of the post and share those.",
  );

  // A link with a few words around it, as LinkedIn's share sends, is a link alone too, and so
  // is a link in the title alone.
  await page.goto("/jobs/new");
  await share(page, { text: "Check out this job at Northwind: https://lnkd.in/x" });
  await expect(page).toHaveURL(/\/jobs\/new\?refused=link$/);
  await page.goto("/jobs/new");
  await share(page, { title: "https://lnkd.in/x" });
  await expect(page).toHaveURL(/\/jobs\/new\?refused=link$/);

  await noJobs(page);
});

test("keeps a short share with a link that names an email address, however its domain begins", async ({
  page,
}) => {
  await controlled(page);

  await share(page, { text: "Send CV: jobs@www.acme.example https://acme.example/jobs" });

  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
});

test("refuses a share larger than jobkit takes, keeping none of it", async ({ page }) => {
  await controlled(page);

  await share(page, { images: await screenshots(9), text: "Northwind is hiring" });

  await expect(page).toHaveURL(/\/jobs\/new\?refused=big$/);
  await expect(page.getByRole("alert")).toHaveText(
    "This share is more than jobkit takes: at most 8 screenshots of 40 MB each and 20,000 characters of text. Share less, or use Choose screenshots.",
  );
  expect(await sharesKept(page)).toBe(0);
  await noJobs(page);
});

test("keeps one share for New job at most, and forgets one no page took within a day", async ({
  page,
}) => {
  await controlled(page);
  // Two shares no page took: one from two days ago, one from now.
  await page.evaluate(
    (arrivals) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("jobkit-intake");
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const transaction = db.transaction("shares", "readwrite");
          for (const [i, arrivedAt] of arrivals.entries()) {
            transaction.objectStore("shares").put({
              id: `00000000-0000-4000-8000-00000000000${String(i)}`,
              images: [],
              text: "An old share",
              url: "",
              arrivedAt,
              openings: 0,
            });
          }
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    [Date.now() - 2 * 24 * 60 * 60 * 1000, Date.now()],
  );

  await page.goto("/jobs/new");
  await expect.poll(() => sharesKept(page)).toBe(1);

  // A new share takes the place of the one no page took.
  await share(page, { images: await screenshots(1), text: "Northwind is hiring" });
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  expect(await sharesKept(page)).toBe(0);
});

test("refuses every share while the server's switch is off", async ({ page }) => {
  await page.goto("/login");
  const status = await page.evaluate(
    async () =>
      (
        await fetch("/api/test/share-target", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ on: false }),
        })
      ).status,
  );
  expect(status).toBe(204);
  await controlled(page);

  await share(page, { images: await screenshots(1), text: "Northwind is hiring" });

  await expect(page).toHaveURL(/\/jobs\/new\?refused=off$/);
  await expect(page.getByRole("alert")).toHaveText(
    "Sharing to jobkit is off for now. Use Choose screenshots instead.",
  );
  await noJobs(page);
});

test("drops a share once this month's spend reaches the cap, starting no job and keeping nothing", async ({
  page,
}) => {
  await page.goto("/login");
  const status = await page.evaluate(
    async () =>
      (
        await fetch("/api/test/spend", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ usd: 25 }),
        })
      ).status,
  );
  expect(status).toBe(204);
  await controlled(page);

  await share(page, { images: await screenshots(1), text: "Northwind is hiring" });

  // The share is taken out of the browser's store before its ID leaves the address. Next's
  // route announcer, an empty alert, comes with the new address.
  await expect(page).toHaveURL(/\/jobs\/new$/);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveText(
    "This month's model spend has reached its cap for new jobs, so jobkit starts none until next month.",
  );
  expect(await sharesKept(page)).toBe(0);
  await noJobs(page);
});
