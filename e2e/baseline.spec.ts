import { expect, test } from "@playwright/test";

/** The Baseline page's stopwatch (ledger spec, "The timing comparison"), from Start to the table. */

test.beforeEach(async ({ request, page }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
  await page.goto("/login");
  const status = await page.evaluate(
    async () => (await fetch("/api/test/signin", { method: "POST" })).status,
  );
  expect(status).toBe(204);
});

test("times a manual application and adds it to the table", async ({ page }) => {
  await page.goto("/baseline");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("timer", { name: "Time so far" })).toBeVisible();

  // Stop needs the company and role.
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("status")).toHaveText("Say the route, the company and the role.");

  await page.getByLabel("Application form").check();
  await page.getByLabel("Company").fill("Contoso");
  await page.getByLabel("Role").fill("Data Engineer");
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByRole("status")).toHaveText(/^Recorded \d+:\d{2}\.$/);
  await expect(page.getByRole("row", { name: /^All routes 1 / })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Application form 1 / })).toBeVisible();
  await expect(page.getByText("Data Engineer at Contoso")).toBeVisible();
});

test("discards a run started by mistake, recording nothing", async ({ page }) => {
  await page.goto("/baseline");
  await page.getByRole("button", { name: "Start" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Discard" }).click();

  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(page.getByRole("row", { name: /^All routes 0 / })).toBeVisible();
});
