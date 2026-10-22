import { expect, type Page, test } from "@playwright/test";

/**
 * Every waiting state shows its controls, and a control moves the job on as
 * the platform's state table allows (review AC9), with the fake models: the
 * role pick, the eligibility decision, the kit-type pick, a post stopped as
 * no job post, a failed step, and the manual run. An upload that did not
 * finish is not here: the test server cannot let 15 minutes pass.
 */

const NO_BOX = { tile: -1, x1: -1, y1: -1, x2: -1, y2: -1 };
const EMAIL = {
  kind: "email",
  address: "jobs@contoso.com",
  quote: "Apply by email to jobs@contoso.com",
  box: NO_BOX,
};

/** A role the sample profile's templates draft an email for, at once and with no model call. */
const ROLE = {
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
  route: EMAIL,
  instructions: [],
  required_attachments: [],
  screening_questions: [],
};

const record = (roles: object[], postKind = "job_post") => ({
  post_kind: postKind,
  language: "en",
  company: { name: "Contoso Labs", website: "" },
  recruiter: { name: "", title: "" },
  scam_signals: [],
  roles,
});

const POST = "Contoso Labs is hiring. Apply by email to jobs@contoso.com";

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

/** The fake models' answers, in the order the stages will ask; none makes a model call fail. */
async function script(page: Page, answers: unknown[]): Promise<void> {
  const status = await page.evaluate(
    async (each) =>
      (
        await fetch("/api/test/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: { "gemini-3.8-flash": each } }),
        })
      ).status,
    answers,
  );
  expect(status).toBe(204);
}

/** Pastes the post on New job and starts it, landing on its page. */
async function start(page: Page): Promise<void> {
  await page.goto("/jobs/new");
  await page.getByLabel("Paste text").fill(POST);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
}

/** The job page's line under its heading: its state in words, and when it started. */
const state = (page: Page, words: string) =>
  expect(page.getByText(new RegExp(`^${words} · started`))).toBeVisible();

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** The box under one of the page's headings: the innermost that holds it. */
const panel = (page: Page, title: string) =>
  page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .last();

test("offers each role of a post with several, with Skip, and goes on with the one picked", async ({
  page,
}) => {
  await script(page, [
    record([
      ROLE,
      {
        ...ROLE,
        id: "P2",
        title: "Data Engineer",
        location: {
          ...ROLE.location,
          work_mode: "onsite",
          places: [{ text: "Lahore", code: "PK" }],
        },
      },
    ]),
  ]);
  await start(page);

  await state(page, "Pick a role");
  const roles = panel(page, "This post offers several roles. Which one are you applying for?");
  // Each role with its title, where it is, and how to apply.
  await expect(roles.getByText("Senior Full-Stack Engineer", { exact: true })).toBeVisible();
  await expect(roles.getByText("Data Engineer", { exact: true })).toBeVisible();
  await expect(roles.getByText("onsite, Lahore")).toBeVisible();
  await expect(roles.getByText("Apply by email: jobs@contoso.com")).toHaveCount(2);
  await expect(button(page, "Apply for this role")).toHaveCount(2);
  await expect(button(page, "Skip")).toBeVisible();

  await button(page, "Apply for this role").first().click();
  await state(page, "Ready to review");
  await expect(page.getByRole("heading", { name: /^Senior Full-Stack Engineer/ })).toBeVisible();
});

test("asks the owner about a role that may not be open to them, with Draft anyway and Skip", async ({
  page,
}) => {
  // Remote within the UK alone: the sample profile's owner lives in Pakistan.
  await script(page, [
    record([
      {
        ...ROLE,
        location: {
          ...ROLE.location,
          places: [{ text: "London", code: "GB" }],
          remote_regions: ["UK"],
        },
      },
    ]),
  ]);
  await start(page);

  await state(page, "Eligibility needs your decision");
  // The reasons, then the two ways on.
  const decision = panel(page, "This role may not be open to you");
  await expect(decision.getByRole("listitem").first()).toBeVisible();
  await expect(button(page, "Draft anyway")).toBeVisible();
  await expect(button(page, "Skip")).toBeVisible();

  await button(page, "Draft anyway").click();
  await state(page, "Ready to review");
});

