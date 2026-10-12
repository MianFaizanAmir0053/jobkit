import { describe, expect, it } from "vitest";

import { agreement, inPastedText } from "./addressRead";

/* The second read's agreement: extraction AC10. */

describe("agreement", () => {
  it("passes equal reads: addresses after trimming and lower case, numbers after normalising", () => {
    expect(agreement("email", "Jobs@Example.com", { read: " jobs@example.com " })).toEqual({
      ok: true,
    });
    expect(agreement("whatsapp", "0300 1234567", { read: "+92 300 1234567" })).toEqual({
      ok: true,
    });
  });

  it("blocks different reads, a missing second read, an invalid box and a missing crop", () => {
    expect(agreement("email", "jobs@example.com", { read: "jobs@examp1e.com" })).toEqual({
      ok: false,
      reason: "disagree",
    });
    expect(agreement("whatsapp", "0300 1234567", { read: "0300 1234568" })).toEqual({
      ok: false,
      reason: "disagree",
    });
    expect(agreement("email", "jobs@example.com", { read: null })).toEqual({
      ok: false,
      reason: "no_second_read",
    });
    expect(agreement("email", "jobs@example.com", { problem: "invalid_box" })).toEqual({
      ok: false,
      reason: "invalid_box",
    });
    expect(agreement("email", "jobs@example.com", { problem: "no_crop" })).toEqual({
      ok: false,
      reason: "no_crop",
    });
  });

  it("never passes two reads of a number that does not normalise", () => {
    expect(agreement("whatsapp", "98765 43210", { read: "98765 43210" })).toEqual({
      ok: false,
      reason: "disagree",
    });
  });

  it("passes pasted text only when it holds the contact", () => {
    expect(agreement("email", "jobs@example.com", { inText: true })).toEqual({ ok: true });
    expect(agreement("email", "jobs@example.com", { inText: false })).toEqual({
      ok: false,
      reason: "not_in_text",
    });
  });
});

describe("inPastedText", () => {
  const post =
    "Senior engineer wanted. Apply to jobs@example.com. WhatsApp 0300-1234567 for questions.";

  it("finds an address only verbatim and whole", () => {
    expect(inPastedText("email", "jobs@example.com", post)).toBe(true);
    expect(inPastedText("email", "Jobs@example.com", post)).toBe(false);
    expect(inPastedText("email", "obs@example.com", post)).toBe(false);
    expect(inPastedText("email", "jobs@example.co", post)).toBe(false);
    expect(inPastedText("email", "jobs@example.com", "Write to xjobs@example.com.uk now")).toBe(
      false,
    );
  });

  it("finds a number by its digits after normalising, however the post spaces it", () => {
    expect(inPastedText("whatsapp", "+92 300 1234567", post)).toBe(true);
    expect(inPastedText("whatsapp", "923001234567", post)).toBe(true);
    expect(inPastedText("whatsapp", "0300 1234568", post)).toBe(false);
    expect(inPastedText("whatsapp", "98765 43210", "Call 98765 43210")).toBe(false);
  });

  it("finds an empty contact nowhere", () => {
    expect(inPastedText("email", " ", post)).toBe(false);
    expect(inPastedText("whatsapp", "", post)).toBe(false);
  });
});
