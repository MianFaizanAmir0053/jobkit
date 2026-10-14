/**
 * The ports domain code talks through (platform spec A3). Adapters in
 * src/adapters implement them; tests use PGlite, the local file system and
 * fakes, so no test touches the network.
 */
import type { ZodType } from "zod";

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
  /** Stores a file. One already at the path is replaced only with `overwrite`; otherwise put throws. */
  put(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    options?: { overwrite?: boolean },
  ): Promise<void>;
  /** A file's bytes; null when there is no file at the path, and a throw for any other failure. */
  get(path: string): Promise<Uint8Array | null>;
  /** A file's size; null when there is no file at the path, and a throw for any other failure. */
  stat(path: string): Promise<{ size: number } | null>;
  list(prefix: string): Promise<string[]>;
  remove(paths: readonly string[]): Promise<void>;
}

/** One DNS question's answer (review spec, "Stage address_checks"). */
export type DnsAnswer =
  /** MX exchanges, or addresses; a null MX's exchange is "" or ".". */
  | { kind: "records"; values: string[] }
  /** The name exists with no records of that type, or does not exist. */
  | { kind: "none" }
  | { kind: "timeout" }
  /** Any other failure: a server failure or a refusal. */
  | { kind: "failed" };

export interface Dns {
  lookup(name: string, type: "MX" | "A" | "AAAA"): Promise<DnsAnswer>;
}

/**
 * What sending one email from the owner's Gmail came to (decisions A20):
 * sent, with Gmail's IDs; refused by Google, so the owner must connect Gmail
 * again; unknown, when the answer was lost after Gmail had the email, so it
 * may have gone; or failed, and not sent, for any other reason.
 */
export type GmailSendResult =
  | { ok: true; messageId: string; threadId: string }
  | { ok: false; reason: "unauthorised" | "unknown" | "failed"; message: string };

/** Sends one MIME message from the owner's connected Gmail. */
export interface GmailSender {
  send(message: string): Promise<GmailSendResult>;
}

export interface Clock {
  now(): Date;
}

export interface Random {
  bytes(length: number): Uint8Array;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type LlmInput =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; base64: string };

/**
 * One model request as a provider adapter sees it (platform spec B4). It has
 * no field for tools: no stage can hand a model tools while it reads post text.
 */
export interface LlmRequest {
  model: string;
  system: string;
  content: readonly LlmInput[];
  /** The output's shape; the adapter sends it as the provider's structured-output format. */
  schema: ZodType;
  effort: Effort;
  maxTokens: number;
  /** Aborted by the caller's idle and total timeouts. */
  signal: AbortSignal;
  /**
   * Called whenever the provider sends anything, keep-alive pings included, so
   * a dead connection can be told apart from a model that is thinking.
   */
  onEvent: () => void;
}

/** What one model run reported; a fallback after a refusal adds a second entry (B4). */
export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type LlmFailureKind = "rate-limit" | "server" | "connection" | "client" | "aborted";

export type LlmReply =
  | {
      kind: "answer";
      text: string;
      model: string;
      requestId: string | null;
      usage: LlmUsage[];
      /** The answer stopped at max_tokens, so it is incomplete. */
      truncated: boolean;
    }
  | {
      kind: "refusal";
      model: string;
      requestId: string | null;
      usage: LlmUsage[];
      category: string | null;
      /** What else the provider said about it, for the call log. */
      detail?: string;
    }
  | {
      kind: "failure";
      failure: LlmFailureKind;
      message: string;
      requestId: string | null;
      retryAfterMs: number | null;
    };

export interface Llm {
  /** The request's input tokens as the provider counts them, before sending. */
  countInputTokens(request: Omit<LlmRequest, "signal" | "onEvent">): Promise<number>;
  call(request: LlmRequest): Promise<LlmReply>;
}
