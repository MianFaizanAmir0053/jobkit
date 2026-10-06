/**
 * The `Db` port on PGlite, the in-process Postgres used by tests and local
 * development. API: https://pglite.dev/docs/api
 */
import { mkdir } from "node:fs/promises";

import { PGlite, type Transaction } from "@electric-sql/pglite";

import type { Db, QueryResult, Row } from "@/core/ports";
import { assertSchemaName, fillSchema } from "@/server/db/schemaName";

export interface PgliteDb extends Db {
  close(): Promise<void>;
}

type Runner = Pick<PGlite | Transaction, "query" | "exec">;

function wrap(runner: Runner, schema: string, tx: Db["tx"]): Db {
  return {
    schema,
    async query<T extends Row = Row>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<T>> {
      const result = await runner.query<T>(fillSchema(sql, schema), [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await runner.exec(fillSchema(sql, schema));
    },
    tx,
  };
}

/** `dataDir` persists to disk; without it the database lives in memory. */
export async function createPgliteDb(opts: {
  schema: string;
  dataDir?: string;
}): Promise<PgliteDb> {
  assertSchemaName(opts.schema);
  // PGlite creates only the last folder of its data directory, not its parents.
  if (opts.dataDir) await mkdir(opts.dataDir, { recursive: true });
  const pg = await PGlite.create(opts.dataDir ?? "memory://");

  const db: Db = wrap(pg, opts.schema, (fn) =>
    pg.transaction((t) => {
      // A transaction inside a transaction runs in the outer one.
      const inner: Db = wrap(t, opts.schema, (nested) => nested(inner));
      return fn(inner);
    }),
  );

  return { ...db, close: () => pg.close() };
}
