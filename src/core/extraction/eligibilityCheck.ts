import type { FixedAnswers } from "@/core/profile/schema";
import {
  isCountryCode,
  isPlaceCode,
  isUnclearRegion,
  placeCode,
  placeContains,
  placeName,
  placesOverlap,
} from "@/core/shared/regions";

import type { Role } from "./record";

/**
 * Whether the owner is likely eligible for a role (extraction spec, "Stage
 * eligibility"): deterministic code, no model, comparing the chosen role
 * with the profile's fixed answers through the shared region table. Each
 * finding is `unclear` or `likely_ineligible` with its reason and the post's
 * words; the result is the most severe finding, or `eligible` with none.
 * Where a post says where the work can be done (remote regions, and the
 * places of an onsite or hybrid role), those are alternatives: the role
 * passes when any one does ("London or Lahore" passes through Lahore), and
 * otherwise takes the least severe of their findings. A demand the check
 * cannot read is unclear, never passed in silence.
 */

export type EligibilityResult = "eligible" | "unclear" | "likely_ineligible";

export interface EligibilityReason {
  kind: "remote_region" | "work_authorisation" | "place" | "other_limit" | "time_zone";
  result: Exclude<EligibilityResult, "eligible">;
  message: string;
  /** The post's words the finding rests on; empty when it rests on none. */
  quote: string;
}

export interface Eligibility {
  result: EligibilityResult;
  reasons: EligibilityReason[];
}

export interface EligibilityProfile {
  /** The owner's country, as a code. */
  home: string;
  fixedAnswers: Pick<FixedAnswers, "work_authorisation" | "relocation" | "working_window">;
}

const RANK: Record<EligibilityResult, number> = { eligible: 0, unclear: 1, likely_ineligible: 2 };

const DEFAULT_OVERLAP_HOURS = 2;
const WORKDAY = { start: 9 * 60, end: 17 * 60 };

type Finding = EligibilityReason | null;

export function checkEligibility(role: Role, profile: EligibilityProfile, at: Date): Eligibility {
  const where = [...(remoteRegions(role, profile) ?? []), ...(places(role, profile) ?? [])];
  const reasons = [
    ...bestOf(where),
    ...workAuthorisation(role, profile),
    ...role.eligibility.other_limits
      .filter((quote) => quote.trim() !== "")
      .map((quote): EligibilityReason => ({
        kind: "other_limit",
        result: "unclear",
        message: "The post sets another limit. Check whether you meet it.",
        quote,
      })),
    ...timeZone(role, profile, at),
  ];
  const result = reasons.reduce<EligibilityResult>(
    (worst, reason) => (RANK[reason.result] > RANK[worst] ? reason.result : worst),
    "eligible",
  );
  return { result, reasons };
}

/**
 * Alternatives, each passing (null) or with its finding: none when any one
 * passes, otherwise the findings of the least severe kind, since the owner
 * needs only one alternative to work.
 */
function bestOf(alternatives: readonly Finding[]): EligibilityReason[] {
  if (alternatives.length === 0 || alternatives.some((finding) => finding === null)) return [];
  const findings = alternatives as EligibilityReason[];
  const best = Math.min(...findings.map((finding) => RANK[finding.result]));
  return findings.filter((finding) => RANK[finding.result] === best);
}

/** Names a sentence puts "the" before: "the United States", "the Netherlands", "the Middle East". */
const WITH_THE =
  /^(?:United |European |Gulf |Middle East|Democratic |Republic |Central African|Dominican|British |French |U\.S\. |Isle |Netherlands$|Philippines$|Bahamas$|Gambia$|Maldives$|Seychelles$|Comoros$)|Islands$/;

/** A place's name as a sentence reads it: "the United States", "Pakistan". */
function named(code: string): string {
  const name = placeName(code);
  return WITH_THE.test(name) ? `the ${name}` : name;
}

function hoursText(count: number): string {
  return `${count} ${count === 1 ? "hour" : "hours"}`;
}

