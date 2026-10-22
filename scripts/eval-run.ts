/**
 *   npm run eval -- --stage extract                          dev cases: what a run would cost; spends nothing
 *   npm run eval -- --stage extract --yes                     run them, up to the $5 budget
 *   npm run eval -- --stage extract --yes --budget 2          another budget, in dollars
 *   npm run eval -- --stage extract --model gemini-3.1-pro-preview --yes another model
 *   npm run eval -- --stage extract --split test --final --yes           the final run on test
 *   npm run eval -- --stage extract --split synthetic --yes              the public synthetic posts
 *
 * Runs the app's own stages on the labelled cases in private/archive (evals
 * spec, "Runs, budget and reports"), in an in-memory database with the
 * profile seeded from private/profile.yaml, on the evaluation keys in
 * .env.local; it refuses to start beside an app key or a remote database.
 * The synthetic posts run on evals/synthetic/profile.sample.yaml, from the
 * screenshots npm run eval:render made.
 * Reports go to private/evals/runs/. Live model calls cost money: run with
 * --yes only once the owner has approved the spend.
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

import { evalCommand } from "../evals/command";
import { openRun } from "../evals/openRun";

import { loadLocalEnv } from "./ops";

function commitOf(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const localEnv = loadLocalEnv();
  const profileFile = resolve(join("private", "profile.yaml"));
  await evalCommand(process.argv.slice(2), {
    env: process.env,
    localEnv,
    archive: resolve(join("private", "archive")),
    profileFile,
    syntheticDir: resolve(join("evals", "synthetic")),
    evalsDir: resolve(join("private", "evals")),
    commit: commitOf(),
    now: () => new Date(),
    log: (line) => console.log(line),
    // In memory, on the evaluation keys: nothing the run writes outlives it but its report.
    open: (profile) => openRun(profile, { ...process.env, ...localEnv }),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
