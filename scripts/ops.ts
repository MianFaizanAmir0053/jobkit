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

export function parseTarget(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Target {
  if (argv.length === 0) {
    // npm reads `npm run x --prod` as its own --production: it keeps the flag
    // from the script and sets NODE_ENV=production, so the script would
    // quietly work on the local database while the owner meant production.
    // NODE_ENV is the only trace npm leaves, and a shell can set it too.
    if (env.npm_lifecycle_event && env.NODE_ENV === "production") {
      throw new Error(
        "NODE_ENV is production, which npm sets when it takes --prod for itself, so this did nothing. " +
          `To reach production, put -- before the script's arguments: npm run ${env.npm_lifecycle_event} -- <arguments> --prod. ` +
          "To work locally, unset NODE_ENV.",
      );
    }
    return "local";
  }
  if (argv.length === 1 && argv[0] === "--prod") return "prod";
  throw new Error(
    `Unknown arguments ${JSON.stringify(argv)}: run with no arguments, or with --prod`,
  );
}

/**
 * The production project's reference, from SUPABASE_URL, after checking
 * that DATABASE_URL is for the same project, so the reference the owner
 * types is always the database reached. The pooler's user is written
 * `jobkit_app.<project-ref>` (runbook step 5); a direct connection's host
 * is `db.<project-ref>.supabase.co`. A URL naming neither is refused.
 */
export function productionRef(env: Readonly<Record<string, string | undefined>>): string {
  const ref = projectRefFromSupabaseUrl(env.SUPABASE_URL ?? "");
  let url: URL | null = null;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    // Not a URL: it names no project either.
  }
  const user = url ? decodeURIComponent(url.username) : "";
  const databaseRef = user.includes(".")
    ? user.slice(user.indexOf(".") + 1)
    : (/^db\.([a-z0-9]+)\.supabase\.co$/.exec(url?.hostname ?? "")?.[1] ?? null);
  if (databaseRef === null) {
    throw new Error(
      "DATABASE_URL names no Supabase project (runbook step 5 writes its user as jobkit_app.<project-ref>): fix .env.ops.local",
    );
  }
  if (databaseRef !== ref) {
    throw new Error(
      `DATABASE_URL is for project ${databaseRef}, but SUPABASE_URL is for ${ref}: fix .env.ops.local`,
    );
  }
  return ref;
}

/**
 * Refuses to go on when npm kept one of the script's own flags, which it
 * does when there is no -- before them: `npm run x --replace` sets
 * npm_config_replace_registry_host, and `npm run x --list` npm_config_list,
 * and the script never sees the flag.
 */
export function refuseSwallowedFlags(
  flags: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!env.npm_lifecycle_event) return;
  for (const flag of flags) {
    const name = `npm_config_${flag.replaceAll("-", "_")}`;
    if (Object.keys(env).some((key) => key === name || key.startsWith(`${name}_`))) {
      throw new Error(
        `npm took --${flag} for itself, so this did nothing. Put -- before the script's arguments: npm run ${env.npm_lifecycle_event} -- <arguments> --${flag}`,
      );
    }
  }
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
 * Reads KEY=value lines, and refuses any line two readers could take
 * differently, rather than guess. `next dev` ends an unquoted value at a `#`
 * and a careless parser would not, and the bootstrap sets the database
 * role's password from these values, so a guess either way could lock
 * production out. A value that holds `#` must be quoted; a comment may then
 * follow the closing quote. A value that starts with `#` is empty, followed
 * by a comment. An optional `export` is dropped. Errors name the line and
 * the key, never the value.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const quoted = /^(["'])(.*?)\1\s*(#.*)?$/.exec(raw);
    if (quoted) values[key] = quoted[2]!;
    else if (/^["']/.test(raw))
      problems.push(`line ${index + 1}: ${key}'s quotes do not close, or text follows them`);
    else if (raw.startsWith("#")) values[key] = "";
    else if (raw.includes("#"))
      problems.push(`line ${index + 1}: ${key} holds #, so its value must be in quotes`);
    else values[key] = raw;
  });
  if (problems.length > 0) throw new Error(`This env file needs fixing:\n${problems.join("\n")}`);
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
