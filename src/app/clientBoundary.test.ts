import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * Browser code never loads server code. Starting from every file marked
 * "use client", this follows the project's own imports and fails on any path
 * that reaches the server's folders, the adapters, a Node built-in, or a
 * package that only runs on a server (image decoding, databases, model SDKs).
 * Type-only imports are skipped: the compiler erases them.
 */

const SRC = join(process.cwd(), "src");
const SERVER_FOLDERS = [join(SRC, "server"), join(SRC, "adapters")];
const SERVER_PACKAGES = [
  /^node:/,
  /^sharp$/,
  /^pg$/,
  /^@electric-sql\//,
  /^@anthropic-ai\//,
  /^@google\//,
  /^@supabase\//,
  /^server-only$/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => join(dir, file))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
}

function isClient(file: string): boolean {
  return /^\s*["']use client["']/.test(readFileSync(file, "utf8"));
}

/** The modules a file imports for their values, as written. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of text.matchAll(statement)) {
    if (match[2]) continue;
    // import { type A, type B } from "x" imports nothing at run time either.
    const names = match[3]!
      .replace(/[{}]/g, "")
      .split(",")
      .map((name) => name.trim());
    if (names.length > 0 && names.every((name) => name === "" || name.startsWith("type ")))
      continue;
    found.push(match[4]!);
  }
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) found.push(match[1]!);
  for (const match of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  return found;
}

/** A project file an import names, or null for a package. */
function resolveImport(specifier: string, from: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${relative(SRC, from)} imports ${specifier}, which does not resolve`);
}

/** Every path from a client file to server code, as a chain of files and the import that ends it. */
function serverReach(entry: string): string[] {
  const reached: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      const target = resolveImport(specifier, file);
      const path = [...chain, relative(SRC, file)];
      if (target === null) {
        if (SERVER_PACKAGES.some((pattern) => pattern.test(specifier))) {
          reached.push(`${path.join(" → ")} → ${specifier}`);
        }
      } else if (SERVER_FOLDERS.some((folder) => target.startsWith(folder))) {
        reached.push(`${path.join(" → ")} → ${relative(SRC, target)}`);
      } else {
        walk(target, path);
      }
    }
  };
  walk(entry, []);
  return reached;
}

describe("the browser's code", () => {
  const clients = sourceFiles(SRC).filter(isClient);

  it("is found", () => {
    expect(clients.map((file) => relative(SRC, file).replaceAll("\\", "/"))).toContain(
      "app/(app)/jobs/new/NewJobForm.tsx",
    );
  });

  it.each(clients.map((file) => [relative(SRC, file), file]))(
    "%s reaches no server code",
    (_name, file) => {
      expect(serverReach(file)).toEqual([]);
    },
  );

  it("would catch a client file that reached sharp through the project's own imports", () => {
    // extraction/tiles.ts loads sharp; nothing a client imports may lead there.
    const tiles = join(SRC, "core", "extraction", "tiles.ts");
    const reach = serverReach(tiles);
    expect(reach.some((line) => line.endsWith("→ sharp"))).toBe(true);
  });
});
