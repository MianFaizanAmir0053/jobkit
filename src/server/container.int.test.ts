import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContainer, getContainer, type Container } from "./container";
import { lockLocalData } from "./db/localDb";
import { NO_ANSWER, setScriptedAnswers } from "./scriptedModels";

let container: Container | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await container?.close();
  container = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
  vi.unstubAllEnvs();
  // getContainer keeps its container on globalThis; forget the closed one.
  delete (globalThis as { jobkitContainer?: unknown }).jobkitContainer;
});

describe("createContainer", () => {
  it("in development, lets go of the local database when it fails to start, so the next try can open it", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "jobkit-dev-"));
    const migrationsDir = join(dataDir, "migrations");
    mkdirSync(migrationsDir);
    writeFileSync(join(migrationsDir, "0001_broken.sql"), "this is not sql;");

    await expect(
      createContainer(
        { JOBKIT_ENV: "development", APP_ORIGIN: "http://localhost:3000" },
        { dataDir, migrationsDir },
      ),
    ).rejects.toThrow();

    expect(() => lockLocalData(dataDir!, "the next try")()).not.toThrow();
  });

  it("in development, uses PGlite and local files under the data folder, migrated and ready", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "jobkit-dev-"));
    container = await createContainer(
      { JOBKIT_ENV: "development", APP_ORIGIN: "http://localhost:3000" },
      { dataDir },
    );

    expect(container.kind).toBe("development");
    const heartbeat = await container.db.query<{ id: number }>(
      "select id from {{schema}}.heartbeat",
    );
    expect(heartbeat.rows).toEqual([{ id: 1 }]);
    await container.storage.put("probe/a.txt", new TextEncoder().encode("a"), "text/plain");
    expect(await container.storage.stat("probe/a.txt")).toEqual({ size: 1 });
    // The only test that writes a whole PGlite data directory to disk: about
    // 10 seconds alone, and well past 30 while other files boot in parallel.
  }, 60_000);

  it("in test, uses an in-memory database", async () => {
    container = await createContainer({ JOBKIT_ENV: "test", APP_ORIGIN: "http://localhost:3000" });

    expect(container.kind).toBe("test");
    expect((await container.db.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
  });

  it("supplies the system clock and cryptographic randomness", async () => {
    container = await createContainer({ JOBKIT_ENV: "test" });

    expect(Math.abs(container.clock.now().getTime() - Date.now())).toBeLessThan(5_000);
    const [a, b] = [container.random.bytes(32), container.random.bytes(32)];
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("in production, refuses to start and names every missing variable", async () => {
    await expect(createContainer({ JOBKIT_ENV: "production" })).rejects.toThrow(
      /^Missing environment variables for production: DATABASE_URL, SUPABASE_URL, SUPABASE_SECRET_KEY$/,
    );
  });

  it("in production, starts without a model key, and only the models that need it fail", async () => {
    container = await createContainer({
      JOBKIT_ENV: "production",
      DATABASE_URL: "postgresql://jobkit_app@db.example.test:6543/postgres",
      SUPABASE_URL: "https://project.supabase.example",
      SUPABASE_SECRET_KEY: "secret-value",
      GEMINI_API_KEY: "app-key",
    });

    expect(container.kind).toBe("production");
    expect(container.llmFor("gemini-3.8-flash")).toMatchObject({ call: expect.any(Function) });
    expect(() => container!.llmFor("claude-opus-5-5")).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it("in test, answers only from the script, whatever keys the shell holds", async () => {
    container = await createContainer({ JOBKIT_ENV: "test", ANTHROPIC_EVALS_API_KEY: "evals-key" });
    setScriptedAnswers([]);

    // No provider is loaded: with no answer set, the call says so instead of reaching one.
    await expect(
      container.llmFor("claude-opus-5-5").countInputTokens({
        model: "claude-opus-5-5",
        system: "",
        content: [],
        schema: z.object({}),
        effort: "low",
        maxTokens: 10,
      }),
    ).resolves.toBe(1_000);
    await expect(
      container.llmFor("claude-opus-5-5").call({
        model: "claude-opus-5-5",
        system: "",
        content: [],
        schema: z.object({}),
        effort: "low",
        maxTokens: 10,
        signal: new AbortController().signal,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(NO_ANSWER);
  });

  it("checks every local build, as when the dev server builds again after an edited .env file", async () => {
    await expect(
      createContainer({ JOBKIT_ENV: "test", GEMINI_API_KEY: "app-key" }),
    ).rejects.toThrow(/^A local run refuses to start: GEMINI_API_KEY is set/);
    await expect(
      createContainer({
        NODE_ENV: "development",
        JOBKIT_ENV: "production",
        DATABASE_URL: "postgresql://jobkit_app@db.example.test:6543/postgres",
        SUPABASE_URL: "https://project.supabase.example",
        SUPABASE_SECRET_KEY: "secret-value",
      }),
    ).rejects.toThrow(/^A local run refuses to start: DATABASE_URL points at another machine/);
  });

  it("refuses an unknown environment", async () => {
    await expect(createContainer({ JOBKIT_ENV: "staging" })).rejects.toThrow(/JOBKIT_ENV/);
  });

  it("on a Vercel deployment, refuses anything but production, so no test or development container runs there", async () => {
    for (const VERCEL_ENV of ["production", "preview"]) {
      for (const JOBKIT_ENV of ["test", "development", undefined]) {
        await expect(createContainer({ VERCEL: "1", VERCEL_ENV, JOBKIT_ENV })).rejects.toThrow(
          /Vercel .* deployment/,
        );
      }
    }
  });

  it("is not fooled by VERCEL=1 in a local file, which `vercel env pull` writes with VERCEL_ENV=development", async () => {
    container = await createContainer({
      VERCEL: "1",
      VERCEL_ENV: "development",
      JOBKIT_ENV: "test",
    });

    expect(container.kind).toBe("test");
  });
});

describe("getContainer", () => {
  it("builds one container per process from its environment, and retries after a failed start", async () => {
    vi.stubEnv("JOBKIT_ENV", "staging");
    await expect(getContainer()).rejects.toThrow(/JOBKIT_ENV/);

    vi.stubEnv("JOBKIT_ENV", "test");
    container = await getContainer();

    expect(container.kind).toBe("test");
    expect(await getContainer()).toBe(container);
  });
});
