import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { issueSession } from "@/core/platform/sessions";
import { createTestDb, insertTestJobs } from "@/server/db/testDb";

import { companyRoleHash, postFingerprint } from "./normalise";
import {
  type ApplicationStatus,
  changeStatus,
  type NewApplication,
  openApplication,
  TRANSITIONS,
  setAddress,
  setRoute,
  undoStatus,
} from "./statuses";

const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB = "33333333-3333-4333-8333-333333333333";
const THIRD_JOB = "44444444-4444-4444-8444-444444444444";
const STATUSES: readonly ApplicationStatus[] = [
  "open",
  "kit_ready",
  "sent",
  "submitted",
  "skipped",
  "bounced",
];

let db: PgliteDb;
let clock: FakeClock;
const deps = () => ({ db, clock });

beforeAll(async () => {
  db = await createTestDb();
  await insertTestJobs(db, [JOB, OTHER_JOB, THIRD_JOB]);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.applications; delete from {{schema}}.sessions");
  clock = fakeClock();
});

const application = (overrides: Partial<NewApplication> = {}): NewApplication => ({
  jobId: JOB,
  roleId: "P1",
  company: "Acme (Pvt) Ltd",
  role: "Front-End Developer",
  address: "jobs@acme.example",
  route: "email",
  requirements: ["3+ years of React and TypeScript", "Experience with REST APIs"],
  arm: null,
  jobKind: "real",
  ...overrides,
});

interface AuditRow {
  from_status: string | null;
  to_status: string;
  changed_at: Date;
  session_id: string | null;
}

async function audit(id: string): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow & Record<string, unknown>>(
    `select from_status, to_status, changed_at, session_id from {{schema}}.status_changes
      where application_id = $1 order by changed_at, to_status`,
    [id],
  );
  return rows;
}

/** Puts an application straight into a status, as a fixture. */
async function inStatus(
  status: ApplicationStatus,
  overrides: Partial<NewApplication> = {},
): Promise<string> {
  const id = await openApplication(deps(), application(overrides), null);
  await db.query("update {{schema}}.applications set status = $2 where id = $1", [id, status]);
  return id;
}

/** Walks an application through the real statuses, as the owner's taps would. */
async function walked(
  steps: readonly ApplicationStatus[],
  overrides: Partial<NewApplication> = {},
): Promise<string> {
  const id = await openApplication(deps(), application(overrides), null);
  for (const step of steps) {
    clock.advance(60_000);
    expect(await changeStatus(deps(), id, step, null)).toMatchObject({ ok: true, changed: true });
  }
  return id;
}

async function stamps(id: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select status, kit_ready_at, sent_at, submitted_at, skipped_at, bounced_at
       from {{schema}}.applications where id = $1`,
    [id],
  );
  return rows[0]!;
}

describe("openApplication", () => {
  it("records the chosen role as open, with its keys, its fingerprint and an audit row", async () => {
    const id = await openApplication(deps(), application(), null);

    const { rows } = await db.query(
      `select status, role_id, company_key, role_key, company_role_hash, post_fingerprint, opened_at,
              status_changed_at, arm, job_kind
         from {{schema}}.applications where id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      status: "open",
      role_id: "P1",
      company_key: "acme",
      role_key: "frontenddeveloper",
      company_role_hash: companyRoleHash("Acme (Pvt) Ltd", "Front-End Developer"),
      post_fingerprint: [...postFingerprint(application().requirements)],
      opened_at: clock.now(),
      status_changed_at: clock.now(),
      arm: null,
      job_kind: "real",
    });
    expect(await audit(id)).toEqual([
      { from_status: null, to_status: "open", changed_at: clock.now(), session_id: null },
    ]);
  });

  it("gives a second tap on the same role the same application, with one audit row", async () => {
    const first = await openApplication(deps(), application(), null);
    clock.advance(1_000);
    const second = await openApplication(deps(), application(), null);

    expect(second).toBe(first);
    expect(await audit(first)).toHaveLength(1);
  });

  it("gives each role of one post its own application, though they are written alike", async () => {
    const lahore = await openApplication(
      deps(),
      application({ roleId: "P1", role: "Flutter Developer (Lahore)" }),
      null,
    );
    const karachi = await openApplication(
      deps(),
      application({
        roleId: "P2",
        role: "Flutter Developer (Karachi)",
        address: "khi@acme.example",
      }),
      null,
    );

    expect(karachi).not.toBe(lahore);
  });

  it("takes what a new extraction read when the same role is picked again, while no kit is out", async () => {
    const id = await openApplication(deps(), application(), null);
    clock.advance(1_000);

    const again = await openApplication(
      deps(),
      application({
        role: "Front End Developer",
        address: "careers@acme.example",
        requirements: ["Vue"],
      }),
      null,
    );

    expect(again).toBe(id);
    const { rows } = await db.query(
      "select role, address, post_fingerprint from {{schema}}.applications where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({
      role: "Front End Developer",
      address: "careers@acme.example",
      post_fingerprint: ["vue"],
    });
    expect(await audit(id)).toHaveLength(1);
  });

  it("keeps an application as it was sent when its role is picked again", async () => {
    const id = await walked(["kit_ready", "sent"]);

    expect(
      await openApplication(deps(), application({ address: "other@acme.example" }), null),
    ).toBe(id);
    const { rows } = await db.query("select address from {{schema}}.applications where id = $1", [
      id,
    ]);
    expect(rows[0]).toEqual({ address: "jobs@acme.example" });
  });
});

