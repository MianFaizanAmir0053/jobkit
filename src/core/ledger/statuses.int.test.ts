import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { issueSession } from "@/core/platform/sessions";
import { createTestDb } from "@/server/db/testDb";

import { companyRoleHash, postFingerprint } from "./normalise";
import {
  type ApplicationStatus,
  changeStatus,
  type NewApplication,
  openApplication,
  TRANSITIONS,
} from "./statuses";

const JOB = "11111111-1111-4111-8111-111111111111";
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
async function inStatus(status: ApplicationStatus): Promise<string> {
  const id = await openApplication(deps(), application(), null);
  await db.query("update {{schema}}.applications set status = $2 where id = $1", [id, status]);
  return id;
}

describe("openApplication", () => {
  it("records the chosen role as open, with its keys, its fingerprint and an audit row", async () => {
    const id = await openApplication(deps(), application(), null);

    const { rows } = await db.query(
      `select status, company_key, role_key, company_role_hash, post_fingerprint, opened_at,
              status_changed_at, arm, job_kind
         from {{schema}}.applications where id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      status: "open",
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
});

describe("changeStatus", () => {
  const allowed = STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as const));
  const refused = STATUSES.flatMap((from) =>
    STATUSES.filter((to) => to !== from && !TRANSITIONS[from].includes(to)).map((to) => [from, to] as const),
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

  it.each(allowed)("accepts %s to %s, stamps its time and writes an audit row", async (from, to) => {
    const id = await inStatus(from);
    clock.advance(60_000);

    expect(await changeStatus(deps(), id, to, null)).toEqual({ ok: true, changed: true, status: to });

    const { rows } = await db.query<Record<string, unknown>>(
      `select status, status_changed_at, ${to}_at as stamped from {{schema}}.applications where id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ status: to, status_changed_at: clock.now(), stamped: clock.now() });
    expect((await audit(id)).at(-1)).toMatchObject({ from_status: from, to_status: to });
  });

  it.each(refused)("refuses %s to %s and writes nothing", async (from, to) => {
    const id = await inStatus(from);

    expect(await changeStatus(deps(), id, to, null)).toEqual({ ok: false, reason: "refused", status: from });
    expect(await audit(id)).toHaveLength(1);
  });

  it("moves an open application to skipped when the owner skips before a kit exists", async () => {
    const id = await openApplication(deps(), application(), null);

    expect(await changeStatus(deps(), id, "skipped", null)).toMatchObject({ ok: true, status: "skipped" });
  });

  it("records a double tap once", async () => {
    const id = await inStatus("kit_ready");

    expect(await changeStatus(deps(), id, "sent", null)).toMatchObject({ changed: true });
    expect(await changeStatus(deps(), id, "sent", null)).toEqual({ ok: true, changed: false, status: "sent" });
    expect((await audit(id)).filter((row) => row.to_status === "sent")).toHaveLength(1);
  });

  it("records which session made the change", async () => {
    const random = cryptoRandom;
    const { session } = await issueSession({ db, clock, random }, { kind: "google", label: "laptop" });
    const id = await openApplication(deps(), application(), session.id);

    await changeStatus(deps(), id, "skipped", session.id);

    expect((await audit(id)).map((row) => row.session_id)).toEqual([session.id, session.id]);
  });

  it("reports an application that does not exist", async () => {
    expect(await changeStatus(deps(), "22222222-2222-4222-8222-222222222222", "sent", null)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});
