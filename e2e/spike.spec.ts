import { expect, test } from "@playwright/test";

/**
 * Task 8's spike page in a desktop browser: both Gmail handoffs and the
 * background run. The share target's own test is share.spec.ts.
 */

test.beforeEach(async ({ request, page }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
  await page.goto("/login");
  const status = await page.evaluate(
    async () => (await fetch("/api/test/signin", { method: "POST" })).status,
  );
  expect(status).toBe(204);
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
