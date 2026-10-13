import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import type { EligibilityResult } from "@/core/extraction/eligibilityCheck";
import type { ExtractOutput } from "@/core/extraction/extract";
import {
  INSTRUCTION_KINDS,
  type RecordFlagKind,
  type Role,
  ROUTE_KINDS,
  SCAM_KINDS,
} from "@/core/extraction/record";
import { roleKey } from "@/core/ledger/normalise";

import { checkRenders, loadSyntheticPosts, readManifest, type SyntheticPost } from "./render";
import type { EvalCase } from "./run";
import { sameContact, SCORED_FIELDS, type ScoredFields } from "./score";

/**
 * The synthetic posts as the runner scores them (evals spec, "Case
 * sources"): each post's rendered screenshot, taken only while the render
 * manifest vouches for it, and what the post expects. The fields a post
 * gives (company, role, route, contact, eligibility) are scored as the
 * archive's labels are; the rest are checks on what the model noticed,
 * which the extraction and drafting specs defer here: the must-haves and
 * the depth they ask for, lines addressed to AI, the roles and their
 * contacts, the language, scam signals, a contact the strict checks flag,
 * and the tiles sent. A key the extract stage cannot check is named as left
 * to the stage that can, never counted as met.
 */

const ELIGIBILITY = [
  "eligible",
  "unclear",
  "likely_ineligible",
] as const satisfies readonly EligibilityResult[];

const CONTACT_FLAG_KINDS = ["missing_country_code", "invalid_address"] as const;

/** The contact flags a post can expect, as the record's checks name them. */
const CONTACT_FLAGS: Readonly<Record<(typeof CONTACT_FLAG_KINDS)[number], RecordFlagKind>> = {
  missing_country_code: "number",
  invalid_address: "address",
};

const expectSchema = z
  .strictObject({
    company: z.string().optional(),
    role: z.string().optional(),
    route: z.enum(ROUTE_KINDS).optional(),
    contact: z.string().optional(),
    eligibility: z.enum(ELIGIBILITY).optional(),
    /** The must-haves, each in the post's words; the role read has these and no others. */
    must: z.array(z.string().min(1)).optional(),
    /** The depth read for the must-have holding these words. */
    depth: z.record(z.string(), z.enum(["production", "professional", "any"])).optional(),
    /** The post's instructions; one addressed to AI may be read as several. */
    instructions: z
      .array(
        z.strictObject({
          kind: z.enum(INSTRUCTION_KINDS),
          /** Words the value read holds; any value when absent. */
          value: z.string().min(1).optional(),
          addressed_to_ai: z.boolean(),
        }),
      )
      .optional(),
    roles: z.number().int().nonnegative().optional(),
    /** Each role's contact, by its title. */
    contacts: z.record(z.string(), z.string()).optional(),
    language: z.enum(["en", "other"]).optional(),
    /** Kinds the model or the phrase backstop must report; others may come too. */
    scam_signals: z.array(z.enum(SCAM_KINDS)).optional(),
    contact_flag: z.enum(CONTACT_FLAG_KINDS).optional(),
    tiles: z.number().int().positive().optional(),
    /** Drafting's: the fixed answers by question, and the must-have gaps the draft answers. */
    fixed_keys: z.record(z.string(), z.string()).optional(),
    must_gaps_expected: z.number().int().nonnegative().optional(),
  })
  .superRefine(({ must = [], depth = {} }, ctx) => {
    for (const words of Object.keys(depth)) {
      if (!must.some((each) => holds(each, words))) {
        ctx.addIssue({
          code: "custom",
          path: ["depth", words],
          message: `The depth for "${words}" names words none of the post's must-haves holds.`,
        });
      }
    }
  });

export type SyntheticExpect = z.infer<typeof expectSchema>;

const expectationsSchema = z.array(z.object({ id: z.string(), expect: expectSchema }));

/** The keys another stage checks, and that stage. */
const LATER: Readonly<Partial<Record<keyof SyntheticExpect, string>>> = {
  fixed_keys: "draft",
  must_gaps_expected: "draft",
};

/** The public posts, each with its expectations; a key no check knows is refused, so none is skipped unseen. */
export function syntheticPosts(file: string): (SyntheticPost & { expect: SyntheticExpect })[] {
  const posts = loadSyntheticPosts(file);
  const parsed = expectationsSchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `${file}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" ")}`,
    );
  }
  return posts.map((post, i) => ({ ...post, expect: parsed.data[i]!.expect }));
}

