import { expect, type Page, test } from "@playwright/test";

/**
 * A handoff happens inside the click (review AC3): Open in Gmail opens
 * Gmail's compose window, and Copy email puts the email on the clipboard,
 * while every request the page then sends to jobkit is held, as on the
 * slowest network, the post of the words it handed off among them. So the
 * click waits for no request, and the post lands once the network lets it.
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

/** A sentence every draft of the sample profile's templates ends with. */
const COURTESY = "I would welcome a call about how I could help.";

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

/** Pastes the post, waits for its email, and settles its one flag: the job's ID. */
async function readyEmail(page: Page): Promise<string> {
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
  await page.getByLabel("I meet this requirement").click();
  // The controls open once the server agrees that nothing holds the email.
  await expect(page.getByRole("button", { name: "Copy email" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Open in Gmail" })).toHaveAttribute(
    "href",
    /^https:\/\/mail\.google\.com\//,
  );
  return new URL(page.url()).pathname.split("/").pop()!;
}

/**
 * Holds every request the page sends to jobkit from now on until released,
 * as the slowest network would: the method and path of each, in order.
 */
async function holdJobkit(page: Page) {
  const origin = new URL(page.url()).origin;
  const held: string[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.origin === origin,
    async (route) => {
      held.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await released;
      await route.continue();
    },
  );
  return { held, release };
}

test("opens Gmail inside the click, though jobkit cannot yet be reached", async ({
  page,
  context,
}) => {
  // Gmail opens in a tab of its own: the address it opens is kept, and nothing leaves the test.
  let opened: (url: string) => void = () => {};
  const gmail = new Promise<string>((resolve) => {
    opened = resolve;
  });
  await context.route("https://mail.google.com/**", async (route) => {
    opened(route.request().url());
    await route.abort();
  });
  const id = await readyEmail(page);
  const jobkit = await holdJobkit(page);

  await page.getByRole("link", { name: "Open in Gmail" }).click();

  // Gmail opened with the email, while nothing the page sent to jobkit has come back.
  const compose = new URL(await gmail);
  expect(compose.searchParams.getAll("to")).toEqual(["jobs@contoso.com"]);
  expect(compose.searchParams.get("body")).toContain(COURTESY);
  // The words it handed off went to jobkit from the click, after the handoff, and are held still.
  await expect.poll(() => jobkit.held).toContain(`POST /api/jobs/${id}/handoff`);

  const landed = page.waitForResponse((response) =>
    response.url().endsWith(`/api/jobs/${id}/handoff`),
  );
  jobkit.release();
  expect((await landed).status()).toBe(200);
});

test("copies the email inside the click, though jobkit cannot yet be reached", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const id = await readyEmail(page);
  const jobkit = await holdJobkit(page);

  await page.getByRole("button", { name: "Copy email" }).click();

  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(COURTESY);
  await expect.poll(() => jobkit.held).toContain(`POST /api/jobs/${id}/handoff`);

  const landed = page.waitForResponse((response) =>
    response.url().endsWith(`/api/jobs/${id}/handoff`),
  );
  jobkit.release();
  expect((await landed).status()).toBe(200);
});
