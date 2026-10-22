import { readFileSync } from "node:fs";

import {
  devices,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

/**
 * QR pairing across two browsers (platform spec B3; B10, AC5 to AC8): a
 * laptop signed in through the test sign-in route, and a phone that learns
 * the token only from the QR code's link.
 */

// Rendered by src/app/(app)/test/data/page.testonly.tsx for live, approved sessions.
const MARKER = "jobkit-e2e-owner-data-marker";
// A fixed answer from the sample profile, which only Google sessions may see.
const FIXED_ANSWER = "USD 5,000 a month";
// Everything the dev server prints (e2e/devServer.mjs).
const SERVER_LOG = ".data/e2e/server.log";
// A job of the owner's, as its page and the jobs list name it, and where its email goes.
const COMPANY = "Contoso Labs";
const ADDRESS = "jobs@contoso.com";
// What the Stats page says once the owner's email went.
const SENT_STAT = "emails had a factual edit";

/** The post the owner's job reads, with a must-have only the owner can say they meet. */
const RECORD = {
  post_kind: "job_post",
  language: "en",
  company: { name: COMPANY, website: "" },
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
        address: ADDRESS,
        quote: `Apply by email to ${ADDRESS}`,
        box: { tile: -1, x1: -1, y1: -1, x2: -1, y2: -1 },
      },
      instructions: [],
      required_attachments: [],
      screening_questions: [],
    },
  ],
};

interface Device {
  context: BrowserContext;
  page: Page;
  /** Every URL the browser requested, without its fragment, which never leaves the browser. */
  sent: string[];
}

test.beforeEach(async ({ request }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
});

async function open(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  const sent: string[] = [];
  context.on("request", (request) => sent.push(request.url().split("#")[0]!));
  return { context, page: await context.newPage(), sent } satisfies Device;
}

async function laptop(browser: Browser): Promise<Device> {
  const device = await open(browser);
  await device.page.goto("/login");
  const status = await device.page.evaluate(
    async () => (await fetch("/api/test/signin", { method: "POST" })).status,
  );
  expect(status).toBe(204);
  return device;
}

function phone(browser: Browser): Promise<Device> {
  return open(browser, { ...devices["Pixel 7"] });
}

/** The laptop makes a code; the phone opens the QR code's link and shows its six digits. */
async function scan(from: Device, to: Device): Promise<{ token: string; code: string }> {
  await from.page.goto("/devices");
  const [made] = await Promise.all([
    from.page.waitForResponse((response) => response.url().endsWith("/api/pair/tokens")),
    from.page.getByRole("button", { name: "Pair a phone" }).click(),
  ]);
  const { url } = (await made.json()) as { url: string };
  await expect(from.page.getByRole("img", { name: "QR code that pairs a phone" })).toBeVisible();

  // What the phone's camera does with the QR code.
  await to.page.goto(url);
  const shown = to.page.getByLabel(/^Code \d( \d){5}$/);
  await expect(shown).toBeVisible();
  const code = (await shown.textContent())!.replace(/\D/g, "");
  return { token: new URL(url).hash.slice("#t=".length), code };
}

async function approve(from: Device, code: string): Promise<void> {
  await expect(from.page.getByText(/A phone is waiting/)).toBeVisible();
  await from.page.getByLabel("Code from the phone").fill(code);
  await from.page.getByRole("button", { name: "Approve" }).click();
}

/**
 * The owner takes a pasted post, with the fake models, to an email marked
 * sent, so its job page and the Stats page have the owner's data to show:
 * the job page's path.
 */
async function sentJob(owner: Device): Promise<string> {
  const { context, page } = owner;
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
    .fill(`${COMPANY} is hiring a Senior Full-Stack Engineer. Apply by email to ${ADDRESS}`);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText(/^Ready to review/)).toBeVisible();
  await page.getByLabel("I meet this requirement").click();
  await expect(page.getByText(`Did you send it to ${ADDRESS}?`)).toBeVisible();
  const gmail = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open in Gmail" }).click();
  await (await gmail).close();
  await page.getByRole("button", { name: "Mark sent" }).click();
  await expect(page.getByText("Did you change anything in Gmail?")).toBeVisible();
  // Past the double-tap guard, an answer of its own.
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "No", exact: true }).click();
  await expect(page.getByText(/^Sent · started/)).toBeVisible();
  return new URL(page.url()).pathname;
}

