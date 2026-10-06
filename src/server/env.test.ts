import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ENV_GROUPS } from "./env";

function readEnvExample(): Map<string, string> {
  const text = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    entries.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return entries;
}

describe(".env.example", () => {
  it("lists every variable the platform spec places in Vercel, .env.local or .env.ops.local", () => {
    const listed = readEnvExample();
    const expected = new Set<string>([
      ...ENV_GROUPS.vercel,
      ...ENV_GROUPS.local,
      ...ENV_GROUPS.ops,
    ]);

    expect([...expected].filter((name) => !listed.has(name))).toEqual([]);
  });

  it("lists nothing the spec does not name", () => {
    const expected = new Set<string>([
      ...ENV_GROUPS.vercel,
      ...ENV_GROUPS.local,
      ...ENV_GROUPS.ops,
    ]);

    expect([...readEnvExample().keys()].filter((name) => !expected.has(name))).toEqual([]);
  });

  it("carries no values, so it can never leak a secret", () => {
    const withValues = [...readEnvExample()].filter(([, value]) => value !== "");

    expect(withValues).toEqual([]);
  });
});

describe("ENV_GROUPS", () => {
  it("keeps evaluation keys out of Vercel and production model keys out of .env.local", () => {
    expect(ENV_GROUPS.vercel).not.toContain("ANTHROPIC_EVALS_API_KEY");
    expect(ENV_GROUPS.vercel).not.toContain("GEMINI_EVALS_API_KEY");
    expect(ENV_GROUPS.local).not.toContain("ANTHROPIC_API_KEY");
    expect(ENV_GROUPS.local).not.toContain("GEMINI_API_KEY");
    expect(ENV_GROUPS.local).not.toContain("DATABASE_URL");
  });

  it("keeps the bootstrap credentials in .env.ops.local only", () => {
    expect(ENV_GROUPS.ops).toContain("DATABASE_BOOTSTRAP_URL");
    expect(ENV_GROUPS.ops).toContain("JOBKIT_APP_DB_PASSWORD");
    expect(ENV_GROUPS.vercel).not.toContain("DATABASE_BOOTSTRAP_URL");
    expect(ENV_GROUPS.local).not.toContain("DATABASE_BOOTSTRAP_URL");
  });
});
