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
    ["Acme W.L.L.", "acme"],
    ["Acme WLL", "acme"],
    ["Acme DMCC", "acme"],
    ["Acme PJSC", "acme"],
    ["Acme SPC", "acme"],
    ["Acme K.S.C.C.", "acme"],
    ["Acme Q.P.S.C.", "acme"],
    ["Acme B.S.C.", "acme"],
    ["Acme Est.", "acme"],
    ["Acme GmbH & Co. KG", "acme"],
    ["Acme L.P.", "acme"],
    ["Acme S.L.", "acme"],
    ["Acme AB", "acme"],
    ["Acme Oy", "acme"],
    ["Acme SE", "acme"],
    ["Acme S.p.A.", "acme"],
    ["Acme Sdn Bhd", "acme"],
    ["M/s Acme", "acme"],
    ["M/S. Acme", "acme"],
    ["Messrs Acme Traders", "acmetraders"],
    ["M&S", "ms"],
    ["M&S Food", "msfood"],
    ["Acme Ltd (Lahore)", "acme"],
    ["McKinsey & Company", "mckinsey"],
    ["McKinsey & Co.", "mckinsey"],
    ["  ACME  ", "acme"],
    ["Ten Pearls", "tenpearls"],
    ["Limited Brands", "limitedbrands"],
    ["Café Ltd", "café"],
    ["Café Ltd", "café"],
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
    ["Software Engineer (Senior)", "seniorsoftwareengineer"],
    ["Software Engineer (Sr.)", "seniorsoftwareengineer"],
    ["Developer (Senior, Lahore)", "seniordeveloper"],
    ["Developer (Backend)", "backenddeveloper"],
    ["Developer (Front End)", "frontenddeveloper"],
    ["Developer (FE)", "frontenddeveloper"],
    ["Developer (BE)", "backenddeveloper"],
    ["Engineer (Mid-Level)", "midlevelengineer"],
    ["Engineer (QA)", "qaengineer"],
    ["Software Engineer (II)", "iisoftwareengineer"],
    ["Software Engineer (L3)", "l3softwareengineer"],
    ["Software Engineer (Level 2)", "level2softwareengineer"],
    ["Software Engineer (Team Lead)", "teamleadsoftwareengineer"],
    ["Software Engineer (Internship)", "internshipsoftwareengineer"],
    ["Software Engineer (Java)", "javasoftwareengineer"],
    ["Assistant Director (BPS-17)", "bps17assistantdirector"],
  ])(
    "keeps seniority, level, discipline and skill words from brackets, first: %j becomes %j",
    (role, key) => {
      expect(roleKey(role)).toBe(key);
    },
  );

  it("reads the same role however its parts are ordered or set apart", () => {
    for (const title of [
      "React Developer (Senior)",
      "React Developer - Senior",
      "React Developer, Senior",
    ]) {
      expect([title, roleKey(title)]).toEqual([title, roleKey("Senior React Developer")]);
    }
  });

  it.each([
    "React Developer - Lahore",
    "React Developer | Lahore",
    "React Developer, Lahore",
    "React Developer – Remote",
    "Urgent Hiring: React Developer",
    "React Developer - Urgent Hiring",
  ])("drops a part set apart from the role that names no role: %j", (title) => {
    expect(roleKey(title)).toBe("reactdeveloper");
  });

  it("keeps every part of a title whose parts name no role it knows", () => {
    expect(roleKey("Flutter Wizard - Lahore")).toBe("flutterwizardlahore");
  });

  it.each([
    "React Developer (Johar Town, Lahore)",
    "React Developer (DHA Phase 5, Lahore)",
    "React Developer (Lahore & Islamabad)",
    "React Developer (Onsite Lahore)",
    "React Developer (Hyderabad)",
    "React Developer (Remote - PK)",
    "React Developer (Pakistan only)",
    "React Developer (Urgent Hiring)",
    "React Developer (Full Time)",
    "React Developer (Contract)",
    "React Developer (m/w/d)",
    "React Developer (WFH)",
    "React Developer (US)",
  ])("drops everything else in brackets, places and labels alike: %j", (role) => {
    expect(roleKey(role)).toBe("reactdeveloper");
  });

  it("tells roles apart by the seniority, level or discipline in their brackets", () => {
    expect(roleKey("Software Engineer (Senior)")).not.toBe(roleKey("Software Engineer"));
    expect(roleKey("Developer (Backend)")).not.toBe(roleKey("Developer (Frontend)"));
    expect(roleKey("Engineer (AI)")).not.toBe(roleKey("Engineer (QA)"));
    expect(roleKey("Software Engineer (II)")).not.toBe(roleKey("Software Engineer"));
    expect(roleKey("Assistant Director (BPS-17)")).not.toBe(roleKey("Assistant Director (BPS-18)"));
  });

  it("reads an abbreviation written against the next word", () => {
    expect(roleKey("Sr.React Developer")).toBe(roleKey("Sr. React Developer"));
    expect(roleKey("Jr.Dev")).toBe("juniordeveloper");
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

  it("reads a mailto: link as its address", () => {
    expect(addressKey("mailto:Jobs@Acme.example")).toBe("jobs@acme.example");
  });

  it("takes linear time on a long hostile address", () => {
    const started = performance.now();
    addressKey("(a".repeat(8_000));
    addressKey(`+92 ${"(".repeat(8_000)}`);

    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("sameAddress", () => {
  it("compares emails without case or surrounding spaces", () => {
    expect(sameAddress(" Jobs@Acme.example ", "jobs@acme.example")).toBe(true);
    expect(sameAddress("jobs@acme.example", "hr@acme.example")).toBe(false);
  });

  const PK_FORMS = [
    "+92 300 1234567",
    "0300-1234567",
    "0092 300 1234567",
    "+92 (0)300 1234567",
    "300 1234567",
    "+92 0300 1234567",
    "+920300-1234567",
    "0092 0300 1234567",
    "0300–1234567",
    "0300 1234567 (WhatsApp)",
    "wa.me/923001234567",
    "https://wa.me/923001234567",
    "tel:+923001234567",
    "WhatsApp: 0300-1234567",
    "Phone: +92 300 1234567",
    "0300‎-1234567",
    "‪+92 300 1234567‬",
    "۰۳۰۰-۱۲۳۴۵۶۷",
    "٠٣٠٠-١٢٣٤٥٦٧",
  ];

  it.each(PK_FORMS)("takes %j for the same number as +92 300 1234567", (number) => {
    expect(sameAddress(number, "+92 300 1234567")).toBe(true);
    expect(sameAddress("+92 300 1234567", number)).toBe(true);
  });

  it("matches every form of one number with every other", () => {
    for (const a of PK_FORMS)
      for (const b of PK_FORMS) expect([a, b, sameAddress(a, b)]).toEqual([a, b, true]);
  });

  it.each([
    ["+971 50 123 4567", "050 123 4567"],
    ["+971 050 123 4567", "+971 50 123 4567"],
    ["+44 020 7946 0000", "+44 20 7946 0000"],
    ["+974 3312 3456", "3312 3456"],
    ["+1 (212) 555-1234", "212 555 1234"],
  ])("matches %j written another way as %j", (one, other) => {
    expect(sameAddress(one, other)).toBe(true);
  });

  it("keeps the 0 an Italian number has after its country code", () => {
    expect(addressKey("+39 06 1234 5678")).toBe("390612345678");
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
  it("takes word trigrams from each requirement, and a line of one or two words whole", () => {
    expect(
      postFingerprint(["3+ years of React.js", "Sr. dev experience", "Git", "Node.js / Express"]),
    ).toEqual(
      new Set([
        "3 years of",
        "years of reactjs",
        "senior developer experience",
        "git",
        "nodejs express",
      ]),
    );
  });

  it("tells terse posts with different stacks apart, though they share the same boilerplate", () => {
    const boilerplate = [
      "1-2 years experience",
      "Good communication skills",
      "Immediate joiners preferred",
    ];
    const laravel = postFingerprint(["PHP", "Laravel", "MySQL", ...boilerplate]);
    const flutter = postFingerprint(["Flutter", "Dart", "Firebase", ...boilerplate]);

    expect(similarity(laravel, flutter)).toBeLessThan(0.6);
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
