import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { fakeClock } from "@/adapters/clock";
import {
  answer,
  failure,
  fakeLlm,
  refusal,
  silence,
  slowStream,
  usageOf,
  whenCalled,
} from "@/adapters/fakeLlm";
import type { PgliteDb } from "@/adapters/pglite";
import type { Llm } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import { caseless } from "./caseless";
import { abandonStartedCalls, callModel, type ModelCallGuard, type ModelCallInput } from "./models";

const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB = "22222222-2222-4222-8222-222222222222";

const Out = z.object({ title: z.string(), count: z.number() });

const input: ModelCallInput<z.infer<typeof Out>> = {
  stage: "extract",
  jobId: JOB,
  model: "claude-opus-5-5",
  system: "Read the post.",
  content: [{ type: "text", text: "A job post." }],
  schema: Out,
  effort: "high",
  maxTokens: 16_000,
};

const allowAll: ModelCallGuard = async () => ({ ok: true });

let db: PgliteDb;
const clock = fakeClock();

function deps(llm: Llm, opts: { guard?: ModelCallGuard; idleMs?: number; totalMs?: number } = {}) {
  return {
    db,
    clock,
    llmFor: () => llm,
    guard: opts.guard ?? allowAll,
    limits: {
      idleMs: opts.idleMs ?? 60,
      totalMs: opts.totalMs ?? 400,
      maxRetryWaitMs: 30,
      defaultRetryWaitMs: 5,
      countMs: 50,
    },
  };
}

interface CallRow {
  attempt: number;
  outcome: string;
  answered_model: string | null;
  request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number;
  cost_provisional: boolean;
  price_known: boolean;
  ended_at: Date | null;
  iterations: unknown;
  error: string | null;
}

async function rows(): Promise<CallRow[]> {
  const result = await db.query<CallRow & Record<string, unknown>>(
    `select attempt, outcome, answered_model, request_id, input_tokens, output_tokens,
            cost_usd::float8 as cost, cost_provisional, price_known, ended_at, iterations, error
       from {{schema}}.model_calls order by attempt`,
  );
  return result.rows;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("delete from {{schema}}.model_calls");
});