describe("setRoute and setAddress", () => {
  it("records the route the owner picked, until the application is sent, submitted or skipped", async () => {
    const id = await inStatus("kit_ready", { route: null });

    expect(await setRoute(deps(), id, "form")).toBe(true);
    expect(await changeStatus(deps(), id, "submitted", null)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await setRoute(deps(), id, "email")).toBe(false);
  });

  it("records the address the owner corrected on the review page, until the application is sent", async () => {
    const id = await inStatus("kit_ready");

    expect(await setAddress(deps(), id, "hr@acme.example")).toBe(true);
    await changeStatus(deps(), id, "sent", null);
    expect(await setAddress(deps(), id, "other@acme.example")).toBe(false);
    const { rows } = await db.query("select address from {{schema}}.applications where id = $1", [
      id,
    ]);
    expect(rows[0]).toEqual({ address: "hr@acme.example" });
  });

  it("answers no for an ID that is not one", async () => {
    expect(await setRoute(deps(), "not-an-id", "form")).toBe(false);
    expect(await setAddress(deps(), "not-an-id", "hr@acme.example")).toBe(false);
  });
});

describe("changeStatus", () => {
  const allowed = STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as const));
  const refused = STATUSES.flatMap((from) =>
    STATUSES.filter((to) => to !== from && !TRANSITIONS[from].includes(to)).map(
      (to) => [from, to] as const,
    ),
  );

  it("allows exactly the transitions in the spec's table", () => {
    expect(allowed).toEqual([
      ["open", "kit_ready"],
      ["open", "skipped"],
      ["kit_ready", "sent"],
      ["kit_ready", "submitted"],
      ["kit_ready", "skipped"],
      ["sent", "bounced"],
    ]);
  });

  it.each(allowed)(
    "accepts %s to %s, stamps its time and writes an audit row",
    async (from, to) => {
      const id = await inStatus(from, { route: to === "submitted" ? "form" : "email" });
      clock.advance(60_000);

      expect(await changeStatus(deps(), id, to, null)).toEqual({
        ok: true,
        changed: true,
        status: to,
      });

      const { rows } = await db.query<Record<string, unknown>>(
        `select status, status_changed_at, ${to}_at as stamped from {{schema}}.applications where id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ status: to, status_changed_at: clock.now(), stamped: clock.now() });
      expect((await audit(id)).at(-1)).toMatchObject({ from_status: from, to_status: to });
    },
  );

  it.each(refused)("refuses %s to %s and writes nothing", async (from, to) => {
    const id = await inStatus(from);

    expect(await changeStatus(deps(), id, to, null)).toEqual({
      ok: false,
      reason: "refused",
      status: from,
    });
    expect(await audit(id)).toHaveLength(1);
  });

  it("moves an open application to skipped when the owner skips before a kit exists", async () => {
    const id = await openApplication(deps(), application(), null);

    expect(await changeStatus(deps(), id, "skipped", null)).toMatchObject({
      ok: true,
      status: "skipped",
    });
  });

  it("records a double tap once", async () => {
    const id = await inStatus("kit_ready");

    expect(await changeStatus(deps(), id, "sent", null)).toMatchObject({ changed: true });
    expect(await changeStatus(deps(), id, "sent", null)).toEqual({
      ok: true,
      changed: false,
      status: "sent",
    });
    expect((await audit(id)).filter((row) => row.to_status === "sent")).toHaveLength(1);
  });

  it("marks an email kit sent, and a form or message kit submitted, never the other way round", async () => {
    const email = await inStatus("kit_ready", { route: "email" });
    const form = await inStatus("kit_ready", { jobId: OTHER_JOB, route: "form" });
    const message = await inStatus("kit_ready", { jobId: THIRD_JOB, route: "message" });

    expect(await changeStatus(deps(), email, "submitted", null)).toEqual({
      ok: false,
      reason: "wrong-route",
      status: "kit_ready",
      route: "email",
    });
    expect(await changeStatus(deps(), form, "sent", null)).toEqual({
      ok: false,
      reason: "wrong-route",
      status: "kit_ready",
      route: "form",
    });
    expect(await changeStatus(deps(), email, "sent", null)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await changeStatus(deps(), form, "submitted", null)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await changeStatus(deps(), message, "submitted", null)).toMatchObject({
      ok: true,
      changed: true,
    });
  });

  it("refuses to mark a kit sent or submitted before its route is known", async () => {
    const id = await inStatus("kit_ready", { route: null });

    expect(await changeStatus(deps(), id, "sent", null)).toEqual({
      ok: false,
      reason: "wrong-route",
      status: "kit_ready",
      route: null,
    });
    expect(await changeStatus(deps(), id, "submitted", null)).toEqual({
      ok: false,
      reason: "wrong-route",
      status: "kit_ready",
      route: null,
    });
    expect(await changeStatus(deps(), id, "skipped", null)).toMatchObject({
      ok: true,
      changed: true,
    });
  });

  it("records which session made the change", async () => {
    const random = cryptoRandom;
    const { session } = await issueSession(
      { db, clock, random },
      { kind: "google", label: "laptop" },
    );
    const id = await openApplication(deps(), application(), session.id);

    await changeStatus(deps(), id, "skipped", session.id);

    expect((await audit(id)).map((row) => row.session_id)).toEqual([session.id, session.id]);
  });

  it("reports an application that does not exist, or an ID that is not one", async () => {
    expect(
      await changeStatus(deps(), "22222222-2222-4222-8222-222222222222", "sent", null),
    ).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await changeStatus(deps(), "not-an-id", "sent", null)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(
      await undoStatus(deps(), "not-an-id", { status: "sent", at: clock.now() }, null),
    ).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("undoStatus", () => {
  /** The application's last change, as the job menu shows it. */
  async function lastChange(id: string): Promise<{ status: ApplicationStatus; at: Date }> {
    const { rows } = await db.query<{ status: ApplicationStatus; status_changed_at: Date }>(
      "select status, status_changed_at from {{schema}}.applications where id = $1",
      [id],
    );
    return { status: rows[0]!.status, at: rows[0]!.status_changed_at };
  }

  it("takes back a mistaken Mark sent: back to kit_ready, its time cleared, with an audit row", async () => {
    const id = await walked(["kit_ready", "sent"]);
    const last = await lastChange(id);
    clock.advance(60_000);

    expect(await undoStatus(deps(), id, last, null)).toEqual({
      ok: true,
      changed: true,
      status: "kit_ready",
    });
    expect(await stamps(id)).toMatchObject({
      status: "kit_ready",
      kit_ready_at: expect.any(Date),
      sent_at: null,
    });
    expect((await audit(id)).at(-1)).toMatchObject({
      from_status: "sent",
      to_status: "kit_ready",
      changed_at: clock.now(),
    });
  });

  it("takes back a skip after the kit, but not one before it, which closed the job", async () => {
    const early = await walked(["skipped"]);
    const late = await walked(["kit_ready", "skipped"], { jobId: OTHER_JOB });

    expect(await undoStatus(deps(), early, await lastChange(early), null)).toEqual({
      ok: false,
      reason: "refused",
      status: "skipped",
    });
    expect(await undoStatus(deps(), late, await lastChange(late), null)).toMatchObject({
      status: "kit_ready",
    });
    expect(await stamps(late)).toMatchObject({ skipped_at: null });
  });

  it("takes back Mark submitted and Mark bounced, one tap at a time", async () => {
    const submitted = await walked(["kit_ready", "submitted"], { route: "form" });
    const bounced = await walked(["kit_ready", "sent", "bounced"], { jobId: OTHER_JOB });

    expect(await undoStatus(deps(), submitted, await lastChange(submitted), null)).toMatchObject({
      status: "kit_ready",
    });
    expect(await undoStatus(deps(), bounced, await lastChange(bounced), null)).toMatchObject({
      status: "sent",
    });
    expect(await stamps(bounced)).toMatchObject({ sent_at: expect.any(Date), bounced_at: null });
    clock.advance(60_000);
    expect(await undoStatus(deps(), bounced, await lastChange(bounced), null)).toMatchObject({
      status: "kit_ready",
    });
  });

  it("records a double tap once", async () => {
    const id = await walked(["kit_ready", "sent"]);
    const last = await lastChange(id);

    expect(await undoStatus(deps(), id, last, null)).toMatchObject({ changed: true });
    expect(await undoStatus(deps(), id, last, null)).toEqual({
      ok: true,
      changed: false,
      status: "kit_ready",
    });
    expect((await audit(id)).filter((row) => row.from_status === "sent")).toHaveLength(1);
  });

  it("refuses a late tap for a change the owner has since made again", async () => {
    const id = await walked(["kit_ready", "sent"]);
    const first = await lastChange(id);
    await undoStatus(deps(), id, first, null);
    clock.advance(60_000);
    await changeStatus(deps(), id, "sent", null);

    expect(await undoStatus(deps(), id, first, null)).toEqual({
      ok: false,
      reason: "refused",
      status: "sent",
    });
    expect((await stamps(id)).status).toBe("sent");
  });

  it("refuses to take back a status no tap made", async () => {
    const id = await walked(["kit_ready"]);

    expect(await undoStatus(deps(), id, await lastChange(id), null)).toEqual({
      ok: false,
      reason: "refused",
      status: "kit_ready",
    });
    expect(
      await undoStatus(
        deps(),
        "22222222-2222-4222-8222-222222222222",
        { status: "sent", at: clock.now() },
        null,
      ),
    ).toEqual({ ok: false, reason: "not-found" });
  });
});
