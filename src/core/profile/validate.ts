import { createHash } from "node:crypto";

import { isMap, isScalar, LineCounter, parseDocument, type Document } from "yaml";

import { isPlaceCode } from "@/core/shared/regions";
import { isSkillTag } from "@/core/shared/skills";

import { type ProfileDocument, profileSchema } from "./schema";

/**
 * Checks a profile file the way the seed does (profile spec, "Seeding"):
 * the strict schema, then what the schema cannot see, then the CV and the
 * style example files. Every problem is reported, each with its line.
 */
export interface ProfileFiles {
  /** A file named relative to the profile file; null when there is none. */
  read(path: string): Uint8Array | null;
}

export interface ProfileProblem {
  line: number | null;
  message: string;
}

export type ValidatedProfile =
  | {
      ok: true;
      profile: ProfileDocument;
      cv: Uint8Array;
      styleExamples: string[];
      /** SHA-256 of the file, the CV and the style examples together. */
      hash: string;
    }
  | { ok: false; problems: ProfileProblem[] };

const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_STYLE_WORDS = 1500;
const PLACEHOLDERS: ReadonlySet<string> = new Set(["skill", "related"]);

type Path = readonly (string | number)[];

export function validateProfile(text: string, files: ProfileFiles): ValidatedProfile {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      problems: doc.errors.map((error) => ({
        line: error.linePos?.[0].line ?? null,
        message: error.message.split("\n")[0]!,
      })),
    };
  }
  const problems: ProfileProblem[] = [];
  const at = (path: Path, message: string, key?: string) =>
    problems.push({ line: lineOf(doc, counter, path, key), message: `${pathText(path, key)}: ${message}` });

  const parsed = profileSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path as Path;
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) at(path, "is not a key the profile knows", key);
      } else if (issue.code === "invalid_type" && issue.message.endsWith("received undefined")) {
        at(path, "is missing");
      } else {
        at(path, issue.message);
      }
    }
    return { ok: false, problems: sorted(problems) };
  }
  const profile = parsed.data;

  // IDs are unique across the file and never reused.
  const seen = new Set<string>();
  const ids: [Path, string][] = [
    ...profile.facts.map((fact, i): [Path, string] => [["facts", i, "id"], fact.id]),
    ...profile.gaps.templates.map((t, i): [Path, string] => [["gaps", "templates", i, "id"], t.id]),
    ...profile.gaps.known.map((k, i): [Path, string] => [["gaps", "known", i, "id"], k.id]),
  ];
  for (const [path, value] of ids) {
    if (seen.has(value)) at(path, `${value} is used more than once`);
    seen.add(value);
  }

  // Skills from the shared vocabulary, places from the region table.
  const skill = (path: Path, tag: string) => {
    if (!isSkillTag(tag)) at(path, `${tag} is not in the skill vocabulary (src/core/shared/skills.ts)`);
  };
  const place = (path: Path, code: string) => {
    if (!isPlaceCode(code)) at(path, `${code} is not in the region table (src/core/shared/regions.ts)`);
  };
  profile.facts.forEach((fact, i) => fact.skills.forEach((tag, j) => skill(["facts", i, "skills", j], tag)));
  profile.gaps.known.forEach((gap, i) => gap.skills.forEach((tag, j) => skill(["gaps", "known", i, "skills", j], tag)));
  for (const tag of Object.keys(profile.fixed_answers.years_per_stack)) {
    skill(["fixed_answers", "years_per_stack", tag], tag);
  }
  place(["owner", "location", "country"], profile.owner.location.country);
  profile.fixed_answers.relocation.places.forEach((code, i) =>
    place(["fixed_answers", "relocation", "places", i], code),
  );
  profile.fixed_answers.work_authorisation.forEach((entry, i) =>
    place(["fixed_answers", "work_authorisation", i, "place"], entry.place),
  );

  if (!isTimeZone(profile.owner.location.timezone)) {
    at(["owner", "location", "timezone"], "is not a time zone such as Asia/Karachi");
  }
  profile.gaps.templates.forEach((template, i) => {
    for (const [, name] of template.text.matchAll(/\{([^}]*)\}/g)) {
      if (!PLACEHOLDERS.has(name!)) {
        at(["gaps", "templates", i, "text"], `uses {${name}}; templates may use only {skill} and {related}`);
      }
    }
  });

  // The CV and the style examples.
  const cv = files.read(profile.cv.file);
  if (cv === null) at(["cv", "file"], `${profile.cv.file} does not exist`);
  else if (cv.length > MAX_CV_BYTES) at(["cv", "file"], "the CV is larger than 5 MB");
  else if (new TextDecoder().decode(cv.subarray(0, 5)) !== "%PDF-") at(["cv", "file"], "the CV is not a PDF");

  const styleBytes: Uint8Array[] = [];
  profile.style_examples.forEach((path, i) => {
    const bytes = files.read(path);
    if (bytes === null) at(["style_examples", i], `${path} does not exist`);
    else styleBytes.push(bytes);
  });
  const styleExamples = styleBytes.map((bytes) => new TextDecoder().decode(bytes));
  const words = styleExamples.reduce((sum, example) => sum + example.split(/\s+/).filter(Boolean).length, 0);
  if (words > MAX_STYLE_WORDS) {
    at(["style_examples"], `the style examples have ${words} words; at most ${MAX_STYLE_WORDS} in total`);
  }

  if (problems.length > 0 || cv === null) return { ok: false, problems: sorted(problems) };
  return { ok: true, profile, cv, styleExamples, hash: hashOf([new TextEncoder().encode(text), cv, ...styleBytes]) };
}

/** Each part with its length first, so no two different sets of files hash alike. */
function hashOf(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:`).update(part);
  return hash.digest("hex");
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone !== "";
  } catch {
    return false;
  }
}

/** The line of the deepest node on the path that exists, or of the named key in it. */
function lineOf(doc: Document, counter: LineCounter, path: Path, key?: string): number | null {
  for (let depth = path.length; depth >= 0; depth--) {
    const node: unknown = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true);
    if (key !== undefined && depth === path.length && isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && item.key.value === key);
      const range = pair && isScalar(pair.key) ? pair.key.range : undefined;
      if (range) return counter.linePos(range[0]).line;
    }
    const range = (node as { range?: [number, number, number] } | null)?.range;
    if (range) return counter.linePos(range[0]).line;
  }
  return null;
}

function pathText(path: Path, key?: string): string {
  const parts = key === undefined ? path : [...path, key];
  return parts.reduce<string>(
    (text, part) => (typeof part === "number" ? `${text}[${part}]` : text ? `${text}.${part}` : part),
    "",
  ) || "the file";
}

function sorted(problems: ProfileProblem[]): ProfileProblem[] {
  return problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
