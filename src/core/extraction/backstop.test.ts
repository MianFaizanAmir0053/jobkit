import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { backstopSignals } from "./backstop";
import { type JobRecord, jobRecordSchema } from "./record";

// A plain email post the model found nothing wrong with.
function fixture(): JobRecord {
  const path = join(process.cwd(), "evals", "synthetic", "records", "S01-email-simple.json");
  return jobRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function withInstruction(record: JobRecord, text: string): JobRecord {
  const [role, ...rest] = record.roles;
  const instruction = { kind: "other" as const, text, value: "", addressed_to_ai: false };
  return { ...record, roles: [{ ...role!, instructions: [instruction] }, ...rest] };
}

describe("backstopSignals", () => {
  it("adds a national ID signal for a CNIC request in pasted text, when the model reported none", () => {
    const pasted =
      "Senior engineer wanted.\nSend your CV and a copy of your CNIC to hr@example.com";

    expect(backstopSignals(fixture(), pasted)).toEqual([
      { kind: "national_id", quote: "Send your CV and a copy of your CNIC to hr@example.com" },
    ]);
  });

  it("adds one when the request appears only in a quoted field of a screenshot's record", () => {
    const record = withInstruction(fixture(), "Attach your CNIC with the application");

    expect(backstopSignals(record, "")).toEqual([
      { kind: "national_id", quote: "Attach your CNIC with the application" },
    ]);
  });

  it("looks in each quoted field: instructions, the route's quote, and the eligibility quotes", () => {
    const hit = "Attach your CNIC";
    const placed: ((role: JobRecord["roles"][number]) => JobRecord["roles"][number])[] = [
      (role) => ({
        ...role,
        instructions: [{ kind: "other", text: hit, value: "", addressed_to_ai: false }],
      }),
      (role) => ({
        ...role,
        instructions: [{ kind: "other", text: "", value: hit, addressed_to_ai: false }],
      }),
      (role) => ({ ...role, route: { ...role.route, quote: hit } }),
      (role) => ({
        ...role,
        eligibility: { ...role.eligibility, work_authorisation: [{ place: "PK", quote: hit }] },
      }),
      (role) => ({ ...role, eligibility: { ...role.eligibility, other_limits: [hit] } }),
    ];
    for (const place of placed) {
      const record = fixture();
      const scanned = { ...record, roles: [place(record.roles[0]!)] };

      expect(backstopSignals(scanned, "")).toEqual([{ kind: "national_id", quote: hit }]);
    }
    // Other fields are the model's own words, not quotes, and are not scanned.
    const record = fixture();
    const title = { ...record, roles: [{ ...record.roles[0]!, title: hit }] };
    expect(backstopSignals(title, "")).toEqual([]);
  });

  it("reports each kind once, in the order first found", () => {
    const record = fixture();
    const role = record.roles[0]!;
    const scanned: JobRecord = {
      ...record,
      roles: [
        {
          ...role,
          route: { ...role.route, quote: "send your bank account details" },
          eligibility: { ...role.eligibility, other_limits: ["registration fee of PKR 5,000"] },
        },
      ],
    };

    expect(backstopSignals(scanned, "pay the processing fee").map((signal) => signal.kind)).toEqual(
      ["fee", "bank_details"],
    );
  });

  it("finds a CNIC number and an IBAN whose checksum holds, and each listed phrase", () => {
    const hits = (text: string) => backstopSignals(fixture(), text).map((signal) => signal.kind);

    expect(hits("ID 35202-1234567-1 please")).toEqual(["national_id"]);
    expect(hits("Pay into GB82 WEST 1234 5698 7654 32 today")).toEqual(["bank_details"]);
    expect(hits("Pay into GB82WEST12345698765432")).toEqual(["bank_details"]);
    expect(hits("a small Registration Fee applies")).toEqual(["fee"]);
    expect(hits("two passport copies")).toEqual(["national_id"]);
    expect(hits("share your BANK ACCOUNT")).toEqual(["bank_details"]);
  });

  it("finds nothing in look-alikes: a failing IBAN checksum, a part of a word, a different number", () => {
    const hits = (text: string) => backstopSignals(fixture(), text);

    expect(hits("ref GB82WEST12345698765431")).toEqual([]);
    expect(hits("PCNICK is our product")).toEqual([]);
    expect(hits("call 0300-1234567")).toEqual([]);
    expect(hits("no fees at all; we never ask for money")).toEqual([]);
  });

  it("adds nothing when the model reported a scam signal itself", () => {
    const record = { ...fixture(), scam_signals: [{ kind: "fee" as const, quote: "pay first" }] };

    expect(backstopSignals(record, "Send your CNIC")).toEqual([]);
  });

  it("gives one signal per kind, quoting its first line cut to 120 characters", () => {
    const long = `Please send your CNIC ${"and more ".repeat(20)}`.trim();

    const signals = backstopSignals(
      fixture(),
      `${long}\nAlso your CNIC copy\nPay the processing fee`,
    );

    expect(signals.map((signal) => signal.kind)).toEqual(["national_id", "fee"]);
    expect(signals[0]!.quote).toHaveLength(120);
    expect(long.startsWith(signals[0]!.quote)).toBe(true);
  });
});
