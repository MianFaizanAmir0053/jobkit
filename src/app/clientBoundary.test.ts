import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
 * Browser code never loads server code. Starting from every file whose
 * directives include "use client", this follows the project's own imports,
 * read with the TypeScript parser, and fails on any path that reaches the
 * server's folders, the adapters, a Node built-in, or a package that only
 * runs on a server. Type-only imports are skipped: the compiler erases them.
 */

const SRC = join(process.cwd(), "src");
const SERVER_FOLDERS = [join(SRC, "server"), join(SRC, "adapters")];
const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const BUILTINS = new Set(builtinModules);
const SERVER_PACKAGES = [
  /^node:/,
  /^sharp$/,
  /^pg$/,
  /^@electric-sql\//,
  /^@anthropic-ai\//,
  /^@google\//,
  /^@supabase\//,
  /^arctic$/,
  /^next\/headers$/,
  /^server-only$/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => join(dir, file))
    .filter((file) => SOURCE.test(file) && !/\.test\.[a-z]+$/.test(file));
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** Whether the file's directive prologue, the string statements it opens with, says "use client". */
function isClient(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

/** The modules a file loads at run time: imports and exports that are not type-only, import() and require(). */
function runtimeImports(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isImport || isRequire) && argument && ts.isStringLiteralLike(argument)) {
        found.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A project file an import names, or null for a package. */
function resolveImport(specifier: string, from: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  const candidates = [
    base,
    ...["ts", "tsx", "js", "jsx", "mjs", "cjs"].map((ext) => `${base}.${ext}`),
  ];
  candidates.push(...["index.ts", "index.tsx", "index.js"].map((name) => join(base, name)));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${relative(SRC, from)} imports ${specifier}, which does not resolve`);
}

function isServerPackage(specifier: string): boolean {
  return BUILTINS.has(specifier) || SERVER_PACKAGES.some((pattern) => pattern.test(specifier));
}

/** Every path from a file to server code, as a chain of files and the import that ends it. */
function serverReach(entry: string): string[] {
  const reached: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const path = [...chain, relative(SRC, file)];
    for (const specifier of runtimeImports(parse(file))) {
      const target = resolveImport(specifier, file);
      if (target === null) {
        if (isServerPackage(specifier)) reached.push(`${path.join(" → ")} → ${specifier}`);
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

const sourceOf = (text: string) => ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true);

describe("the reader of files", () => {
  it("finds the directive after comments, and on a line it shares with an import", () => {
    expect(isClient(sourceOf('// Licence: MIT\n/* note */\n"use client";\nexport {};'))).toBe(true);
    expect(isClient(sourceOf("'use strict';\n'use client';"))).toBe(true);
    expect(isClient(sourceOf('import x from "y";\n"use client";'))).toBe(false);
    expect(runtimeImports(sourceOf('"use client"; import { a } from "crypto";'))).toEqual([
      "crypto",
    ]);
  });

  it("reads every way a file loads a module, and skips the ones the compiler erases", () => {
    const text = [
      'import a from "a";',
      'import type { B } from "b";',
      'import { type C } from "c";',
      'import { type D, d } from "d";',
      'import "e";',
      'export { f } from "f";',
      'export type { G } from "g";',
      'const h = await import("h");',
      'const i = require("i");',
    ].join("\n");

    expect(runtimeImports(sourceOf(text))).toEqual(["a", "d", "e", "f", "h", "i"]);
  });

  it("counts a bare built-in such as crypto as server code", () => {
    expect(isServerPackage("crypto")).toBe(true);
    expect(isServerPackage("node:crypto")).toBe(true);
    expect(isServerPackage("next/headers")).toBe(true);
    expect(isServerPackage("react")).toBe(false);
  });
});

describe("the browser's code", () => {
  const clients = sourceFiles(SRC).filter((file) => isClient(parse(file)));

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

  it("would catch a file that reaches sharp through the project's own imports", () => {
    // extraction/tiles.ts loads sharp; nothing a client imports may lead there.
    const reach = serverReach(join(SRC, "core", "extraction", "tiles.ts"));
    expect(reach.some((line) => line.endsWith("→ sharp"))).toBe(true);
  });
});
