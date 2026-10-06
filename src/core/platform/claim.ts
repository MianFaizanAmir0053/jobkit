import type { Db, Row } from "@/core/ports";

/**
 * Platform spec B1, atomic claims: every check-then-act on shared rows is one
 * conditional `UPDATE … WHERE … RETURNING`, never a read followed by a write.
 * Returns the claimed row, or null when another request claimed it first.
 *
 * A claim that touches several rows has a WHERE clause missing its key (it
 * would approve every waiting phone, say), so it is undone and thrown. Inside
 * a caller's transaction it joins that transaction.
 */
export async function claimOne<T extends Row = Row>(
  db: Db,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  // Without RETURNING a won claim comes back with no rows and reads as lost.
  if (!/\breturning\b/i.test(sql)) throw new Error("A claim needs a RETURNING clause");
  return db.tx(async (tx) => {
    const { rows } = await tx.query<T>(sql, params);
    if (rows.length > 1) {
      throw new Error(`A claim must touch at most one row; this one touched ${rows.length}`);
    }
    return rows[0] ?? null;
  });
}
