import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openRun } from "./openRun";

/*
 * What an evaluation run works on (platform spec B4, AC13): a local
 * database in memory and models on the evaluation keys alone, never beside
 * an app key or a remote database.
 */

const PROFILE = join(process.cwd(), "evals", "synthetic", "profile.sample.yaml");
const EVALS_KEY = { GEMINI_EVALS_API_KEY: "fixture-evals-key" };

describe("openRun", () => {
  it("opens a database in memory with the profile seeded, which nothing outlives, and models on the evaluation keys", async () => {
    // A database on this machine is no reason to refuse, and still not where the run writes.
    const env = { ...EVALS_KEY, DATABASE_URL: "postgresql://jobkit@localhost:5432/jobkit" };
    const first = await openRun(PROFILE, env);
    try {
      const active = await first.db.query(
        "select id from {{schema}}.profile_versions where active",
      );
      expect(active.rows).toHaveLength(1);
      await first.db.query(
        `insert into {{schema}}.jobs (id, state, state_changed_at, received_at)
         values ('66666666-6666-4666-8666-666666666666', 'closed', now(), now())`,
      );
      expect(first.llmFor("gemini-3.8-flash")).toMatchObject({ call: expect.any(Function) });
      expect(() => first.llmFor("claude-opus-5-5")).toThrow(/ANTHROPIC_EVALS_API_KEY is not set/);
    } finally {
      await first.close();
    }

    const second = await openRun(PROFILE, env);
    try {
      expect((await second.db.query("select id from {{schema}}.jobs")).rows).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("refuses an app key or a remote database before it reads the profile", async () => {
    // A profile that is not there: each refusal comes before the run goes looking for it.
    const missing = join(process.cwd(), "evals", "no-such-profile.yaml");

    await expect(
      openRun(missing, { ...EVALS_KEY, DATABASE_URL: "postgres://db.example.com:5432/jobkit" }),
    ).rejects.toThrow(/DATABASE_URL points at another machine/);
    await expect(
      openRun(missing, { ...EVALS_KEY, GEMINI_API_KEY: "fixture-app-key" }),
    ).rejects.toThrow(/GEMINI_API_KEY is set/);
    // Without them it opens, and only then finds the profile missing.
    await expect(openRun(missing, EVALS_KEY)).rejects.toThrow(/no-such-profile\.yaml/);
  });
});
