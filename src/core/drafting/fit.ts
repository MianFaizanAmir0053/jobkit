import type { Role } from "@/core/extraction/record";
import type { Fact } from "@/core/profile/schema";

import type { FitRow, Verdict } from "./kit";

/**
 * The fit check (drafting spec, "Fit check"): code checks every `met`
 * verdict against the facts it cites. A skill or experience requirement
 * needs a cited fact sharing one of its skills, at the depth it asks and
 * with the years it states, taken from the strongest such fact; an
 * education requirement needs a cited education fact. Anything short of
 * that is `fit_unverified` and counts as partial, so a must-have needs a
 * gap line; a requirement with no row is `fit_missing` and counts as a gap.
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
        : showsSkill(requirement, cited);
    if (!shown) {
      flags.push({ kind: "fit_unverified", requirementId: requirement.id, reason: "facts" });
    }
    verdicts.set(requirement.id, shown ? "met" : "partial");
  }
  return { flags, verdicts };
}

function showsSkill(requirement: Role["requirements"][number], cited: readonly Fact[]): boolean {
  const sharing = cited.filter((fact) =>
    fact.skills.some((skill) => requirement.skills.includes(skill)),
  );
  if (sharing.length === 0) return false;
  const depth = Math.max(...sharing.map((fact) => DEPTH_RANK[fact.depth]));
  if (depth < REQUIRED_RANK[requirement.depth]) return false;
  if (requirement.years < 0) return true;
  return Math.max(...sharing.map((fact) => fact.years ?? 0)) >= requirement.years;
}
