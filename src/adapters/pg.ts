/**
 * The `Db` port on node-postgres, for production through Supabase's
 * transaction pooler. Queries carry no `name`, so node-postgres never creates
 * named prepared statements, which the pooler does not support:
 * https://supabase.com/docs/guides/database/connecting-to-postgres
 * The live contract test (pg.live.test.ts) confirms this against the real pooler.
 */
import pg from "pg";

import type { Db, QueryResult, Row } from "@/core/ports";
import { assertSchemaName, fillSchema } from "@/server/db/schemaName";

export interface PgDb extends Db {
  close(): Promise<void>;
}

type Client = Pick<pg.PoolClient, "query">;

function wrap(client: Client, schema: string, tx: Db["tx"]): Db {
  return {
    schema,
    async query<T extends Row = Row>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<T>> {
      const result = await client.query<T>(fillSchema(sql, schema), [...params]);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await client.query(fillSchema(sql, schema));
    },
    tx,
  };
}

/**
 * When an idle client loses its connection (the pooler restarts, the network
 * drops), the pool removes it and then emits "error"; with no listener that
 * emit throws and takes the process down. The next query gets a new client.
 * https://node-postgres.com/apis/pool#error
 */
export function createPool(opts: { connectionString: string; max?: number }): pg.Pool {
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: opts.max ?? 3 });
  pool.on("error", (error) => console.error("Postgres pool:", error.message));
  return pool;
}

export function createPgDb(opts: { connectionString: string; schema: string; max?: number }): PgDb {
  assertSchemaName(opts.schema);
  const pool = createPool(opts);

  const db = wrap(pool, opts.schema, async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // A transaction inside a transaction runs in the outer one.
      const inner: Db = wrap(client, opts.schema, (nested) => nested(inner));
      const result = await fn(inner);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  return { ...db, close: () => pool.end() };
}
