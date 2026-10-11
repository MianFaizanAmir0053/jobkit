import { describe, expect, it } from "vitest";
import { z } from "zod";

import { caseless } from "./caseless";

describe("caseless", () => {
  const kind = caseless(["full_time", "part_time"]);

  it("takes a value written in another case, in the schema's own spelling", () => {
    expect(kind.parse("Full_time")).toBe("full_time");
    expect(kind.parse("PART_TIME")).toBe("part_time");
    expect(kind.parse("full_time")).toBe("full_time");
  });

  it("refuses what matches no value, a value two members match without case, and anything not a string", () => {
    expect(kind.safeParse("contract").success).toBe(false);
    expect(caseless(["Remote", "remote"]).safeParse("REMOTE").success).toBe(false);
    expect(caseless(["Remote", "remote"]).parse("remote")).toBe("remote");
    expect(kind.safeParse(3).success).toBe(false);
  });

  it("treats a value listed twice as one value", () => {
    expect(caseless(["a", "a"]).parse("A")).toBe("a");
  });

  it("compares only ASCII letters without case", () => {
    // U+212A KELVIN SIGN lower-cases to "k" in JavaScript, but is not the letter K.
    expect(caseless(["kind"]).safeParse("\u212Aind").success).toBe(false);
  });

  it("describes itself as the enum in JSON Schema, so the API holds the model to the values", () => {
    expect(z.toJSONSchema(z.object({ kind }))).toMatchObject({
      properties: { kind: { type: "string", enum: ["full_time", "part_time"] } },
    });
  });
});
