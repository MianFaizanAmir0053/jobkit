import type { DraftOutput } from "@/core/drafting/draftStage";
import type { FitRow } from "@/core/drafting/kit";
import type { Role } from "@/core/extraction/record";

import { flagKey, isMeetable } from "./decisions";

/**
 * The fit table (review spec, "Job page", item 4): each of the chosen
 * role's requirements with the verdict the draft gave it and the one the
 * fit check counts, the facts it cited and its note, or none when the
 * draft did not weigh it; why validate flagged the row, if it did, with
 * that flag's key, its place among the kit's flags as the review decisions
 * name it; and whether the row takes the owner's "I meet this
 * requirement", for one only they can confirm they meet, which clears that
 * flag as its "I checked this" does.
 */

export interface FitTableRow {
  id: string;
  text: string;
  /** Whether it is a must-have; else a nice-to-have. */
  must: boolean;
  /** The verdict the draft gave it; null when it gave none. */
  verdict: FitRow["verdict"] | null;
  /**
   * The verdict the fit check counts: partial for a met its facts do not
   * bear out; met for one only the owner can confirm, until validate runs
   * again with their tick (Task 29); null when the draft gave none.
   */
  counted: FitRow["verdict"] | null;
  factIds: string[];
  note: string;
  /** validate's words for a row it flagged as unverified or missing; null for none. */
  why: string | null;
  /** That flag's key, which the owner's decisions name; null for none. */
  flag: string | null;
  /** Whether the owner's "I meet this requirement" clears the flag. */
  tick: boolean;
}

export function fitTableOf(role: Role, draft: Pick<DraftOutput, "fit" | "flags">): FitTableRow[] {
  return role.requirements.map((requirement) => {
    const row = draft.fit.find((entry) => entry.requirementId === requirement.id);
    const place = draft.flags.findIndex(
      (flag) =>
        (flag.kind === "fit_unverified" || flag.kind === "fit_missing") &&
        flag.at === requirement.id,
    );
    const flag = place >= 0 ? draft.flags[place]! : null;
    const tick = flag !== null && isMeetable(flag);
    const unverified = flag?.kind === "fit_unverified" && !tick;
    return {
      id: requirement.id,
      text: requirement.text,
      must: requirement.priority === "must",
      verdict: row?.verdict ?? null,
      counted: row ? (unverified && row.verdict === "met" ? "partial" : row.verdict) : null,
      factIds: row?.factIds ?? [],
      note: row?.note ?? "",
      why: flag?.message ?? null,
      flag: flag ? flagKey(place) : null,
      tick,
    };
  });
}
