import { describe, expect, it } from "vitest";

import { sha256Hex } from "@/lib/encoding";

import {
  addressKey,
  companyKey,
  companyRoleHash,
  postFingerprint,
  roleKey,
  similarity,
} from "./normalise";

describe("companyKey", () => {
  it.each([
    ["Acme Ltd", "acme"],
    ["Acme Limited", "acme"],
    ["Acme (Pvt) Ltd", "acme"],
    ["Acme Pvt. Ltd.", "acme"],
    ["Acme Private Limited", "acme"],
    ["Acme, Inc.", "acme"],
    ["Acme LLC", "acme"],
    ["Acme Corp", "acme"],
    ["Acme Corporation", "acme"],
    ["Acme GmbH", "acme"],
    ["Acme B.V.", "acme"],
    ["Acme FZ-LLC", "acme"],
    ["Acme PLC", "acme"],
    ["  ACME  ", "acme"],
    ["Ten Pearls", "tenpearls"],
    ["Limited Brands", "limitedbrands"],
    ["Café Ltd", "café"],
  ])("%j becomes %j", (company, key) => {
    expect(companyKey(company)).toBe(key);
  });

  it.each(["", "   ", "Ltd", "(Pvt) Ltd", "Inc."])("gives no key for %j", (company) => {
    expect(companyKey(company)).toBeNull();
  });
});

describe("roleKey", () => {
  it.each([
    ["Front-End Developer", "frontenddeveloper"],
    ["Front End Developer", "frontenddeveloper"],
    ["Frontend Developer", "frontenddeveloper"],
    ["FE Developer", "frontenddeveloper"],
    ["Sr. Front End Developer", "seniorfrontenddeveloper"],
    ["Jr Dev", "juniordeveloper"],
    ["SWE", "softwareengineer"],
    ["Backend Eng.", "backendengineer"],
    ["BE Engineer", "backendengineer"],
    ["React Developer (Lahore)", "reactdeveloper"],
    ["React Developer [Karachi, Pakistan]", "reactdeveloper"],
    ["React Developer - Remote", "reactdeveloper"],
    ["Hybrid React Developer", "reactdeveloper"],
    ["React Developer, Onsite", "reactdeveloper"],
    ["React Developer On-site", "reactdeveloper"],
    ["DevOps Engineer", "devopsengineer"],
  ])("%j becomes %j", (role, key) => {
    expect(roleKey(role)).toBe(key);
  });

  it("keeps seniority, since a senior role is a different role", () => {
    expect(roleKey("Senior Engineer")).not.toBe(roleKey("Engineer"));
    expect(roleKey("Sr Engineer")).toBe(roleKey("Senior Engineer"));
  });
});

describe("companyRoleHash", () => {
  it("is the same for one company and role however they are written", () => {
    expect(companyRoleHash("Acme (Pvt) Ltd", "Front-End Developer")).toBe(
      companyRoleHash("ACME", "Frontend Developer (Remote)"),
    );
  });

  it("is the SHA-256 of the company key, a bar and the role key", () => {
    expect(companyRoleHash("Acme Ltd", "Sr Dev")).toBe(sha256Hex("acme|seniordeveloper"));
  });

  it("is absent when the company is empty", () => {
    expect(companyRoleHash("", "Developer")).toBeNull();
    expect(companyRoleHash("Ltd", "Developer")).toBeNull();
  });
});

describe("addressKey", () => {
  it("compares emails without case or spaces, and numbers by their digits", () => {
    expect(addressKey(" Jobs@Acme.example ")).toBe("jobs@acme.example");
    expect(addressKey("+92 300 123-4567")).toBe(addressKey("923001234567"));
    expect(addressKey("")).toBeNull();
    expect(addressKey(" ( - ) ")).toBeNull();
  });
});

describe("postFingerprint", () => {
  it("takes word trigrams from each requirement after the same normalisation", () => {
    expect(postFingerprint(["3+ years of React.js", "Sr. dev experience", "Git"])).toEqual(
      new Set(["3 years of", "years of reactjs", "senior developer experience"]),
    );
  });
});

describe("similarity", () => {
  const requirements = [
    "3+ years of professional experience with React and TypeScript",
    "Experience with REST APIs and state management libraries",
    "Comfortable writing unit tests with Jest and Testing Library",
    "Good written and spoken English",
  ];

  it("is the Jaccard index of two fingerprints", () => {
    expect(similarity(new Set(["a b c", "b c d"]), new Set(["b c d", "c d e"]))).toBeCloseTo(1 / 3);
    expect(similarity(postFingerprint(requirements), postFingerprint(requirements))).toBe(1);
  });

  it("is zero when either side has no trigrams", () => {
    expect(similarity(new Set(), postFingerprint(requirements))).toBe(0);
    expect(similarity(new Set(), new Set())).toBe(0);
  });

  it("stays high for a repost that rewords one requirement and adds another", () => {
    const repost = [
      ...requirements.slice(0, 3),
      "Excellent written and spoken English",
      "Nice to have: Next.js",
    ];

    expect(similarity(postFingerprint(requirements), postFingerprint(repost))).toBeGreaterThanOrEqual(0.6);
  });
});
