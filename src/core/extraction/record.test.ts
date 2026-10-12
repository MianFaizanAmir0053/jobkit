import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { NUMBER_FLAG, normaliseWhatsAppNumber } from "./contacts";
import {
  FLAG_MESSAGES,
  type JobRecord,
  MAX_FIELD_LENGTH,
  MAX_QUOTE_LENGTH,
  type RecordFlag,
  checkRecord,
  jobRecordSchema,
} from "./record";
import { type Tile, tileSpans } from "./tiles";

/*
 * Extraction AC3. The synthetic records are what the fake model answers for
 * the synthetic posts in posts.yaml. Each must parse, and agree with its
 * post's labels, so the stages and evaluations built on them can trust them.
 */
const SYNTHETIC = join(process.cwd(), "evals", "synthetic");
const RECORDS = join(SYNTHETIC, "records");

interface Post {
  id: string;
  render: { width: number; height: number };
  text: string;
  expect: Record<string, unknown>;
}

const POSTS = parse(readFileSync(join(SYNTHETIC, "posts.yaml"), "utf8")) as Post[];
const FIXTURES = readdirSync(RECORDS)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length))
  .sort();

function fixture(id: string): JobRecord {
  return JSON.parse(readFileSync(join(RECORDS, `${id}.json`), "utf8")) as JobRecord;
}

