import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createContainer, type Container } from "./container";

let container: Container | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await container?.close();
  container = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
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
  });

  it("in test, uses an in-memory database", async () => {
    container = await createContainer({ JOBKIT_ENV: "test", APP_ORIGIN: "http://localhost:3000" });

    expect(container.kind).toBe("test");
    expect((await container.db.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
  });

  it("in production, refuses to start and names every missing variable", async () => {
    await expect(createContainer({ JOBKIT_ENV: "production" })).rejects.toThrow(
      /DATABASE_URL.*SUPABASE_URL.*SUPABASE_SECRET_KEY/,
    );
  });

  it("refuses an unknown environment", async () => {
    await expect(createContainer({ JOBKIT_ENV: "staging" })).rejects.toThrow(/JOBKIT_ENV/);
  });
});
