import type { Db, Random } from "@/core/ports";
import { hmacSha256 } from "@/lib/encoding";

/**
 * Timing arms (ledger spec, "The timing comparison"; amendment A13). During
 * real use each new job goes to the manual arm with probability one in
 * three, from a seeded sequence, when it is created; nobody chooses or
 * swaps. Whether real use has started is the caller's question.
 */
export type Arm = "tool" | "manual";

/** Below this, a draw's first four bytes give the manual arm: one in three. */
const MANUAL_BELOW = Math.floor(2 ** 32 / 3);

/** The arm at a place in the sequence a seed sets. */
export function armAt(seed: Uint8Array, index: number): Arm {
  const draw = new DataView(hmacSha256(seed, String(index)).buffer).getUint32(0);
  return draw < MANUAL_BELOW ? "manual" : "tool";
}

/**
 * Takes the next place in the sequence, in one statement, so two jobs
 * created at once get different places. The first draw stores a fresh
 * seed; every later one keeps it.
 */
export async function drawArm(deps: {
  db: Db;
  random: Random;
}): Promise<{ arm: Arm; index: number }> {
  const { rows } = await deps.db.query<{ seed: Uint8Array; index: number }>(
    `insert into {{schema}}.arm_sequence as sequence (id, seed, next_index) values (1, $1, 1)
     on conflict (id) do update set next_index = sequence.next_index + 1
     returning seed, next_index - 1 as index`,
    [deps.random.bytes(32)],
  );
  const { seed, index } = rows[0]!;
  return { arm: armAt(new Uint8Array(seed), index), index };
}