/** A post as the runner takes it: its screenshot alone, the fields it gives as labels, and the rest to check. */
export function caseOf(
  post: SyntheticPost & { expect: SyntheticExpect },
  image: Uint8Array,
): EvalCase {
  return {
    id: post.id,
    split: "synthetic",
    images: [{ bytes: image, contentType: "image/png" }],
    pastedText: "",
    labels: Object.fromEntries(
      SCORED_FIELDS.filter((field) => post.expect[field] !== undefined).map((field) => [
        field,
        post.expect[field],
      ]),
    ) as Partial<ScoredFields>,
    expect: post.expect,
  };
}

/** The images a run read: the Chrome that rendered them, and each one's SHA-256. */
export interface Renders {
  browser: string;
  images: Record<string, string>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The synthetic posts as the runner takes them, from `dir` (evals/synthetic):
 * each one's screenshot, read once, so the bytes checked are the bytes run,
 * and refused, naming every problem, unless the manifest vouches for each:
 * none missing, changed, or of a post edited since it was rendered.
 */
export function syntheticCases(dir: string): { cases: EvalCase[]; renders: Renders } {
  const posts = syntheticPosts(join(dir, "posts.yaml"));
  const screenshots = join(dir, "screenshots");
  const manifest = readManifest(join(screenshots, "manifest.json"));
  if (!manifest)
    throw new Error("The synthetic posts have not been rendered: run npm run eval:render.");
  const images = new Map<string, Uint8Array>();
  for (const post of posts) {
    const file = join(screenshots, `${post.id}.png`);
    if (existsSync(file)) images.set(`${post.id}.png`, new Uint8Array(readFileSync(file)));
  }
  const problems = checkRenders(posts, manifest, (name) => images.get(name) ?? null);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return {
    cases: posts.map((post) => caseOf(post, images.get(`${post.id}.png`)!)),
    renders: {
      browser: manifest.browser,
      images: Object.fromEntries(
        posts.map((post) => [`${post.id}.png`, sha256(images.get(`${post.id}.png`)!)]),
      ),
    },
  };
}

/** Words that join a requirement's words rather than say what it asks. */
const JOINING = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "with",
]);

/** A text's words, without case or punctuation. */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !JOINING.has(word));
}

/** Whether `text` holds every word of `wanted`, in any order. */
function holds(text: string, wanted: string): boolean {
  const words = new Set(wordsOf(text));
  const needed = wordsOf(wanted);
  return needed.length > 0 && needed.every((word) => words.has(word));
}

/** What a run observed of a post: extract's output, and the role it went on with. */
export interface Observed {
  output: ExtractOutput;
  role: Role | null;
}

export interface Check {
  /** The expectation's key in posts.yaml. */
  key: keyof SyntheticExpect;
  /** Whether the run met it; null when another stage checks it. */
  met: boolean | null;
  /** What was read instead, when it was not met. */
  note: string;
}

const quoted = (texts: readonly string[]) => texts.map((text) => `"${text}"`).join(", ");

/** Pairs each wanted entry with a distinct entry read that fits it, most exacting first. */
function pairUp<W, R>(
  wanted: readonly W[],
  read: readonly R[],
  fits: (wanted: W, read: R) => boolean,
  exacting: (wanted: W) => boolean = () => false,
): { missing: W[]; unpaired: R[] } {
  const used = new Set<number>();
  const missing: W[] = [];
  const order = [...wanted.filter(exacting), ...wanted.filter((each) => !exacting(each))];
  for (const each of order) {
    const at = read.findIndex((entry, i) => !used.has(i) && fits(each, entry));
    if (at === -1) missing.push(each);
    else used.add(at);
  }
  return { missing, unpaired: read.filter((_, i) => !used.has(i)) };
}

function mustCheck(must: readonly string[], role: Role): Omit<Check, "key"> {
  const read = role.requirements
    .filter((requirement) => requirement.priority === "must")
    .map(({ text }) => text);
  const { missing, unpaired } = pairUp(must, read, (wanted, text) => holds(text, wanted));
  const notes = [
    ...(missing.length > 0 ? [`${quoted(missing)} was not read as a must-have`] : []),
    ...(unpaired.length > 0 ? [`${quoted(unpaired)} was read as one`] : []),
  ];
  return { met: notes.length === 0, note: notes.join("; ") };
}

