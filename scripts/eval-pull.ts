/**
 *   npm run eval:pull                           jobs kept for evaluation in the local database, into private/archive
 *   npm run eval:pull -- --prod                 the same from production, after you type the project reference
 *   npm run eval:pull -- --release <job ID>     leave a kept job whose images cannot be copied to the purge
 *
 * Copies each kept job's images, the crop of its contact and its pasted
 * text into a case folder and clears its images' keep flags (evals spec,
 * "Case sources"; intake spec, "Storage and retention"), so the 30-day
 * purge deletes the cloud copy. A job whose image cannot be copied stays
 * kept for the next pull; --release clears its flags without copying.
 */
import { join, resolve } from "node:path";

import { pullKeptJobs, releaseKeptJob } from "../evals/pull";

import { parseTarget } from "./ops";
import { openTarget } from "./targets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job --release names, and the arguments left for the target. */
function releaseOf(argv: readonly string[]): { release: string | null; rest: string[] } {
  const at = argv.indexOf("--release");
  if (at < 0) return { release: null, rest: [...argv] };
  const jobId = argv[at + 1];
  if (!jobId || !UUID.test(jobId)) {
    throw new Error("Give the job's whole ID, as the pull printed it: --release <job ID>");
  }
  return { release: jobId, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

async function main(): Promise<void> {
  const { release, rest } = releaseOf(process.argv.slice(2));
  const target = parseTarget(rest);
  const archive = resolve(join("private", "archive"));
  const { db, storage, where } = await openTarget(
    target,
    release
      ? `clear the keep flags of job ${release}, which the purge then deletes, in`
      : "copy the jobs kept for evaluation, and clear their keep flags, in",
    "npm run eval:pull",
  );
  try {
    if (release) {
      const released = await releaseKeptJob(db, release);
      console.log(`In ${where}, job ${release}: ${released} image(s) no longer kept.`);
      return;
    }
    const report = await pullKeptJobs({ db, storage }, archive);
    console.log(`From ${where}, new or completed cases in ${archive}: ${report.cases.length}`);
    for (const entry of report.cases) {
      const added = entry.existing
        ? ", added to a case already in the archive: check its labels"
        : "";
      console.log(`  ${entry.id}  ${entry.images} image(s)${added}`);
    }
    for (const note of report.notes) console.log(`  ${note}`);
    for (const entry of report.failed) {
      console.log(`Kept for the next pull: job ${entry.jobId}: ${entry.reason}`);
    }
    if (report.failed.some((entry) => entry.reason.includes("is gone from storage"))) {
      console.log(
        "A job whose image is gone stays kept until you release it: npm run eval:pull -- --release <job ID>",
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
