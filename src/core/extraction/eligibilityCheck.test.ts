import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkEligibility,
  type EligibilityProfile,
  offsetMinutes,
  overlapMinutes,
} from "./eligibilityCheck";
import type { JobRecord, Role } from "./record";

/* The eligibility table: extraction AC11. */

const base: Role = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "evals", "synthetic", "records", "S01-email-simple.json"),
      "utf8",
    ),
  ) as JobRecord
).roles[0]!;

/** A role like S01's, with no location, permit or time-zone demands unless a test sets them. */
function role(overrides: {
  location?: Partial<Role["location"]>;
  eligibility?: Partial<Role["eligibility"]>;
}): Role {
  return {
    ...base,
    location: {
      work_mode: "remote",
      places: [],
      remote_regions: [],
      time_zone: { zone: "unspecified", min_overlap_hours: -1, text: "" },
      ...overrides.location,
    },
    eligibility: {
      work_authorisation: [],
      sponsorship: "unspecified",
      other_limits: [],
      ...overrides.eligibility,
    },
  };
}

const profile: EligibilityProfile = {
  home: "PK",
  fixedAnswers: {
    work_authorisation: [
      { place: "PK", authorised: true },
      { place: "EU", authorised: false, sponsorship_needed: true },
      { place: "AE", authorised: false, sponsorship_needed: true },
    ],
    relocation: { open: true, places: ["AE"], text: "Open to relocating to the UAE" },
    working_window: { start_utc: "04:00", end_utc: "13:00", text: "09:00 to 18:00 Pakistan time" },
  },
};

const JULY = new Date("2026-07-15T12:00:00Z");
const check = (subject: Role, owner: EligibilityProfile = profile, at: Date = JULY) =>
  checkEligibility(subject, owner, at);

describe("remote regions", () => {
  it("passes a region that includes the owner's country, and refuses one that does not", () => {
    expect(check(role({ location: { remote_regions: ["worldwide"] } })).result).toBe("eligible");
    expect(check(role({ location: { remote_regions: ["US only"] } }))).toEqual({
      result: "likely_ineligible",
      reasons: [
        {
          kind: "remote_region",
          result: "likely_ineligible",
          message: "Remote work is open only to United States, which does not include Pakistan.",
          quote: "US only",
        },
      ],
    });
  });

  it("is unclear for a region with no agreed countries, and for one the table does not know", () => {
    expect(check(role({ location: { remote_regions: ["EMEA"] } })).result).toBe("unclear");
    expect(check(role({ location: { remote_regions: ["Southeast Asia"] } })).result).toBe(
      "unclear",
    );
  });

  it("passes when any region it names includes the owner's country", () => {
    expect(check(role({ location: { remote_regions: ["US", "Pakistan"] } })).result).toBe(
      "eligible",
    );
    expect(check(role({ location: { remote_regions: ["US", "EMEA"] } })).result).toBe("unclear");
  });
});

describe("work authorisation", () => {
  const germany = (sponsorship: Role["eligibility"]["sponsorship"]) =>
    role({
      eligibility: {
        work_authorisation: [{ place: "DE", quote: "Must be authorised to work in Germany" }],
        sponsorship,
      },
    });

  it("meets Germany through the profile's EU entry: no sponsorship is likely ineligible, unspecified is unclear", () => {
    expect(check(germany("not_offered")).result).toBe("likely_ineligible");
    expect(check(germany("unspecified")).result).toBe("unclear");
    expect(check(germany("offered")).result).toBe("unclear");
  });

  it("is unclear for a place the profile does not cover, and passes one the owner may work in", () => {
    const canada = role({
      eligibility: { work_authorisation: [{ place: "CA", quote: "Eligible to work in Canada" }] },
    });
    expect(check(canada).reasons).toEqual([
      {
        kind: "work_authorisation",
        result: "unclear",
        message: "Your profile does not say whether you may work in Canada.",
        quote: "Eligible to work in Canada",
      },
    ]);
    const pakistan = role({
      eligibility: { work_authorisation: [{ place: "PK", quote: "Pakistan only" }] },
    });
    expect(check(pakistan).result).toBe("eligible");
  });
});