describe("callModel", () => {
  it("returns the parsed output; the row is inserted as started before sending and completed after", async () => {
    let whileSending: CallRow[] = [];
    const llm = fakeLlm(
      [
        whenCalled(
          async () => {
            whileSending = await rows();
          },
          answer({ title: "Engineer", count: 2 }, { requestId: "req_1" }),
        ),
      ],
      { inputTokens: 10_000 },
    );

    const result = await callModel(deps(llm), input);

    expect(result).toEqual({
      ok: true,
      output: { title: "Engineer", count: 2 },
      model: "claude-opus-5-5",
      costUsd: 0.014,
    });
    // The upper bound while in flight: 10,000 in at $4 plus 16,000 max out at $20 per million.
    expect(whileSending).toMatchObject([
      { attempt: 1, outcome: "started", cost: 0.36, cost_provisional: true, ended_at: null },
    ]);
    expect(await rows()).toMatchObject([
      {
        attempt: 1,
        outcome: "ok",
        answered_model: "claude-opus-5-5",
        request_id: "req_1",
        input_tokens: 1000,
        output_tokens: 500,
        cost: 0.014,
        cost_provisional: false,
        price_known: true,
      },
    ]);
  });

  it("prices each model run, a refusal fallback included, at that model's rates", async () => {
    const llm = fakeLlm([
      answer(
        { title: "Engineer", count: 2 },
        {
          model: "claude-opus-4-8",
          usage: [usageOf("claude-opus-5-5", 1000, 0), usageOf("claude-opus-4-8", 1000, 500)],
        },
      ),
    ]);

    const result = await callModel(deps(llm), input);

    // $0.004 for the declined run, then 1,000 in at $5 and 500 out at $25 per million.
    expect(result).toMatchObject({ ok: true, model: "claude-opus-4-8", costUsd: 0.0215 });
    const [row] = await rows();
    expect(row).toMatchObject({
      answered_model: "claude-opus-4-8",
      input_tokens: 2000,
      cost: 0.0215,
    });
    expect(row!.iterations).toEqual([
      expect.objectContaining({ model: "claude-opus-5-5", costUsd: 0.004 }),
      expect.objectContaining({ model: "claude-opus-4-8", costUsd: 0.0175 }),
    ]);
  });

  it("retries once after a rate limit, waiting the retry-after; a retried call has two rows", async () => {
    const llm = fakeLlm([failure("rate-limit", 10), answer({ title: "x", count: 1 })], {
      inputTokens: 10_000,
    });
    const started = Date.now();

    const result = await callModel(deps(llm), input);

    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(await rows()).toMatchObject([
      { attempt: 1, outcome: "rate-limited", cost: 0.36, cost_provisional: true },
      { attempt: 2, outcome: "ok", cost_provisional: false },
    ]);
  });

  it("caps the wait at the most a retry may wait, whatever retry-after asks", async () => {
    const llm = fakeLlm([failure("server", 60_000), answer({ title: "x", count: 1 })]);
    const started = Date.now();

    expect((await callModel(deps(llm), input)).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up after the retry fails too", async () => {
    const llm = fakeLlm([failure("connection"), failure("server")]);

    expect(await callModel(deps(llm), input)).toEqual({
      ok: false,
      reason: "unavailable",
      message: "The model service is unavailable. Try again shortly.",
    });
    expect((await rows()).map((r) => r.outcome)).toEqual(["connection-error", "server-error"]);
  });

  it("never retries a refusal, and records what the declined run cost", async () => {
    const llm = fakeLlm([refusal()]);

    expect(await callModel(deps(llm), input)).toEqual({
      ok: false,
      reason: "refused",
      message: "The model declined this post.",
    });
    expect(llm.calls).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { outcome: "refused", cost: 0.004, cost_provisional: false, error: null },
    ]);
  });

  it("keeps the provisional cost of an answer that came without usage", async () => {
    const llm = fakeLlm(
      [answer({ title: "x", count: 1 }, { usage: [], model: "claude-opus-5-5-x" })],
      {
        inputTokens: 10_000,
      },
    );

    expect(await callModel(deps(llm), input)).toMatchObject({ ok: true, costUsd: 0.36 });
    expect(await rows()).toMatchObject([
      { outcome: "ok", answered_model: "claude-opus-5-5-x", cost: 0.36, cost_provisional: true },
    ]);
  });

  it("keeps the provisional cost of a refusal that came without usage", async () => {
    await callModel(deps(fakeLlm([refusal({ usage: [] })], { inputTokens: 10_000 })), input);

    expect(await rows()).toMatchObject([
      { outcome: "refused", cost: 0.36, cost_provisional: true },
    ]);
  });

  it("records the policy category a refusal names", async () => {
    await callModel(deps(fakeLlm([refusal({ category: "cyber" })])), input);

    expect(await rows()).toMatchObject([{ outcome: "refused", error: "refusal: cyber" }]);
  });

  it("records what else the provider said about a refusal", async () => {
    await callModel(
      deps(fakeLlm([refusal({ category: "cyber", detail: "the fallback model was busy" })])),
      input,
    );
    await db.exec("update {{schema}}.model_calls set attempt = 2");
    await callModel(deps(fakeLlm([refusal({ detail: "no category" })])), input);

    expect((await rows()).map((row) => row.error)).toEqual([
      "no category",
      "refusal: cyber; the fallback model was busy",
    ]);
  });

  it("never retries any other client error", async () => {
    const llm = fakeLlm([failure("client")]);

    expect(await callModel(deps(llm), input)).toMatchObject({ ok: false, reason: "rejected" });
    expect(await rows()).toMatchObject([{ outcome: "client-error", cost_provisional: true }]);
  });

  it("stores a provider's error message without the NUL characters Postgres text cannot hold", async () => {
    const llm = fakeLlm([
      () => ({
        kind: "failure",
        failure: "client",
        message: `bad${String.fromCharCode(0)} request`,
        requestId: null,
        retryAfterMs: null,
      }),
    ]);

    expect(await callModel(deps(llm), input)).toMatchObject({ ok: false, reason: "rejected" });
    expect(await rows()).toMatchObject([{ outcome: "client-error", error: "bad request" }]);
  });

  it("abandons a stream that stays silent for the idle limit, without retrying", async () => {
    const llm = fakeLlm([silence()], { inputTokens: 10_000 });

    expect(await callModel(deps(llm), input)).toMatchObject({ ok: false, reason: "timeout" });
    expect(llm.calls).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { outcome: "timeout", cost: 0.36, cost_provisional: true },
    ]);
  });

  it("takes an abort the adapter reports first as this wrapper's own timeout", async () => {
    const llm = fakeLlm([failure("aborted"), answer({ title: "x", count: 1 })]);

    expect(await callModel(deps(llm), input)).toMatchObject({ ok: false, reason: "timeout" });
    expect(llm.calls).toHaveLength(1);
    expect(await rows()).toMatchObject([{ outcome: "timeout", cost_provisional: true }]);
  });

  it("lets a slow but live stream finish, and stops one that runs past the total limit", async () => {
    const alive = fakeLlm([slowStream(5, 20, answer({ title: "x", count: 1 }))]);
    const endless = fakeLlm([slowStream(50, 20, answer({ title: "x", count: 1 }))]);

    expect((await callModel(deps(alive), input)).ok).toBe(true);
    expect(await callModel(deps(endless), input)).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("keeps a retry inside the call's overall budget", async () => {
    // The first attempt fails at about 300 ms of a 600 ms limit. With the overall
    // budget (600 + 30 ms) the silent retry is cut off near 630 ms; given a fresh
    // 600 ms of its own, it would run past 900 ms.
    const llm = fakeLlm([slowStream(10, 30, failure("server")), silence()]);
    const started = Date.now();

    expect(await callModel(deps(llm, { idleMs: 5_000, totalMs: 600 }), input)).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(780);
  });

  it("sends nothing when the guard refuses, and records the refusal", async () => {
    const llm = fakeLlm([answer({ title: "x", count: 1 })], { inputTokens: 10_000 });
    const asked: number[] = [];
    const guard: ModelCallGuard = async (call) => {
      asked.push(call.provisionalCostUsd);
      return { ok: false, message: "This month's model budget is spent." };
    };

    expect(await callModel(deps(llm, { guard }), input)).toEqual({
      ok: false,
      reason: "refused-cap",
      message: "This month's model budget is spent.",
    });
    expect(llm.calls).toHaveLength(0);
    expect(asked).toEqual([0.36]);
    expect(await rows()).toMatchObject([
      { outcome: "refused-cap", cost: 0, cost_provisional: false },
    ]);
  });

  it("fails without retrying when the answer is not JSON of the expected shape", async () => {
    for (const bad of [{ title: 3, count: 1 }, "not json"]) {
      await db.exec("delete from {{schema}}.model_calls");
      const llm = fakeLlm([answer(bad)]);

      expect(await callModel(deps(llm), input)).toMatchObject({
        ok: false,
        reason: "invalid-output",
      });
      expect(await rows()).toMatchObject([{ outcome: "invalid-output", cost: 0.014 }]);
    }
  });

  it("takes an enum value in another case when the stage's schema marks the field caseless", async () => {
    const Kind = z.object({ kind: caseless(["full_time", "part_time"]) });
    const llm = fakeLlm([answer({ kind: "Full_time" })]);

    expect(await callModel(deps(llm), { ...input, schema: Kind })).toMatchObject({
      ok: true,
      output: { kind: "full_time" },
    });
    expect(await rows()).toMatchObject([{ outcome: "ok" }]);
  });

  it("closes the attempt's row with its cost, then lets a schema that throws surface as the bug it is", async () => {
    // A refinement with a bug; its message holds a NUL, which Postgres text cannot store.
    const Broken = z.object({ title: z.string() }).refine(() => {
      throw new Error(`broken${String.fromCharCode(0)} refine`);
    });
    const llm = fakeLlm([answer({ title: "Engineer" })]);

    await expect(callModel(deps(llm), { ...input, schema: Broken })).rejects.toThrow("refine");

    const [row] = await rows();
    expect(row).toMatchObject({
      outcome: "invalid-output",
      cost: 0.014,
      cost_provisional: false,
      error: "The schema threw while parsing: Error: broken refine",
    });
  });

  it("fails when the answer was cut off at max_tokens", async () => {
    const llm = fakeLlm([answer({ title: "x", count: 1 }, { truncated: true })]);

    expect(await callModel(deps(llm), input)).toMatchObject({ ok: false, reason: "max-tokens" });
    expect(await rows()).toMatchObject([{ outcome: "max-tokens" }]);
  });

  it("estimates the input generously when the provider cannot count it", async () => {
    const llm = fakeLlm([answer({ title: "x", count: 1 })], { inputTokens: "fail" });
    const asked: number[] = [];
    const guard: ModelCallGuard = async (call) => {
      asked.push(call.provisionalCostUsd);
      return { ok: true };
    };

    await callModel(deps(llm, { guard }), {
      ...input,
      system: "",
      content: [{ type: "text", text: "x".repeat(3000) }],
    });

    // A third of the characters as tokens: 1,000 in at $4, plus 16,000 out at $20 per million.
    expect(asked).toEqual([0.324]);
  });

  it("estimates too when counting takes longer than it may", async () => {
    const llm = fakeLlm([answer({ title: "x", count: 1 })], { inputTokens: "hang" });
    const asked: number[] = [];
    const guard: ModelCallGuard = async (call) => {
      asked.push(call.provisionalCostUsd);
      return { ok: true };
    };

    const result = await callModel(deps(llm, { guard }), {
      ...input,
      system: "",
      content: [{ type: "text", text: "x".repeat(3000) }],
    });

    expect(result.ok).toBe(true);
    expect(asked).toEqual([0.324]);
  });

  it("charges a model missing from the price table at the highest rates, and flags it", async () => {
    const llm = fakeLlm([
      answer(
        { title: "x", count: 1 },
        { model: "claude-next", usage: [usageOf("claude-next", 1000, 500)] },
      ),
    ]);

    await callModel(deps(llm), input);

    expect(await rows()).toMatchObject([
      { answered_model: "claude-next", price_known: false, cost: 0.035 },
    ]);
  });
});

