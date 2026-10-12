import { z } from "zod";

import { caseless } from "@/core/platform/caseless";

import { NUMBER_FLAG, isStrictAddress, normaliseWhatsAppNumber } from "./contacts";
import { mapBox, type TilePlace } from "@/core/shared/tileGeometry";

/**
 * The job record (extraction spec, "Job record"). `extract` sends this schema
 * as the structured-output format and parses the answer with it. Structured
 * outputs allow at most 24 optional and 16 union-typed parameters and minItems
 * of 0 or 1, so every field is required and an absent value is a sentinel: an
 * empty string, -1 for a number, an "unspecified" member or an empty array.
 * The schema holds no patterns or length bounds either: the API ignores them,
 * and the parse would then fail the stage over a field the owner can fix.
 * Those checks run on the parsed record instead, as flags (checkRecord).
 * Enum fields are caseless (platform spec B4): structured outputs hold the
 * model to their values but not to their case. The record imports no image
 * code, so the pages that show its flags can use it in the browser.
 */

export const SCAM_KINDS = [
  "national_id",
  "bank_details",
  "fee",
  "personal_messaging_only",
  "other",
] as const;

export const ROUTE_KINDS = [
  "email",
  "ats_form",
  "easy_apply",
  "careers_page",
  "whatsapp",
  "linkedin_dm",
  "linkedin_comment",
  "other",
  "unknown",
] as const;

export const INSTRUCTION_KINDS = [
  "subject_format",
  "include_keyword",
  "attach_document",
  "answer_question",
  "word_limit",
  "format",
  "deadline",
  "other",
] as const;

const SENIORITIES = [
  "intern",
  "junior",
  "mid",
  "senior",
  "lead",
  "staff",
  "principal",
  "unspecified",
] as const;
const EMPLOYMENTS = ["full_time", "part_time", "contract", "internship", "unspecified"] as const;
const PAY_PERIODS = ["hour", "day", "week", "month", "year", "project", "unspecified"] as const;

const quote = z.string().describe("Copied from the post, at most 120 characters.");

const placeCode = z
  .string()
  .describe(
    'An ISO country code such as "GB", a region code such as "EU", "GCC", "APAC" or "EMEA", or "unknown".',
  );

const addressedToAi = z
  .boolean()
  .describe("Whether it addresses an AI, a language model, a bot or an automated tool.");

const box = z
  .strictObject({
    tile: z.number(),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
  })
  .describe(
    "Where the contact appears: the tile's number from 1, in the order the tiles were sent, and the box's corners in that tile's pixels. All -1 when it was not read from a screenshot.",
  );

const role = z.strictObject({
  id: z.string().describe("P1, P2, … in the order the post lists its roles."),
  title: z.string(),
  seniority: caseless(SENIORITIES),
  employment: caseless(EMPLOYMENTS),
  location: z.strictObject({
    work_mode: caseless(["remote", "hybrid", "onsite", "unspecified"]),
    places: z.array(z.strictObject({ text: z.string(), code: placeCode })),
    remote_regions: z
      .array(z.string())
      .describe("Regions remote work is open to, as the post writes them."),
    time_zone: z.strictObject({
      zone: z.string().describe('An IANA time zone such as "Asia/Dubai", or "unspecified".'),
      min_overlap_hours: z
        .number()
        .describe("The overlap the post asks for, in hours; -1 when it names none."),
      text: z.string().describe("The post's words about time zones; empty when it has none."),
    }),
  }),
  eligibility: z.strictObject({
    work_authorisation: z.array(z.strictObject({ place: placeCode, quote })),
    sponsorship: caseless(["offered", "not_offered", "unspecified"]),
    other_limits: z
      .array(quote)
      .describe("Citizenship, security clearance and any other limit, each quoted."),
  }),
  salary: z.strictObject({
    text: z.string().describe("The pay as the post writes it; empty when it gives none."),
    currency: z.string().describe('An ISO 4217 code such as "PKR"; empty when not stated.'),
    min: z.number().describe("-1 when absent."),
    max: z.number().describe("-1 when absent."),
    period: caseless(PAY_PERIODS),
  }),
  requirements: z.array(
    z.strictObject({
      id: z.string().describe("R1, R2, … within the role."),
      text: z.string(),
      priority: caseless(["must", "nice"]),
      kind: caseless(["skill", "experience", "education", "language", "other"]),
      skills: z.array(z.string()),
      depth: caseless(["production", "professional", "any"]),
      years: z.number().describe("The years of experience asked for; -1 when not stated."),
    }),
  ),
  route: z.strictObject({
    kind: caseless(ROUTE_KINDS),
    address: z
      .string()
      .describe(
        "This role's email address, link or number, exactly as written; empty when it has none.",
      ),
    quote,
    box,
  }),
  instructions: z.array(
    z.strictObject({
      kind: caseless(INSTRUCTION_KINDS),
      text: z.string(),
      value: z
        .string()
        .describe(
          "The subject format, keyword, word limit, deadline or other value it sets; for a line addressed to AI, the exact words it asks applicants to write; empty when none.",
        ),
      addressed_to_ai: addressedToAi,
    }),
  ),
  required_attachments: z.array(z.strictObject({ name: z.string(), is_cv: z.boolean() })),
  screening_questions: z.array(
    z.strictObject({
      id: z.string().describe("Q1, Q2, … within the role."),
      text: z.string(),
      addressed_to_ai: addressedToAi,
    }),
  ),
});

