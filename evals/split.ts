import { createHash } from "node:crypto";

/**
 * The split (evals spec, "Splits"): each case is assigned once, to `test`
 * or `dev`. Cases not yet assigned are taken in the order of their IDs'
 * hashes, so the order depends on the IDs alone, and each goes to `test`
 * while the cases given hold fewer than ten there, otherwise to `dev`. A
 * test case no longer given, deleted or left out, stops counting, so its
 * place goes to a later case. The cases of one application, a resend or a
 * reply in its thread, share one split, and go to `test` only when all of
 * them fit. An assigned case never moves, so the blind test set stays fixed
 * as the archive grows.
 */

export const TEST_SIZE = 10;

export type Split = "test" | "dev";

const hashOf = (id: string) => createHash("sha256").update(id).digest("hex");

/**
 * Splits for `caseIds`, the cases ready to be in one, keeping every
 * assignment in `assigned`; `groupOf` names the application a case is of.
 */
export function assignSplits(
  caseIds: readonly string[],
  assigned: Readonly<Record<string, Split>>,
  groupOf: (id: string) => string = (id) => id,
): Record<string, Split> {
  const result: Record<string, Split> = { ...assigned };
  const given = [...new Set(caseIds)];
  let test = given.filter((id) => result[id] === "test").length;
  // An application's split, from a case of it given and assigned before.
  const groupSplit = new Map<string, Split>();
  for (const id of given) {
    const split = result[id];
    if (split && !groupSplit.has(groupOf(id))) groupSplit.set(groupOf(id), split);
  }
  const fresh = given
    .filter((id) => !Object.hasOwn(result, id))
    .map((id) => ({ id, hash: hashOf(id) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    .map(({ id }) => id);
  const newcomers = new Map<string, string[]>();
  for (const id of fresh) newcomers.set(groupOf(id), [...(newcomers.get(groupOf(id)) ?? []), id]);
  for (const id of fresh) {
    if (Object.hasOwn(result, id)) continue;
    const group = groupOf(id);
    const members = newcomers.get(group)!;
    const split = groupSplit.get(group) ?? (test + members.length <= TEST_SIZE ? "test" : "dev");
    for (const member of members) result[member] = split;
    if (split === "test") test += members.length;
    groupSplit.set(group, split);
  }
  return result;
}
