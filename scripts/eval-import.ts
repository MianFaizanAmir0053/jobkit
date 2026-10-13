/**
 *   npm run eval:import -- --mbox <file>                       a Takeout mbox of sent mail
 *   npm run eval:import -- --mbox <file> --archive <folder>    into another archive than private/archive
 *   npm run eval:import -- --mbox <file> --profile <file>      style examples from another profile file
 *   npm run eval:import -- --mbox <file> --attachment cv.pdf   another CV file name than resume.pdf
 *
 * Makes one case folder per sent application (evals spec, "Case sources"),
 * leaving out any whose body holds one of the profile's style examples, and
 * reports what it kept, skipped and could not read. Nothing leaves the
 * laptop: it reads and writes local files only.
 */
import { join, resolve } from "node:path";

import { importMbox, styleExamplesOf } from "../evals/import";

const VALUED = new Set(["--mbox", "--archive", "--profile", "--attachment"]);

function parseArgs(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!VALUED.has(flag)) throw new Error(`Unknown argument ${flag}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    values.set(flag, value);
    i++;
  }
  return values;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mbox = args.get("--mbox");
  if (!mbox) throw new Error("Give the mbox file: npm run eval:import -- --mbox <file>");
  const archive = resolve(args.get("--archive") ?? join("private", "archive"));
  const profile = resolve(args.get("--profile") ?? join("private", "profile.yaml"));
  const { examples, problems } = styleExamplesOf(profile);
  for (const problem of problems) console.warn(`Warning: ${problem}; it cannot be left out.`);

  const report = await importMbox(resolve(mbox), archive, {
    attachment: args.get("--attachment") ?? "resume.pdf",
    styleExamples: examples,
  });

  console.log(`New cases in ${archive}: ${report.cases.length}`);
  for (const entry of report.cases) console.log(`  ${entry.id}  ${entry.subject}`);
  console.log(`Already imported: ${report.alreadyImported}`);
  console.log(
    `Skipped: ${report.skipped.not_sent} not marked Sent, ${report.skipped.no_resume} without the CV, ${report.skipped.style_example} matching a style example`,
  );
  for (const entry of report.malformed) {
    console.log(`Could not read message ${entry.index}: ${entry.error}`);
  }
  console.log("Next: copy each post's screenshots from the phone into its case folder.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
