import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { guardCommits, guardStaged, guardTree } from "./guard";

// Each test spawns many git processes, which is slow on Windows.

let repo: string;

// Git exports GIT_DIR, GIT_INDEX_FILE and others to the processes it starts,
// such as hooks, and `rebase --exec` and `bisect run` from a linked worktree.
// Inherited, they send every git command to that repository, whatever its
// working directory: these tests once re-initialised a worktree's repository
// as bare, wrote their user into its config and committed their fixtures to it.
function isGitVariable(name: string): boolean {
  return name.startsWith("GIT_");
}

function gitIn(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const name of Object.keys(env).filter(isGitVariable)) delete env[name];
  return execFileSync("git", args, { cwd, encoding: "utf8", env });
}

function git(...args: string[]): string {
  return gitIn(repo, args);
}

function write(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

type RepoState = { config: string; head: string; refs: string; index: string };

/** What a stray git command would change in the repository at `dir`. */
function repoState(dir: string): RepoState {
  return {
    config: readFileSync(join(dir, ".git", "config"), "utf8"),
    head: readFileSync(join(dir, ".git", "HEAD"), "utf8"),
    refs: gitIn(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    index: gitIn(dir, ["ls-files", "--stage"]),
  };
}

beforeEach(() => {
  // The guard itself still honours git's variables, because the pre-commit
  // hook needs the GIT_DIR and GIT_INDEX_FILE git hands it, so each test takes
  // them out of this process for the guard as well.
  for (const name of Object.keys(process.env).filter(isGitVariable)) {
    vi.stubEnv(name, undefined);
  }
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
  vi.unstubAllEnvs();
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

describe("run with git's variables inherited, as under rebase --exec", () => {
  let other: string;
  let before: RepoState;
  let saved: Record<string, string | undefined>;

  // A beforeAll runs ahead of the file's beforeEach, so these variables stand
  // in for ones the test run inherited from git, naming another repository.
  beforeAll(() => {
    other = mkdtempSync(join(tmpdir(), "jobkit-guard-other-"));
    gitIn(other, ["init", "-q", "-b", "main"]);
    gitIn(other, ["config", "user.email", "other@example.com"]);
    gitIn(other, ["config", "user.name", "Other"]);
    gitIn(other, ["config", "commit.gpgsign", "false"]);
    gitIn(other, ["commit", "-q", "--allow-empty", "-m", "other"]);
    before = repoState(other);

    const inherited = {
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, ".git", "index"),
    };
    saved = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]));
    Object.assign(process.env, inherited);
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(other, { recursive: true, force: true });
  });

  it("sets up, stages and guards in its own repository and leaves the other untouched", () => {
    write("private/profile.yaml", "facts: []\n");
    git("add", "-f", "private/profile.yaml");

    expect(guardStaged(repo).join("\n")).toMatch(/private/);
    expect(git("log", "--format=%s")).toBe("first\n");
    expect(repoState(other)).toEqual(before);
  });
});
