import { expect, test } from "@playwright/test";

/** The read-only Profile page (profile spec, "Profile page"; profile AC7). */

test.beforeEach(async ({ request, page }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
  await page.goto("/login");
  const status = await page.evaluate(
    async () => (await fetch("/api/test/signin", { method: "POST" })).status,
  );
  expect(status).toBe(204);
});

test("says how to make a profile when there is none", async ({ page }) => {
  await page.goto("/profile");

  await expect(page.getByText("There is no profile yet.")).toBeVisible();
});

test("shows the version's date, the approved and waiting counts, and approved items only, with no editing", async ({
  page,
  request,
}) => {
  expect((await request.post("/api/test/profile")).status()).toBe(204);

  await page.goto("/profile");
  const main = page.getByRole("region", { name: "Profile" });

  await expect(
    main.getByText(/^The version seeded on \d{1,2} \w+ \d{4} \([0-9a-f]{12}\)\./),
  ).toBeVisible();
  await expect(main.getByText("5 approved, 1 waiting")).toBeVisible();
  await expect(main.getByText("1 approved, 0 waiting")).toBeVisible();
  await expect(
    main.getByText("I have built production React and Next.js applications for five years."),
  ).toBeVisible();
  await expect(main.getByText(/waiting for approval and must never appear/)).toHaveCount(0);
  await expect(main.getByText("Version sample")).toBeVisible();
  // Read-only: nothing on the page can change the profile.
  await expect(main.locator("input, textarea, select, button, form")).toHaveCount(0);
});