/** A place a post names: the shared table's reading of its words first, then the model's code. */
function placeOf(text: string, code: string): string | null {
  return placeCode(text) ?? (isPlaceCode(code) ? code : null);
}

/** Each remote region the post names, looked up whole: a region taking in the owner's country passes. */
function remoteRegions(role: Role, profile: EligibilityProfile): Finding[] | null {
  const phrases = role.location.remote_regions.filter((phrase) => phrase.trim() !== "");
  if (phrases.length === 0) return null;
  return phrases.map((phrase) => {
    const code = placeCode(phrase);
    const finding = (result: EligibilityReason["result"], message: string): EligibilityReason => ({
      kind: "remote_region",
      result,
      message,
      quote: phrase,
    });
    if (code === null) {
      return finding(
        "unclear",
        "The post names a region we could not place. Check whether it includes you.",
      );
    }
    if (isUnclearRegion(code)) {
      return finding(
        "unclear",
        `${placeName(code)} has no agreed list of countries. Check whether it includes ${named(profile.home)}.`,
      );
    }
    const contains = placeContains(code, profile.home);
    if (contains === true) return null;
    if (contains === false) {
      return finding(
        "likely_ineligible",
        `Remote work is open only to people in ${named(code)}, which does not include ${named(profile.home)}.`,
      );
    }
    return finding("unclear", "Check whether this region includes you.");
  });
}

/**
 * Each place the post asks the right to work in, matched to the profile's
 * entry for it or a region containing it. Every place listed must be met,
 * as the spec reads.
 */
function workAuthorisation(role: Role, profile: EligibilityProfile): EligibilityReason[] {
  const findings: EligibilityReason[] = [];
  for (const required of role.eligibility.work_authorisation) {
    if (required.quote.trim() === "" && required.place.trim() === "") continue;
    const finding = (result: EligibilityReason["result"], message: string) =>
      findings.push({ kind: "work_authorisation", result, message, quote: required.quote });
    const place = isPlaceCode(required.place) ? required.place : placeCode(required.place);
    if (place === null || isUnclearRegion(place)) {
      finding("unclear", "The post asks for the right to work somewhere we could not place.");
      continue;
    }
    const entries = profile.fixedAnswers.work_authorisation;
    const entry =
      entries.find((each) => each.place === place) ??
      entries.find((each) => placeContains(each.place, place) === true);
    const name = named(place);
    if (!entry) {
      finding("unclear", `Your profile does not say whether you may work in ${name}.`);
    } else if (entry.authorised) {
      continue;
    } else if (role.eligibility.sponsorship === "not_offered") {
      finding(
        "likely_ineligible",
        `The role needs the right to work in ${name}, which you do not have, and the post offers no sponsorship.`,
      );
    } else {
      finding(
        "unclear",
        role.eligibility.sponsorship === "offered"
          ? `The role needs the right to work in ${name}, which you do not have; the post offers sponsorship.`
          : `The role needs the right to work in ${name}, which you do not have; the post does not say whether it sponsors.`,
      );
    }
  }
  return findings;
}

/**
 * Where an onsite or hybrid role is done: a place in the owner's country
 * passes; a region that takes in their country might be, so it is unclear;
 * elsewhere the profile's relocation answer decides. A role whose work mode
 * the post does not give is judged on any places it names, but never more
 * severely than unclear, since it may be remote.
 */
