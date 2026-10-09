import { describe, expect, it } from "vitest";

import { sha256Hex } from "@/lib/encoding";

import {
  addressKey,
  companyKey,
  companyRoleHash,
  postFingerprint,
  roleKey,
  sameAddress,
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

  it.each([
    ["Software Engineer (Senior)", "softwareengineersenior"],
    ["Software Engineer (Sr.)", "softwareengineersenior"],
    ["Developer (Backend, Lahore)", "developerbackend"],
    ["React Developer (Lahore - Hybrid)", "reactdeveloper"],
    ["React Developer (Remote / UK)", "reactdeveloper"],
  ])("drops only places and work modes from brackets: %j becomes %j", (role, key) => {
    expect(roleKey(role)).toBe(key);
  });

  it("tells roles apart by what their brackets say besides a place", () => {
    expect(roleKey("Software Engineer (Senior)")).not.toBe(roleKey("Software Engineer"));
    expect(roleKey("Developer (Backend)")).not.toBe(roleKey("Developer (Frontend)"));
  });

  it("reads a bare pair of letters as a word, though QA and AI are also country codes", () => {
    expect(roleKey("Engineer (QA)")).toBe("engineerqa");
    expect(roleKey("Engineer (AI)")).not.toBe(roleKey("Engineer (QA)"));
    expect(roleKey("Engineer (US)")).toBe("engineer");
  });

  it("is empty for a title that names only a place or a work mode", () => {
    expect(roleKey("(Remote)")).toBe("");
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

  it("drops a number's leading zeros, the trunk and international prefixes", () => {
    expect(addressKey("0300-1234567")).toBe("3001234567");
    expect(addressKey("0092 300 1234567")).toBe("923001234567");
  });
});

describe("sameAddress", () => {
  it("compares emails without case or surrounding spaces", () => {
    expect(sameAddress(" Jobs@Acme.example ", "jobs@acme.example")).toBe(true);
    expect(sameAddress("jobs@acme.example", "hr@acme.example")).toBe(false);
  });

  it.each([
    "+92 300 1234567",
    "0300-1234567",
    "0092 300 1234567",
    "+92 (0)300 1234567",
    "300 1234567",
  ])("takes %j for the same number as +92 300 1234567", (number) => {
    expect(sameAddress(number, "+92 300 1234567")).toBe(true);
    expect(sameAddress("+92 300 1234567", number)).toBe(true);
  });

  it.each([
    ["+971 50 123 4567", "050 123 4567"],
    ["+974 3312 3456", "3312 3456"],
    ["+1 (212) 555-1234", "212 555 1234"],
  ])("matches %j written at home as %j", (international, national) => {
    expect(sameAddress(international, national)).toBe(true);
  });

  it("tells different numbers apart, even ones that share their last digits", () => {
    expect(sameAddress("+92 300 1234567", "+92 300 7654321")).toBe(false);
    expect(sameAddress("+92 300 1234567", "+93 300 1234567")).toBe(false);
    expect(sameAddress("(212) 555-1234", "(312) 555-1234")).toBe(false);
  });

  it("needs eight digits before a shorter number can match the end of a longer one", () => {
    expect(sameAddress("123 4567", "0300 1234567")).toBe(false);
    expect(sameAddress("123 4567", "1234567")).toBe(true);
  });

  it("never matches an email with a number, or an empty address", () => {
    expect(sameAddress("923001234567@example.com", "+92 300 1234567")).toBe(false);
    expect(sameAddress("", "")).toBe(false);
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

    expect(
      similarity(postFingerprint(requirements), postFingerprint(repost)),
    ).toBeGreaterThanOrEqual(0.6);
  });
});