export const jobRecordSchema = z.strictObject({
  post_kind: caseless(["job_post", "not_a_job_post"]),
  language: caseless(["en", "other"]),
  company: z.strictObject({ name: z.string(), website: z.string() }),
  recruiter: z.strictObject({ name: z.string(), title: z.string() }),
  scam_signals: z.array(z.strictObject({ kind: caseless(SCAM_KINDS), quote })),
  roles: z.array(role),
});

export type JobRecord = z.infer<typeof jobRecordSchema>;
export type Role = JobRecord["roles"][number];

export type RecordFlagKind =
  "address" | "number" | "box" | "duplicate_id" | "too_long" | "no_roles";

/** A check the record failed. The record is kept and the review page shows the flag; nothing is retried. */
export interface RecordFlag {
  kind: RecordFlagKind;
  /** Where, by position, such as "roles[0].route.address": never a value from the post, which is untrusted. */
  path: string;
  message: string;
}

export const FLAG_MESSAGES: Readonly<Record<RecordFlagKind, string>> = {
  // Never "as the post shows it": a post may hide a second recipient in the address.
  address:
    "This email address did not pass the strict check. Type the address yourself, and nothing else.",
  number: NUMBER_FLAG,
  box: "Where this contact sits on the screenshot is not known.",
  duplicate_id:
    "The model gave this entry an ID it had already used. Check it is not listed twice.",
  too_long: "This text is longer than the post would make it. Check it against the post.",
  no_roles: "No role was found in this post.",
};

/** The prompt trims each quote to this many characters (extraction spec, "Job record"). */
export const MAX_QUOTE_LENGTH = 120;

/** Longer than any field a post fills honestly: a sign of runaway output. */
export const MAX_FIELD_LENGTH = 1000;

/** Fields whose values are quotes: under these keys, a string, or each string in the list, is one. */
const QUOTE_KEYS: ReadonlySet<string> = new Set(["quote", "other_limits"]);

/**
 * What in a parsed record fails a check: an over-long field (counted in
 * characters), an ID used twice in one list, an email address or WhatsApp
 * number that fails the strict check, a contact box that is not inside one
 * of the tiles sent or has corners but no tile, or an English job post with no role.
 * Output that fails is kept and flagged, never retried (extraction spec,
 * "Stage extract"). Requirement and question IDs are numbered within each role.
 */
export function checkRecord(record: JobRecord, tiles: readonly TilePlace[]): RecordFlag[] {
  const flags: RecordFlag[] = [];
  const flag = (kind: RecordFlagKind, path: string) =>
    flags.push({ kind, path, message: FLAG_MESSAGES[kind] });

  eachString(record, "", false, (path, text, isQuote) => {
    if ([...text].length > (isQuote ? MAX_QUOTE_LENGTH : MAX_FIELD_LENGTH)) flag("too_long", path);
  });
  // A post in another language stops before its roles matter, so only an English one is flagged.
  if (record.post_kind === "job_post" && record.language === "en" && record.roles.length === 0) {
    flag("no_roles", "roles");
  }
  repeatedIds(record.roles, "roles", flag);
  record.roles.forEach((role, i) => {
    const at = `roles[${i}]`;
    repeatedIds(role.requirements, `${at}.requirements`, flag);
    repeatedIds(role.screening_questions, `${at}.screening_questions`, flag);
    const { kind, address, box: contactBox } = role.route;
    if (kind === "email" && !isStrictAddress(address)) flag("address", `${at}.route.address`);
    if (kind === "whatsapp" && !normaliseWhatsAppNumber(address).ok)
      flag("number", `${at}.route.address`);
    const { tile, ...corners } = contactBox;
    const placed =
      tile === -1
        ? Object.values(corners).every((corner) => corner === -1)
        : mapBox(contactBox, tiles) !== null;
    if (!placed) flag("box", `${at}.route.box`);
  });
  return flags;
}

function eachString(
  value: unknown,
  path: string,
  isQuote: boolean,
  visit: (path: string, text: string, isQuote: boolean) => void,
): void {
  if (typeof value === "string") visit(path, value, isQuote);
  else if (Array.isArray(value))
    value.forEach((item, i) => eachString(item, `${path}[${i}]`, isQuote, visit));
  else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      eachString(child, path === "" ? key : `${path}.${key}`, QUOTE_KEYS.has(key), visit);
    }
  }
}

function repeatedIds(
  items: readonly { id: string }[],
  path: string,
  flag: (kind: RecordFlagKind, path: string) => void,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) flag("duplicate_id", `${path}[${i}].id`);
    seen.add(item.id);
  });
}
