/**
 * Pairing races against the real Supabase database (platform spec B1,
 * "Atomic claims"; B3). PGlite has one connection, so it cannot show a race
 * or a deadlock; Postgres can. Runs only with `npm run test:live`, by hand,
 * with .env.ops.local filled in.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { systemClock } from "@/adapters/clock";
import { createPgDb, type PgDb } from "@/adapters/pg";
import { cryptoRandom } from "@/adapters/random";
import { applyMigrations, loadMigrations } from "@/server/db/migrate";

import { loadOpsEnv } from "../../../scripts/ops";
import { approvePairing, createPairingToken, redeemPairingToken, rejectPairing } from "./pairing";
import { endSession, findSession, issueSession } from "./sessions";

const env = loadOpsEnv();
const SCHEMA = `jobkit_live_${Date.now().toString(36)}`;
let admin: PgDb;
let app: PgDb;
const deps = () => ({ db: app, clock: systemClock, random: cryptoRandom });

beforeAll(async () => {
  admin = createPgDb({ connectionString: env.DATABASE_BOOTSTRAP_URL!, schema: SCHEMA, max: 2 });
  app = createPgDb({ connectionString: env.DATABASE_URL!, schema: SCHEMA, max: 6 });
  await admin.exec("create schema {{schema}} authorization jobkit_app");
  await applyMigrations(app, loadMigrations(join(process.cwd(), "db", "migrations")));
}, 120_000);

afterAll(async () => {
  await admin.exec("drop schema if exists {{schema}} cascade");
  await Promise.all([admin.close(), app.close()]);
}, 60_000);

async function waitingPhone() {
  const laptop = await issueSession(deps(), { kind: "google", label: "laptop" });
  const made = await createPairingToken(deps(), laptop.session);
  if (!made.ok) throw new Error("expected a token");
  const redeemed = await redeemPairingToken(deps(), made.token, "phone");
  if (!redeemed.ok) throw new Error("expected a redemption");
  return { laptop, phone: redeemed.issued, code: redeemed.code };
}

describe("pairing races on real Postgres", () => {
  it("approve and reject of one phone at the same moment both finish; exactly one wins", async () => {
    for (let round = 0; round < 5; round++) {
      const { laptop, phone, code } = await waitingPhone();

      const [approved, rejected] = await Promise.all([
        approvePairing(deps(), laptop.session, phone.session.id, code),
        rejectPairing(deps(), laptop.session, phone.session.id),
      ]);

      expect(approved.ok !== rejected).toBe(true);
      expect((await findSession(deps(), phone.token)).ok).toBe(approved.ok);
    }
  }, 120_000);

  it("a phone redeeming while the laptop signs out finishes either way, with no deadlock", async () => {
    for (let round = 0; round < 5; round++) {
      const laptop = await issueSession(deps(), { kind: "google", label: "laptop" });
      const made = await createPairingToken(deps(), laptop.session);
      if (!made.ok) throw new Error("expected a token");

      const [redeemed] = await Promise.all([
        redeemPairingToken(deps(), made.token, "phone"),
        endSession(app, laptop.token),
      ]);

      expect(typeof redeemed.ok).toBe("boolean");
    }
  }, 120_000);

  it("two codes made at the same moment for one session leave only one usable", async () => {
    const laptop = await issueSession(deps(), { kind: "google", label: "laptop" });

    await Promise.all([
      createPairingToken(deps(), laptop.session),
      createPairingToken(deps(), laptop.session),
    ]);

    const { rows } = await app.query<{ n: number }>(
      `select count(*)::int as n from {{schema}}.pairing_tokens
        where created_by = $1 and used_at is null`,
      [laptop.session.id],
    );
    expect(rows[0]!.n).toBe(1);
  }, 120_000);
});
