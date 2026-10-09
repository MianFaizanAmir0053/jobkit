import { z } from "zod";

import { isCountryCode, isPlaceCode, isUnclearRegion, placeContains } from "@/core/shared/regions";
import { isSkillTag } from "@/core/shared/skills";

/**
 * The profile file's schema (profile spec, "The profile file"). It is
 * strict: an unknown key anywhere is an error. Skills and places are
 * checked against the shared tables here, so they are reported in the same
 * pass as everything else; IDs across the file and the files it names are
 * checked in validate.ts. No message repeats a value from the file, which
 * holds the owner's personal data.
 */

/**
 * Any value: no control characters and no half of a surrogate pair, which
 * Postgres cannot store and no answer needs.
 */
const str = () =>
  z
    .string()
    .regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/, "holds a control character")
    .regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/, "holds a broken character");

const id = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}-[a-z0-9-]+$`), `must look like ${prefix}-lower-case-words`);

const text = (what: string) => str().trim().min(1, `${what} is empty`);

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time such as 04:00");

const skill = str().refine(
  isSkillTag,
  "is not in the skill vocabulary (src/core/shared/skills.ts)",
);

const place = str().refine(isPlaceCode, "is not in the region table (src/core/shared/regions.ts)");

/**
 * A path the seed may read: relative, inside the profile file's folder or
 * below it, so a typo can never send another file to storage or a model.
 */
export function isPathBelow(path: string): boolean {
  if (/^[\\/]|^[a-zA-Z]:/.test(path)) return false;
  return !path.split(/[\\/]/).includes("..");
}

/** The same file however the path is written: "./style/a.txt", "style\a.txt" and "Style/A.txt". */
export function samePathKey(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/")
    .toLowerCase();
}

const filePath = (what: string) =>
  text(what).refine(isPathBelow, "must name a file in the profile file's folder or below it");

/** A web address: a link in a message to a recruiter must open a page. */
const webLink = str().pipe(z.url({ protocol: /^https?$/ }));

/**
 * An IANA zone written as the database names it, such as Asia/Karachi, and
 * known to this runtime; UTC on its own too. Offsets ("+05:00") and
 * abbreviations ("EST") are not zones.
 */
function isTimeZone(zone: string): boolean {
  if (zone !== "UTC" && !/^[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z0-9_+-]+)+$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Only {skill} and {related}, each in its braces. */
function usesOnlyKnownPlaceholders(template: string): boolean {
  return !/[{}]/.test(template.replaceAll("{skill}", "").replaceAll("{related}", ""));
}

export const FACT_KINDS = [
  "skill",
  "experience",
  "project",
  "metric",
  "education",
  "language",
  "other",
] as const;
export const DEPTHS = ["production", "professional", "side-project", "learning"] as const;

export const factSchema = z.strictObject({
  id: id("F"),
  statement: text("the statement"),
  phrase: text("the phrase"),
  kind: z.enum(FACT_KINDS),
  skills: z.array(skill),
  depth: z.enum(DEPTHS),
  years: z.number().nonnegative().optional(),
  source: text("the source"),
  approved: z.boolean(),
});

export const knownGapSchema = z.strictObject({
  id: id("K"),
  skills: z.array(skill).min(1, "a known gap names at least one skill"),
  line: text("the line"),
  approved: z.boolean(),
});

export const gapTemplateSchema = z.strictObject({
  id: id("G"),
  text: text("the template").refine(
    usesOnlyKnownPlaceholders,
    "may use only the placeholders {skill} and {related}",
  ),
});

const workAuthorisationSchema = z
  .strictObject({
    place,
    authorised: z.boolean(),
    sponsorship_needed: z.boolean().optional(),
    text: text("the text").optional(),
  })
  .refine((entry) => !(entry.authorised && entry.sponsorship_needed === true), {
    message: "contradicts authorised: true",
    path: ["sponsorship_needed"],
  });

/**
 * Work-authorisation entries that eligibility can read one way: no region
 * whose countries are unclear, such as EMEA, no place twice, and no place
 * that takes in, or lies in, an earlier entry's place with the other answer
 * (PK authorised with SOUTH_ASIA not).
 */
function oneAnswerPerPlace(
  entries: readonly { place: string; authorised: boolean }[],
  ctx: z.RefinementCtx,
): void {
  entries.forEach((entry, i) => {
    const at = (message: string) => ctx.addIssue({ code: "custom", message, path: [i, "place"] });
    if (isUnclearRegion(entry.place)) {
      return at("is a region whose countries are unclear; name countries or a clear region");
    }
    const earlier = entries.slice(0, i);
    if (earlier.some((other) => other.place === entry.place)) {
      return at("names the same place as an earlier entry");
    }
    const overlaps = (other: { place: string; authorised: boolean }) =>
      other.authorised !== entry.authorised &&
      (placeContains(other.place, entry.place) === true ||
        placeContains(entry.place, other.place) === true);
    if (earlier.some(overlaps)) at("overlaps an earlier entry that answers otherwise");
  });
}

/** Reports each entry whose key repeats an earlier one's, at that entry. */
function noRepeats<T>(keyOf: (item: T) => string, field: string | null, message: string) {
  return (items: readonly T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const key = keyOf(item);
      if (seen.has(key))
        ctx.addIssue({ code: "custom", message, path: field === null ? [i] : [i, field] });
      seen.add(key);
    });
  };
}

export const fixedAnswersSchema = z.strictObject({
  salary_expectation: z.record(
    z.string().regex(/^[A-Z]{3}$/, "must be a currency code such as USD"),
    text("the salary expectation"),
  ),
  notice_period: text("the notice period"),
  availability: text("the availability"),
  working_window: z
    .strictObject({ start_utc: time, end_utc: time, text: text("the working window") })
    .refine((window) => window.start_utc !== window.end_utc, {
      message: "is the same as the start",
      path: ["end_utc"],
    }),
  relocation: z.strictObject({
    open: z.boolean(),
    places: z.array(place),
    text: text("the relocation answer"),
  }),
  work_authorisation: z.array(workAuthorisationSchema).superRefine(oneAnswerPerPlace),
  years_per_stack: z.record(str(), z.number().nonnegative()).superRefine((years, ctx) => {
    for (const tag of Object.keys(years)) {
      if (!isSkillTag(tag)) {
        ctx.addIssue({
          code: "custom",
          message: "is not in the skill vocabulary (src/core/shared/skills.ts)",
          path: [tag],
        });
      }
    }
  }),
  eeo: z.strictObject({
    gender: text("the answer"),
    ethnicity: text("the answer"),
    veteran: text("the answer"),
    disability: text("the answer"),
  }),
});

export const profileSchema = z.strictObject({
  schema: z.literal(1),
  owner: z.strictObject({
    name: text("the name"),
    email: z.email(),
    location: z.strictObject({
      city: text("the city"),
      country: str().refine(
        isCountryCode,
        "is not a country code in the region table (src/core/shared/regions.ts)",
      ),
      timezone: str().refine(isTimeZone, "is not a time zone such as Asia/Karachi"),
    }),
  }),
  links: z.strictObject({
    portfolio: webLink,
    linkedin: webLink.optional(),
    github: webLink.optional(),
  }),
  signature: text("the signature"),
  cv: z.strictObject({ file: filePath("the CV file"), label: text("the CV label") }),
  facts: z.array(factSchema),
  gaps: z.strictObject({ templates: z.array(gapTemplateSchema), known: z.array(knownGapSchema) }),
  fixed_answers: fixedAnswersSchema,
  style_examples: z
    .array(filePath("a style example path"))
    .min(3, "needs 3 to 5 style examples")
    .max(5, "needs 3 to 5 style examples")
    .superRefine(noRepeats(samePathKey, null, "names the same file as an earlier style example")),
});

export type ProfileDocument = z.infer<typeof profileSchema>;
export type Fact = z.infer<typeof factSchema>;
export type KnownGap = z.infer<typeof knownGapSchema>;
export type GapTemplate = z.infer<typeof gapTemplateSchema>;
export type FixedAnswers = z.infer<typeof fixedAnswersSchema>;
