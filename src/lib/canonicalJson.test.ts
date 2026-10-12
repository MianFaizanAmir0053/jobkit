import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonicalJson";

describe("canonicalJson", () => {
  it("writes the same text for the same value, whatever order its keys were set in", () => {
    const first = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } };
    const second = { a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(first)).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it("keeps the order of arrays, which is part of the value", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("refuses what JSON cannot carry exactly, rather than giving two values one text", () => {
    class Point {
      x = 1;
    }
    const refused = [
      new Set([1]),
      new Map([["a", 1]]),
      new Number(1),
      new Point(),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      BigInt(10),
      () => 1,
      Symbol("s"),
    ];
    for (const value of refused) {
      expect(() => canonicalJson({ value }), String(value)).toThrow(TypeError);
    }
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    // JSON writes undefined in a list as null, which would make [undefined] and [null] one text.
    expect(() => canonicalJson({ list: [1, undefined] })).toThrow(TypeError);
  });

  it("writes a date as JSON does, and leaves out a field set to undefined", () => {
    expect(canonicalJson({ at: new Date("2026-10-11T09:00:00Z"), gone: undefined })).toBe(
      '{"at":"2026-10-11T09:00:00.000Z"}',
    );
  });

  it("writes a key named __proto__ as data", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{"b":1},"a":1}'))).toBe(
      '{"__proto__":{"b":1},"a":1}',
    );
  });
});