function post(id: string): Post {
  const found = POSTS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no synthetic post ${id}`);
  return found;
}

/** The tiles a post's screenshot is cut into; the checks need only their places and sizes. */
function tilesOf(id: string): Tile[] {
  const { width, height } = post(id).render;
  return tileSpans(width, height).map((span) => ({ image: 0, ...span, width, png: new Uint8Array() }));
}

/** A record's contact as the review page would use it: a number normalised, anything else as given. */
function contactOf(route: JobRecord["roles"][number]["route"]): string {
  if (route.kind !== "whatsapp") return route.address;
  const number = normaliseWhatsAppNumber(route.address);
  return number.ok ? number.number : route.address;
}

const kinds = (flags: RecordFlag[]) => flags.map(({ kind, path }) => ({ kind, path }));

describe("the synthetic records", () => {
  it("cover every synthetic post, and only those", () => {
    expect(FIXTURES).toEqual(POSTS.map((candidate) => candidate.id).sort());
  });

  it.each(FIXTURES)("%s parses with the record schema", (id) => {
    expect(jobRecordSchema.safeParse(fixture(id)).success).toBe(true);
  });

  /*
   * Labels for later stages (eligibility, fixed answers, the fit check's
   * expected gaps) are checked by those stages' own tests.
   */
  it.each(FIXTURES)("%s agrees with its post's labels", (id) => {
    const record = fixture(id);
    const labels = post(id).expect;
    const [first] = record.roles;
    if ("language" in labels) expect(record.language).toBe(labels.language);
    if ("company" in labels) expect(record.company.name).toBe(labels.company);
    if ("role" in labels) expect(first?.title).toBe(labels.role);
    if ("route" in labels) expect(first?.route.kind).toBe(labels.route);
    if ("contact" in labels) expect(first && contactOf(first.route)).toBe(labels.contact);
    if ("roles" in labels) expect(record.roles).toHaveLength(labels.roles as number);
    if ("contacts" in labels) {
      const byTitle = Object.fromEntries(record.roles.map((role) => [role.title, contactOf(role.route)]));
      expect(byTitle).toEqual(labels.contacts);
    }
    if ("scam_signals" in labels) {
      expect(record.scam_signals.map((signal) => signal.kind)).toEqual(labels.scam_signals);
    }
    if ("must" in labels) {
      const musts = first?.requirements.filter((requirement) => requirement.priority === "must");
      expect(musts?.map((requirement) => requirement.text)).toEqual(labels.must);
    }
    if ("instructions" in labels) {
      expect(first?.instructions).toMatchObject(labels.instructions as object[]);
    }
    if ("tiles" in labels) expect(tilesOf(id)).toHaveLength(labels.tiles as number);
    if ("contact_flag" in labels) {
      const flagKind = { missing_country_code: "number", invalid_address: "address" }[
        labels.contact_flag as string
      ];
      expect(kinds(checkRecord(record, tilesOf(id)))).toEqual([
        { kind: flagKind, path: "roles[0].route.address" },
      ]);
    } else {
      expect(checkRecord(record, tilesOf(id))).toEqual([]);
    }
  });

  it("include a contact read from a screenshot, in a later tile", () => {
    const [role] = fixture("S12-tall-dubai").roles;
    expect(role?.route.box.tile).toBe(3);
  });
});

describe("jobRecordSchema", () => {
  const base = () => structuredClone(fixture("S01-email-simple")) as unknown as Record<string, any>;

  it.each([
    ["a missing field", (r: Record<string, any>) => delete r.company],
    ["null for an absent number", (r: Record<string, any>) => (r.roles[0].salary.min = null)],
    ["a kind outside its list", (r: Record<string, any>) => (r.roles[0].route.kind = "fax")],
    ["an unknown key", (r: Record<string, any>) => (r.extra = "x")],
    ["an unknown key in a role", (r: Record<string, any>) => (r.roles[0].notes = "x")],
    ["text for a flag", (r: Record<string, any>) => (r.roles[0].instructions[0].addressed_to_ai = "no")],
    ["text for a number", (r: Record<string, any>) => (r.roles[0].requirements[0].years = "4")],
    ["one role instead of a list", (r: Record<string, any>) => (r.roles = r.roles[0])],
  ])("rejects %s", (_case, breakIt) => {
    const record = base();
    breakIt(record);
    expect(jobRecordSchema.safeParse(record).success).toBe(false);
  });

  it("keeps output that parses but fails a check, and flags it rather than failing", () => {
    const record = structuredClone(fixture("S01-email-simple"));
    record.roles[0]!.route.address = "jobs at example dot com";
    const parsed = jobRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    const before = structuredClone(record);
    expect(kinds(checkRecord(record, []))).toEqual([{ kind: "address", path: "roles[0].route.address" }]);
    expect(record).toEqual(before);
  });
});

describe("checkRecord", () => {
  it("checks each role's own contact", () => {
    const record = structuredClone(fixture("S07-two-roles"));
    record.roles[1]!.route.address = "ml@";
    expect(checkRecord(record, [])).toEqual([
      { kind: "address", path: "roles[1].route.address", message: FLAG_MESSAGES.address },
    ]);
  });

  it("flags a WhatsApp number in a form whose country is not certain", () => {
    expect(checkRecord(fixture("S06-number-without-country-code"), [])).toEqual([
      { kind: "number", path: "roles[0].route.address", message: NUMBER_FLAG },
    ]);
  });

  it("checks no contact on routes that carry none to check", () => {
    for (const id of ["S03-ats-form", "S04-easy-apply", "S13-dm-or-comment"]) {
      expect(checkRecord(fixture(id), [])).toEqual([]);
    }
  });

  it("accepts a box inside its tile", () => {
    expect(checkRecord(fixture("S12-tall-dubai"), tilesOf("S12-tall-dubai"))).toEqual([]);
  });

  it("flags a box outside its tile, and a box with no screenshot to be in", () => {
    const record = structuredClone(fixture("S12-tall-dubai"));
    record.roles[0]!.route.box.y2 = 1249;
    expect(checkRecord(record, tilesOf("S12-tall-dubai"))).toEqual([
      { kind: "box", path: "roles[0].route.box", message: FLAG_MESSAGES.box },
    ]);
    expect(kinds(checkRecord(fixture("S12-tall-dubai"), []))).toEqual([
      { kind: "box", path: "roles[0].route.box" },
    ]);
  });

  it("flags role, requirement and question IDs used twice", () => {
    const roles = structuredClone(fixture("S07-two-roles"));
    roles.roles[1]!.id = "P1";
    const requirements = structuredClone(fixture("S01-email-simple"));
    requirements.roles[0]!.requirements[2]!.id = "R1";
    const questions = structuredClone(fixture("S03-ats-form"));
    questions.roles[0]!.screening_questions[3]!.id = "Q2";
    expect(kinds(checkRecord(roles, []))).toEqual([{ kind: "duplicate_id", path: "roles[1].id" }]);
    expect(kinds(checkRecord(requirements, []))).toEqual([
      { kind: "duplicate_id", path: "roles[0].requirements[2].id" },
    ]);
    expect(kinds(checkRecord(questions, []))).toEqual([
      { kind: "duplicate_id", path: "roles[0].screening_questions[3].id" },
    ]);
  });

  it("allows the same requirement ID in two roles, which number their own", () => {
    expect(checkRecord(fixture("S07-two-roles"), [])).toEqual([]);
  });

  it("flags a quote over 120 characters and any other field over its limit", () => {
    const atLimits = structuredClone(fixture("S10-scam"));
    atLimits.scam_signals[0]!.quote = "q".repeat(MAX_QUOTE_LENGTH);
    atLimits.roles[0]!.title = "t".repeat(MAX_FIELD_LENGTH);
    expect(checkRecord(atLimits, [])).toEqual([]);

    const over = structuredClone(atLimits);
    over.scam_signals[0]!.quote += "q";
    over.roles[0]!.title += "t";
    over.roles[0]!.route.quote = "r".repeat(MAX_QUOTE_LENGTH + 1);
    over.roles[0]!.eligibility.other_limits.push("o".repeat(MAX_QUOTE_LENGTH + 1));
    over.roles[0]!.eligibility.work_authorisation.push({ place: "GB", quote: "w".repeat(MAX_QUOTE_LENGTH + 1) });
    expect(checkRecord(over, [])).toEqual([
      { kind: "too_long", path: "scam_signals[0].quote", message: FLAG_MESSAGES.too_long },
      { kind: "too_long", path: "roles[0].title", message: FLAG_MESSAGES.too_long },
      { kind: "too_long", path: "roles[0].eligibility.work_authorisation[0].quote", message: FLAG_MESSAGES.too_long },
      { kind: "too_long", path: "roles[0].eligibility.other_limits[0]", message: FLAG_MESSAGES.too_long },
      { kind: "too_long", path: "roles[0].route.quote", message: FLAG_MESSAGES.too_long },
    ]);
  });

  it("never repeats a value from the post in a flag", () => {
    const record = fixture("S14-address-injection");
    const flags = checkRecord(record, []);
    expect(flags).toHaveLength(1);
    expect(JSON.stringify(flags)).not.toContain(record.roles[0]!.route.address);
  });

  it("uses the messages the review page shows", () => {
    expect(FLAG_MESSAGES.number).toBe(NUMBER_FLAG);
    for (const message of Object.values(FLAG_MESSAGES)) expect(message).toMatch(/^[A-Z].*[^ ]$/);
  });
});
