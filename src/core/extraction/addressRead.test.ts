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

  it("asks the owner to check a number whose country code jobkit cannot read, whatever the second read", () => {
    expect(agreement("whatsapp", "98765 43210", { read: "98765 43210" })).toEqual({
      ok: false,
      reason: "bad_number",
    });
    expect(agreement("whatsapp", "98765 43210", { inText: true })).toEqual({
      ok: false,
      reason: "bad_number",
    });
  });

  it("says when the machine had no second model", () => {
    expect(agreement("email", "jobs@example.com", { problem: "no_model" })).toEqual({
      ok: false,
      reason: "no_model",
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

  it("finds a number followed by more digits in brackets", () => {
    expect(inPastedText("whatsapp", "0300 1234567", "WhatsApp 0300-1234567 (9am-5pm)")).toBe(true);
    expect(inPastedText("whatsapp", "0300 1234567", "WhatsApp +92 (0)300 1234567")).toBe(true);
  });

  it("never finds a number with its last digits missing inside a longer one", () => {
    expect(inPastedText("whatsapp", "+974 5512 345", "WhatsApp +974 5512 3456")).toBe(false);
    expect(inPastedText("whatsapp", "+974 5512 3456", "WhatsApp +974 5512 3456")).toBe(true);
  });

  it("takes an address's edges from the sentence: brackets and quotes, never a letter or an apostrophe", () => {
    expect(inPastedText("email", "jobs@example.com", "Apply (jobs@example.com) today")).toBe(true);
    expect(inPastedText("email", "jobs@example.com", 'Write to "jobs@example.com"!')).toBe(true);
    expect(inPastedText("email", "souza@acme.com", "CV to d'souza@acme.com")).toBe(false);
    expect(inPastedText("email", "jobs@example.com", "CV to éjobs@example.com")).toBe(false);
  });

  it("finds an empty contact nowhere", () => {
    expect(inPastedText("email", " ", post)).toBe(false);
    expect(inPastedText("whatsapp", "", post)).toBe(false);
  });
});
