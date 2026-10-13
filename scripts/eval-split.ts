/**
 *   npm run eval:split     give a split to every case ready to label that has none
 *
 * Fixes the test and dev splits (evals spec, "Splits"). Run it once the
 * cases you mean to keep have their screenshots and the folders that are
 * not applications are deleted, and again whenever new cases are ready: a
 * case keeps its split for good, so viewing the labelling page never gives
 * one. Nothing leaves the laptop: it reads and writes local files only.
 */
import { join, resolve } from "node:path";

import { fixSplit } from "../evals/cases";
import { styleExamplesOf } from "../evals/import";

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("npm run eval:split takes no arguments.");
  const archive = resolve(join("private", "archive"));
  const { examples, problems } = styleExamplesOf(resolve(join("private", "profile.yaml")));
  for (const problem of problems) {
    console.warn(`Warning: ${problem}, so no case is left out for it.`);
  }
  const report = await fixSplit(archive, { styleExamples: examples });
  console.log(`Given a split now: ${report.added}`);
  console.log(`Ready to label: ${report.test} in test, ${report.dev} in dev`);
  console.log(`Waiting for screenshots, or with a file that cannot be read: ${report.waiting}`);
  console.log(`Left out for holding a style example: ${report.leftOut}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
