import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JobRecord, Role } from "@/core/extraction/record";

import { besideDraft } from "./pipeline";

/* What runs beside draft: platform spec B9's drafting group. */

const base: Role = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "evals", "synthetic", "records", "S01-email-simple.json"),
      "utf8",
    ),
  ) as JobRecord
).roles[0]!;

const routed = (kind: Role["route"]["kind"], address: string): Role => ({
  ...base,
  route: { ...base.route, kind, address },
});

describe("besideDraft", () => {
  it("reads an email address a second time and checks it", () => {
    expect(besideDraft(routed("email", "jobs@example.com"))).toEqual([
      "address_read",
      "address_checks",
    ]);
  });

  it("reads a WhatsApp number a second time, with no address checks", () => {
    expect(besideDraft(routed("whatsapp", "0300 1234567"))).toEqual(["address_read"]);
  });

  it("runs nothing beside for no contact, another route, or no role", () => {
    expect(besideDraft(routed("email", " "))).toEqual([]);
    expect(besideDraft(routed("ats_form", "https://jobs.example.com/apply"))).toEqual([]);
    expect(besideDraft(null)).toEqual([]);
  });
});
