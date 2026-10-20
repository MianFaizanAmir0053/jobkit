import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { type ZodType, z } from "zod";

import { caseless } from "@/core/platform/caseless";

import { answersOnlySchema } from "@/core/drafting/answersStage";
import { judgeAnswerSchema } from "@/core/drafting/judge";
import { draftAnswerSchema, formAnswerSchema } from "@/core/drafting/kit";

import { contactReadSchema } from "./addressReadStage";
import { formQuestionsSchema } from "./questionsStage";
import { jobRecordSchema } from "./record";

/*
 * The structured-output limits (extraction spec, "Job record"; platform spec
 * B4). Each request carries one stage's schema, and the API allows at most 24
 * optional and 16 union-typed parameters per request (each nullable field is
 * a union), minItems of 0 or 1, and no recursion. It does not enforce
 * patterns, length or number bounds, formats it does not know, or defaults,
 * which the wrapper's zod parse would still apply, failing the stage instead
 * of flagging the field; and B4 rules out records, tuples and anything that
 * changes a value. The census reads each schema as the Claude adapter sends
 * it, with shared parts as $defs, and keeps under 20 and 12 for a margin.
 * Drafting's schemas are counted too (extraction AC2).
 */
const STRUCTURED_SCHEMAS: Record<string, ZodType> = {
  "extract: the job record": jobRecordSchema,
  "draft: the fit table and an email body": draftAnswerSchema,
  "draft: the fit table, a cover note and the answers": formAnswerSchema,
  "judge: a verdict for every block": judgeAnswerSchema,
  "address_read: the contact a crop shows": contactReadSchema,
  "extract_questions: a form's questions": formQuestionsSchema,
  "draft_answers: the answers to added questions": answersOnlySchema,
};

const MAX_OPTIONAL = 20;
const MAX_UNIONS = 12;

/** Keywords that bound or fill in a value the API would not enforce the same way. */
const BOUNDS = [
  "pattern",
  "minLength",
  "maxLength",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "format",
  "default",
];

interface Census {
  optional: string[];
  unions: string[];
  bounds: string[];
  /** Records (a schema for any further key) and tuples (prefixItems). */
  shapes: string[];
  /** Definitions that refer back to themselves, directly or through others. */
  recursive: string[];
}

type JsonSchema = Record<string, unknown>;

function census(schema: ZodType): Census {
  const document = z.toJSONSchema(schema, { reused: "ref" }) as JsonSchema;
  const found: Census = { optional: [], unions: [], bounds: [], shapes: [], recursive: [] };
  const refs = new Map<string, Set<string>>();
  visit(document, "$", "$", found, refs);
  found.recursive = [...refs.keys()].filter((from) => reaches(from, from, refs, new Set()));
  return found;
}

function visit(
  node: JsonSchema,
  path: string,
  owner: string,
  found: Census,
  refs: Map<string, Set<string>>,
): void {
  if (typeof node.$ref === "string") {
    const target = node.$ref === "#" ? "$" : node.$ref.replace("#/$defs/", "#");
    refs.set(owner, (refs.get(owner) ?? new Set()).add(target));
  }
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.type)) {
    found.unions.push(path);
  }
  for (const keyword of BOUNDS) if (keyword in node) found.bounds.push(`${path} ${keyword}`);
  if (typeof node.minItems === "number" && node.minItems > 1) found.bounds.push(`${path} minItems`);
  if (typeof node.additionalProperties === "object" && node.additionalProperties !== null) {
    found.shapes.push(`${path} additionalProperties`);
  }
  if ("prefixItems" in node) found.shapes.push(`${path} prefixItems`);

  const properties = (node.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((node.required ?? []) as string[]);
  for (const [key, child] of Object.entries(properties)) {
    if (!required.has(key)) found.optional.push(`${path}.${key}`);
    visit(child, `${path}.${key}`, owner, found, refs);
  }
  if (node.items && typeof node.items === "object") {
    visit(node.items as JsonSchema, `${path}[]`, owner, found, refs);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, i) =>
        visit(branch as JsonSchema, `${path}|${keyword}${i}`, owner, found, refs),
      );
    }
  }
  const definitions = node.$defs;
  if (definitions && typeof definitions === "object") {
    for (const [name, child] of Object.entries(definitions as Record<string, JsonSchema>)) {
      visit(child, `#${name}`, `#${name}`, found, refs);
    }
  }
}

function reaches(
  from: string,
  target: string,
  refs: Map<string, Set<string>>,
  seen: Set<string>,
): boolean {
  for (const next of refs.get(from) ?? []) {
    if (next === target) return true;
    if (!seen.has(next)) {
      seen.add(next);
      if (reaches(next, target, refs, seen)) return true;
    }
  }
  return false;
}

const FIXTURES = join(process.cwd(), "evals", "synthetic", "records");

describe("the structured-output schemas", () => {
  for (const [name, schema] of Object.entries(STRUCTURED_SCHEMAS)) {
    describe(name, () => {
      const found = census(schema);

      it(`keeps optional parameters under ${MAX_OPTIONAL} and union-typed ones under ${MAX_UNIONS}`, () => {
        expect(found.optional.length).toBeLessThanOrEqual(MAX_OPTIONAL);
        expect(found.unions.length).toBeLessThanOrEqual(MAX_UNIONS);
      });

      it("holds no bound, format or default, no record or tuple, and no recursion", () => {
        expect({ bounds: found.bounds, shapes: found.shapes, recursive: found.recursive }).toEqual({
          bounds: [],
          shapes: [],
          recursive: [],
        });
      });
    });
  }

  it("uses sentinels, so the job record has no optional or nullable field at all", () => {
    const found = census(jobRecordSchema);
    expect([found.optional, found.unions]).toEqual([[], []]);
  });

  it("changes no value of an answer as the model writes it", () => {
    for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".json"))) {
      const answer: unknown = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
      expect(jobRecordSchema.parse(answer), file).toEqual(answer);
    }
  });
});

describe("the census itself", () => {
  it("finds optional and nullable fields, bounds, formats, defaults, records and tuples", () => {
    const loose = z.object({
      a: z.string().optional(),
      b: z.string().nullable(),
      c: z.string().regex(/x/),
      d: z.array(z.string()).min(2),
      e: z.array(z.object({ f: z.string().max(5) })),
      g: z.number().int().min(0),
      h: z.url(),
      i: z.string().default("x"),
      j: z.record(z.string(), z.number()),
      k: z.tuple([z.string(), z.number()]),
      l: caseless(["x", "y"]),
    });

    const found = census(loose);

    // A field with a default is required on the output side; its default keyword is what shows it.
    expect(found.optional).toEqual(["$.a"]);
    expect(found.unions).toEqual(["$.b"]);
    expect(found.bounds).toEqual(
      expect.arrayContaining([
        "$.c pattern",
        "$.d minItems",
        "$.e[].f maxLength",
        "$.g minimum",
        "$.h format",
        "$.i default",
      ]),
    );
    expect(found.shapes).toEqual(["$.j additionalProperties", "$.k prefixItems"]);
  });

  it("tells reuse from recursion", () => {
    const shared = z.object({ text: z.string() });
    const node: z.ZodType = z.object({
      name: z.string(),
      get children() {
        return z.array(node);
      },
    });

    expect(census(z.object({ a: shared, b: shared })).recursive).toEqual([]);
    expect(census(z.object({ tree: node })).recursive).not.toEqual([]);
  });
});
