import { describe, expect, it } from "vitest";

import { decided, drawnWith, forget, wordsAfter } from "./wordsChain";

/* The words a page's own decisions left: review spec, "The outbound gate". */

describe("wordsAfter", () => {
  it("follows the page's own decisions from the words it shows, and no further", () => {
    expect(wordsAfter("job-1", "a")).toBe("a");

    decided("job-1", "a", "b");
    decided("job-1", "b", "c");

    expect(wordsAfter("job-1", "a")).toBe("c");
    // Drawn again with the words its decisions left: those stand.
    expect(wordsAfter("job-1", "c")).toBe("c");
    // Another job's decisions are its own.
    expect(wordsAfter("job-2", "a")).toBe("a");
  });

  it("ends at the words the latest decision left, though earlier words came back", () => {
    // An edit, its undoing, and another edit: x to y, y back to x, then x to z.
    decided("job-3", "x", "y");
    decided("job-3", "y", "x");
    expect(wordsAfter("job-3", "x")).toBe("x");

    decided("job-3", "x", "z");

    expect(wordsAfter("job-3", "x")).toBe("z");
    expect(wordsAfter("job-3", "y")).toBe("z");
  });

  it("forgets the page's decisions once it is drawn again, so words that come back are its own", () => {
    // The phone edits (a to b) and is drawn with b; the laptop's Undo brings a back.
    decided("job-4", "a", "b");
    forget("job-4");

    // Drawn with a again, the phone names a, which the server has, never b.
    expect(wordsAfter("job-4", "a")).toBe("a");
    // Another job's chain is its own.
    decided("job-5", "a", "b");
    forget("job-4");
    expect(wordsAfter("job-5", "a")).toBe("b");
  });

  it("keeps, drawn again, what its own decisions left from the words drawn, as when quick taps outrun the drawing", () => {
    // Three quick edits, a to b to c to d; the page is drawn with b, then with d.
    decided("job-6", "a", "b");
    decided("job-6", "b", "c");
    decided("job-6", "c", "d");
    drawnWith("job-6", "b");

    expect(wordsAfter("job-6", "b")).toBe("d");
    // The words before the drawing are spent: shown again, as after an Undo elsewhere, they are the page's own.
    expect(wordsAfter("job-6", "a")).toBe("a");
    drawnWith("job-6", "d");
    expect(wordsAfter("job-6", "b")).toBe("b");
  });
});
