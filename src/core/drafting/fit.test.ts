import { describe, expect, it } from "vitest";

import type { Role } from "@/core/extraction/record";
import type { Fact } from "@/core/profile/schema";

import { checkFit } from "./fit";
import type { FitRow } from "./kit";

/* The fit check: drafting AC5. */

type Requirement = Role["requirements"][number];

const requirement = (overrides: Partial<Requirement> & Pick<Requirement, "id">): Requirement => ({
  text: "A requirement",
  priority: "must",
  kind: "skill",
  skills: [],
  depth: "any",
  years: -1,
  ...overrides,
});

const fact = (overrides: Partial<Fact> & Pick<Fact, "id">): Fact => ({
  statement: "A statement.",
  phrase: "a phrase",
  kind: "skill",
  skills: [],
  depth: "production",
  source: "test",
  approved: true,
  ...overrides,
});

const role = (requirements: Requirement[]): Role => ({ requirements }) as unknown as Role;

const met = (requirementId: string, factIds: string[]): FitRow => ({
  requirementId,
  verdict: "met",
  factIds,
  note: "",
});

const facts = [
  fact({ id: "F-k8s-learning", skills: ["kubernetes"], depth: "learning", years: 1 }),
  fact({ id: "F-docker", skills: ["docker"], depth: "production", years: 5 }),
  fact({ id: "F-k8s-prod", skills: ["kubernetes"], depth: "production", years: 2 }),
  fact({ id: "F-bsc", kind: "education", skills: [], depth: "professional" }),
];

describe("checkFit", () => {
  it("does not believe 'production Kubernetes' met by a fact still learning it", () => {
    const result = checkFit(
      role([requirement({ id: "R1", skills: ["kubernetes"], depth: "production" })]),
      [met("R1", ["F-k8s-learning"])],
      facts,
    );

    expect(result.flags).toEqual([
      { kind: "fit_unverified", requirementId: "R1", reason: "facts" },
    ]);
    expect(result.verdicts.get("R1")).toBe("partial");
  });

  it("does not believe '3+ years Kubernetes' met by a fact about Docker only, nor by too few years", () => {
    const threeYears = role([requirement({ id: "R1", skills: ["kubernetes"], years: 3 })]);

    expect(checkFit(threeYears, [met("R1", ["F-docker"])], facts).flags).toEqual([
      { kind: "fit_unverified", requirementId: "R1", reason: "facts" },
    ]);
    expect(checkFit(threeYears, [met("R1", ["F-k8s-prod"])], facts).flags).toEqual([
      { kind: "fit_unverified", requirementId: "R1", reason: "facts" },
    ]);
  });

  it("believes a verdict its facts bear out, taking the strongest depth and the most years among them", () => {
    const result = checkFit(
      role([requirement({ id: "R1", skills: ["kubernetes"], depth: "production", years: 1 })]),
      [met("R1", ["F-k8s-learning", "F-k8s-prod"])],
      facts,
    );

    expect(result.flags).toEqual([]);
    expect(result.verdicts.get("R1")).toBe("met");
  });

  it("meets a degree only with a cited education fact", () => {
    const degree = role([
      requirement({ id: "R1", kind: "education", text: "BSc in Computer Science" }),
    ]);

    expect(checkFit(degree, [met("R1", ["F-bsc"])], facts).flags).toEqual([]);
    expect(checkFit(degree, [met("R1", ["F-docker"])], facts).flags).toEqual([
      { kind: "fit_unverified", requirementId: "R1", reason: "facts" },
    ]);
  });

  it("ignores a cited fact the profile does not have", () => {
    expect(
      checkFit(
        role([requirement({ id: "R1", skills: ["docker"] })]),
        [met("R1", ["F-gone"])],
        facts,
      ).flags,
    ).toEqual([{ kind: "fit_unverified", requirementId: "R1", reason: "facts" }]);
  });

  it("asks the owner to confirm a language or other requirement, counting it met meanwhile", () => {
    const result = checkFit(
      role([requirement({ id: "R1", kind: "language", text: "Fluent English" })]),
      [met("R1", [])],
      facts,
    );

    expect(result.flags).toEqual([
      { kind: "fit_unverified", requirementId: "R1", reason: "needs_tick" },
    ]);
    expect(result.verdicts.get("R1")).toBe("met");
  });

  it("flags a requirement with no row, counting it a gap, and keeps the model's partial and gap verdicts", () => {
    const result = checkFit(
      role([requirement({ id: "R1" }), requirement({ id: "R2" }), requirement({ id: "R3" })]),
      [
        { requirementId: "R2", verdict: "partial", factIds: [], note: "" },
        { requirementId: "R3", verdict: "gap", factIds: [], note: "" },
      ],
      facts,
    );

    expect(result.flags).toEqual([{ kind: "fit_missing", requirementId: "R1" }]);
    expect([...result.verdicts]).toEqual([
      ["R1", "gap"],
      ["R2", "partial"],
      ["R3", "gap"],
    ]);
  });
});
