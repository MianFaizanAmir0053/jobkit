import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb } from "@/server/db/testDb";

import { applyAgain, duplicateGate, duplicatesOf, findDuplicates } from "./duplicates";
import { companyRoleHash, postFingerprint } from "./normalise";
import { type ApplicationStatus, changeStatus, type NewApplication, openApplication } from "./statuses";

const DAY = 24 * 60 * 60 * 1000;

const REQUIREMENTS = [
  "3+ years of professional experience with React and TypeScript",
  "Experience with REST APIs and state management libraries",
  "Comfortable writing unit tests with Jest and Testing Library",
  "Good written and spoken English",
];

let db: PgliteDb;
let clock: FakeClock;
let jobs = 0;
const deps = () => ({ db, clock });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.applications; delete from {{schema}}.earlier_applications;
     delete from {{schema}}.baseline_runs`,
  );
  clock = fakeClock();
});

function newJob(): string {
  jobs += 1;
  return `00000000-0000-4000-8000-${String(jobs).padStart(12, "0")}`;
}

const application = (overrides: Partial<NewApplication> = {}): NewApplication => ({
  jobId: newJob(),
  company: "Acme (Pvt) Ltd",
  role: "Front-End Developer",
  address: "jobs@acme.example",
  route: "email",
  requirements: REQUIREMENTS,
  arm: null,
  jobKind: "real",
  ...overrides,
});

/** An earlier application, walked through the real statuses to `status`. */
async function earlier(
  status: ApplicationStatus,
  overrides: Partial<NewApplication> = {},
): Promise<string> {
  const id = await openApplication(deps(), application(overrides), null);
  const path: Record<ApplicationStatus, ApplicationStatus[]> = {
    open: [],
    kit_ready: ["kit_ready"],
    sent: ["kit_ready", "sent"],
    submitted: ["kit_ready", "submitted"],
    skipped: ["kit_ready", "skipped"],
    bounced: ["kit_ready", "sent", "bounced"],
  };
  for (const step of path[status]) await changeStatus(deps(), id, step, null);
  clock.advance(DAY);
  return id;
}

/** A second share of a post, as the new application the check runs for. */
async function newShare(overrides: Partial<NewApplication> = {}): Promise<string> {
  return openApplication(deps(), application(overrides), null);
}

describe("duplicatesOf", () => {
  it("matches a repost with new text but the same company and role on company-role", async () => {
    await earlier("sent");
    const id = await newShare({
      company: "ACME",
      role: "Frontend Developer (Remote)",
      address: null,
      requirements: ["Build dashboards in Vue", "Own the design system"],
    });

    expect(await duplicatesOf(db, id)).toEqual([
      {
        reason: "company-role",
        source: "application",
        company: "Acme (Pvt) Ltd",
        role: "Front-End Developer",
        at: expect.any(Date),
      },
    ]);
  });

  it("matches the same address under another role, naming that role", async () => {
    await earlier("submitted", { role: "Backend Engineer", requirements: ["Go and Postgres"] });
    const id = await newShare({ address: "  JOBS@acme.example ", requirements: ["Vue"] });

    expect(await duplicatesOf(db, id)).toEqual([
      expect.objectContaining({ reason: "address", role: "Backend Engineer" }),
    ]);
  });

  it("matches a reworded title with mostly the same requirements on post", async () => {
    await earlier("sent", { address: "careers@acme.example" });
    const id = await newShare({
      role: "Sr. Front End Developer",
      requirements: [...REQUIREMENTS.slice(0, 3), "Excellent written and spoken English"],
    });

    expect(await duplicatesOf(db, id)).toEqual([
      expect.objectContaining({ reason: "post", role: "Front-End Developer" }),
    ]);
  });

  it("matches a second share of a post whose kit was never sent on drafted", async () => {
    await earlier("kit_ready", { address: null, requirements: [] });
    const id = await newShare({ address: null, requirements: [] });

    expect(await duplicatesOf(db, id)).toEqual([
      expect.objectContaining({ reason: "drafted", source: "application" }),
    ]);
  });

  it("matches a kit that was skipped after it was made on drafted too", async () => {
    await earlier("skipped", { address: null, requirements: [] });
    const id = await newShare({ address: null, requirements: [] });

    expect(await duplicatesOf(db, id)).toEqual([expect.objectContaining({ reason: "drafted" })]);
  });

  it("matches a manual run and an imported earlier application", async () => {
    await db.query(
      `insert into {{schema}}.baseline_runs (started_at, stopped_at, route, company, role)
       values ($1, $2, 'email', 'Acme', 'Frontend Developer')`,
      [new Date(clock.now().getTime() - DAY), clock.now()],
    );
    await db.query(
      `insert into {{schema}}.earlier_applications
         (company, role, company_role_hash, applied_on, route, address, imported_at)
       values ('Acme Ltd', 'Front End Developer', $1, '2026-05-04', 'form', null, $2)`,
      [companyRoleHash("Acme Ltd", "Front End Developer"), clock.now()],
    );
    const id = await newShare({ address: null, requirements: [] });

    expect(await duplicatesOf(db, id)).toEqual([
      { reason: "company-role", source: "manual-run", company: "Acme", role: "Frontend Developer", at: clock.now() },
      {
        reason: "company-role",
        source: "earlier",
        company: "Acme Ltd",
        role: "Front End Developer",
        at: new Date("2026-05-04T00:00:00Z"),
      },
    ]);
  });

  it("matches an imported earlier application on its address", async () => {
    await db.query(
      `insert into {{schema}}.earlier_applications
         (company, role, company_role_hash, applied_on, route, address, imported_at)
       values ('Globex', 'Designer', $1, '2026-05-04', 'email', 'Jobs@Acme.example', $2)`,
      [companyRoleHash("Globex", "Designer"), clock.now()],
    );
    const id = await newShare({ requirements: [] });

    expect(await duplicatesOf(db, id)).toEqual([
      expect.objectContaining({ reason: "address", source: "earlier", role: "Designer" }),
    ]);
  });

  it("lists every reason an earlier application matches on, newest first", async () => {
    await earlier("sent", { role: "Backend Engineer" });
    await earlier("sent");
    const id = await newShare();

    const reasons = (await duplicatesOf(db, id))!.map((match) => [match.role, match.reason]);
    expect(reasons).toEqual([
      ["Front-End Developer", "company-role"],
      ["Front-End Developer", "address"],
      ["Front-End Developer", "post"],
      ["Backend Engineer", "address"],
      ["Backend Engineer", "post"],
    ]);
  });

  it("leaves out the application itself, posts still open without a kit, and test jobs", async () => {
    await earlier("open");
    await earlier("sent", { jobKind: "test" });
    const id = await newShare();

    expect(await duplicatesOf(db, id)).toEqual([]);
  });

  it("finds nothing for another company and role at another address", async () => {
    await earlier("sent");
    const id = await newShare({
      company: "Globex",
      role: "Designer",
      address: "hr@globex.example",
      requirements: ["Figma", "A portfolio of shipped mobile apps"],
    });

    expect(await duplicatesOf(db, id)).toEqual([]);
  });
});

describe("findDuplicates", () => {
  it("matches a post with no company only on its address and requirements", async () => {
    await db.query(
      `insert into {{schema}}.baseline_runs (started_at, stopped_at, route, company, role)
       values ($1, $1, 'email', 'Acme', 'Front-End Developer')`,
      [clock.now()],
    );
    await earlier("sent");

    const matches = await findDuplicates(db, {
      company: "",
      role: "Front-End Developer",
      address: "jobs@acme.example",
      fingerprint: postFingerprint(REQUIREMENTS),
    });

    expect(matches.map((match) => match.reason)).toEqual(["address", "post"]);
  });

  it("checks a company and role before any application exists", async () => {
    await earlier("sent");

    const matches = await findDuplicates(db, {
      company: "acme",
      role: "frontend developer",
      address: null,
      fingerprint: postFingerprint([]),
    });

    expect(matches.map((match) => match.reason)).toEqual(["company-role"]);
  });
});

describe("duplicateGate", () => {
  it("holds every match until the owner taps apply again, and lets a clean application through", async () => {
    await earlier("sent");
    const repeat = await newShare();
    const fresh = await newShare({ company: "Globex", role: "Designer", address: null, requirements: [] });

    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: false });
    expect(await duplicateGate(db, fresh)).toEqual({ matches: [], cleared: true });

    expect(await applyAgain(deps(), repeat)).toBe(true);
    expect(await applyAgain(deps(), repeat)).toBe(false);
    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: true });
  });

  it("reports an application that does not exist", async () => {
    expect(await duplicateGate(db, "22222222-2222-4222-8222-222222222222")).toBeNull();
  });
});
