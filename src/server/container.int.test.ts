import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createContainer, getContainer, type Container } from "./container";

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
      /DATABASE_URL.*SUPABASE_URL.*SUPABASE_SECRET_KEY/,
    );
  });

  it("refuses an unknown environment", async () => {
    await expect(createContainer({ JOBKIT_ENV: "staging" })).rejects.toThrow(/JOBKIT_ENV/);
  });

  it("on Vercel, refuses anything but production, so no test or development container runs there", async () => {
    for (const JOBKIT_ENV of ["test", "development", undefined]) {
      await expect(createContainer({ VERCEL: "1", JOBKIT_ENV })).rejects.toThrow(/Vercel/);
    }
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
