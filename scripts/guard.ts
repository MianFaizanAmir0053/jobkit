/**
 * The commit guard (platform spec B7).
 *
 *   tsx scripts/guard.ts --staged             pre-commit: the staged changes
 *   tsx scripts/guard.ts --tree               CI: every tracked file
 *   tsx scripts/guard.ts --commits BEFORE AFTER   CI: every commit a push adds
 *
 * Exits with status 1 and lists every violation when anything is found.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { checkContent, checkPath, checkSize, knownSecretsFrom, pushRange } from "./guardRules";

const LOCAL_ENV_FILES = [".env.local", ".env.ops.local"];

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
}

function gitList(cwd: string, args: string[]): string[] {
  return git(cwd, args).toString("utf8").split("\0").filter(Boolean);
}

function knownSecrets(cwd: string): string[] {
  return LOCAL_ENV_FILES.flatMap((file) => {
    const path = join(cwd, file);
    return existsSync(path) ? knownSecretsFrom(readFileSync(path, "utf8")) : [];
  });
}

function checkFile(path: string, content: Buffer, secrets: readonly string[]): string[] {
  const problems: string[] = [];
  const pathProblem = checkPath(path);
  if (pathProblem) problems.push(pathProblem);
  const sizeProblem = checkSize(content.length);
  if (sizeProblem) problems.push(`${path}: ${sizeProblem}`);
  for (const found of checkContent(content.toString("utf8"), secrets)) {
    problems.push(`${path}: ${found}`);
  }
  return problems;
}

export function guardStaged(cwd: string): string[] {
  const secrets = knownSecrets(cwd);
  const paths = gitList(cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
  return paths.flatMap((path) => checkFile(path, git(cwd, ["show", `:${path}`]), secrets));
}

export function guardTree(cwd: string): string[] {
  const secrets = knownSecrets(cwd);
  return gitList(cwd, ["ls-files", "-z"]).flatMap((path) => {
    const full = join(cwd, path);
    return existsSync(full) ? checkFile(path, readFileSync(full), secrets) : [];
  });
}

export function guardCommits(cwd: string, range: string): string[] {
  const secrets = knownSecrets(cwd);
  const commits = git(cwd, ["rev-list", "--reverse", range])
    .toString("utf8")
    .split(/\s+/)
    .filter(Boolean);
  return commits.flatMap((sha) => {
    const short = sha.slice(0, 8);
    const problems: string[] = [];
    const paths = gitList(cwd, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "--root",
      "--diff-filter=ACMR",
      sha,
    ]);
    for (const path of paths) {
      const pathProblem = checkPath(path);
      if (pathProblem) problems.push(`${short} ${pathProblem}`);
      const size = Number(
        git(cwd, ["cat-file", "-s", `${sha}:${path}`])
          .toString("utf8")
          .trim(),
      );
      const sizeProblem = checkSize(size);
      if (sizeProblem) problems.push(`${short} ${path}: ${sizeProblem}`);
    }
    const added = git(cwd, ["show", "--format=", "--no-color", "--unified=0", sha])
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");
    for (const found of checkContent(added, secrets)) problems.push(`${short}: ${found}`);
    return problems;
  });
}

/** True when origin/main exists and is not simply the commit being pushed. */
function mainIsBase(cwd: string, after: string): boolean {
  try {
    const main = git(cwd, ["rev-parse", "--verify", "--quiet", "origin/main"])
      .toString("utf8")
      .trim();
    const head = git(cwd, ["rev-parse", "--verify", "--quiet", after]).toString("utf8").trim();
    return main !== "" && main !== head;
  } catch {
    return false;
  }
}

function main(argv: string[]): number {
  const cwd = process.cwd();
  const [mode, ...rest] = argv;
  let problems: string[];
  try {
    if (mode === "--staged") problems = guardStaged(cwd);
    else if (mode === "--tree") problems = guardTree(cwd);
    else if (mode === "--commits" && rest.length === 2) {
      const [before, after] = rest as [string, string];
      problems = guardCommits(
        cwd,
        pushRange(before, after, { mainIsBase: mainIsBase(cwd, after) }),
      );
    } else {
      console.error("usage: guard.ts --staged | --tree | --commits BEFORE AFTER");
      return 2;
    }
  } catch (error) {
    console.error(
      `The commit guard could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  if (problems.length === 0) return 0;
  console.error("The commit guard found:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("Remove these before committing. Secrets and personal data never enter git.");
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
