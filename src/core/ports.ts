/**
 * The ports domain code talks through (platform spec A3). Adapters in
 * src/adapters implement them; tests use PGlite, the local file system and
 * fakes, so no test touches the network.
 */

export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  /** The Postgres schema every `{{schema}}` placeholder in SQL becomes. */
  readonly schema: string;
  /** Runs one statement with `$1`-style parameters. */
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Runs one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in one transaction, committed when it resolves and rolled back when it throws. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export interface Storage {
  /** A URL the phone uploads one file to, straight to storage, without a session. */
  createSignedUploadUrl(path: string): Promise<{ url: string; token: string }>;
  /** A short-lived URL the browser reads one private file from. */
  createSignedReadUrl(path: string, expiresInSeconds: number): Promise<string>;
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array | null>;
  stat(path: string): Promise<{ size: number } | null>;
  list(prefix: string): Promise<string[]>;
  remove(paths: readonly string[]): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Random {
  bytes(length: number): Uint8Array;
}
