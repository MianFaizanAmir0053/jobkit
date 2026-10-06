import { expect, test } from "@playwright/test";

/**
 * Task 8's spike page in a desktop browser: the service worker catches a
 * share-target POST and reports what arrived. The real test of the share
 * target is the owner's phone; this checks the worker's part.
 */

test.beforeEach(async ({ request, page }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
  await page.goto("/login");
  const status = await page.evaluate(
    async () => (await fetch("/api/test/signin", { method: "POST" })).status,
  );
  expect(status).toBe(204);
});

test("the service worker answers a shared post with what arrived, without its content", async ({
  page,
}) => {
  await page.goto("/spike");
  // A page loaded before the worker became active is not controlled by it; the next load is.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // What Android's share sheet sends: a multipart POST to the manifest's share target.
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/share-target";
    form.enctype = "multipart/form-data";
    const images = document.createElement("input");
    images.type = "file";
    images.name = "images";
    images.multiple = true;
    const files = new DataTransfer();
    files.items.add(new File([new Uint8Array(2048)], "a.png", { type: "image/png" }));
    files.items.add(new File([new Uint8Array(1024)], "b.jpg", { type: "image/jpeg" }));
    images.files = files.files;
    const text = document.createElement("input");
    text.name = "text";
    text.value = "hello";
    form.append(images, text);
    document.body.append(form);
    form.submit();
  });

  await expect(page).toHaveURL(/\/spike\/share\?/);
  await expect(page.getByRole("status")).toHaveText("The share target works: the images arrived.");
  const url = new URL(page.url());
  expect(Object.fromEntries(url.searchParams)).toEqual({
    parts: "3",
    images: "2",
    bytes: "3072",
    types: "image/png,image/jpeg",
    text: "5",
    url: "0",
  });
});

test("offers both Gmail handoffs and the background run", async ({ page }) => {
  await page.goto("/spike");

  await expect(page.getByRole("link", { name: "Open in Gmail" })).toHaveAttribute(
    "href",
    /^mailto:spike@example\.com\?subject=Application%3A%20Test%20Engineer/,
  );
  await expect(page.getByRole("link", { name: "Download the test CV" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a 200-second run" })).toBeVisible();
});