describe("callModel with a broken adapter", () => {
  it("lets an adapter's exception surface, a bug, after closing the attempt's row", async () => {
    const broken: Llm = {
      countInputTokens: async () => 1000,
      call: async () => {
        throw new Error("adapter bug");
      },
    };

    await expect(callModel(deps(broken), input)).rejects.toThrow("adapter bug");
    expect(await rows()).toMatchObject([{ outcome: "client-error", cost_provisional: true }]);
  });

  it("records a Gemini call under its provider", async () => {
    const llm = fakeLlm([answer({ title: "x", count: 1 })]);

    await callModel(deps(llm), { ...input, model: "gemini-3.8-flash" });

    const { rows: saved } = await db.query<{ provider: string }>(
      "select provider from {{schema}}.model_calls",
    );
    expect(saved).toEqual([{ provider: "gemini" }]);
  });
});

describe("abandonStartedCalls", () => {
  it("marks the job's rows left started by a killed invocation abandoned, keeping their cost", async () => {
    for (const job of [JOB, OTHER_JOB]) {
      await db.query(
        `insert into {{schema}}.model_calls
           (job_id, stage, attempt, provider, requested_model, started_at, outcome, cost_usd, cost_provisional)
         values ($1, 'extract', 1, 'anthropic', 'claude-opus-5-5', $2, 'started', 0.36, true)`,
        [job, clock.now()],
      );
    }

    expect(await abandonStartedCalls(db, JOB, clock.now())).toBe(1);
    const { rows: after } = await db.query<{ job_id: string; outcome: string; cost: number }>(
      "select job_id, outcome, cost_usd::float8 as cost from {{schema}}.model_calls order by job_id",
    );
    expect(after).toEqual([
      { job_id: JOB, outcome: "abandoned", cost: 0.36 },
      { job_id: OTHER_JOB, outcome: "started", cost: 0.36 },
    ]);
  });
});
