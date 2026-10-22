import { expect, type Page, test } from "@playwright/test";

/**
 * Skip on one device while the kit is open on another (review AC10 and the
 * outbound gate): the other page, which hears nothing from the first, is
 * drawn again within the gate's 15-second check, its outbound controls
 * held; and the skip taken back there opens the kit on the first again.
 */

const RECORD = {
  post_kind: "job_post",
  language: "en",
  company: { name: "Contoso Labs", website: "" },
  recruiter: { name: "", title: "" },
  scam_signals: [],
  roles: [
    {
      id: "P1",
      title: "Senior Full-Stack Engineer",
      seniority: "senior",
      employment: "full_time",
      location: {
        work_mode: "remote",
        places: [],
        remote_regions: ["worldwide"],
        time_zone: { zone: "unspecified", min_overlap_hours: -1, text: "" },
      },
      eligibility: { work_authorisation: [], sponsorship: "unspecified", other_limits: [] },
      salary: { text: "", currency: "", min: -1, max: -1, period: "unspecified" },
      requirements: [
        {
          id: "R1",
          text: "4+ years with React",
          priority: "must",
          kind: "experience",
          skills: ["react"],
          depth: "any",
          years: 4,
        },
      ],
      route: {
        kind: "email",
        address: "jobs@contoso.com",
        quote: "Apply by email to jobs@contoso.com",
        box: { tile: -1, x1: -1, y1: -1, x2: -1, y2: -1 },
      },
      instructions: [],
      required_attachments: [],
      screening_questions: [],
    },
  ],
};

/** The gate's check runs every 15 seconds; the page is drawn again after it. */
const REDRAWN = { timeout: 30_000 };

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  expect(
    await page.evaluate(async () => (await fetch("/api/test/signin", { method: "POST" })).status),
  ).toBe(204);
}

test("a skip on one device holds the kit on the other, and its taking back opens it again", async ({
  page,
  browser,
  request,
}) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
  await signIn(page);
  const scripted = await page.evaluate(async (record) => {
    const profile = await fetch("/api/test/profile", { method: "POST" });
    const models = await fetch("/api/test/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { "gemini-3.8-flash": [record] } }),
    });
    return [profile.status, models.status];
  }, RECORD);
  expect(scripted).toEqual([204, 204]);
  await page.goto("/jobs/new");
  await page
    .getByLabel("Paste text")
    .fill(
      "Contoso Labs is hiring a Senior Full-Stack Engineer. Apply by email to jobs@contoso.com",
    );
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText(/^Ready to review/)).toBeVisible();
  const jobUrl = page.url();

  // The other device: a browser of its own, signed in apart, on the same kit.
  const other = await browser.newContext();
  try {
    const phone = await other.newPage();
    await signIn(phone);
    await phone.goto(jobUrl);
    await expect(phone.getByText(/^Ready to review/)).toBeVisible();
    await expect(phone.getByRole("link", { name: "Open in Gmail" })).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Skip this job" }).click();
    await expect(page.getByText(/^Skipped · started/)).toBeVisible();

    await expect(phone.getByText(/^Skipped · started/)).toBeVisible(REDRAWN);
    // The kit stays on the page, its outbound controls held by the skip.
    await expect(phone.getByRole("link", { name: "Open in Gmail" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await phone.getByRole("button", { name: "Take back the skip" }).click();
    await expect(phone.getByText(/^Ready to review/)).toBeVisible();
    await expect(page.getByText(/^Ready to review/)).toBeVisible(REDRAWN);
  } finally {
    await other.close();
  }
});
