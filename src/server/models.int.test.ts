import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { answer, fakeLlm } from "@/adapters/fakeLlm";
import type { PgliteDb } from "@/adapters/pglite";
import { callModel } from "@/core/platform/models";
import { createTestDb } from "@/server/db/testDb";

import { modelCallDeps } from "./models";

let db: PgliteDb;
let clock: FakeClock;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.model_calls");
  clock = fakeClock(new Date("2026-10-15T12:00:00Z"));
});

const input = {
  stage: "extract",
  jobId: null,
  model: "claude-opus-5-5",
  system: "Read the post.",
  content: [{ type: "text" as const, text: "A job post." }],
  schema: z.object({ title: z.string() }),
  effort: "high" as const,
  maxTokens: 1000,
};

async function spent(usd: number): Promise<void> {
  await db.query(
    `insert into {{schema}}.model_calls (stage, attempt, provider, requested_model, started_at, outcome, cost_usd)
     values ('extract', 1, 'anthropic', 'claude-opus-5-5', $1, 'ok', $2)`,
    [new Date("2026-10-10T09:00:00Z"), usd],
  );
}

describe("modelCallDeps", () => {
  it("lets a model call run while the month's spend is under the cap", async () => {
    await spent(25.99);
    const llm = fakeLlm([answer({ title: "Engineer" })]);

    const result = await callModel(modelCallDeps({ db, clock, llmFor: () => llm }), input);

    expect(result).toMatchObject({ ok: true, output: { title: "Engineer" } });
  });

  it("refuses every model call once the month's spend reaches $26, sending nothing", async () => {
    await spent(26);
    const llm = fakeLlm([answer({ title: "Engineer" })]);

    const result = await callModel(modelCallDeps({ db, clock, llmFor: () => llm }), input);

    expect(result).toMatchObject({ ok: false, reason: "refused-cap" });
    expect(llm.calls).toHaveLength(0);
  });
});