test("pairs a phone, and the token never reaches a request URL or a server log line", async ({
  browser,
}) => {
  const owner = await laptop(browser);
  const mobile = await phone(browser);

  const { token, code } = await scan(owner, mobile);
  // The phone's page took the token out of its address bar at once.
  await expect(mobile.page).toHaveURL(/\/pair$/);
  await approve(owner, code);

  await expect(mobile.page).toHaveURL(/\/jobs$/);
  await expect(mobile.page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  await owner.page.reload();
  await expect(owner.page.getByText("Paired phone")).toBeVisible();
  for (const url of [...owner.sent, ...mobile.sent]) expect(url).not.toContain(token);
  expect(readFileSync(SERVER_LOG, "utf8")).not.toContain(token);
});

test("a phone waiting for approval gets none of the owner's data, from pages or payloads", async ({
  browser,
}) => {
  const owner = await laptop(browser);
  const mobile = await phone(browser);
  const { code } = await scan(owner, mobile);
  // The checks below mean something only if the pages do show data to an approved session.
  expect((await owner.page.request.post("/api/test/profile")).status()).toBe(204);
  const job = await sentJob(owner);
  await expect(owner.page.getByText(COMPANY).first()).toBeVisible();
  await owner.page.goto("/stats");
  await expect(owner.page.getByText(`0 of 1 ${SENT_STAT}`, { exact: false })).toBeVisible();
  await owner.page.goto("/test/data");
  await expect(owner.page.getByText(MARKER)).toBeVisible();
  await owner.page.goto("/profile");
  await expect(owner.page.getByText(FIXED_ANSWER)).toBeVisible();

  for (const path of ["/jobs", job, "/stats", "/test/data", "/devices", "/profile"]) {
    await mobile.page.goto(path);
    await expect(mobile.page).toHaveURL(/\/pair$/);
    const bodies = await mobile.page.evaluate(async (target) => {
      const html = await (await fetch(target)).text();
      const payload = await (await fetch(target, { headers: { RSC: "1" } })).text();
      return [html, payload];
    }, path);
    for (const body of bodies) {
      for (const owners of [MARKER, FIXED_ANSWER, COMPANY, ADDRESS, SENT_STAT]) {
        expect(body, path).not.toContain(owners);
      }
    }
  }
  // Only the waiting screen, with the phone's code still on it.
  await expect(mobile.page.getByLabel(/^Code /)).toBeVisible();

  await owner.page.goto("/devices");
  await approve(owner, code);
  await expect(mobile.page).toHaveURL(/\/jobs$/);
  await mobile.page.goto("/test/data");
  await expect(mobile.page.getByText(MARKER)).toBeVisible();
  await mobile.page.goto(job);
  await expect(mobile.page.getByText(COMPANY).first()).toBeVisible();
});

test("a paired phone cannot reach Devices or the Profile, and once revoked it is sent to sign in", async ({
  browser,
}) => {
  const owner = await laptop(browser);
  const mobile = await phone(browser);
  const { code } = await scan(owner, mobile);
  await approve(owner, code);
  await expect(mobile.page).toHaveURL(/\/jobs$/);
  expect((await owner.page.request.post("/api/test/profile")).status()).toBe(204);

  await expect(mobile.page.getByRole("link", { name: "Devices" })).toHaveCount(0);
  await expect(mobile.page.getByRole("link", { name: "Profile" })).toHaveCount(0);
  for (const path of ["/devices", "/profile"]) {
    await mobile.page.goto(path);
    await expect(mobile.page).toHaveURL(/\/jobs$/);
  }
  // Nor in the page's payloads: the owner's fixed answers stay off paired phones.
  const bodies = await mobile.page.evaluate(async () => [
    await (await fetch("/profile")).text(),
    await (await fetch("/profile", { headers: { RSC: "1" } })).text(),
  ]);
  for (const body of bodies) expect(body).not.toContain(FIXED_ANSWER);

  await owner.page.reload();
  owner.page.once("dialog", (dialog) => void dialog.accept());
  await owner.page.getByRole("button", { name: /^Revoke Android/ }).click();
  await expect(owner.page.getByText("Paired phone")).toHaveCount(0);

  await mobile.page.goto("/jobs");
  await expect(mobile.page).toHaveURL(/\/login$/);
});
