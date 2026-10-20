/**
 *   npm run eval:judge-set                                   where the judge set stands
 *   npm run eval:judge-set -- --from private/evals/judge-candidates.json   make it, once
 *
 * The frozen judge set (evals spec, "Labelling"): Claude Code drafts
 * candidate sentences against the profile's approved facts, each with the
 * facts it cites and what it is meant to be, into a candidates file; this
 * makes private/evals/judge-set.json from it, each cited fact frozen whole,
 * and refuses once the set exists, as it never changes. The owner then
 * labels each sentence once on /dev/label/judge, blind to any verdict.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { validateProfile } from "@/core/profile/validate";

import { type Candidate, createJudgeSet, JUDGE_LABELS, readJudgeSet } from "../evals/judgeSet";

function main(): void {
  const args = process.argv.slice(2);
  const file = resolve(join("private", "evals", "judge-set.json"));
  if (args.length === 0) {
    const set = readJudgeSet(file);
    if (!set) {
      console.log(`No judge set yet: make it with --from <candidates file>. It would be ${file}.`);
      return;
    }
    const labelled = set.items.filter((item) => item.label !== null);
    console.log(
      `${set.items.length} sentences, made ${set.createdAt.slice(0, 10)}; ${labelled.length} labelled (${JUDGE_LABELS.map((label) => `${labelled.filter((item) => item.label === label).length} ${label}`).join(", ")}).`,
    );
    return;
  }
  if (args.length !== 2 || args[0] !== "--from") {
    throw new Error("npm run eval:judge-set takes no arguments, or --from <candidates file>.");
  }
  const candidates = JSON.parse(readFileSync(resolve(args[1]!), "utf8")) as Candidate[];
  const profileFile = resolve(join("private", "profile.yaml"));
  const checked = validateProfile(readFileSync(profileFile, "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(dirname(profileFile), path))),
  });
  if (!checked.ok) {
    throw new Error(
      `${profileFile} has problems: ${checked.problems.map((problem) => problem.message).join("; ")}`,
    );
  }
  const set = createJudgeSet(file, candidates, checked.profile.facts, new Date());
  console.log(
    `Made ${file} with ${set.items.length} sentences. Label each once on /dev/label/judge.`,
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
