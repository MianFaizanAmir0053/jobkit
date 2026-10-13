/**
 *   npm run profile:seed                                         private/profile.yaml, into the local database
 *   npm run profile:seed -- --prod                               private/profile.yaml, into production
 *   npm run profile:seed -- evals/synthetic/profile.sample.yaml  the public sample, locally
 *   npm run profile:seed -- --list [--prod]                      the stored versions, newest first
 *   npm run profile:seed -- --activate <hash start> [--prod]     makes a stored version active again
 *
 * Checks the profile file, its CV and its style examples (profile spec,
 * "Seeding"), and reports every problem with its line. A good file becomes
 * the active version; one already seeded is made active again. --activate
 * rolls back to a stored version whose files the owner no longer has.
 */
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { systemClock } from "@/adapters/clock";
import { listVersions } from "@/core/profile/profile";
import { activateByHash, seedProfile, type SeedResult } from "@/core/profile/seed";
import { loadProfileFile } from "@/server/profileFile";

import { parseTarget, refuseSwallowedFlags, type Target } from "./ops";
import { openTarget } from "./targets";

/** The script's name in the local database's lock. */
const HOLDER = "npm run profile:seed";

type Command =
  { kind: "seed"; file: string } | { kind: "list" } | { kind: "activate"; hashStart: string };

/** The command, and the arguments left for parseTarget, which refuses any it does not know. */
function parseArgs(args: readonly string[]): { command: Command; rest: string[] } {
  const at = args.indexOf("--activate");
  if (at >= 0) {
    const hashStart = args[at + 1];
    if (hashStart === undefined || hashStart.startsWith("-")) {
      throw new Error("--activate needs the start of a version's hash, as --list shows it");
    }
    return {
      command: { kind: "activate", hashStart },
      rest: args.filter((_, i) => i !== at && i !== at + 1),
    };
  }
  if (args.includes("--list")) {
    return { command: { kind: "list" }, rest: args.filter((arg) => arg !== "--list") };
  }
  const file = args.find((arg) => !arg.startsWith("-"));
  return {
    command: { kind: "seed", file: resolve(file ?? join("private", "profile.yaml")) },
    rest: args.filter((arg) => arg !== file),
  };
}

async function main(): Promise<void> {
  refuseSwallowedFlags(["list", "activate"]);
  const { command, rest } = parseArgs(process.argv.slice(2));
  const target = parseTarget(rest);
  if (command.kind === "seed") return seed(command.file, target);

  const doing =
    command.kind === "list"
      ? "list the profile versions in"
      : "change the active profile version in";
  const { db, where } = await openTarget(target, doing, HOLDER);
  try {
    if (command.kind === "activate")
      return report(await activateByHash(db, command.hashStart), where);
    const versions = await listVersions(db);
    if (versions.length === 0) console.log(`No profile version is stored in ${where}.`);
    for (const version of versions) {
      const when = version.createdAt.toISOString().slice(0, 16).replace("T", " ");
      const facts = `${version.facts.approved} approved, ${version.facts.waiting} waiting`;
      console.log(
        `${version.hash.slice(0, 12)}  ${when} UTC  ${facts}${version.active ? "  (active)" : ""}`,
      );
    }
  } finally {
    await db.close();
  }
}

async function seed(file: string, target: Target): Promise<void> {
  if (!existsSync(file)) {
    throw new Error(
      `${file} does not exist: see runbook step 13, and the profile spec, "Drafting the first version"`,
    );
  }
  const checked = loadProfileFile(file);
  if (!checked.ok) {
    for (const { line, message } of checked.problems) console.error(`line ${line}: ${message}`);
    throw new Error(`${checked.problems.length} problem(s), so nothing was seeded.`);
  }
  // Named before production asks for its reference, so the public sample cannot go there unseen.
  const approved = checked.profile.facts.filter((fact) => fact.approved).length;
  const what = `seed ${relative(process.cwd(), file)} (${checked.profile.owner.name}, ${approved} approved facts, hash ${checked.hash.slice(0, 12)}) into`;
  const { db, storage, where } = await openTarget(target, what, HOLDER);
  try {
    report(await seedProfile({ db, storage, clock: systemClock }, checked), where);
  } finally {
    await db.close();
  }
}

function report(result: SeedResult, where: string): void {
  if (result.status === "refused") throw new Error(`Nothing changed: ${result.message}.`);
  const said = {
    created: "Seeded a new profile version",
    reactivated: "Made an earlier profile version active again",
    unchanged: "Nothing changed; the active profile version is",
  }[result.status];
  console.log(`${said} ${result.versionId} in ${where}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
