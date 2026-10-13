/**
 *   npm run eval:summary                 the latest runs' aggregates, into private/evals/summary.md
 *   npm run eval:summary -- --publish    that file as it stands, after you have read it, to evals/results/<date>.md
 *
 * Writes the aggregate-only summary (evals spec, "Runs, budget and
 * reports"): shares with their counts and intervals, cost and time, and the
 * model comparison, with no case's words, names, addresses or phone
 * numbers. It is checked for anything from a case before it is written,
 * and again before it is published. Publishing is the owner's approval:
 * --publish copies exactly the file the owner read, and git keeps it only
 * once they commit it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { checkSummary, readReports, summaryOf } from "../evals/summary";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--publish")) {
    throw new Error("npm run eval:summary takes no arguments, or --publish.");
  }
  const evalsDir = resolve(join("private", "evals"));
  const reports = readReports(join(evalsDir, "runs"));
  const draft = join(evalsDir, "summary.md");
  if (args[0] === "--publish") {
    if (!existsSync(draft)) {
      throw new Error("Write the summary first with npm run eval:summary, and read it.");
    }
    const text = readFileSync(draft, "utf8");
    const found = checkSummary(text, reports);
    if (found.length > 0) {
      throw new Error(
        `${draft} holds ${found.length} strings from cases, addresses or long numbers: nothing was published.`,
      );
    }
    const published = resolve(
      join("evals", "results", `${new Date().toISOString().slice(0, 10)}.md`),
    );
    mkdirSync(join("evals", "results"), { recursive: true });
    writeFileSync(published, text);
    console.log(`Published to ${published}. Commit it when you are ready for it to be public.`);
    return;
  }
  if (reports.length === 0) throw new Error("No evaluation runs yet: run npm run eval first.");
  const text = summaryOf(reports, new Date());
  const found = checkSummary(text, reports);
  if (found.length > 0) {
    throw new Error(
      `The summary would hold ${found.length} strings from cases: nothing was written.`,
    );
  }
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(draft, text);
  console.log(
    `Written to ${draft}. Read it; to publish it as it stands, run npm run eval:summary -- --publish.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
