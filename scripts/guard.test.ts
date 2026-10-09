import { describe, expect, it } from "vitest";

import { checkContent, checkPath, checkSize, knownSecretsFrom, pushRange } from "./guardRules";

// Key-shaped fixtures are assembled at run time, so this file never holds one.
const fake = {
  anthropic: "sk-" + "ant-" + "api03-" + "a".repeat(40),
  googleApi: "AI" + "za" + "B".repeat(35),
  googleOAuth: "GOC" + "SPX-" + "c".repeat(28),
  supabase: "sb_" + "secret_" + "d".repeat(32),
  privateKey: "-----BEGIN " + "PRIVATE KEY-----",
  jwt: "ey" + "J" + "e".repeat(20) + ".ey" + "J" + "f".repeat(20) + "." + "g".repeat(20),
  postgres:
    "postgres" + "://jobkit_app.abcd:" + "s3cr3t-pa55" + "@aws-0.pooler.example.com:6543/postgres",
};

describe("checkPath", () => {
  it("blocks anything under private/", () => {
    expect(checkPath("private/profile.yaml")).toMatch(/private/);
  });

  it("blocks anything under .data/, where the local database keeps the owner's profile and CV", () => {
    expect(checkPath(".data/storage/profile/cv-0123.pdf")).toMatch(/\.data/);
    expect(checkPath(".data\\pglite\\base")).toMatch(/\.data/);
  });

  it("blocks a private/ or .data/ folder at any depth and in any case, as a script run elsewhere makes", () => {
    expect(checkPath("scripts/.data/storage/profile/cv.pdf")).toMatch(/\.data/);
    expect(checkPath(".Data/pglite/base")).toMatch(/\.data/);
    expect(checkPath("evals/Private/profile.yaml")).toMatch(/private/);
    expect(checkPath("src/core/privateness.ts")).toBeNull();
  });

  it("blocks .env files but allows .env.example", () => {
    expect(checkPath(".env.local")).toMatch(/env/);
    expect(checkPath(".env.ops.local")).toMatch(/env/);
    expect(checkPath(".env.example")).toBeNull();
  });

  it("allows ordinary source files", () => {
    expect(checkPath("src/server/env.ts")).toBeNull();
  });
});

describe("checkSize", () => {
  it("blocks files over 1 MB", () => {
    expect(checkSize(1024 * 1024 + 1)).toMatch(/1 MB/);
    expect(checkSize(1024 * 1024)).toBeNull();
  });
});

describe("checkContent", () => {
  it.each(Object.entries(fake))("finds a %s", (_name, secret) => {
    expect(checkContent(`const x = "${secret}";`, [])).not.toEqual([]);
  });

  it("ignores the prefixes the specs mention in prose", () => {
    const prose =
      "Anthropic keys (`sk-ant-`), Google API keys (`AIza`), Supabase secret keys (`sb_secret_`).";
    expect(checkContent(prose, [])).toEqual([]);
  });

  it("ignores placeholder passwords in documented connection strings", () => {
    expect(checkContent("connection strings (`postgres://user:password@`)", [])).toEqual([]);
    expect(checkContent("postgresql://jobkit_app.<ref>:<password>@host:6543/postgres", [])).toEqual(
      [],
    );
  });

  it("finds an exact value from the local env files, even with no known shape", () => {
    const secret = "q".repeat(8) + "Zx41-" + "w".repeat(8);
    expect(checkContent(`token: ${secret}`, [secret])).not.toEqual([]);
  });
});

describe("knownSecretsFrom", () => {
  it("keeps the values of secret-bearing variables of 12 characters or more", () => {
    const text = [
      "# comment",
      "CRON_SECRET=" + "k".repeat(43),
      "DATABASE_URL=" + "postgres" + "://u:" + "p".repeat(16) + "@h/db",
      "GEMINI_EVALS_API_KEY=" + "m".repeat(39),
      "",
    ].join("\n");
    expect(knownSecretsFrom(text)).toEqual([
      "k".repeat(43),
      "postgres" + "://u:" + "p".repeat(16) + "@h/db",
      "m".repeat(39),
    ]);
  });

  it("ignores values that are not secrets, so the owner's address and URLs stay committable", () => {
    const text = [
      "OWNER_EMAIL=owner@example.com",
      "APP_ORIGIN=https://jobkit.example.com",
      "SUPABASE_URL=https://abcd.supabase.co",
    ].join("\n");
    expect(knownSecretsFrom(text)).toEqual([]);
  });

  it("ignores short values", () => {
    expect(knownSecretsFrom("CRON_SECRET=short")).toEqual([]);
  });
});

describe("pushRange", () => {
  const after = "2".repeat(40);

  it("covers the commits between before and after on an existing branch", () => {
    expect(pushRange("1".repeat(40), after, { mainIsBase: true })).toBe(
      `${"1".repeat(40)}..${after}`,
    );
  });

  it("covers the commits not on main when the push creates a branch", () => {
    expect(pushRange("0".repeat(40), after, { mainIsBase: true })).toBe(`origin/main..${after}`);
  });

  it("covers the whole history when there is no main to compare with, as on the first push", () => {
    expect(pushRange("0".repeat(40), after, { mainIsBase: false })).toBe(after);
  });
});