test("asks how to apply for a post that does not say, offering each kit and Skip", async ({
  page,
}) => {
  await script(page, [
    record([{ ...ROLE, route: { kind: "unknown", address: "", quote: "", box: NO_BOX } }]),
  ]);
  await start(page);

  await state(page, "Pick a kit type");
  await expect(page.getByRole("heading", { name: "How do you apply for this one?" })).toBeVisible();
  for (const kit of ["An email", "An application form", "A message", "Skip"]) {
    await expect(button(page, kit)).toBeVisible();
  }

  await button(page, "An email").click();
  await state(page, "Ready to review");
});

test("stops a post that is no job post, and reads it again once the owner says it is one", async ({
  page,
}) => {
  await script(page, [record([ROLE], "not_a_job_post"), record([ROLE])]);
  await start(page);

  await state(page, "Stopped");
  await expect(
    page.getByText(
      "This does not look like a job post. If it is one, say so and it is read again.",
    ),
  ).toBeVisible();
  await expect(button(page, "This is a job post")).toBeVisible();
  await expect(button(page, "Skip")).toBeVisible();

  await button(page, "This is a job post").click();
  await state(page, "Ready to review");
});

test("says a step failed, with Retry and Skip, and Retry runs the step again", async ({ page }) => {
  // No answer: reading the post fails.
  await script(page, []);
  await start(page);

  await state(page, "Failed");
  // The step that failed, and why, then the two ways on.
  await expect(
    page.getByRole("list", { name: "Steps" }).getByRole("listitem").filter({ hasText: "Failed" }),
  ).toHaveText(/^Read the post/);
  await expect(panel(page, "This step failed").locator("p").first()).not.toBeEmpty();
  await expect(button(page, "Retry")).toBeVisible();
  await expect(button(page, "Skip")).toBeVisible();

  await script(page, [record([ROLE])]);
  await button(page, "Retry").click();
  await state(page, "Ready to review");
});

test("shows a manual run's clock and Stop, which records the route, the company and the role", async ({
  page,
  context,
}) => {
  // Real use starts at the first handoff: from then on, one new job in three is a manual run.
  await context.route("https://mail.google.com/**", (route) => route.abort());
  await script(page, [record([ROLE])]);
  await start(page);
  await expect(page.getByText("Did you send it to jobs@contoso.com?")).toBeVisible();
  const handedOff = page.waitForResponse((response) => response.url().endsWith("/handoff"));
  const gmail = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open in Gmail" }).click();
  await (await gmail).close();
  expect((await handedOff).status()).toBe(200);

  // New jobs until one is drawn into the manual arm; the others fail at once, with no answer.
  const manual = page.getByText("This one is a manual run: apply the old way, then tap Stop.");
  await script(page, []);
  for (let tries = 0; tries < 20; tries++) {
    await start(page);
    await expect(manual.or(page.getByRole("heading", { name: "This step failed" }))).toBeVisible();
    if (await manual.isVisible()) break;
  }
  await expect(manual, "no job in 20 was drawn into the manual arm").toBeVisible();

  await state(page, "Manual run");
  await expect(page.getByText(/^\d+:\d{2}$/)).toBeVisible();
  await expect(page.getByRole("group", { name: "How you applied" })).toBeVisible();
  await expect(button(page, "Skip")).toBeVisible();
  // Stop asks how the owner applied first, picking no route for them, then the company and role.
  await button(page, "Stop").click();
  await expect(page.getByText("Say how you applied.")).toBeVisible();
  await page.getByLabel("Application form").check();
  await button(page, "Stop").click();
  await expect(page.getByText("Say the company and the role.")).toBeVisible();

  await page.getByLabel("Company").fill("Northwind Traders");
  await page.getByLabel("Role").fill("Data Engineer");
  await button(page, "Stop").click();

  // Closed, and named as the application Stop recorded: by a form, so submitted, not sent.
  await expect(page.getByText("This job is closed.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Data Engineer · Northwind Traders" }),
  ).toBeVisible();
  await state(page, "Submitted");
});
