import { createHash } from "node:crypto";

/**
 * The split (evals spec, "Splits"): each case is assigned once, to `test`
 * or `dev`. Cases not yet assigned are taken in the order of their IDs'
 * hashes, so the order depends on the IDs alone, and each goes to `test`
 * while it holds fewer than ten, otherwise to `dev`. An assigned case never
 * moves, so the blind test set stays fixed as the archive grows.
 */

export const TEST_SIZE = 10;

export type Split = "test" | "dev";

const hashOf = (id: string) => createHash("sha256").update(id).digest("hex");

export function assignSplits(
  caseIds: readonly string[],
  assigned: Readonly<Record<string, Split>>,
): Record<string, Split> {
  const result: Record<string, Split> = { ...assigned };
  let test = Object.values(result).filter((split) => split === "test").length;
  const fresh = [...new Set(caseIds)]
    .filter((id) => !Object.hasOwn(result, id))
    .map((id) => ({ id, hash: hashOf(id) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  for (const { id } of fresh) {
    if (test < TEST_SIZE) {
      result[id] = "test";
      test++;
    } else {
      result[id] = "dev";
    }
  }
  return result;
}
