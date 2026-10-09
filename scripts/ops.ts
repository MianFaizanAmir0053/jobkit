/**
 * Shared by the operations scripts (bootstrap, migrate, seed, import).
 * Platform spec B8: they work on the local database by default and reach
 * production only with `--prod`, after the owner types the project reference.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { assertSchemaName } from "@/server/db/schemaName";

export type Target = "local" | "prod";

export function parseTarget(argv: readonly string[]): Target {
  if (argv.length === 0) return "local";
  if (argv.length === 1 && argv[0] === "--prod") return "prod";
  throw new Error(
    `Unknown arguments ${JSON.stringify(argv)}: run with no arguments, or with --prod`,
  );
}

export function projectRefFromSupabaseUrl(url: string): string {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url.trim());
  if (!match?.[1]) throw new Error("SUPABASE_URL must look like https://<project-ref>.supabase.co");
  return match[1];
}

export async function confirmProduction(
  ref: string,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  const typed = await ask(
    `This changes the production database of project ${ref}. Type the project reference to go on: `,
  );
  if (typed.trim() !== ref) throw new Error("The reference did not match; nothing was changed.");
}

export async function askOnTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

/**
 * Reads KEY=value lines: an optional `export`, and one pair of quotes around
 * a value removed. A value is otherwise kept exactly as written, `#`
 * included, because a password may hold one and the bootstrap sets the
 * database role's password from this file. So unlike `next dev`, nothing
 * after a value is taken as a comment: these files keep comments on lines
 * of their own.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/** `.env.ops.local`, read only by these scripts and only with `--prod`. */
export function loadOpsEnv(cwd = process.cwd()): Record<string, string> {
  const path = join(cwd, ".env.ops.local");
  if (!existsSync(path)) throw new Error(".env.ops.local is missing: see docs/runbook/setup.md");
  return parseEnvFile(readFileSync(path, "utf8"));
}

/** `.env.local`, for the live model tests and the evaluations, which run outside `next dev`. */
export function loadLocalEnv(cwd = process.cwd()): Record<string, string> {
  const path = join(cwd, ".env.local");
  if (!existsSync(path)) throw new Error(".env.local is missing: see docs/runbook/setup.md");
  return parseEnvFile(readFileSync(path, "utf8"));
}

export function requireValues(env: Record<string, string>, names: readonly string[]): void {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`.env.ops.local lacks ${missing.join(", ")}`);
}

/** Statements that do not involve the role's password; the password is set separately, escaped by Postgres. */
export function schemaStatements(opts: { schema: string; role: string }): string[] {
  assertSchemaName(opts.schema);
  assertSchemaName(opts.role);
  return [
    `create schema if not exists ${opts.schema} authorization ${opts.role}`,
    `revoke all on schema ${opts.schema} from public`,
  ];
}
