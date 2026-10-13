/**
 *   npm run eval:split                              give a split to every case ready to label that has none
 *   npm run eval:split -- --partial                 the same while some cases still wait for screenshots
 *   npm run eval:split -- --without-style-examples  the same when the profile's style examples cannot be read
 *
 * Fixes the test and dev splits (evals spec, "Splits"). Run it once the
 * cases you mean to keep have their screenshots and what is not an
 * application is set aside on its page, and again whenever new cases are ready: a
 * case keeps its split for good, so viewing the labelling page never gives
 * one. It refuses while test has free places and cases still wait, since
 * the test set must be a draw from all the cases, and while the style
 * examples cannot be read, since a case they would leave out could take a
 * test place. Nothing leaves the laptop: it reads and writes local files
 * only.
 */
import { join, resolve } from "node:path";

import { fixSplit } from "../evals/cases";
import { styleExamplesOf } from "../evals/import";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--partial" && arg !== "--without-style-examples") {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  const archive = resolve(join("private", "archive"));
  const { examples, problems } = styleExamplesOf(resolve(join("private", "profile.yaml")));
  if (problems.length > 0 && !args.has("--without-style-examples")) {
    throw new Error(
      `${problems.join("; ")}. Fix the profile, or run npm run eval:split -- --without-style-examples to give splits without leaving out the cases those examples match.`,
    );
  }
  const report = await fixSplit(
    archive,
    { styleExamples: examples },
    { partial: args.has("--partial") },
  );
  console.log(
    `Given a split now: ${report.added}, ${report.test.length} in test and ${report.dev} in dev`,
  );
  for (const id of report.test) console.log(`  test: ${id}`);
  console.log(`Waiting for screenshots, or with a file that cannot be read: ${report.waiting}`);
  console.log(
    `Left out (a style example's application, or sent once jobkit drafted): ${report.leftOut}`,
  );
  for (const id of report.held) {
    console.log(
      `Held without a split: ${id}, the same application as a case in a full test set. Set one of them aside.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
