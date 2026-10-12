import { describe, expect, it } from "vitest";
import { type ZodType, z } from "zod";

import { jobRecordSchema } from "./record";

/*
 * The structured-output limits (extraction spec, "Job record"). Across one
 * request the API allows at most 24 optional and 16 union-typed parameters
 * (each nullable field is a union), minItems of 0 or 1, and no recursion. It
 * ignores patterns and length bounds, which the wrapper's zod parse would
 * still enforce, failing the stage instead of flagging the field. This test
 * starts the count with extraction's schemas, under 20 and 12 for a margin;
 * Task 22 adds drafting's (extraction AC2).
 */
const STRUCTURED_SCHEMAS: Record<string, ZodType> = {
  "extract: the job record": jobRecordSchema,
};

const MAX_OPTIONAL = 20;
const MAX_UNIONS = 12;

/** Keywords that bound a value the API would not enforce. */
const BOUNDS = ["pattern", "minLength", "maxLength", "maxItems", "minProperties", "maxProperties"];

interface Census {
  optional: string[];
  unions: string[];
  bounds: string[];
  refs: string[];
}

type JsonSchema = Record<string, unknown>;

function census(schema: ZodType): Census {
  const found: Census = { optional: [], unions: [], bounds: [], refs: [] };
  visit(z.toJSONSchema(schema) as JsonSchema, "$", found);
  return found;
}

function visit(node: JsonSchema, path: string, found: Census): void {
  if (typeof node.$ref === "string") found.refs.push(path);
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.type)) {
    found.unions.push(path);
  }
  for (const keyword of BOUNDS) if (keyword in node) found.bounds.push(`${path} ${keyword}`);
  if (typeof node.minItems === "number" && node.minItems > 1) found.bounds.push(`${path} minItems`);

  const properties = (node.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((node.required ?? []) as string[]);
  for (const [key, child] of Object.entries(properties)) {
    if (!required.has(key)) found.optional.push(`${path}.${key}`);
    visit(child, `${path}.${key}`, found);
  }
  if (node.items && typeof node.items === "object") visit(node.items as JsonSchema, `${path}[]`, found);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, i) => visit(branch as JsonSchema, `${path}|${keyword}${i}`, found));
    }
  }
  for (const keyword of ["$defs", "definitions"]) {
    const definitions = node[keyword];
    if (definitions && typeof definitions === "object") {
      for (const [name, child] of Object.entries(definitions as Record<string, JsonSchema>)) {
        visit(child, `${path}#${name}`, found);
      }
    }
  }
}

describe("the structured-output schemas", () => {
  const totals = Object.values(STRUCTURED_SCHEMAS).map(census);

  it(`keep optional parameters under ${MAX_OPTIONAL} and union-typed ones under ${MAX_UNIONS}`, () => {
    expect(totals.flatMap((found) => found.optional).length).toBeLessThanOrEqual(MAX_OPTIONAL);
    expect(totals.flatMap((found) => found.unions).length).toBeLessThanOrEqual(MAX_UNIONS);
  });

  it("hold no pattern, length bound or minItems above 1", () => {
    expect(totals.flatMap((found) => found.bounds)).toEqual([]);
  });

  it("are not recursive", () => {
    expect(totals.flatMap((found) => found.refs)).toEqual([]);
  });

  it("use sentinels, so the job record has no optional or nullable field at all", () => {
    expect(census(jobRecordSchema)).toEqual({ optional: [], unions: [], bounds: [], refs: [] });
  });
});

describe("the census itself", () => {
  it("finds optional and nullable fields, patterns, length bounds and minItems above 1", () => {
    const loose = z.object({
      a: z.string().optional(),
      b: z.string().nullable(),
      c: z.string().regex(/x/),
      d: z.array(z.string()).min(2),
      e: z.array(z.object({ f: z.string().max(5) })),
    });
    expect(census(loose)).toEqual({
      optional: ["$.a"],
      unions: ["$.b"],
      bounds: ["$.c pattern", "$.d minItems", "$.e[].f maxLength"],
      refs: [],
    });
  });
});
