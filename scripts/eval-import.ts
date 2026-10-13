/**
 *   npm run eval:import -- --mbox <file>                       a Takeout mbox of sent mail
 *   npm run eval:import -- --eml <folder>                      .eml files saved with Gmail's "Download message"
 *   npm run eval:import -- ... --archive <folder>              into another archive under private/
 *   npm run eval:import -- ... --profile <file>                style examples from another profile file
 *   npm run eval:import -- ... --attachment cv.pdf             another CV file name than resume.pdf
 *   npm run eval:import -- ... --jobkit-from <YYYY-MM-DD>      the day you first sent an application jobkit drafted
 *
 * Makes one case folder per sent application (evals spec, "Case sources"),
 * leaving out any whose body holds one of the profile's style examples,
 * and any sent from the day jobkit began drafting, whose words may be a
 * model's. The first import must be told that day (today, if jobkit has
 * drafted nothing yet), and the archive keeps it; a later day is refused.
 * Downloaded messages count only when they are from OWNER_EMAIL. Cases set
 * aside as not applications are not brought back. Reports what it kept,
 * skipped and could not read. Nothing leaves the laptop: it reads and
 * writes local files only.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  dayOf,
  importEmlFolder,
  importMbox,
  jobkitFromOf,
  keepImportRecord,
  styleExamplesOf,
  underPrivate,
} from "../evals/import";

import { loadLocalEnv } from "./ops";

const VALUED = new Set([
  "--mbox",
  "--eml",
  "--archive",
  "--profile",
  "--attachment",
  "--jobkit-from",
]);

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
  const eml = args.get("--eml");
  if (!mbox === !eml) {
    throw new Error(
      "Give one source: npm run eval:import -- --mbox <file>, or -- --eml <folder of .eml files>",
    );
  }
  const archive = resolve(args.get("--archive") ?? join("private", "archive"));
  // Real mail stays where git and the commit guard ignore it, on this laptop.
  if (!underPrivate(resolve("private"), archive)) {
    throw new Error("--archive must be a folder under private/, on this laptop.");
  }
  // The source must be there before anything is kept, the day jobkit began drafting included.
  const source = resolve((mbox ?? eml)!);
  if (!existsSync(source) || statSync(source).isFile() !== Boolean(mbox)) {
    throw new Error(mbox ? `No mbox file at ${source}` : `No folder at ${source}`);
  }
  // A downloaded message carries no Sent label: it counts only from the owner's address.
  const owner =
    process.env.OWNER_EMAIL ?? (existsSync(".env.local") ? loadLocalEnv().OWNER_EMAIL : undefined);
  if (eml && !owner) {
    throw new Error("--eml needs OWNER_EMAIL in .env.local, to keep only mail you sent.");
  }
  const profile = resolve(args.get("--profile") ?? join("private", "profile.yaml"));
  const { examples, problems } = styleExamplesOf(profile);
  for (const problem of problems) {
    console.warn(
      `Warning: ${problem}; the labelling page and eval:split check the examples again once they can be read.`,
    );
  }
  const given = args.get("--jobkit-from");
  const jobkitFrom = jobkitFromOf(archive, given ? dayOf(given) : null);
  // Kept before any case is written, so the archive never holds mail without it.
  keepImportRecord(archive, { jobkitFrom, leftOut: [] });
  const options = {
    attachment: args.get("--attachment") ?? "resume.pdf",
    styleExamples: examples,
    jobkitFrom,
    ...(owner ? { owner } : {}),
  };

  const report = mbox
    ? await importMbox(source, archive, options)
    : await importEmlFolder(source, archive, options);
  // Mail left out for a style example, so its replies and resends are left out when cases are read.
  keepImportRecord(archive, { jobkitFrom, leftOut: report.leftOut });

  console.log(`New cases in ${archive}: ${report.cases.length}`);
  for (const entry of report.cases) console.log(`  ${entry.id}  ${entry.subject}`);
  console.log(`Already imported: ${report.alreadyImported}`);
  if (report.repaired > 0)
    console.log(`Written again, after an import cut short: ${report.repaired}`);
  if (report.dismissed > 0) console.log(`Set aside as not applications: ${report.dismissed}`);
  if (report.removed > 0) {
    console.log(`Removed from the archive after they were given a split: ${report.removed}`);
  }
  console.log(
    `Skipped: ${report.skipped.not_sent} not marked Sent or not from you, ${report.skipped.no_resume} without the CV, ${report.skipped.style_example} matching a style example, ${report.skipped.after_jobkit} sent from ${jobkitFrom.toLocaleString()} on, when jobkit may have drafted them, or with no date`,
  );
  for (const entry of report.malformed) {
    console.log(`Could not read message ${entry.file ?? entry.index}: ${entry.error}`);
  }
  console.log(
    "Next: copy the phone's screenshots into private/archive/_screenshots/ and match them on /dev/label; then run npm run eval:split.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
