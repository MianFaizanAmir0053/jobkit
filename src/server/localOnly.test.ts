import { describe, expect, it } from "vitest";

import { assertLocalOnly, isLocalRun, localOnlyProblems, onThisMachine } from "./localOnly";

describe("localOnlyProblems", () => {
  it("finds nothing wrong with the development values .env.local holds", () => {
    expect(
      localOnlyProblems({
        JOBKIT_ENV: "development",
        JOBKIT_LOCAL_EVALS: "1",
        APP_ORIGIN: "http://localhost:3000",
        OWNER_EMAIL: "owner@example.com",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        ANTHROPIC_EVALS_API_KEY: "evals-key",
        GEMINI_EVALS_API_KEY: "evals-key",
      }),
    ).toEqual([]);
  });

  it("names every key and secret that only production or the production scripts hold", () => {
    expect(
      localOnlyProblems({
        ANTHROPIC_API_KEY: "k",
        GEMINI_API_KEY: "k",
        SUPABASE_SECRET_KEY: "k",
        CRON_SECRET: "k",
        KEEPALIVE_SECRET: "k",
        JOBKIT_APP_DB_PASSWORD: "k",
      }),
    ).toEqual([
      "SUPABASE_SECRET_KEY is set",
      "ANTHROPIC_API_KEY is set",
      "GEMINI_API_KEY is set",
      "CRON_SECRET is set",
      "KEEPALIVE_SECRET is set",
      "JOBKIT_APP_DB_PASSWORD is set",
    ]);
  });

  it("names a production address that leaves this machine, and allows one that does not", () => {
    expect(
      localOnlyProblems({
        DATABASE_URL: "postgresql://jobkit_app@aws-0-eu.pooler.supabase.example:6543/postgres",
        SUPABASE_URL: "https://project.supabase.example",
        DATABASE_BOOTSTRAP_URL: "postgresql://postgres@localhost:5432/postgres",
      }),
    ).toEqual(["DATABASE_URL points at another machine", "SUPABASE_URL points at another machine"]);
  });

  it("treats an empty value as unset", () => {
    expect(localOnlyProblems({ ANTHROPIC_API_KEY: "", DATABASE_URL: "" })).toEqual([]);
  });
});

describe("assertLocalOnly", () => {
  it("refuses with every problem, by name only", () => {
    const secret = "app-key-value-0123";

    expect(() =>
      assertLocalOnly(
        { ANTHROPIC_API_KEY: secret, DATABASE_URL: "postgresql://u@db.example:5432/x" },
        "The dev server",
      ),
    ).toThrow(
      /^The dev server refuses to start: DATABASE_URL points at another machine; ANTHROPIC_API_KEY is set\./,
    );
    expect(() => assertLocalOnly({ ANTHROPIC_API_KEY: secret }, "The dev server")).not.toThrow(
      new RegExp(secret),
    );
  });

  it("lets a clean environment start", () => {
    expect(() => assertLocalOnly({}, "The dev server")).not.toThrow();
  });
});

describe("isLocalRun", () => {
  it("counts the dev server, whatever its JOBKIT_ENV, and anything not set up as production", () => {
    expect(isLocalRun({ NODE_ENV: "development", JOBKIT_ENV: "production" })).toBe(true);
    expect(isLocalRun({ NODE_ENV: "production", JOBKIT_ENV: "development" })).toBe(true);
    expect(isLocalRun({ NODE_ENV: "test", JOBKIT_ENV: "test" })).toBe(true);
    expect(isLocalRun({})).toBe(true);
  });

  it("does not count production, even when Vercel hides its own variables", () => {
    expect(isLocalRun({ NODE_ENV: "production", JOBKIT_ENV: "production" })).toBe(false);
  });
});

describe("onThisMachine", () => {
  it("accepts only loopback hosts and local sockets", () => {
    expect(onThisMachine("postgresql://u@localhost:5432/db")).toBe(true);
    expect(onThisMachine("postgresql://u@db.localhost:5432/db")).toBe(true);
    expect(onThisMachine("postgresql://u@127.0.0.1:5432/db")).toBe(true);
    expect(onThisMachine("postgresql://u@[::1]:5432/db")).toBe(true);
    expect(onThisMachine("postgresql://u@localhost/db?host=/var/run/postgresql")).toBe(true);
    expect(onThisMachine("postgresql://u@localhost.example.com:5432/db")).toBe(false);
    expect(onThisMachine("postgresql://u@10.0.0.5:5432/db")).toBe(false);
  });

  it("looks at the host Postgres takes from the query too, which wins over the URL's own", () => {
    expect(onThisMachine("postgres://u@localhost:5432/postgres?host=pooler.supabase.example")).toBe(
      false,
    );
    expect(onThisMachine("postgres://u@localhost:5432/postgres?hostaddr=10.0.0.5")).toBe(false);
  });

  it("counts a URL it cannot read, or one with no host, as remote", () => {
    expect(onThisMachine("not a url")).toBe(false);
    expect(onThisMachine("postgresql:///db")).toBe(false);
  });
});
