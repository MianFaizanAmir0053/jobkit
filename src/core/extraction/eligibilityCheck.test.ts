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
          message:
            "Remote work is open only to people in the United States, which does not include Pakistan.",
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

  it("skips blank phrases", () => {
    expect(check(role({ location: { remote_regions: [" ", "worldwide"] } })).result).toBe(
      "eligible",
    );
  });
});

describe("where the work is done", () => {
  it("passes 'onsite in Lahore, or remote in the US only' through Lahore", () => {
    const either = role({
      location: {
        work_mode: "onsite",
        places: [{ text: "Lahore", code: "PK" }],
        remote_regions: ["US only"],
      },
    });

    expect(check(either)).toEqual({ result: "eligible", reasons: [] });
  });

  it("takes the least severe finding when no alternative passes", () => {
    const either = role({
      location: {
        work_mode: "onsite",
        places: [{ text: "Dubai", code: "AE" }],
        remote_regions: ["US only"],
      },
    });

    expect(check(either).reasons.map(({ kind, result }) => [kind, result])).toEqual([
      ["place", "unclear"],
    ]);
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

  it("reads a place written as a name rather than a code, and skips a blank entry", () => {
    const written = role({
      eligibility: {
        work_authorisation: [
          { place: "Germany", quote: "Right to work in Germany" },
          { place: "", quote: " " },
        ],
        sponsorship: "not_offered",
      },
    });

    expect(check(written).reasons).toEqual([
      {
        kind: "work_authorisation",
        result: "likely_ineligible",
        message:
          "The role needs the right to work in Germany, which you do not have, and the post offers no sponsorship.",
        quote: "Right to work in Germany",
      },
    ]);
  });

  it("is unclear for a place it cannot place", () => {
    const unknown = role({
      eligibility: { work_authorisation: [{ place: "Narnia", quote: "Right to work in Narnia" }] },
    });

    expect(check(unknown).result).toBe("unclear");
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

  it("reads the post's words before the model's code", () => {
    expect(check(onsite(["Lahore", "GB"])).result).toBe("eligible");
  });

  it("is unclear for a region that takes in the owner's country", () => {
    expect(check(onsite(["South Asia", "SOUTH_ASIA"])).reasons).toEqual([
      {
        kind: "place",
        result: "unclear",
        message:
          "The role is onsite somewhere in South Asia, which includes Pakistan. Check where.",
        quote: "South Asia",
      },
    ]);
  });

  it("is unclear for a region the owner would relocate to part of", () => {
    const germany: EligibilityProfile = {
      ...profile,
      fixedAnswers: {
        ...profile.fixedAnswers,
        relocation: { open: true, places: ["DE"], text: "Open to relocating to Germany" },
      },
    };

    expect(check(onsite(["Europe", "EUROPE"]), germany).result).toBe("unclear");
    expect(check(onsite(["Netherlands", "NL"]), germany).reasons[0]?.message).toBe(
      "The role is onsite in the Netherlands, and your profile is open to relocating only to other places.",
    );
  });

  it("is unclear for an onsite role that does not say where", () => {
    expect(check(role({ location: { work_mode: "onsite", places: [] } })).reasons).toEqual([
      {
        kind: "place",
        result: "unclear",
        message: "The role is onsite, and the post does not say where. Check where you would work.",
        quote: "",
      },
    ]);
  });

  it("checks the places of a role whose work mode is not given, but never past unclear", () => {
    const unspecified = (place: [string, string]) =>
      role({
        location: { work_mode: "unspecified", places: [{ text: place[0], code: place[1] }] },
      });

    expect(check(unspecified(["Berlin", "DE"])).reasons).toEqual([
      {
        kind: "place",
        result: "unclear",
        message:
          "The role is based in Germany, and your profile is open to relocating only to other places.",
        quote: "Berlin",
      },
    ]);
    expect(check(unspecified(["Karachi", "PK"])).result).toBe("eligible");
    expect(check(role({ location: { work_mode: "unspecified" } })).result).toBe("eligible");
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

  it("skips a blank limit", () => {
    expect(check(role({ eligibility: { other_limits: ["", "  "] } })).result).toBe("eligible");
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
          "Your working hours overlap 09:00 to 17:00 in the post's time zone by 3 hours; the post asks for 4 hours.",
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

  it("says 1 hour, not 1 hours", () => {
    // Los Angeles in July is UTC-7: 09:00 to 17:00 there is 16:00 to 00:00 UTC.
    const window: EligibilityProfile = {
      ...profile,
      fixedAnswers: {
        ...profile.fixedAnswers,
        working_window: { start_utc: "09:00", end_utc: "17:00", text: "" },
      },
    };
    const losAngeles = role({
      location: { time_zone: { zone: "America/Los_Angeles", min_overlap_hours: 1.5, text: "PT" } },
    });

    expect(check(losAngeles, window).reasons[0]?.message).toBe(
      "Your working hours overlap 09:00 to 17:00 in the post's time zone by 1 hour; the post asks for 1.5 hours.",
    );
  });

  it("does not check an unspecified zone, and is unclear about one this runtime does not know", () => {
    expect(check(role({})).result).toBe("eligible");
    const unknown = role({
      location: { time_zone: { zone: "Mars/Olympus", min_overlap_hours: 4, text: "Mars time" } },
    });
    expect(check(unknown).reasons).toEqual([
      {
        kind: "time_zone",
        result: "unclear",
        message: "The post asks for a time zone we could not read. Check the hours it means.",
        quote: "Mars time",
      },
    ]);
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
