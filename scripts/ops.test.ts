import { describe, expect, it } from "vitest";

import {
  confirmProduction,
  parseEnvFile,
  parseTarget,
  projectRefFromSupabaseUrl,
  schemaStatements,
} from "./ops";

describe("parseTarget", () => {
  it("works on the local database unless --prod is given", () => {
    expect(parseTarget([])).toBe("local");
    expect(parseTarget(["--prod"])).toBe("prod");
  });

  it("refuses anything else, so a typo never means production", () => {
    expect(() => parseTarget(["--production"])).toThrow(/--prod/);
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
});

describe("schemaStatements", () => {
  it("creates the schema owned by the app role and closes it to everyone else", () => {
    const statements = schemaStatements({ schema: "jobkit", role: "jobkit_app" });

    expect(statements).toContain("create schema if not exists jobkit authorization jobkit_app");
    expect(statements).toContain("revoke all on schema jobkit from public");
    expect(statements.join(" ")).not.toMatch(/password/i);
  });
});
