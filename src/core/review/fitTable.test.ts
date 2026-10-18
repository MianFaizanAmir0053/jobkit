import { describe, expect, it } from "vitest";

import type { FitRow } from "@/core/drafting/kit";
import { ONLY_YOU_CAN_CONFIRM, type KitFlag } from "@/core/drafting/validate";
import type { Role } from "@/core/extraction/record";

import { fitTableOf } from "./fitTable";

/* The fit table: review spec, "Job page", item 4. */

type Requirement = Role["requirements"][number];
const requirement = (
  id: string,
  text: string,
  kind: Requirement["kind"] = "skill",
  priority: Requirement["priority"] = "must",
): Requirement => ({ id, text, kind, priority, skills: [], depth: "any", years: -1 });

const role = (requirements: Requirement[]) => ({ requirements }) as unknown as Role;

const fit = (
  requirementId: string,
  verdict: FitRow["verdict"],
  factIds: string[] = [],
  note = "",
) => ({ requirementId, verdict, factIds, note }) satisfies FitRow;

describe("fitTableOf", () => {
  it("gives each requirement its verdict, cited facts and note, and none for one not weighed", () => {
    const rows = fitTableOf(
      role([
        requirement("R1", "4+ years with React", "experience"),
        requirement("R2", "AWS", "skill", "nice"),
      ]),
      { fit: [fit("R1", "met", ["F-react"], "Five years.")], flags: [] },
    );

    expect(rows).toEqual([
      {
        id: "R1",
        text: "4+ years with React",
        must: true,
        verdict: "met",
        counted: "met",
        factIds: ["F-react"],
        note: "Five years.",
        why: null,
        flag: null,
        tick: false,
      },
      {
        id: "R2",
        text: "AWS",
        must: false,
        verdict: null,
        counted: null,
        factIds: [],
        note: "",
        why: null,
        flag: null,
        tick: false,
      },
    ]);
  });

  it("says why a row is flagged, and offers the tick only where only the owner can confirm it", () => {
    const flags: KitFlag[] = [
      { kind: "over_limit", at: "body", message: "Too long." },
      {
        kind: "fit_unverified",
        at: "R1",
        message: "Marked as met, but no cited fact shows every skill named.",
      },
      { kind: "fit_unverified", at: "R2", message: ONLY_YOU_CAN_CONFIRM },
      { kind: "fit_missing", at: "R3", message: "The draft did not weigh this requirement." },
    ];

    const rows = fitTableOf(
      role([
        requirement("R1", "Node.js"),
        requirement("R2", "Fluent Urdu", "language"),
        requirement("R3", "Leads a team", "other"),
      ]),
      { fit: [fit("R1", "met", ["F-node"]), fit("R2", "met")], flags },
    );

    // Each flag named by its place among the kit's flags, as the review decisions name flags; a met
    // verdict its facts do not bear out counts as partial, as the fit check counts it.
    expect(
      rows.map(({ id, counted, why, flag, tick }) => ({ id, counted, why, flag, tick })),
    ).toEqual([
      {
        id: "R1",
        counted: "partial",
        why: "Marked as met, but no cited fact shows every skill named.",
        flag: "F2",
        tick: false,
      },
      { id: "R2", counted: "met", why: ONLY_YOU_CAN_CONFIRM, flag: "F3", tick: true },
      {
        id: "R3",
        counted: null,
        why: "The draft did not weigh this requirement.",
        flag: "F4",
        tick: false,
      },
    ]);
  });
});
