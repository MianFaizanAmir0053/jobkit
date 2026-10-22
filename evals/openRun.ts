import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { systemClock } from "@/adapters/clock";
import { createLocalStorage } from "@/adapters/localStorage";
import { cryptoRandom } from "@/adapters/random";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";
import { assertLocalOnly } from "@/server/localOnly";
import { modelsFor } from "@/server/models";

import type { RunDeps } from "./run";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * What an evaluation run works on (platform spec B4 and AC13; evals spec,
 * "Runs, budget and reports"): a database in memory, as the tests' is, with
 * the profile seeded; files in a folder of its own; and models on the
 * evaluation keys alone. Nothing the run writes outlives `close` but its
 * report. Like `npm run eval` itself, it refuses an environment holding an
 * app key or naming a remote database, before it opens anything.
 */
export async function openRun(
  profileFile: string,
  env: Env,
): Promise<RunDeps & { close(): Promise<void> }> {
  assertLocalOnly(env, "npm run eval");
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
        `${profileFile} has problems: ${checked.problems.map((problem) => problem.message).join("; ")}`,
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
    llmFor: modelsFor("development", env),
    close,
  };
}
