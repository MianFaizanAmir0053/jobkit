import { ENV_GROUPS } from "@/server/env";

type Env = Readonly<Record<string, string | undefined>>;

const LOCAL: ReadonlySet<string> = new Set(ENV_GROUPS.local);

/**
 * Every variable that only the deployed app or the production scripts hold:
 * the model keys, the other secrets and the production addresses (B8).
 */
const PRODUCTION_ONLY: readonly string[] = [
  ...new Set<string>([...ENV_GROUPS.vercel, ...ENV_GROUPS.ops]),
].filter((name) => !LOCAL.has(name));

/**
 * Whether this process is a local run that must hold no production value:
 * the dev server, whatever its JOBKIT_ENV, and anything not configured as
 * production. It does not rely on Vercel's system variables, which a project
 * setting can hide, so production never refuses itself.
 */
export function isLocalRun(env: Env): boolean {
  return env.NODE_ENV === "development" || env.JOBKIT_ENV !== "production";
}

/**
 * What stops a local run, the dev server or an evaluation, from starting
 * (platform spec B8, AC13): a key or secret that only production holds, or
 * an address that leaves this machine. Either would let a local run spend
 * the app's budget or touch its data unseen. Only names are reported, never
 * values.
 */
export function localOnlyProblems(env: Env): string[] {
  const problems: string[] = [];
  for (const name of PRODUCTION_ONLY) {
    const value = env[name];
    if (!value) continue;
    if (!name.endsWith("_URL")) problems.push(`${name} is set`);
    else if (!onThisMachine(value)) problems.push(`${name} points at another machine`);
  }
  return problems;
}

export function assertLocalOnly(env: Env, who: string): void {
  const problems = localOnlyProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `${who} refuses to start: ${problems.join("; ")}. Those belong to the deployed app ` +
        "or the production scripts; remove them from the .env files and from the shell.",
    );
  }
}

/**
 * Whether a URL reaches only this machine. Postgres also takes the host from
 * `host` and `hostaddr` query parameters, which win over the URL's own, so
 * every host named anywhere must be loopback or a local socket path. A URL
 * that does not parse, or names no host at all, counts as remote.
 */
export function onThisMachine(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hosts = [
    parsed.hostname,
    ...parsed.searchParams.getAll("host"),
    ...parsed.searchParams.getAll("hostaddr"),
  ].filter((host) => host !== "");
  return hosts.length > 0 && hosts.every(isLoopback);
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    // A Unix socket directory, on this machine by definition.
    host.startsWith("/")
  );
}
