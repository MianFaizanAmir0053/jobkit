import { expect, type Page, test } from "@playwright/test";

/**
 * Every outbound control is held while any reason holds the kit back, and
 * opens once none does (review AC2): a form's Copy all, each field's Copy
 * and Open application link; a WhatsApp message's Open WhatsApp and Copy
 * message. The email's controls are tried in flow.spec.ts.
 */

const LOCATION = {
  work_mode: "remote",
  places: [],
  remote_regions: ["worldwide"],
  time_zone: { zone: "unspecified", min_overlap_hours: -1, text: "" },
};
const ELIGIBILITY = { work_authorisation: [], sponsorship: "unspecified", other_limits: [] };
const SALARY = { text: "", currency: "", min: -1, max: -1, period: "unspecified" };
const NO_BOX = { tile: -1, x1: -1, y1: -1, x2: -1, y2: -1 };
const NO_GAP = { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" };

const role = (route: object, extra: object) => ({
  id: "P1",
  title: "Full-Stack Developer",
  seniority: "unspecified",
  employment: "unspecified",
  location: LOCATION,
  eligibility: ELIGIBILITY,
  salary: SALARY,
  requirements: [],
  route,
  instructions: [],
  required_attachments: [],
  screening_questions: [],
  ...extra,
});

const record = (route: object, extra: object = {}) => ({
  post_kind: "job_post",
  language: "en",
  company: { name: "Fabrikam Payments", website: "" },
  recruiter: { name: "", title: "" },
  scam_signals: [],
  roles: [role(route, extra)],
});

const sentence = {
  id: "S1",
  text: "I have built production React applications for five years.",
  paragraph_break: false,
  class: "claim",
  fact_ids: ["F-react-production"],
  fields: [],
  gap: NO_GAP,
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

/** Scripts the models' answers, pastes the post on New job and waits for its kit. */
async function readyKit(page: Page, answers: unknown[], post: string) {
  const scripted = await page.evaluate(
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
  expect(scripted).toBe(204);
  await page.goto("/jobs/new");
  await page.getByLabel("Paste text").fill(post);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText(/^Ready to review/)).toBeVisible();
}

/** A held link is a span marked disabled; an open one is a real link. */
const held = (page: Page, name: string) =>
  expect(page.getByRole("link", { name })).toHaveAttribute("aria-disabled", "true");
const open = (page: Page, name: string) =>
  expect(page.getByRole("link", { name })).toHaveAttribute("href", /^https:/);

test("holds a form's every control until its answer is settled", async ({ page, context }) => {
  // The copy buttons write to the clipboard, which the test then reads back.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const link = "https://boards.example.net/fabrikam/jobs/4471";
  await readyKit(
    page,
    [
      record(
        { kind: "ats_form", address: link, quote: `Apply here: ${link}`, box: NO_BOX },
        {
          screening_questions: [
            { id: "Q1", text: "Why do you want to join Fabrikam?", addressed_to_ai: false },
            // Pay the owner has now, which the profile does not hold: theirs to answer.
            { id: "Q2", text: "What is your current salary in GBP?", addressed_to_ai: false },
          ],
        },
      ),
      {
        fit: [],
        blocks: [sentence],
        answers: [
          {
            question_id: "Q1",
            topic: "none",
            text: "I want to build payment products with React.",
            fact_ids: ["F-react-production"],
          },
          { question_id: "Q2", topic: "salary", text: "", fact_ids: [] },
        ],
      },
      {
        verdicts: [
          { block_id: "S1", verdict: "supported", company_claim: false, note: "" },
          { block_id: "Q1", verdict: "supported", company_claim: false, note: "" },
        ],
      },
    ],
    `Fabrikam Payments is hiring a Full-Stack Developer. Apply here: ${link}`,
  );

  // Each answer has a copy button of its own, named by its question.
  const answerCopy = page.getByRole("button", { name: "Copy: Why do you want to join Fabrikam?" });

  await held(page, "Open application link");
  await expect(page.getByRole("button", { name: "Copy all" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy: Cover note" })).toBeDisabled();
  await expect(answerCopy).toBeDisabled();

  await page
    .getByRole("button", { name: /^I will answer it in the form/ })
    .first()
    .click();
  await expect(page.getByText("You will answer it in the form.").first()).toBeVisible();

  await open(page, "Open application link");
  await expect(page.getByRole("button", { name: "Copy all" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Copy: Cover note" })).toBeEnabled();
  // The answer's own button copies that answer alone.
  await answerCopy.click();
  await expect(answerCopy).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "I want to build payment products with React.",
  );
});

test("holds a WhatsApp message's every control until its finding is checked", async ({ page }) => {
  await readyKit(
    page,
    [
      record(
        {
          kind: "whatsapp",
          address: "0300 0000000",
          quote: "Send CV on WhatsApp: 0300 0000000",
          box: NO_BOX,
        },
        { location: { ...LOCATION, places: [{ text: "Lahore", code: "PK" }], remote_regions: [] } },
      ),
      { fit: [], blocks: [sentence] },
      {
        verdicts: [
          {
            block_id: "S1",
            verdict: "overstated",
            company_claim: false,
            note: "Five years is more than the facts show.",
          },
        ],
      },
    ],
    "Fabrikam Payments is hiring a Full-Stack Developer in Lahore. Send CV on WhatsApp: 0300 0000000",
  );

  await held(page, "Open WhatsApp");
  await expect(page.getByRole("button", { name: "Copy message" })).toBeDisabled();

  await page
    .getByRole("button", { name: /^I checked this/ })
    .first()
    .click();

  await open(page, "Open WhatsApp");
  await expect(page.getByRole("button", { name: "Copy message" })).toBeEnabled();
});
