import type { Container } from "./container";

/**
 * The test-only routes (the stand-in for Google sign-in, the database
 * reset, the data page) answer only in the dev server that the end-to-end
 * tests start, with its in-memory database. next.config.ts already leaves
 * them out of every build; this is the second lock, so neither a wrong
 * JOBKIT_ENV nor a stray build can expose them.
 */
export function testRoutesAllowed(
  env: Readonly<Record<string, string | undefined>>,
  containerKind: Container["kind"],
): boolean {
  return env.NODE_ENV !== "production" && !env.VERCEL && containerKind === "test";
}
