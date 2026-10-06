import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardCommits, guardStaged, guardTree } from "./guard";

// Each test spawns many git processes, which is slow on Windows.

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "jobkit-guard-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Guard Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  write("README.md", "clean\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "first");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("guardStaged", () => {
  it("passes a clean staged file", () => {
    write("src/a.ts", "export const a = 1;\n");
    git("add", "src/a.ts");

    expect(guardStaged(repo)).toEqual([]);
  });

  it("blocks a staged file under private/", () => {
    write("private/profile.yaml", "facts: []\n");
    git("add", "-f", "private/profile.yaml");

    expect(guardStaged(repo).join("\n")).toMatch(/private/);
  });

  it("blocks a staged key-shaped string", () => {
    write("src/a.ts", `const k = "${"sb_" + "secret_" + "x".repeat(32)}";\n`);
    git("add", "src/a.ts");

    expect(guardStaged(repo).join("\n")).toMatch(/Supabase secret key/);
  });

  it("blocks a connection string with a password", () => {
    write(
      "docs/note.md",
      "postgres" + "://jobkit_app.ref:" + "r3al-pa55word" + "@host:6543/postgres\n",
    );
    git("add", "docs/note.md");

    expect(guardStaged(repo).join("\n")).toMatch(/connection string/);
  });

  it("blocks an exact value from the local env files", () => {
    const secret = "v".repeat(10) + "-9" + "y".repeat(10);
    write(".env.ops.local", `CRON_SECRET=${secret}\n`);
    write("docs/runbook.md", `the secret is ${secret}\n`);
    git("add", "docs/runbook.md");

    expect(guardStaged(repo).join("\n")).toMatch(/local env files/);
  });
});

describe("guardTree", () => {
  it("checks every tracked file", () => {
    write("src/b.ts", `const k = "${"GOC" + "SPX-" + "z".repeat(28)}";\n`);
    git("add", "src/b.ts");
    git("commit", "-q", "-m", "oops");

    expect(guardTree(repo).join("\n")).toMatch(/OAuth client secret/);
  });
});

describe("guardCommits", () => {
  it("finds a secret added and then removed inside the range", () => {
    const base = git("rev-parse", "HEAD").trim();
    write("src/c.ts", `const k = "${"sk-" + "ant-" + "q".repeat(40)}";\n`);
    git("add", "src/c.ts");
    git("commit", "-q", "-m", "add key");
    write("src/c.ts", "const k = process.env.KEY;\n");
    git("add", "src/c.ts");
    git("commit", "-q", "-m", "remove key");
    const head = git("rev-parse", "HEAD").trim();

    expect(guardTree(repo)).toEqual([]);
    expect(guardCommits(repo, `${base}..${head}`).join("\n")).toMatch(/Anthropic key/);
  });
});
