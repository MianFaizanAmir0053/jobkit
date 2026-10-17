import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";

/**
 * The share target, end to end with a synthetic POST (intake AC4): what
 * Android's share sheet sends goes to the service worker, which keeps the
 * screenshots and opens New job, where the upload starts with no further
 * tap; an empty share, a share holding only a link, and every share while
 * the server's switch is off are refused with their messages, and start no
 * job. The real test of the share sheet is the owner's phone (spikes.md).
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

/** What Android's share sheet sends: a multipart POST to the manifest's share target. */
async function share(page: Page, parts: { images?: string[]; text?: string; url?: string }) {
  await page.evaluate(
    ({ images, text, url }) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/share-target";
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
    { images: parts.images ?? [], text: parts.text ?? "", url: parts.url ?? "" },
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

  await noJobs(page);
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
