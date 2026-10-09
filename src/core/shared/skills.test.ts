import { describe, expect, it } from "vitest";

import { isSkillTag, SKILLS, skillName, skillTag } from "./skills";

describe("skillTag", () => {
  it.each([
    ["k8s", "kubernetes"],
    ["Kubernetes", "kubernetes"],
    ["Next.js", "nextjs"],
    ["next js", "nextjs"],
    ["React.js", "react"],
    ["Node", "nodejs"],
    ["C#", "csharp"],
    ["C++", "cpp"],
    ["CI/CD", "ci-cd"],
    ["Tailwind CSS", "tailwind"],
    ["PostgreSQL", "postgresql"],
    ["Golang", "go"],
  ])("maps %j to %j", (text, tag) => {
    expect(skillTag(text)).toBe(tag);
  });

  it("knows nothing it was not told", () => {
    expect(skillTag("cobol")).toBeNull();
  });

  it("knows no tag for a name that means something else too", () => {
    // RTL is right-to-left layout in Arabic-market posts; AngularJS is the old 1.x framework.
    expect(skillTag("RTL")).toBeNull();
    expect(skillTag("AngularJS")).toBeNull();
  });
});

describe("the vocabulary", () => {
  it("has lower-case kebab tags, each naming itself, and display names", () => {
    for (const skill of SKILLS) {
      expect(skill.tag).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skillTag(skill.tag)).toBe(skill.tag);
      expect(isSkillTag(skill.tag)).toBe(true);
    }
    expect(skillName("kubernetes")).toBe("Kubernetes");
    expect(skillName("not-a-tag")).toBe("not-a-tag");
    expect(isSkillTag("k8s")).toBe(false);
  });
});
