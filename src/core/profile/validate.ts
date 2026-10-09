import { createHash } from "node:crypto";

import { isMap, isScalar, LineCounter, parseDocument, visit, type Document } from "yaml";

import { isPathBelow, type ProfileDocument, profileSchema, samePathKey } from "./schema";

/**
 * Checks a profile file the way the seed does (profile spec, "Seeding"):
 * the YAML, the strict schema with the shared tables, IDs across the file,
 * then the CV and the style example files. Every problem is reported in one
 * pass, each with its line, and no message repeats a value from the file,
 * which holds the owner's personal data.
 */
export interface ProfileFiles {
  /** A regular file named relative to the profile file; null when there is none. */
  read(path: string): Uint8Array | null;
}

export interface ProfileProblem {
  line: number;
  message: string;
}

declare const checked: unique symbol;

/** A profile the validator passed. The seed takes nothing else, so a hash always matches its files. */
export type CheckedProfile = {
  ok: true;
  profile: ProfileDocument;
  cv: Uint8Array;
  styleExamples: string[];
  /** SHA-256 of the file, the CV and the style examples together. */
  hash: string;
  readonly [checked]: true;
};

export type ValidatedProfile = CheckedProfile | { ok: false; problems: ProfileProblem[] };

const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_STYLE_WORDS = 1500;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** YAML errors by code: the library's own messages quote the file. */
const YAML_PROBLEMS: Readonly<Record<string, string>> = {
  DUPLICATE_KEY: "the file repeats a key here",
  TAB_AS_INDENT: "a tab indents this line; indent with spaces",
  BAD_INDENT: "the indentation is off here",
  MISSING_CHAR: "a quote or a bracket is not closed",
  MULTIPLE_DOCS: "the file holds more than one YAML document",
};

/** One broken bracket can upset every later line; the first few say where to look. */
const MAX_YAML_PROBLEMS = 5;

const ALIAS = "a value starts with *, which YAML reads as an alias; put the value in quotes";

type Path = readonly (string | number)[];
type Report = (path: Path, message: string, key?: string) => void;

export function validateProfile(text: string, files: ProfileFiles): ValidatedProfile {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, uniqueKeys: true });
  if (doc.errors.length > 0) return { ok: false, problems: yamlProblems(doc) };
  if (doc.contents === null)
    return { ok: false, problems: [{ line: 1, message: "the file is empty" }] };
  // An alias is never needed in a profile, and an unknown one throws.
  const aliases = aliasLines(doc, counter);
  if (aliases.length > 0)
    return { ok: false, problems: aliases.map((line) => ({ line, message: ALIAS })) };
  const data: unknown = doc.toJS();

  const problems: ProfileProblem[] = [];
  const at: Report = (path, message, key) =>
    problems.push({
      line: lineOf(doc, counter, path, key),
      message: `${pathText(path, key)}: ${message}`,
    });

  const parsed = profileSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path as Path;
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) at(path, "is not a key the profile knows", key);
      } else if (path.length > 0 && !doc.hasIn(path)) {
        at(path, "is missing");
      } else if (issue.code === "invalid_key") {
        at(path, issue.issues[0]?.message ?? issue.message);
      } else {
        at(path, issue.message);
      }
    }
  }
  checkIds(data, at);
  const read = readFiles(data, files, at);

  if (!parsed.success || problems.length > 0 || read.cv === null) {
    return { ok: false, problems: problems.sort((a, b) => a.line - b.line) };
  }
  return {
    ok: true,
    profile: parsed.data,
    cv: read.cv,
    styleExamples: read.styleExamples,
    hash: hashOf([new TextEncoder().encode(text), read.cv, ...read.styleBytes]),
  } as CheckedProfile;
}

