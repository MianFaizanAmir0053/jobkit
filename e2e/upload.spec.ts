import { expect, test } from "@playwright/test";
import sharp from "sharp";

/**
 * Starting a job from the New job page on the test server (intake spec,
 * "Upload path"): screenshots upload straight to storage, and an upload a
 * reload cut short is finished when New job opens again, with fresh URLs
 * for the screenshots that had not arrived (intake AC7).
 */

test.beforeEach(async ({ request, page }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
  await page.goto("/login");
  const status = await page.evaluate(
    async () => (await fetch("/api/test/signin", { method: "POST" })).status,
  );
  expect(status).toBe(204);
});

/** A real screenshot-sized PNG, one shade per file so no two hash alike. */
async function screenshot(name: string, shade: number) {
  const buffer = await sharp({
    create: {
      width: 1080,
      height: 1920,
      channels: 3,
      background: { r: shade, g: shade, b: shade },
    },
  })
    .png()
    .toBuffer();
  return { name, mimeType: "image/png", buffer };
}

test("finishes an upload a reload cut short, sending again only the screenshot that had not arrived", async ({
  page,
}) => {
  const uploads: string[] = [];
  let held = false;
  // The second screenshot's upload drops, and the page is reloaded before it tries again.
  await page.route("**/api/dev/storage/upload/**", async (route) => {
    uploads.push(new URL(route.request().url()).pathname);
    if (uploads.length >= 2) {
      held = true;
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto("/jobs/new");
  await page
    .getByLabel("Choose screenshots")
    .setInputFiles([await screenshot("first.png", 40), await screenshot("second.png", 200)]);
  await page.getByRole("button", { name: "Start" }).click();
  await expect.poll(() => held).toBe(true);

  await page.unroute("**/api/dev/storage/upload/**");
  const fresh: string[] = [];
  const again: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/jobs/") && url.endsWith("/upload-urls")) fresh.push(url);
    if (request.method() === "PUT" && url.includes("/api/dev/storage/upload/")) again.push(url);
  });
  await page.reload();

  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  // One request for fresh URLs, and one upload: the screenshot that had not arrived.
  expect(fresh).toHaveLength(1);
  expect(again).toHaveLength(1);
  expect(uploads).not.toContain(new URL(again[0]!).pathname);
  await expect(page.getByText("The upload did not finish")).toHaveCount(0);
});
