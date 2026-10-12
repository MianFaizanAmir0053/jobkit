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
 *
 * Where the work can be done (remote regions, and the places of an onsite
 * or hybrid role) are alternatives: the role passes when any one does
 * ("London or Lahore" passes through Lahore), and otherwise takes the least
 * severe of their findings. What the post leaves open beside them, an
 * onsite role with no place, or the places of a role whose work mode is not
 * clear, is reported apart, so it never cancels a clear exclusion. A demand
 * the check cannot read is unclear, never passed in silence.
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

/** What a post may write for "no zone given". */
const NO_ZONE: ReadonlySet<string> = new Set(["", "unspecified", "unknown", "none"]);

/** The region table's code for anywhere at all. */
const WORLDWIDE = "WORLDWIDE";

type Finding = EligibilityReason | null;
type Place = Role["location"]["places"][number];

/** Where the work can be done, as the post gives it. */
interface Where {
  /** Alternatives, each passing (null) or with its finding. */
  alternatives: Finding[];
  /** What the post leaves open, reported whatever the alternatives give. */
  open: EligibilityReason[];
  /** The places of a role whose work mode is not clear: reported only when no alternative passes. */
  maybe: EligibilityReason[];
}

export function checkEligibility(role: Role, profile: EligibilityProfile, at: Date): Eligibility {
  const where = whereWorkIsDone(role, profile);
  const passed = where.alternatives.some((finding) => finding === null);
  const reasons = [
    ...bestOf(where.alternatives),
    ...where.open,
    ...(passed ? [] : where.maybe),
    ...workAuthorisation(role, profile),
    ...otherLimits(role),
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
  /^(?:United |European |Gulf |Middle East|Democratic |Republic |Central African|Dominican|British |French Southern|U\.S\. |Isle |Netherlands$|Caribbean Netherlands$|Philippines$|Bahamas$|Gambia$|Maldives$|Seychelles$|Comoros$)|Islands$/;

/** A place's name as a sentence reads it: "the United States", "Pakistan". */
function named(code: string): string {
  const name = placeName(code);
  return WITH_THE.test(name) ? `the ${name}` : name;
}

/** The same, at the start of a sentence: "The Middle East and North Africa". */
function namedFirst(code: string): string {
  const name = named(code);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function hoursText(count: number): string {
  return `${count} ${count === 1 ? "hour" : "hours"}`;
}

/** A place a post names: the shared table's reading of its words first, then the model's code. */
function placeOf(text: string, code: string): string | null {
  return placeCode(text) ?? (isPlaceCode(code) ? code : null);
}

/**
 * The alternatives and what the post leaves open. A role whose work mode
 * is not given, or a remote one that names places but no region ("London ·
 * Remote"), may be done at its places: one that passes is a passing
 * alternative, and the rest are unclear at most, since the role may be
 * done anywhere.
 */
function whereWorkIsDone(role: Role, profile: EligibilityProfile): Where {
  const where: Where = { alternatives: remoteRegions(role, profile), open: [], maybe: [] };
  const mode = role.location.work_mode;
  // A place with no words but a code the table knows is still a place the post names.
  const listed = role.location.places.filter(
    (place) => place.text.trim() !== "" || isPlaceCode(place.code),
  );
  if (mode === "onsite" || mode === "hybrid") {
    if (listed.length === 0) where.open.push(noPlace(mode));
    for (const place of listed) where.alternatives.push(placeFinding(place, mode, profile));
  } else if (mode === "unspecified" || where.alternatives.length === 0) {
    for (const place of listed) {
      const finding = placeFinding(place, "based", profile);
      if (finding === null) where.alternatives.push(null);
      else where.maybe.push({ ...finding, result: "unclear" });
    }
  }
  return where;
}

function noPlace(how: string): EligibilityReason {
  return {
    kind: "place",
    result: "unclear",
    message:
      how === "based"
        ? "The post does not say where the role is based. Check where you would work."
        : `The role is ${how}, and the post does not say where. Check where you would work.`,
    quote: "",
  };
}

/** Each remote region the post names, looked up whole: a region taking in the owner's country passes. */
function remoteRegions(role: Role, profile: EligibilityProfile): Finding[] {
  return role.location.remote_regions
    .filter((phrase) => phrase.trim() !== "")
    .map((phrase) => {
      const code = placeCode(phrase);
      const finding = (
        result: EligibilityReason["result"],
        message: string,
      ): EligibilityReason => ({
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
          `${namedFirst(code)} has no agreed list of countries. Check whether it includes ${named(profile.home)}.`,
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
 * One place the work may be done: the owner's country passes; a region that
 * takes in their country might be, so it is unclear; elsewhere the
 * profile's relocation answer decides.
 */
function placeFinding(place: Place, how: string, profile: EligibilityProfile): Finding {
  const code = placeOf(place.text, place.code);
  const finding = (result: EligibilityReason["result"], message: string): EligibilityReason => ({
    kind: "place",
    result,
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
  if (code === WORLDWIDE) return { ...noPlace(how), quote: place.text };
  if (!isCountryCode(code) && placeContains(code, profile.home) === true) {
    return finding(
      "unclear",
      `The role is ${how} somewhere in ${named(code)}, which includes ${named(profile.home)}. Check where.`,
    );
  }
  const name = named(code);
  const relocation = profile.fixedAnswers.relocation;
  if (!relocation.open) {
    return finding(
      "likely_ineligible",
      `The role is ${how} in ${name}, and your profile says you are not open to relocating.`,
    );
  }
  const covers = (each: string) => each === code || placeContains(each, code) === true;
  if (relocation.places.length === 0 || relocation.places.some(covers)) {
    return finding(
      "unclear",
      `The role is ${how} in ${name}. You are open to relocating there; check the move.`,
    );
  }
  if (relocation.places.some((each) => placesOverlap(each, code) === true)) {
    return finding(
      "unclear",
      `The role is ${how} in ${name}. You are open to relocating to part of it; check where.`,
    );
  }
  return finding(
    "likely_ineligible",
    `The role is ${how} in ${name}, and your profile is open to relocating only to other places.`,
  );
}

/**
 * Each place the post asks the right to work in, matched to the profile's
 * entry for it or a region containing it. A post's list cannot say "or"
 * from "and", so when the owner may work in one place it lists, the others
 * are unclear at most (the owner's rule, 2026-10-12).
 */
function workAuthorisation(role: Role, profile: EligibilityProfile): EligibilityReason[] {
  const entries = profile.fixedAnswers.work_authorisation;
  const judged = role.eligibility.work_authorisation
    .filter((required) => required.quote.trim() !== "" || required.place.trim() !== "")
    .map((required) => {
      const place = isPlaceCode(required.place) ? required.place : placeCode(required.place);
      const known = place !== null && !isUnclearRegion(place);
      const entry = known
        ? (entries.find((each) => each.place === place) ??
          entries.find((each) => placeContains(each.place, place) === true))
        : undefined;
      return { required, place: known ? place : null, entry };
    });
  const met = judged.find(({ entry }) => entry?.authorised === true);
  const findings: EligibilityReason[] = [];
  for (const { required, place, entry } of judged) {
    const finding = (result: EligibilityReason["result"], message: string) =>
      findings.push({ kind: "work_authorisation", result, message, quote: required.quote });
    if (place === null) {
      finding("unclear", "The post asks for the right to work somewhere we could not place.");
      continue;
    }
    const name = named(place);
    if (!entry) {
      finding("unclear", `Your profile does not say whether you may work in ${name}.`);
    } else if (entry.authorised) {
      continue;
    } else if (met?.place) {
      finding(
        "unclear",
        `The post also asks for the right to work in ${name}, which you do not have. You may work in ${named(met.place)}, which it lists too; check whether it needs both.`,
      );
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

function otherLimits(role: Role): EligibilityReason[] {
  return role.eligibility.other_limits
    .filter((quote) => quote.trim() !== "")
    .map((quote): EligibilityReason => ({
      kind: "other_limit",
      result: "unclear",
      message: "The post sets another limit. Check whether you meet it.",
      quote,
    }));
}

/**
 * When the post names a zone: how much of the owner's working window falls
 * within 09:00 to 17:00 there, on a 24-hour circle, so windows that cross
 * midnight in UTC count. Less than the post asks, or under 2 hours when it
 * asks nothing, is unclear, as is a zone that cannot be read, and a demand
 * on working hours with no zone. The zone's offset is taken at `at`. Only
 * the post's own words are quoted: a zone the model inferred is not them.
 */
function timeZone(role: Role, profile: EligibilityProfile, at: Date): EligibilityReason[] {
  const { zone, min_overlap_hours: asked, text } = role.location.time_zone;
  const quote = text.trim();
  const unclear = (message: string): EligibilityReason[] => [
    { kind: "time_zone", result: "unclear", message, quote },
  ];
  if (NO_ZONE.has(zone.trim().toLowerCase())) {
    return quote !== "" || asked > 0
      ? unclear(
          "The post asks for working hours we could not place in a time zone. Check the hours it means.",
        )
      : [];
  }
  const offset = offsetMinutes(zone.trim(), at);
  if (offset === null) {
    return unclear("The post asks for a time zone we could not read. Check the hours it means.");
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
  return unclear(
    asked >= 0
      ? `Your working hours overlap ${day} by ${span}; the post asks for ${hoursText(asked)}.`
      : `Your working hours overlap ${day} by only ${span}.`,
  );
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