/** IDs are unique across the file and never reused. */
function checkIds(data: unknown, at: Report): void {
  const root = asRecord(data);
  const gaps = asRecord(root?.gaps);
  const groups: [Path, unknown][] = [
    [["facts"], root?.facts],
    [["gaps", "templates"], gaps?.templates],
    [["gaps", "known"], gaps?.known],
  ];
  const seen = new Set<string>();
  for (const [base, items] of groups) {
    asList(items).forEach((item, i) => {
      const id = asRecord(item)?.id;
      if (typeof id !== "string") return;
      if (seen.has(id)) at([...base, i, "id"], "is used more than once");
      seen.add(id);
    });
  }
}

/**
 * The CV and the style examples, read even when the rest of the file has
 * problems, so the owner hears about everything at once. A path the schema
 * refuses is never read.
 */
function readFiles(
  data: unknown,
  files: ProfileFiles,
  at: Report,
): { cv: Uint8Array | null; styleExamples: string[]; styleBytes: Uint8Array[] } {
  const root = asRecord(data);
  const readable = (path: unknown): path is string =>
    typeof path === "string" && path.trim() !== "" && isPathBelow(path.trim());

  let cv: Uint8Array | null = null;
  const cvFile = asRecord(root?.cv)?.file;
  if (readable(cvFile)) {
    cv = files.read(cvFile.trim());
    if (cv === null) at(["cv", "file"], "there is no such file");
    else if (cv.length > MAX_CV_BYTES) at(["cv", "file"], "the CV is larger than 5 MB");
    else if (new TextDecoder().decode(cv.subarray(0, 5)) !== "%PDF-")
      at(["cv", "file"], "the CV is not a PDF");
  }

  const styleExamples: string[] = [];
  const styleBytes: Uint8Array[] = [];
  const seen = new Set<string>();
  asList(root?.style_examples).forEach((path, i) => {
    if (!readable(path) || seen.has(samePathKey(path))) return;
    seen.add(samePathKey(path));
    const bytes = files.read(path.trim());
    if (bytes === null) return at(["style_examples", i], "there is no such file");
    let example: string;
    try {
      example = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return at(["style_examples", i], "is not UTF-8 text; save it as UTF-8");
    }
    if (CONTROL_CHARACTER.test(example)) {
      return at(["style_examples", i], "holds a control character, so it is not plain text");
    }
    styleExamples.push(example);
    styleBytes.push(bytes);
  });
  const words = styleExamples.reduce(
    (sum, example) => sum + example.split(/\s+/).filter(Boolean).length,
    0,
  );
  if (words > MAX_STYLE_WORDS) {
    at(
      ["style_examples"],
      `the style examples have ${words} words; at most ${MAX_STYLE_WORDS} in total`,
    );
  }
  return { cv, styleExamples, styleBytes };
}

function yamlProblems(doc: Document): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  for (const error of doc.errors) {
    const line = error.linePos?.[0].line ?? 1;
    if (problems.some((problem) => problem.line === line)) continue;
    problems.push({
      line,
      message: YAML_PROBLEMS[error.code] ?? `the file is not valid YAML here (${error.code})`,
    });
    if (problems.length === MAX_YAML_PROBLEMS) break;
  }
  return problems;
}

function aliasLines(doc: Document, counter: LineCounter): number[] {
  const lines: number[] = [];
  visit(doc, {
    Alias(_key, node) {
      lines.push(node.range ? counter.linePos(node.range[0]).line : 1);
    },
  });
  return lines;
}

/** Each part with its length first, so no two different sets of files hash alike. */
function hashOf(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:`).update(part);
  return hash.digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The line of the deepest node on the path that exists, or of the named key in it; else line 1. */
function lineOf(doc: Document, counter: LineCounter, path: Path, key?: string): number {
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
  return 1;
}

function pathText(path: Path, key?: string): string {
  const parts = key === undefined ? path : [...path, key];
  return (
    parts.reduce<string>(
      (text, part) =>
        typeof part === "number" ? `${text}[${part}]` : text ? `${text}.${part}` : part,
      "",
    ) || "the file"
  );
}
