import { describe, expect, it } from "vitest";

import {
  confirmProduction,
  parseEnvFile,
  parseTarget,
  productionRef,
  projectRefFromSupabaseUrl,
  schemaStatements,
} from "./ops";

describe("parseTarget", () => {
  const npmRun = { npm_lifecycle_event: "ledger:import" };

  it("works on the local database unless --prod is given", () => {
    expect(parseTarget([], npmRun)).toBe("local");
    expect(parseTarget(["--prod"], npmRun)).toBe("prod");
  });

  it("refuses anything else, so a typo never means production", () => {
    expect(() => parseTarget(["--production"], npmRun)).toThrow(/--prod/);
  });

  it("refuses to run locally when npm took --prod for itself, which it marks with NODE_ENV=production", () => {
    expect(() => parseTarget([], { ...npmRun, NODE_ENV: "production" })).toThrow(
      "npm took --prod for itself, so this did nothing. Put -- before the script's arguments: npm run ledger:import -- <arguments> --prod",
    );
    expect(parseTarget(["--prod"], { ...npmRun, NODE_ENV: "production" })).toBe("prod");
    expect(parseTarget([], { NODE_ENV: "production" })).toBe("local");
  });
});

describe("productionRef", () => {
  const SUPABASE_URL = "https://abcd1234efgh.supabase.co";
  const pooler = (user: string) =>
    `postgresql://${user}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;

  it("reads the project reference, when DATABASE_URL is for the same project", () => {
    expect(productionRef({ SUPABASE_URL, DATABASE_URL: pooler("jobkit_app.abcd1234efgh") })).toBe(
      "abcd1234efgh",
    );
    expect(productionRef({ SUPABASE_URL, DATABASE_URL: pooler("jobkit_app") })).toBe(
      "abcd1234efgh",
    );
  });

  it("refuses a DATABASE_URL for another project", () => {
    expect(() =>
      productionRef({ SUPABASE_URL, DATABASE_URL: pooler("jobkit_app.zzzz9999yyyy") }),
    ).toThrow(
      "DATABASE_URL is for project zzzz9999yyyy, but SUPABASE_URL is for abcd1234efgh: fix .env.ops.local",
    );
  });
});

describe("projectRefFromSupabaseUrl", () => {
  it("reads the project reference from the project URL", () => {
    expect(projectRefFromSupabaseUrl("https://abcd1234efgh.supabase.co")).toBe("abcd1234efgh");
  });

  it("refuses a URL that is not a Supabase project URL", () => {
    expect(() => projectRefFromSupabaseUrl("https://example.com")).toThrow(/SUPABASE_URL/);
  });
});

describe("confirmProduction", () => {
  it("goes ahead when the owner types the project reference", async () => {
    await expect(confirmProduction("abcd1234", async () => " abcd1234 ")).resolves.toBeUndefined();
  });

  it("stops when the owner types anything else", async () => {
    await expect(confirmProduction("abcd1234", async () => "yes")).rejects.toThrow(/did not match/);
  });
});

describe("parseEnvFile", () => {
  it("reads name=value lines and ignores comments, blanks and quotes", () => {
    expect(parseEnvFile(["# c", "", "A=1", 'B="two words"', "C='3'"].join("\n"))).toEqual({
      A: "1",
      B: "two words",
      C: "3",
    });
  });

  it("keeps a quoted value whole, # included, and lets a comment follow the closing quote", () => {
    expect(
      parseEnvFile(
        ['JOBKIT_APP_DB_PASSWORD="Xk3#pQ9" # rotated', "B='single # too'", "C= # removed"].join(
          "\n",
        ),
      ),
    ).toEqual({ JOBKIT_APP_DB_PASSWORD: "Xk3#pQ9", B: "single # too", C: "" });
  });

  it("refuses what next dev would read differently, naming the line and key but never the value", () => {
    const read = () =>
      parseEnvFile(
        ["A=1", "JOBKIT_APP_DB_PASSWORD=Xk3#pQ9", 'KEY="unclosed', 'D="x" trailing'].join("\n"),
      );

    expect(read).toThrow(
      [
        "This env file needs fixing:",
        "line 2: JOBKIT_APP_DB_PASSWORD holds #, so its value must be in quotes",
        "line 3: KEY's quotes do not close, or text follows them",
        "line 4: D's quotes do not close, or text follows them",
      ].join("\n"),
    );
    expect(read).not.toThrow(/Xk3/);
  });

  it("drops an export prefix", () => {
    expect(parseEnvFile("export A=1")).toEqual({ A: "1" });
  });
});

describe("schemaStatements", () => {
  it("creates the schema owned by the app role and closes it to everyone else", () => {
    const statements = schemaStatements({ schema: "jobkit", role: "jobkit_app" });

    expect(statements).toContain("create schema if not exists jobkit authorization jobkit_app");
    expect(statements).toContain("revoke all on schema jobkit from public");
    expect(statements.join(" ")).not.toMatch(/password/i);
  });
});