describe("onsite and hybrid places", () => {
  const onsite = (...places: [string, string][]) =>
    role({
      location: { work_mode: "onsite", places: places.map(([text, code]) => ({ text, code })) },
    });

  it("passes 'London or Lahore' through Lahore", () => {
    expect(check(onsite(["London", "GB"], ["Lahore", "PK"])).result).toBe("eligible");
  });

  it("is unclear onsite in Dubai with relocation open to the UAE", () => {
    expect(check(onsite(["Dubai", "AE"]))).toMatchObject({ result: "unclear" });
  });

  it("is likely ineligible onsite in Berlin with relocation open only to the UAE, or closed", () => {
    expect(check(onsite(["Berlin", "DE"])).result).toBe("likely_ineligible");
    const closed: EligibilityProfile = {
      ...profile,
      fixedAnswers: {
        ...profile.fixedAnswers,
        relocation: { open: false, places: [], text: "Not open to relocating" },
      },
    };
    expect(check(onsite(["Dubai", "AE"]), closed).result).toBe("likely_ineligible");
  });

  it("is unclear with relocation open anywhere, and for a place it cannot place", () => {
    const anywhere: EligibilityProfile = {
      ...profile,
      fixedAnswers: {
        ...profile.fixedAnswers,
        relocation: { open: true, places: [], text: "Open to relocating" },
      },
    };
    expect(check(onsite(["Berlin", "DE"]), anywhere).result).toBe("unclear");
    expect(check(onsite(["Springfield", "unknown"])).result).toBe("unclear");
  });

  it("takes a hybrid role's places as an onsite role's", () => {
    expect(
      check(role({ location: { work_mode: "hybrid", places: [{ text: "Berlin", code: "DE" }] } }))
        .result,
    ).toBe("likely_ineligible");
  });
});

describe("other limits", () => {
  it("is unclear for a citizenship limit, quoting it", () => {
    expect(
      check(role({ eligibility: { other_limits: ["Must be a US citizen"] } })).reasons,
    ).toEqual([
      {
        kind: "other_limit",
        result: "unclear",
        message: "The post sets another limit. Check whether you meet it.",
        quote: "Must be a US citizen",
      },
    ]);
  });
});

describe("time zone", () => {
  const sydney = (hours = -1) =>
    role({
      location: {
        time_zone: { zone: "Australia/Sydney", min_overlap_hours: hours, text: "Sydney hours" },
      },
    });

  it("computes the overlap with Sydney's working day across midnight in UTC", () => {
    // July: Sydney is UTC+10, so its 09:00 to 17:00 is 23:00 to 07:00 UTC: 3 hours with 04:00 to 13:00.
    expect(check(sydney(), profile, JULY).result).toBe("eligible");
    expect(check(sydney(4), profile, JULY).reasons).toEqual([
      {
        kind: "time_zone",
        result: "unclear",
        message:
          "Your working hours overlap Australia/Sydney's working day by 3 hours; the post asks for 4.",
        quote: "Sydney hours",
      },
    ]);
    // January: daylight saving makes it UTC+11, 22:00 to 06:00 UTC: 2 hours.
    const january = new Date("2026-01-15T12:00:00Z");
    expect(check(sydney(3), profile, january).reasons[0]?.message).toContain("by 2 hours");
  });

  it("asks for 2 hours when the post names a zone but no overlap", () => {
    const losAngeles = role({
      location: { time_zone: { zone: "America/Los_Angeles", min_overlap_hours: -1, text: "PT" } },
    });
    expect(check(losAngeles).result).toBe("unclear");
  });

  it("does not check an unspecified zone, nor one this runtime does not know", () => {
    expect(check(role({})).result).toBe("eligible");
    const unknown = role({
      location: { time_zone: { zone: "Mars/Olympus", min_overlap_hours: 4, text: "" } },
    });
    expect(check(unknown).result).toBe("eligible");
  });

  it("counts windows on a 24-hour circle", () => {
    expect(overlapMinutes([22 * 60, 6 * 60], [4 * 60, 13 * 60])).toBe(120);
    expect(overlapMinutes([0, 60], [23 * 60, 30])).toBe(30);
    expect(offsetMinutes("Asia/Karachi", JULY)).toBe(300);
  });
});

describe("the overall result", () => {
  it("is the most severe finding across the checks", () => {
    const mixed = role({
      location: { remote_regions: ["US only"] },
      eligibility: { other_limits: ["Security clearance required"] },
    });

    const result = check(mixed);

    expect(result.result).toBe("likely_ineligible");
    expect(result.reasons.map((reason) => reason.kind)).toEqual(["remote_region", "other_limit"]);
  });
});
