/**
 *   npm run eval -- --stage extract                          dev cases: what a run would cost; spends nothing
 *   npm run eval -- --stage extract --yes                     run them, up to the $5 budget
 *   npm run eval -- --stage extract --yes --budget 2          another budget, in dollars
 *   npm run eval -- --stage extract --model claude-sonnet-5-5 --yes      another model
 *   npm run eval -- --stage extract --split test --final --yes           the final run on test
 *
 * Runs the app's own stages on the labelled cases in private/archive (evals
 * spec, "Runs, budget and reports"), in an in-memory database with the
 * profile seeded from private/profile.yaml, on the evaluation keys in
 * .env.local; it refuses to start beside an app key or a remote database.
 * Reports go to private/evals/runs/. Live model calls cost money: run with
 * --yes only once the owner has approved the spend.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { systemClock } from "@/adapters/clock";
import { createLocalStorage } from "@/adapters/localStorage";
import { cryptoRandom } from "@/adapters/random";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";
import { modelsFor } from "@/server/models";

import { evalCommand } from "../evals/command";

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
    evalsDir: resolve(join("private", "evals")),
    commit: commitOf(),
    now: () => new Date(),
    log: (line) => console.log(line),
    async open() {
      // In memory, as the tests' database is: nothing the run writes outlives it but its report.
      const db = await createTestDb();
      const root = mkdtempSync(join(tmpdir(), "jobkit-eval-"));
      const storage = createLocalStorage({ root, origin: "http://localhost:3000" });
      const close = async () => {
        await db.close();
        rmSync(root, { recursive: true, force: true });
      };
      try {
        const checked = validateProfile(readFileSync(profileFile, "utf8"), {
          read: (path) => new Uint8Array(readFileSync(join(dirname(profileFile), path))),
        });
        if (!checked.ok) {
          throw new Error(
            `private/profile.yaml has problems: ${checked.problems.map((problem) => problem.message).join("; ")}`,
          );
        }
        await seedProfile({ db, storage, clock: systemClock }, checked);
      } catch (error) {
        await close();
        throw error;
      }
      return {
        db,
        storage,
        clock: systemClock,
        random: cryptoRandom,
        llmFor: modelsFor("development", { ...process.env, ...localEnv }),
        close,
      };
    },
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