function places(role: Role, profile: EligibilityProfile): Finding[] | null {
  const mode = role.location.work_mode;
  const listed = role.location.places.filter((place) => place.text.trim() !== "");
  const atPlaces = mode === "onsite" || mode === "hybrid";
  if (!atPlaces && !(mode === "unspecified" && listed.length > 0)) return null;
  if (listed.length === 0) {
    return [
      {
        kind: "place",
        result: "unclear",
        message: `The role is ${mode}, and the post does not say where. Check where you would work.`,
        quote: "",
      },
    ];
  }
  const relocation = profile.fixedAnswers.relocation;
  const how = atPlaces ? mode : "based";
  return listed.map((place) => {
    const code = placeOf(place.text, place.code);
    const finding = (result: EligibilityReason["result"], message: string): EligibilityReason => ({
      kind: "place",
      result: atPlaces ? result : "unclear",
      message,
      quote: place.text,
    });
    if (code === null || isUnclearRegion(code)) {
      return finding(
        "unclear",
        "We could not tell where this place is. Check whether you could work there.",
      );
    }
    if (code === profile.home) return null;
    if (!isCountryCode(code) && placeContains(code, profile.home) === true) {
      return finding(
        "unclear",
        `The role is ${how} somewhere in ${named(code)}, which includes ${named(profile.home)}. Check where.`,
      );
    }
    const name = named(code);
    if (!relocation.open) {
      return finding(
        "likely_ineligible",
        `The role is ${how} in ${name}, and your profile says you are not open to relocating.`,
      );
    }
    const covered =
      relocation.places.length === 0 ||
      relocation.places.some(
        (each) =>
          each === code || placeContains(each, code) === true || placesOverlap(each, code) === true,
      );
    return covered
      ? finding(
          "unclear",
          `The role is ${how} in ${name}. You are open to relocating there; check the move.`,
        )
      : finding(
          "likely_ineligible",
          `The role is ${how} in ${name}, and your profile is open to relocating only to other places.`,
        );
  });
}

/**
 * When the post names a zone: how much of the owner's working window falls
 * within 09:00 to 17:00 there, on a 24-hour circle, so windows that cross
 * midnight in UTC count. Less than the post asks, or under 2 hours when it
 * asks nothing, is unclear, as is a zone that cannot be read. The zone's
 * offset is taken at `at`.
 */
function timeZone(role: Role, profile: EligibilityProfile, at: Date): EligibilityReason[] {
  const { zone, min_overlap_hours: asked, text } = role.location.time_zone;
  if (zone.trim() === "" || zone === "unspecified") return [];
  const quote = text.trim() !== "" ? text : zone;
  const offset = offsetMinutes(zone, at);
  if (offset === null) {
    return [
      {
        kind: "time_zone",
        result: "unclear",
        message: "The post asks for a time zone we could not read. Check the hours it means.",
        quote,
      },
    ];
  }
  const window = profile.fixedAnswers.working_window;
  const overlap = overlapMinutes(
    [minutesOf(window.start_utc), minutesOf(window.end_utc)],
    [WORKDAY.start - offset, WORKDAY.end - offset],
  );
  const needed = (asked >= 0 ? asked : DEFAULT_OVERLAP_HOURS) * 60;
  if (overlap >= needed) return [];
  const span = hoursText(Math.round((overlap / 60) * 10) / 10);
  const day = "09:00 to 17:00 in the post's time zone";
  return [
    {
      kind: "time_zone",
      result: "unclear",
      message:
        asked >= 0
          ? `Your working hours overlap ${day} by ${span}; the post asks for ${hoursText(asked)}.`
          : `Your working hours overlap ${day} by only ${span}.`,
      quote,
    },
  ];
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}

/** The zone's offset from UTC in minutes at `at`, or null for a zone this runtime does not know. */
export function offsetMinutes(zone: string, at: Date): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
  } catch {
    return null;
  }
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
  );
  const utc = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    at.getUTCHours(),
    at.getUTCMinutes(),
  );
  return Math.round((local - utc) / 60_000);
}

const DAY = 24 * 60;

/** Minutes two daily windows share on a 24-hour circle; a window whose end comes before its start crosses midnight. */
export function overlapMinutes(one: [number, number], other: [number, number]): number {
  const pieces = ([start, end]: [number, number]): [number, number][] => {
    const from = ((start % DAY) + DAY) % DAY;
    const to = ((end % DAY) + DAY) % DAY;
    if (from === to) return [[0, DAY]];
    return from < to
      ? [[from, to]]
      : [
          [from, DAY],
          [0, to],
        ];
  };
  let total = 0;
  for (const [a, b] of pieces(one)) {
    for (const [c, d] of pieces(other)) total += Math.max(0, Math.min(b, d) - Math.max(a, c));
  }
  return total;
}
