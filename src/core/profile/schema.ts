import { z } from "zod";

import { EMAIL_BODY_WORD_LIMIT } from "@/core/shared/email";
import { isCountryCode, isPlaceCode, isUnclearRegion, placesOverlap } from "@/core/shared/regions";
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
 * Any value: no control characters, no direction overrides (which make text
 * read otherwise than it runs) and no half of a surrogate pair, which
 * Postgres cannot store and no answer needs.
 */
const str = () =>
  z
    .string()
    .regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]*$/, "holds a control character")
    .regex(/^[^\u202A-\u202E\u2066-\u2069]*$/, "holds a direction mark")
    .regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/, "holds a broken character");

const id = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}-[a-z0-9-]+$`), `must look like ${prefix}-lower-case-words`);

/** A one-line value: drafts put these inside sentences and subject lines. */
const text = (what: string) =>
  str()
    .trim()
    .min(1, `${what} is empty`)
    .regex(/^[^\r\n\u2028\u2029]*$/, "holds a line break");

/** A value that may run over several lines: the signature only. */
const lines = (what: string) => str().trim().min(1, `${what} is empty`);

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time such as 04:00");

const skill = str().refine(
  isSkillTag,
  "is not in the skill vocabulary (src/core/shared/skills.ts)",
);

const place = str().refine(isPlaceCode, "is not in the region table (src/core/shared/regions.ts)");

/** A place eligibility can match a country against: not a region whose countries are unclear. */
const clearPlace = place.refine(
  (code) => !isUnclearRegion(code),
  "is a region whose countries are unclear; name countries or a clear region",
);

/**
 * A path the seed may read: relative, inside the profile file's folder or
 * below it, so a typo can never send another file to storage or a model.
 * No colon either: a drive letter, or a Windows stream name such as
 * "a.txt::$DATA", which reads a file under another spelling.
 */
export function isPathBelow(path: string): boolean {
  if (/^[\\/]/.test(path) || path.includes(":")) return false;
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

/** A file the seed reads, of one kind: the CV a .pdf, a style example a .txt (never the profile file). */
const filePath = (what: string, extension: ".pdf" | ".txt") =>
  text(what).superRefine((path, ctx) => {
    if (!isPathBelow(path)) {
      ctx.addIssue({
        code: "custom",
        message: "must name a file in the profile file's folder or below it",
      });
    } else if (!path.toLowerCase().endsWith(extension)) {
      ctx.addIssue({ code: "custom", message: `must be a ${extension} file` });
    }
  });

/**
 * A web address: a link in a message to a recruiter must open a page. A
 * space or a line break is refused rather than left to the URL parser,
 * which drops some silently.
 */
const webLink = str()
  .regex(/^\S+$/, "holds a space or a line break")
  .pipe(z.url({ protocol: /^https?$/ }));

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

/** Only {company} and {role}, each in its braces: what code fills in an email template. */
function usesOnlyTemplateFields(sentence: string): boolean {
  return !/[{}]/.test(sentence.replaceAll("{company}", "").replaceAll("{role}", ""));
}

/**
 * An email template's words at most, a placeholder a word: 60 below the
 * email's limit, for the gap lines code adds and the post's names. A draft
 * built from a template is still held to the email's limit, and the post's
 * own, when it is built.
 */
export const TEMPLATE_MAX_WORDS = EMAIL_BODY_WORD_LIMIT - 60;

/**
 * What a template sentence is, as a kit block's class says (drafting spec):
 * a claim rests on the facts it cites; a post sentence names the post's
 * company or role and nothing more; a courtesy sentence does neither.
 */
export const TEMPLATE_SENTENCE_KINDS = ["claim", "post", "courtesy"] as const;

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

/**
 * One sentence of an email template (decisions A21): its words, what kind
 * of sentence it is, the facts it rests on, and whether a new paragraph
 * starts after it. What its kind asks of it is checked in validate.ts, with
 * the facts, so every problem is reported in one pass.
 */
export const templateSentenceSchema = z.strictObject({
  text: text("the sentence").refine(
    usesOnlyTemplateFields,
    "may use only the placeholders {company} and {role}",
  ),
  kind: z.enum(TEMPLATE_SENTENCE_KINDS),
  facts: z.array(id("F")).default([]),
  paragraph_break: z.boolean().default(false),
});

/**
 * An email body for a kind of role (decisions A21), drafted by Claude Code
 * and approved by the owner as facts are. Its skills are the ones its words
 * show, each from a fact it cites, which is what a role's must-haves are
 * weighed against; none for a general one.
 */
export const emailTemplateSchema = z.strictObject({
  id: id("T"),
  name: text("the name"),
  skills: z.array(skill),
  sentences: z.array(templateSentenceSchema).min(1, "a template needs a sentence"),
  approved: z.boolean(),
});

const workAuthorisationSchema = z
  .strictObject({
    place: clearPlace,
    authorised: z.boolean(),
    sponsorship_needed: z.boolean().optional(),
    text: text("the text").optional(),
  })
  .refine((entry) => !(entry.authorised && entry.sponsorship_needed === true), {
    message: "contradicts authorised: true",
    path: ["sponsorship_needed"],
  });

type Authorisation = { place: string; authorised: boolean; sponsorship_needed?: boolean };

/**
 * Work-authorisation entries that eligibility can read one way: no place
 * twice, and no two places sharing a country (PK and SOUTH_ASIA, or North
 * and Latin America through Mexico) that answer otherwise, in being
 * authorised or, where neither is, in needing sponsorship.
 */
function oneAnswerPerPlace(entries: readonly Authorisation[], ctx: z.RefinementCtx): void {
  entries.forEach((entry, i) => {
    const at = (message: string) => ctx.addIssue({ code: "custom", message, path: [i, "place"] });
    const earlier = entries.slice(0, i);
    if (earlier.some((other) => other.place === entry.place)) {
      return at("names the same place as an earlier entry");
    }
    const answersOtherwise = (other: Authorisation) =>
      other.authorised !== entry.authorised ||
      (!entry.authorised &&
        (other.sponsorship_needed ?? null) !== (entry.sponsorship_needed ?? null));
    if (
      earlier.some(
        (other) => placesOverlap(other.place, entry.place) === true && answersOtherwise(other),
      )
    ) {
      at("overlaps an earlier entry that answers otherwise");
    }
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
    places: z.array(clearPlace),
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
  signature: lines("the signature"),
  cv: z.strictObject({ file: filePath("the CV file", ".pdf"), label: text("the CV label") }),
  facts: z.array(factSchema),
  gaps: z.strictObject({ templates: z.array(gapTemplateSchema), known: z.array(knownGapSchema) }),
  // Optional: a file from before templates has none (decisions A21).
  email_templates: z.array(emailTemplateSchema).optional(),
  fixed_answers: fixedAnswersSchema,
  style_examples: z
    .array(filePath("a style example path", ".txt"))
    .min(3, "needs 3 to 5 style examples")
    .max(5, "needs 3 to 5 style examples")
    .superRefine(noRepeats(samePathKey, null, "names the same file as an earlier style example")),
});

export type ProfileDocument = z.infer<typeof profileSchema>;
export type Fact = z.infer<typeof factSchema>;
export type KnownGap = z.infer<typeof knownGapSchema>;
export type GapTemplate = z.infer<typeof gapTemplateSchema>;
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;
export type FixedAnswers = z.infer<typeof fixedAnswersSchema>;
