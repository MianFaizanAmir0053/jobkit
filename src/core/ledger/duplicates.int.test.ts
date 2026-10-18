import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { createTestDb, insertTestJobs } from "@/server/db/testDb";

import { applyAgain, duplicateGate, duplicatesOf, findDuplicates } from "./duplicates";
import { companyRoleHash, postFingerprint } from "./normalise";
import {
  type ApplicationStatus,
  changeStatus,
  type NewApplication,
  openApplication,
  setAddress,
} from "./statuses";

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
  // Applications belong to jobs; newJob() hands out these IDs in turn.
  await insertTestJobs(
    db,
    Array.from({ length: MAX_JOBS }, (_, i) => jobId(i + 1)),
  );
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

const MAX_JOBS = 1000;

function jobId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function newJob(): string {
  jobs += 1;
  if (jobs > MAX_JOBS) throw new Error("Raise MAX_JOBS: the tests need more jobs");
  return jobId(jobs);
}

const application = (overrides: Partial<NewApplication> = {}): NewApplication => ({
  jobId: newJob(),
  roleId: "P1",
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
  const route = status === "submitted" ? "form" : "email";
  const id = await openApplication(deps(), application({ route, ...overrides }), null);
  const path: Record<ApplicationStatus, ApplicationStatus[]> = {
    open: [],
    kit_ready: ["kit_ready"],
    sent: ["kit_ready", "sent"],
    submitted: ["kit_ready", "submitted"],
    skipped: ["kit_ready", "skipped"],
    bounced: ["kit_ready", "sent", "bounced"],
  };
  for (const step of path[status]) {
    expect(await changeStatus(deps(), id, step, null)).toMatchObject({ ok: true });
  }
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
        applied: true,
        bounced: false,
        key: expect.stringMatching(/^application:[0-9a-f-]{36}:company-role$/),
      },
    ]);
  });

  it("says an earlier application whose email bounced went out, and bounced", async () => {
    await earlier("bounced");
    const id = await newShare({ address: null, requirements: [] });

    expect(await duplicatesOf(db, id)).toEqual([
      expect.objectContaining({
        reason: "company-role",
        source: "application",
        applied: true,
        bounced: true,
        key: expect.stringMatching(/^application:[0-9a-f-]{36}:company-role:bounced$/),
      }),
    ]);
  });

  it("matches the same address under another role, naming that role", async () => {
    await earlier("submitted", { role: "Backend Engineer", requirements: ["Go and Postgres"] });
    const id = await newShare({ address: "  JOBS@acme.example ", requirements: ["Vue"] });

    expect(await duplicatesOf(db, id)).toEqual([
      expect.objectContaining({ reason: "address", role: "Backend Engineer", applied: true }),
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
      expect.objectContaining({ reason: "drafted", source: "application", applied: false }),
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
      {
        reason: "company-role",
        source: "manual-run",
        company: "Acme",
        role: "Frontend Developer",
        at: clock.now(),
        applied: true,
        bounced: false,
        key: expect.stringMatching(/^manual-run:[0-9a-f-]{36}:company-role$/),
      },
      {
        reason: "company-role",
        source: "earlier",
        company: "Acme Ltd",
        role: "Front End Developer",
        at: new Date("2026-05-04T00:00:00Z"),
        applied: true,
        bounced: false,
        key: expect.stringMatching(/^earlier:[0-9a-f-]{36}:company-role$/),
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

  it("holds an application again once an earlier kit it was cleared against is sent", async () => {
    const first = await newShare();
    await changeStatus(deps(), first, "kit_ready", null);
    clock.advance(DAY);
    // Another role at the same address: it matches the first, which was never sent.
    const second = await newShare({ company: "Globex", role: "Designer", requirements: ["Figma"] });
    const before = (await duplicateGate(db, second))!;
    expect(before.matches.map((match) => [match.reason, match.applied])).toEqual([
      ["address", false],
    ]);
    await applyAgain(
      deps(),
      second,
      before.matches.map((match) => match.key),
    );
    expect((await duplicateGate(db, second))!.cleared).toBe(true);

    await changeStatus(deps(), first, "sent", null);

    expect((await duplicateGate(db, second))!.cleared).toBe(false);
  });

  it("is not held back by a later kit that was never sent, but is once that kit is sent", async () => {
    const first = await newShare();
    await changeStatus(deps(), first, "kit_ready", null);
    clock.advance(DAY);
    const second = await newShare();
    await changeStatus(deps(), second, "kit_ready", null);

    expect(await duplicatesOf(db, first)).toEqual([]);
    expect((await duplicatesOf(db, second))!.map((match) => match.reason)).toEqual([
      "drafted",
      "address",
      "post",
    ]);

    clock.advance(DAY);
    await changeStatus(deps(), second, "sent", null);
    expect((await duplicatesOf(db, first))!.map((match) => match.reason)).toEqual([
      "company-role",
      "address",
      "post",
    ]);
  });

  it("needs three requirement trigrams in common before two posts can match", async () => {
    await earlier("sent", {
      company: "Globex",
      role: "Designer",
      address: null,
      requirements: ["Good written English"],
    });
    const id = await newShare({ address: null, requirements: ["Good written English", "Figma"] });

    expect(await duplicatesOf(db, id)).toEqual([]);
  });

  it("matches a terse post repeated under another title on post", async () => {
    const terse = [
      "Proficient in React.js",
      "Node.js / Express",
      "MongoDB",
      "REST APIs",
      "Git",
      "1-2 years experience",
      "Good communication skills",
      "Immediate joiners preferred",
    ];
    await earlier("sent", {
      company: "Globex",
      role: "MERN Developer",
      address: null,
      requirements: terse,
    });
    const id = await newShare({
      company: "Initech",
      role: "Full Stack Engineer",
      address: null,
      requirements: terse,
    });

    expect((await duplicatesOf(db, id))!.map((match) => match.reason)).toEqual(["post"]);
  });

  it("holds back exactly one of two kits for one post opened at the same moment", async () => {
    const one = await newShare();
    const two = await newShare();
    await changeStatus(deps(), one, "kit_ready", null);
    await changeStatus(deps(), two, "kit_ready", null);

    const gates = [await duplicateGate(db, one), await duplicateGate(db, two)];

    expect(gates.map((gate) => gate!.cleared).sort()).toEqual([false, true]);
  });

  it("compares company and role by today's rules, whatever key an older row stored", async () => {
    const old = await earlier("sent", { address: null, requirements: [] });
    await db.query("update {{schema}}.applications set company_role_hash = 'stale' where id = $1", [
      old,
    ]);
    await db.query(
      `insert into {{schema}}.earlier_applications
         (company, role, company_role_hash, applied_on, route, address, imported_at)
       values ('Acme Ltd', 'Front End Developer', 'stale too', '2026-05-04', 'form', null, $1)`,
      [clock.now()],
    );
    const id = await newShare({ address: null, requirements: [] });

    expect((await duplicatesOf(db, id))!.map((match) => [match.source, match.reason])).toEqual([
      ["application", "company-role"],
      ["earlier", "company-role"],
    ]);
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

/** The matches the banner shows for an application, as the keys an "apply again" tap sends back. */
async function shown(id: string): Promise<string[]> {
  return (await duplicateGate(db, id))!.matches.map((match) => match.key);
}

describe("duplicateGate and applyAgain", () => {
  it("holds every match until the owner taps apply again, and lets a clean application through", async () => {
    await earlier("sent");
    const repeat = await newShare();
    const fresh = await newShare({
      company: "Globex",
      role: "Designer",
      address: null,
      requirements: [],
    });

    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: false });
    expect(await duplicateGate(db, fresh)).toEqual({ matches: [], covers: [], cleared: true });

    const keys = await shown(repeat);
    expect(await applyAgain(deps(), repeat, keys)).toBe(true);
    expect(await applyAgain(deps(), repeat, keys)).toBe(false);
    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: true });
  });

  it("covers only the matches the banner showed, so one that appeared before the tap still holds", async () => {
    await earlier("sent");
    const repeat = await newShare();
    const keys = await shown(repeat);
    await earlier("sent", { role: "Backend Engineer", requirements: ["Go and Postgres"] });

    await applyAgain(deps(), repeat, keys);

    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: false });
    await applyAgain(deps(), repeat, await shown(repeat));
    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: true });
  });

  it("holds again for a match that appears after the tap, until the owner taps again", async () => {
    await earlier("sent");
    const repeat = await newShare();
    await applyAgain(deps(), repeat, await shown(repeat));
    clock.advance(DAY);

    await earlier("sent", { role: "Backend Engineer", requirements: ["Go and Postgres"] });
    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: false });

    expect(await applyAgain(deps(), repeat, await shown(repeat))).toBe(true);
    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: true });
  });

  it("holds again when the application's own later change finds a new match", async () => {
    await earlier("sent", {
      role: "Backend Engineer",
      address: "hr@acme.example",
      requirements: [],
    });
    const repeat = await newShare({ address: null, requirements: [] });
    await applyAgain(deps(), repeat, await shown(repeat));

    expect(await setAddress(deps(), repeat, "HR@acme.example")).toBe(true);

    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: false });
  });

  it("holds again for an earlier application imported after the tap, however long ago it was made", async () => {
    await earlier("sent");
    const repeat = await newShare({ address: "jobs@acme.example" });
    await applyAgain(deps(), repeat, await shown(repeat));
    clock.advance(DAY);

    await db.query(
      `insert into {{schema}}.earlier_applications
         (company, role, company_role_hash, applied_on, route, address, imported_at)
       values ('Globex', 'Designer', $1, '2026-01-04', 'email', 'jobs@acme.example', $2)`,
      [companyRoleHash("Globex", "Designer"), clock.now()],
    );

    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: false });
  });

  it("holds again when a drafted match is sent, since that is a new match", async () => {
    const drafted = await earlier("kit_ready", { address: null, requirements: [] });
    const repeat = await newShare({ address: null, requirements: [] });
    await applyAgain(deps(), repeat, await shown(repeat));

    await changeStatus(deps(), drafted, "sent", null);

    expect(await duplicateGate(db, repeat)).toMatchObject({ cleared: false });
  });

  it("reports an application that does not exist, or an ID that is not one", async () => {
    expect(await duplicateGate(db, "22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(await applyAgain(deps(), "22222222-2222-4222-8222-222222222222", ["x"])).toBe(false);
    expect(await duplicateGate(db, "not-an-id")).toBeNull();
    expect(await duplicatesOf(db, "not-an-id")).toBeNull();
    expect(await applyAgain(deps(), "not-an-id", ["x"])).toBe(false);
  });
});
