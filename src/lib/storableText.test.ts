import { describe, expect, it } from "vitest";

import { describeThrown, storableText } from "./storableText";

const NUL = String.fromCharCode(0);

describe("storableText", () => {
  it("drops NUL characters, which Postgres text cannot hold", () => {
    expect(storableText(`a${NUL}b${NUL}`)).toBe("ab");
  });

  it("cuts long text to the limit without splitting a character in two", () => {
    expect(storableText("abcdef", 4)).toBe("abcd");
    // An emoji is two UTF-16 units; cutting between them would leave half a character.
    expect(storableText("abc😀", 4)).toBe("abc");
    expect(storableText("abc😀", 5)).toBe("abc😀");
  });
});

describe("describeThrown", () => {
  it("writes an error as its name and message, ready to store", () => {
    expect(describeThrown(new TypeError(`bad${NUL} input`))).toBe("TypeError: bad input");
  });

  it("writes something for a thrown value that cannot be made into text", () => {
    expect(describeThrown(Object.create(null))).toBe("A value that could not be written as text");
    expect(describeThrown({ toString: () => ({}) })).toBe(
      "A value that could not be written as text",
    );
  });
});
