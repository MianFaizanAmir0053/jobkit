import { z } from "zod";

/**
 * The profile file's schema (profile spec, "The profile file"). It is
 * strict: an unknown key anywhere is an error. The checks a schema cannot
 * make, such as skills from the shared vocabulary or places from the region
 * table, are in validate.ts.
 */
const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}-[a-z0-9-]+$`), `must look like ${prefix}-lower-case-words`);

const text = (what: string) => z.string().trim().min(1, `${what} is empty`);

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time such as 04:00");

export const FACT_KINDS = ["skill", "experience", "project", "metric", "education", "language", "other"] as const;
export const DEPTHS = ["production", "professional", "side-project", "learning"] as const;

export const factSchema = z.strictObject({
  id: id("F"),
  statement: text("the statement"),
  phrase: text("the phrase"),
  kind: z.enum(FACT_KINDS),
  skills: z.array(z.string()),
  depth: z.enum(DEPTHS),
  years: z.number().nonnegative().optional(),
  source: text("the source"),
  approved: z.boolean(),
});

export const knownGapSchema = z.strictObject({
  id: id("K"),
  skills: z.array(z.string()).min(1, "a known gap names at least one skill"),
  line: text("the line"),
  approved: z.boolean(),
});

export const gapTemplateSchema = z.strictObject({
  id: id("G"),
  text: text("the template"),
});

export const fixedAnswersSchema = z.strictObject({
  salary_expectation: z.record(z.string().regex(/^[A-Z]{3}$/, "must be a currency code such as USD"), z.string()),
  notice_period: z.string(),
  availability: z.string(),
  working_window: z.strictObject({ start_utc: time, end_utc: time, text: z.string() }),
  relocation: z.strictObject({ open: z.boolean(), places: z.array(z.string()), text: z.string() }),
  work_authorisation: z.array(
    z.strictObject({
      place: z.string(),
      authorised: z.boolean(),
      sponsorship_needed: z.boolean().optional(),
      text: z.string().optional(),
    }),
  ),
  years_per_stack: z.record(z.string(), z.number().nonnegative()),
  eeo: z.strictObject({
    gender: z.string(),
    ethnicity: z.string(),
    veteran: z.string(),
    disability: z.string(),
  }),
});

export const profileSchema = z.strictObject({
  schema: z.literal(1),
  owner: z.strictObject({
    name: text("the name"),
    email: z.email(),
    location: z.strictObject({ city: text("the city"), country: z.string(), timezone: z.string() }),
  }),
  links: z.strictObject({
    portfolio: z.url(),
    linkedin: z.url().optional(),
    github: z.url().optional(),
  }),
  signature: text("the signature"),
  cv: z.strictObject({ file: text("the CV file"), label: text("the CV label") }),
  facts: z.array(factSchema),
  gaps: z.strictObject({ templates: z.array(gapTemplateSchema), known: z.array(knownGapSchema) }),
  fixed_answers: fixedAnswersSchema,
  style_examples: z
    .array(text("a style example path"))
    .min(3, "needs 3 to 5 style examples")
    .max(5, "needs 3 to 5 style examples"),
});

export type ProfileDocument = z.infer<typeof profileSchema>;
export type Fact = z.infer<typeof factSchema>;
export type KnownGap = z.infer<typeof knownGapSchema>;
export type GapTemplate = z.infer<typeof gapTemplateSchema>;
export type FixedAnswers = z.infer<typeof fixedAnswersSchema>;
