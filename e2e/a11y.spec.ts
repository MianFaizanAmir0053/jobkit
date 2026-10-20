import { join } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * The job page's accessibility (review AC13): axe, run in the page through
 * Playwright, finds no serious or critical violation on a ready kit, with
 * its flag, fit, outbound controls and add panel showing. axe-core is a dev
 * dependency of its own (the owner's approval, 2026-10-20).
 */

// The tests run from the repository's root, as Playwright's config sits there.
const AXE = join(process.cwd(), "node_modules", "axe-core", "axe.min.js");

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

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

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

test("the job page has no serious accessibility violation", async ({ page }) => {
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

  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (context: Document) => Promise<{ violations: unknown[] }> };
      }
    ).axe;
    return (await axe.run(document)).violations;
  });
  const serious = (violations as Violation[]).filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    serious.map((violation) => ({
      id: violation.id,
      help: violation.help,
      where: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
});
