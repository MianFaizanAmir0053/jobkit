import type { Role } from "@/core/extraction/record";
import type { Fact } from "@/core/profile/schema";

import { canonicalSkill } from "./build";
import type { FitRow, Verdict } from "./kit";

/**
 * The fit check (drafting spec, "Fit check", with the owner's rule of
 * 2026-10-12): code checks every `met` verdict against the facts it cites.
 * A skill or experience requirement is met only when, for every skill it
 * names, one cited fact has that skill at the depth it asks and with the
 * years it states: depth and years from the same fact, never one from each.
 * An experience requirement naming no skill ("3+ years of professional
 * software development") is met by one cited work fact with the depth and
 * years it asks; one that asks neither ("experience leading a team") names
 * nothing code can check, so it is never met by code (the owner's rule,
 * 2026-10-12).
 * An education requirement needs a cited education fact. Anything short of
 * that is `fit_unverified` and counts as partial, so a must-have needs a gap
 * line; a requirement with no row is `fit_missing` and counts as a gap.
 *
 * A language or "other" requirement is met only with the owner's tick,
 * which the review page will offer. Until it does, such a row is flagged
 * for the owner to confirm but still counts as met, so the kit does not
 * demand a gap line for, say, written English the owner has.
 */

export type FitFlag =
  | { kind: "fit_unverified"; requirementId: string; reason: "facts" | "needs_tick" }
  | { kind: "fit_missing"; requirementId: string };

const DEPTH_RANK: Record<Fact["depth"], number> = {
  learning: 0,
  "side-project": 1,
  professional: 2,
  production: 3,
};

/** Facts about work, which an experience requirement can rest on: not a degree, a language or "other". */
const WORK_KINDS: ReadonlySet<Fact["kind"]> = new Set(["skill", "experience", "project", "metric"]);

const REQUIRED_RANK: Record<Role["requirements"][number]["depth"], number> = {
  any: 0,
  professional: 2,
  production: 3,
};

export function checkFit(
  role: Role,
  fit: readonly FitRow[],
  facts: readonly Fact[],
): { flags: FitFlag[]; verdicts: Map<string, Verdict> } {
  const flags: FitFlag[] = [];
  const verdicts = new Map<string, Verdict>();
  for (const requirement of role.requirements) {
    const row = fit.find((entry) => entry.requirementId === requirement.id);
    if (!row) {
      flags.push({ kind: "fit_missing", requirementId: requirement.id });
      verdicts.set(requirement.id, "gap");
      continue;
    }
    if (row.verdict !== "met") {
      verdicts.set(requirement.id, row.verdict);
      continue;
    }
    const cited = facts.filter((fact) => row.factIds.includes(fact.id));
    if (requirement.kind === "language" || requirement.kind === "other") {
      flags.push({ kind: "fit_unverified", requirementId: requirement.id, reason: "needs_tick" });
      verdicts.set(requirement.id, "met");
      continue;
    }
    const shown =
      requirement.kind === "education"
        ? cited.some((fact) => fact.kind === "education")
        : showsEverySkill(requirement, cited);
    if (!shown) {
      flags.push({ kind: "fit_unverified", requirementId: requirement.id, reason: "facts" });
    }
    verdicts.set(requirement.id, shown ? "met" : "partial");
  }
  return { flags, verdicts };
}

function showsEverySkill(
  requirement: Role["requirements"][number],
  cited: readonly Fact[],
): boolean {
  const deepEnough = (fact: Fact) =>
    DEPTH_RANK[fact.depth] >= REQUIRED_RANK[requirement.depth] &&
    (requirement.years < 0 || (fact.years ?? 0) >= requirement.years);
  const skills = requirement.skills.map(canonicalSkill);
  if (skills.length === 0) {
    const asks = requirement.depth !== "any" || requirement.years >= 0;
    return (
      requirement.kind === "experience" &&
      asks &&
      cited.some((fact) => WORK_KINDS.has(fact.kind) && deepEnough(fact))
    );
  }
  return skills.every((skill) =>
    cited.some((fact) => fact.skills.includes(skill) && deepEnough(fact)),
  );
}
