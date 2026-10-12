import type { FixedAnswers } from "@/core/profile/schema";
import {
  isPlaceCode,
  isUnclearRegion,
  placeCode,
  placeContains,
  placeName,
} from "@/core/shared/regions";

import type { Role } from "./record";

/**
 * Whether the owner is likely eligible for a role (extraction spec, "Stage
 * eligibility"): deterministic code, no model, comparing the chosen role
 * with the profile's fixed answers through the shared region table. Each
 * finding is `unclear` or `likely_ineligible` with its reason and the post's
 * words; the result is the most severe finding, or `eligible` with none.
 * Where a post offers alternatives (remote regions, onsite places), the
 * role is judged by the best of them: "London or Lahore" passes through
 * Lahore.
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

export function checkEligibility(role: Role, profile: EligibilityProfile, at: Date): Eligibility {
  const reasons = [
    ...bestOf(remoteRegions(role, profile)),
    ...workAuthorisation(role, profile),
    ...bestOf(places(role, profile)),
    ...role.eligibility.other_limits.map((quote): EligibilityReason => ({
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
function bestOf(alternatives: (EligibilityReason | null)[] | null): EligibilityReason[] {
  if (alternatives === null || alternatives.length === 0) return [];
  if (alternatives.some((finding) => finding === null)) return [];
  const findings = alternatives as EligibilityReason[];
  const best = Math.min(...findings.map((finding) => RANK[finding.result]));
  return findings.filter((finding) => RANK[finding.result] === best);
}

/** Each remote region the post names, looked up whole: a region taking in the owner's country passes. */
function remoteRegions(
  role: Role,
  profile: EligibilityProfile,
): (EligibilityReason | null)[] | null {
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
        `${placeName(code)} has no agreed list of countries. Check whether it includes ${placeName(profile.home)}.`,
      );
    }
    const contains = placeContains(code, profile.home);
    if (contains === true) return null;
    if (contains === false) {
      return finding(
        "likely_ineligible",
        `Remote work is open only to ${placeName(code)}, which does not include ${placeName(profile.home)}.`,
      );
    }
    return finding("unclear", "Check whether this region includes you.");
  });
}

/** Each place the post asks the right to work in, matched to the profile's entry for it or a region containing it. */
function workAuthorisation(role: Role, profile: EligibilityProfile): EligibilityReason[] {
  const findings: EligibilityReason[] = [];
  for (const required of role.eligibility.work_authorisation) {
    const finding = (result: EligibilityReason["result"], message: string) =>
      findings.push({ kind: "work_authorisation", result, message, quote: required.quote });
    const place = required.place;
    if (!isPlaceCode(place) || isUnclearRegion(place)) {
      finding("unclear", "The post asks for the right to work somewhere we could not place.");
      continue;
    }
    const entries = profile.fixedAnswers.work_authorisation;
    const entry =
      entries.find((each) => each.place === place) ??
      entries.find((each) => placeContains(each.place, place) === true);
    const name = placeName(place);
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

/** An onsite or hybrid role's places: one in the owner's country passes; elsewhere, the profile's relocation answer decides. */
function places(role: Role, profile: EligibilityProfile): (EligibilityReason | null)[] | null {
  const mode = role.location.work_mode;
  if (mode !== "onsite" && mode !== "hybrid") return null;
  const listed = role.location.places.filter((place) => place.text.trim() !== "");
  if (listed.length === 0) return null;
  const relocation = profile.fixedAnswers.relocation;
  return listed.map((place) => {
    const code = isPlaceCode(place.code) ? place.code : placeCode(place.text);
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
    const name = placeName(code);
    if (!relocation.open) {
      return finding(
        "likely_ineligible",
        `The role is ${mode} in ${name}, and your profile says you are not open to relocating.`,
      );
    }
    const covered =
      relocation.places.length === 0 ||
      relocation.places.some((each) => each === code || placeContains(each, code) === true);
    return covered
      ? finding(
          "unclear",
          `The role is ${mode} in ${name}. You are open to relocating there; check the move.`,
        )
      : finding(
          "likely_ineligible",
          `The role is ${mode} in ${name}, and your profile is open to relocating only to other places.`,
        );
  });
}

/**
 * When the post names a zone: how much of the owner's working window falls
 * within 09:00 to 17:00 there, on a 24-hour circle, so windows that cross
 * midnight in UTC count. Less than the post asks, or under 2 hours when it
 * asks nothing, is unclear. The zone's offset is taken at `at`.
 */
function timeZone(role: Role, profile: EligibilityProfile, at: Date): EligibilityReason[] {
  const { zone, min_overlap_hours: asked, text } = role.location.time_zone;
  const offset = zone === "unspecified" ? null : offsetMinutes(zone, at);
  if (offset === null) return [];
  const window = profile.fixedAnswers.working_window;
  const overlap = overlapMinutes(
    [minutesOf(window.start_utc), minutesOf(window.end_utc)],
    [WORKDAY.start - offset, WORKDAY.end - offset],
  );
  const needed = (asked >= 0 ? asked : DEFAULT_OVERLAP_HOURS) * 60;
  if (overlap >= needed) return [];
  const hours = Math.round((overlap / 60) * 10) / 10;
  return [
    {
      kind: "time_zone",
      result: "unclear",
      message:
        asked >= 0
          ? `Your working hours overlap ${zone}'s working day by ${hours} hours; the post asks for ${asked}.`
          : `Your working hours overlap ${zone}'s working day by only ${hours} hours.`,
      quote: text,
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
