import { expect, test } from "@playwright/test";

/**
 * The whole path once, with the fake models (review AC12): a post pasted on
 * New job, its email drafted from the owner's template, the one flag it
 * raises resolved, the email handed off to Gmail and marked sent, and the
 * Stats page counting it.
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
        {
          id: "R2",
          text: "production Node.js",
          priority: "must",
          kind: "skill",
          skills: ["nodejs"],
          depth: "production",
          years: -1,
        },
        // A must-have code cannot weigh: only the owner can say they meet it.
        {
          id: "R3",
          text: "Fluent English",
          priority: "must",
          kind: "language",
          skills: [],
          depth: "any",
          years: -1,
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

test.beforeEach(async ({ request, page }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
  await page.goto("/login");
  const status = await page.evaluate(async () => {
    const signedIn = await fetch("/api/test/signin", { method: "POST" });
    const profile = await fetch("/api/test/profile", { method: "POST" });
    return [signedIn.status, profile.status];
  });
  expect(status).toEqual([204, 204]);
});

test("takes a post to a sent email, and the Stats page counts it", async ({ page, context }) => {
  // Gmail opens in a tab of its own: nothing leaves the test.
  await context.route("https://mail.google.com/**", (route) => route.abort());
  const scripted = await page.evaluate(
    async (record) =>
      (
        await fetch("/api/test/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: { "gemini-3.8-flash": [record] } }),
        })
      ).status,
    RECORD,
  );
  expect(scripted).toBe(204);

  await page.goto("/jobs/new");
  await page
    .getByLabel("Paste text")
    .fill(
      "Contoso Labs is hiring a Senior Full-Stack Engineer. Apply by email to jobs@contoso.com",
    );
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText(/^Ready to review/)).toBeVisible();

  // The flag, and the gate holding the email back until it is resolved.
  await expect(
    page.getByText("Mark sent appears once nothing holds the email back."),
  ).toBeVisible();
  // Every outbound control is held meanwhile (review AC2).
  await expect(page.getByRole("link", { name: "Open in Gmail" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByRole("button", { name: "Copy subject" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy email" })).toBeDisabled();
  // The tick is the server's: the box changes once it answers.
  await page.getByLabel("I meet this requirement").click();
  await expect(page.getByText("You said you meet it.").first()).toBeVisible();
  await expect(page.getByText("Did you send it to jobs@contoso.com?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy subject" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Copy email" })).toBeEnabled();

  // The handoff, then Mark sent.
  const gmail = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open in Gmail" }).click();
  await (await gmail).close();
  await page.getByRole("button", { name: "Mark sent" }).click();
  await expect(page.getByText("Did you change anything in Gmail?")).toBeVisible();
  // Past the double-tap guard, an answer of its own.
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "No", exact: true }).click();
  await expect(page.getByText(/^Sent · started/)).toBeVisible();

  await page.goto("/stats");
  await expect(page.getByText("1 of 1 emails had a factual edit")).toHaveCount(0);
  await expect(
    page.getByText("0 of 1 emails had a factual edit: 0%", { exact: false }),
  ).toBeVisible();
  // Total time counts the email that went.
  await expect(page.getByRole("row", { name: /^Email 1 / }).last()).toBeVisible();
});
