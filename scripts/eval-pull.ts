/**
 *   npm run eval:pull             jobs kept for evaluation in the local database, into private/archive
 *   npm run eval:pull -- --prod   the same from production, after you type the project reference
 *
 * Copies each kept job's images into a case folder and clears its keep
 * flag (evals spec, "Case sources"; intake spec, "Storage and retention"),
 * so the 30-day purge deletes the cloud copy. A job whose image cannot be
 * copied stays kept for the next pull.
 */
import { join, resolve } from "node:path";

import { pullKeptJobs } from "../evals/pull";

import { parseTarget } from "./ops";
import { openTarget } from "./targets";

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const archive = resolve(join("private", "archive"));
  const { db, storage, where } = await openTarget(
    target,
    "copy the jobs kept for evaluation, and clear their keep flags, in",
    "npm run eval:pull",
  );
  try {
    const report = await pullKeptJobs({ db, storage }, archive);
    console.log(`From ${where}, new or completed cases in ${archive}: ${report.cases.length}`);
    for (const entry of report.cases) console.log(`  ${entry.id}  ${entry.images} image(s)`);
    for (const entry of report.failed) {
      console.log(`Kept for the next pull: job ${entry.jobId}: ${entry.reason}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
