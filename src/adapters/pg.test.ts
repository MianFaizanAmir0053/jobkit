import { describe, expect, it, vi } from "vitest";

import { createPool } from "./pg";

describe("createPool", () => {
  it("survives an idle client's error instead of crashing the process, and logs it", async () => {
    // Making a pool opens no connection, so this needs no database.
    const pool = createPool({ connectionString: "postgres://user@127.0.0.1:1/none", max: 1 });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(logged).toHaveBeenCalledWith("Postgres pool:", "Connection terminated unexpectedly");

    logged.mockRestore();
    await pool.end();
  });
});
