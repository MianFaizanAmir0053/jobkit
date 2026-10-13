import { createHash } from "node:crypto";

/**
 * The split (evals spec, "Splits"): each case is assigned once, to `test`
 * or `dev`. Ready cases not yet assigned are taken in the order of their
 * IDs' hashes, so the order depends on the IDs alone, and each goes to
 * `test` while the cases holding a place there number fewer than ten,
 * otherwise to `dev`. A case holds its place while it is in the archive and
 * not left out, ready or not, so only one gone or left out frees it; once a
 * new case takes that place, the case that freed it is released and never
 * holds a place again, so test never holds more than ten. The cases of one
 * application, a resend or a reply in its thread, share one split, taken
 * from any of them still in the archive, and go to `test` only when all of
 * them fit; a new case of an application already in a full test set waits
 * without a split rather than overfill it. A case whose labels cannot be
 * blind, a kept live job's or one labelled with pre-labels shown, never
 * goes to `test`. An assigned case never moves, so the blind test set stays
 * fixed as the archive grows.
 */

export const TEST_SIZE = 10;

export type Split = "test" | "dev";

const hashOf = (id: string) => createHash("sha256").update(id).digest("hex");

export interface SplitInput {
  /** Cases ready to be given a split. */
  ready: readonly string[];
  /** Cases holding their split's place: in the archive and not left out, ready or not. */
  present: readonly string[];
  /** The splits given before, kept whatever happened to their cases. */
  assigned: Readonly<Record<string, Split>>;
  /** Test cases released before: their places went to later cases. */
  released?: readonly string[];
  /** The application a case is of; the cases of one share a split. */
  groupOf?: (id: string) => string;
  /** Whether a case's labels can be blind; one that cannot is never in test. */
  blind?: (id: string) => boolean;
}

export interface SplitOutcome {
  splits: Record<string, Split>;
  /** Ready cases left without a split: their application is in a full test set. */
  held: string[];
  /** Test cases gone or left out whose places this draw gave to new cases, first by ID. */
  released: string[];
}

export function assignSplits(input: SplitInput): SplitOutcome {
  const groupOf = input.groupOf ?? ((id: string) => id);
  const blind = input.blind ?? (() => true);
  const splits: Record<string, Split> = { ...input.assigned };
  const releasedBefore = new Set(input.released ?? []);
  const present = [...new Set(input.present)].filter((id) => !releasedBefore.has(id)).sort();
  const isPresent = new Set(present);
  let test = present.filter((id) => splits[id] === "test").length;
  // Test cases gone or left out: each keeps a claim on a place until a new case takes it.
  const away = Object.keys(input.assigned)
    .filter((id) => input.assigned[id] === "test" && !releasedBefore.has(id) && !isPresent.has(id))
    .sort();
  const released: string[] = [];
  const groupSplit = new Map<string, Split>();
  for (const id of present) {
    const split = splits[id];
    if (split && !groupSplit.has(groupOf(id))) groupSplit.set(groupOf(id), split);
  }
  const fresh = [...new Set(input.ready)]
    .filter((id) => !Object.hasOwn(splits, id))
    .map((id) => ({ id, hash: hashOf(id) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    .map(({ id }) => id);
  const newcomers = new Map<string, string[]>();
  for (const id of fresh) newcomers.set(groupOf(id), [...(newcomers.get(groupOf(id)) ?? []), id]);
  const held: string[] = [];
  const seen = new Set<string>();
  for (const id of fresh) {
    if (seen.has(id)) continue;
    const group = groupOf(id);
    const members = newcomers.get(group)!;
    for (const member of members) seen.add(member);
    const fits = test + members.length <= TEST_SIZE && members.every(blind);
    const known = groupSplit.get(group);
    const split: Split | null =
      known === "dev" ? "dev" : known === "test" ? (fits ? "test" : null) : fits ? "test" : "dev";
    if (split === null) {
      held.push(...members);
      continue;
    }
    for (const member of members) splits[member] = split;
    if (split === "test") {
      test += members.length;
      // Places taken beyond those never filled come from cases away, which are released.
      while (test + away.length - released.length > TEST_SIZE) {
        released.push(away[released.length]!);
      }
    }
    groupSplit.set(group, split);
  }
  return { splits, held, released };
}
