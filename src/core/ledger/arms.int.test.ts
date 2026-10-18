import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PgliteDb } from "@/adapters/pglite";
import type { Random } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import { armAt, drawArm } from "./arms";

let db: PgliteDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.arm_sequence");
});

/** Randomness that always gives the same bytes, so the seed is known. */
const fixed = (byte: number): Random => ({ bytes: (length) => new Uint8Array(length).fill(byte) });

describe("drawArm", () => {
  it("assigns about one job in three to the manual arm, from its seeded sequence", async () => {
    const arms: string[] = [];
    for (let i = 0; i < 300; i++) arms.push((await drawArm({ db, random: fixed(7) })).arm);

    const manual = arms.filter((arm) => arm === "manual").length;
    expect(manual).toBeGreaterThan(80);
    expect(manual).toBeLessThan(120);
  });

  it("follows the sequence the stored seed sets, whatever randomness later calls bring", async () => {
    const first = await drawArm({ db, random: fixed(7) });
    const second = await drawArm({ db, random: fixed(9) });

    const seed = fixed(7).bytes(32);
    expect([first, second]).toEqual([
      { arm: armAt(seed, 0), index: 0 },
      { arm: armAt(seed, 1), index: 1 },
    ]);
  });

  it("gives draws made at the same moment different places in the sequence", async () => {
    const draws = await Promise.all(
      Array.from({ length: 10 }, () => drawArm({ db, random: fixed(7) })),
    );

    expect(new Set(draws.map((draw) => draw.index))).toEqual(
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
  });
});

describe("armAt", () => {
  it("gives the same arm for the same seed and place, and both arms over a run", () => {
    const seed = fixed(3).bytes(32);
    const run = Array.from({ length: 30 }, (_, i) => armAt(seed, i));

    expect(Array.from({ length: 30 }, (_, i) => armAt(seed, i))).toEqual(run);
    expect(new Set(run)).toEqual(new Set(["tool", "manual"]));
  });
});