function depthCheck(depth: Record<string, string>, role: Role): Omit<Check, "key"> {
  const notes: string[] = [];
  for (const [words, wanted] of Object.entries(depth)) {
    const requirement = role.requirements.find(({ text }) => holds(text, words));
    if (!requirement) notes.push(`no requirement holds "${words}"`);
    else if (requirement.depth !== wanted) {
      notes.push(`"${requirement.text}" was read at depth ${requirement.depth}, not ${wanted}`);
    }
  }
  return { met: notes.length === 0, note: notes.join("; ") };
}

type WantedInstruction = NonNullable<SyntheticExpect["instructions"]>[number];

const who = (toAi: boolean) => (toAi ? "addressed to AI" : "for the applicant");

/**
 * Each instruction expected read as such, and nothing else read for the
 * applicant: a line addressed to AI read as the applicant's is one the
 * drafter would follow. Others read as addressed to AI are allowed, since
 * the prompt splits such a line into one instruction for each thing it asks.
 */
function instructionsCheck(wanted: readonly WantedInstruction[], role: Role): Omit<Check, "key"> {
  const { missing, unpaired } = pairUp(
    wanted,
    role.instructions,
    (each, read) =>
      read.kind === each.kind &&
      read.addressed_to_ai === each.addressed_to_ai &&
      (each.value === undefined || holds(read.value, each.value)),
    (each) => each.value !== undefined,
  );
  const extra = unpaired.filter((read) => !read.addressed_to_ai);
  const notes = [
    ...missing.map(
      (each) =>
        `${each.kind} ${who(each.addressed_to_ai)}${each.value ? ` holding "${each.value}"` : ""} was not read`,
    ),
    ...extra.map(
      (read) => `${read.kind} ${who(false)} was read besides: "${read.value || read.text}"`,
    ),
  ];
  return { met: notes.length === 0, note: notes.join("; ") };
}

const NO_ROLE = { met: false, note: "No role was read." };

/** Each expectation the extract stage can check, in a fixed order, then those left to later stages. */
export function checkExpectations(expect: SyntheticExpect, observed: Observed): Check[] {
  const { output, role } = observed;
  const { record } = output;
  const checks: Check[] = [];
  const check = (key: keyof SyntheticExpect, result: Omit<Check, "key">) =>
    checks.push({ key, ...result });

  if (expect.must) check("must", role ? mustCheck(expect.must, role) : NO_ROLE);
  if (expect.depth) check("depth", role ? depthCheck(expect.depth, role) : NO_ROLE);
  if (expect.instructions) {
    check("instructions", role ? instructionsCheck(expect.instructions, role) : NO_ROLE);
  }
  if (expect.roles !== undefined) {
    const read = record.roles.length;
    check("roles", { met: read === expect.roles, note: `${read} read` });
  }
  if (expect.contacts) {
    const notes = Object.entries(expect.contacts).flatMap(([title, contact]) => {
      const read = record.roles.find((each) => roleKey(each.title) === roleKey(title));
      if (!read) return [`no role "${title}" was read`];
      return sameContact(read.route.address, contact)
        ? []
        : [`"${title}" was read with "${read.route.address}"`];
    });
    check("contacts", { met: notes.length === 0, note: notes.join("; ") });
  }
  if (expect.language) {
    check("language", {
      met: record.language === expect.language,
      note: `read as ${record.language}`,
    });
  }
  if (expect.scam_signals) {
    const kinds = new Set([...record.scam_signals, ...output.backstop].map(({ kind }) => kind));
    const missing = expect.scam_signals.filter((kind) => !kinds.has(kind));
    check("scam_signals", {
      met: missing.length === 0,
      note: missing.length > 0 ? `not reported: ${missing.join(", ")}` : "",
    });
  }
  if (expect.contact_flag) {
    const kind = CONTACT_FLAGS[expect.contact_flag];
    check("contact_flag", {
      met: output.flags.some((flag) => flag.kind === kind),
      note: `flags: ${output.flags.map((flag) => flag.kind).join(", ") || "none"}`,
    });
  }
  if (expect.tiles !== undefined) {
    check("tiles", {
      met: output.tiles.length === expect.tiles,
      note: `${output.tiles.length} sent`,
    });
  }
  for (const [key, stage] of Object.entries(LATER) as [keyof SyntheticExpect, string][]) {
    if (expect[key] !== undefined) {
      check(key, { met: null, note: `Checked when the ${stage} stage is evaluated.` });
    }
  }
  return checks.map((each) => (each.met === true ? { ...each, note: "" } : each));
}
