import type { ZodType } from "zod";

import type {
  Clock,
  Db,
  Effort,
  Llm,
  LlmFailureKind,
  LlmInput,
  LlmReply,
  LlmRequest,
} from "@/core/ports";

import { costOf, provisionalCost, roundUsd } from "./prices";

/**
 * The model-call wrapper (platform spec B4). Every stage that asks a model
 * anything goes through `callModel`: it parses the answer with the stage's
 * schema, writes one `model_calls` row per request attempt (inserted as
 * `started` with an upper-bound cost before sending, completed after),
 * asks the injected guard before each attempt, abandons silent or overlong
 * streams, and retries once, only on an outage.
 */
export interface ModelCallInput<T> {
  stage: string;
  jobId: string | null;
  model: string;
  system: string;
  content: readonly LlmInput[];
  schema: ZodType<T>;
  effort: Effort;
  maxTokens: number;
}

export type ModelCallFailure =
  | "refused"
  | "refused-cap"
  | "timeout"
  | "unavailable"
  | "invalid-output"
  | "max-tokens"
  | "rejected";

export type ModelCallResult<T> =
  | { ok: true; output: T; model: string; costUsd: number }
  | { ok: false; reason: ModelCallFailure; message: string };

/** The ledger supplies the monthly cap as this guard (ledger spec, "Spend cap"). */
export type ModelCallGuard = (call: {
  stage: string;
  jobId: string | null;
  model: string;
  provisionalCostUsd: number;
}) => Promise<{ ok: true } | { ok: false; message: string }>;

export interface ModelCallLimits {
  /** A stream with no event for this long is abandoned. */
  idleMs: number;
  /** No attempt runs longer than this. */
  totalMs: number;
  /** The longest wait before the one retry, whatever retry-after asks. */
  maxRetryWaitMs: number;
  /** The wait when the provider sends no retry-after. */
  defaultRetryWaitMs: number;
  /** Counting the input may take this long before an estimate is used instead. */
  countMs: number;
}

/** B4: 45 seconds without an event, 200 in all, and at most 15 before the one retry. */
export const MODEL_CALL_LIMITS: ModelCallLimits = {
  idleMs: 45_000,
  totalMs: 200_000,
  maxRetryWaitMs: 15_000,
  defaultRetryWaitMs: 2_000,
  countMs: 10_000,
};

export interface ModelCallDeps {
  db: Db;
  clock: Clock;
  llmFor(model: string): Llm;
  guard: ModelCallGuard;
  limits?: Partial<ModelCallLimits>;
}

const MESSAGES: Record<Exclude<ModelCallFailure, "refused-cap">, string> = {
  refused: "The model declined this post.",
  timeout: "The model took too long to answer.",
  unavailable: "The model service is unavailable. Try again shortly.",
  "invalid-output": "The model's answer did not have the expected shape.",
  "max-tokens": "The model's answer was cut off before it finished.",
  rejected: "The model service rejected the request.",
};

const FAILURE_OUTCOMES: Record<Exclude<LlmFailureKind, "aborted">, string> = {
  "rate-limit": "rate-limited",
  server: "server-error",
  connection: "connection-error",
  client: "client-error",
};

/** Only an outage is worth one more try; a refusal, a timeout or a bad request is not (B4). */
const RETRYABLE: ReadonlySet<LlmFailureKind> = new Set(["rate-limit", "server", "connection"]);

/** The most image tokens either provider charges for one picture, for estimates. */
const IMAGE_TOKENS_UPPER_BOUND = 4784;

export function providerOf(model: string): "anthropic" | "gemini" {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "gemini";
  throw new Error(`No provider serves the model ${JSON.stringify(model)}`);
}

export async function callModel<T>(
  deps: ModelCallDeps,
  input: ModelCallInput<T>,
): Promise<ModelCallResult<T>> {
  const limits = { ...MODEL_CALL_LIMITS, ...deps.limits };
  const llm = deps.llmFor(input.model);
  const request: Omit<LlmRequest, "signal" | "onEvent"> = {
    model: input.model,
    system: input.system,
    content: input.content,
    schema: input.schema,
    effort: input.effort,
    maxTokens: input.maxTokens,
  };
  const inputTokens = await countInput(llm, request, limits.countMs);
  // The whole call, its retry and the wait between them, fits in one budget:
  // the runner plans stages around this worst case (B4, B9).
  const deadline = Date.now() + limits.totalMs + limits.maxRetryWaitMs;
  const row = { db: deps.db, input, provider: providerOf(input.model) };
  const fail = (reason: Exclude<ModelCallFailure, "refused-cap">): ModelCallResult<T> => ({
    ok: false,
    reason,
    message: MESSAGES[reason],
  });

  for (let attempt = 1; ; attempt++) {
    const provisional = provisionalCost(
      input.model,
      inputTokens,
      input.maxTokens,
      deps.clock.now(),
    );
    const allowed = await deps.guard({
      stage: input.stage,
      jobId: input.jobId,
      model: input.model,
      provisionalCostUsd: provisional.usd,
    });
    if (!allowed.ok) {
      await insertRow(row, attempt, deps.clock.now(), {
        outcome: "refused-cap",
        costUsd: 0,
        provisional: false,
        priceKnown: provisional.known,
      });
      return { ok: false, reason: "refused-cap", message: allowed.message };
    }

    const id = await insertRow(row, attempt, deps.clock.now(), {
      outcome: "started",
      costUsd: provisional.usd,
      provisional: true,
      priceKnown: provisional.known,
    });
    let reply: LlmReply | { kind: "timeout" };
    try {
      reply = await runAttempt(llm, request, limits.idleMs, deadline - Date.now());
    } catch (error) {
      // Adapters return failures as values; an exception is a bug, so it surfaces.
      await finishWithoutUsage(deps, id, "client-error", null, String(error));
      throw error;
    }

    const timedOut = async () => {
      await finishWithoutUsage(deps, id, "timeout", null, null);
      return fail("timeout");
    };
    if (reply.kind === "timeout") return timedOut();
    if (reply.kind === "failure") {
      // Only this wrapper aborts a request, so an adapter's "aborted" is our timeout too.
      if (reply.failure === "aborted") return timedOut();
      await finishWithoutUsage(
        deps,
        id,
        FAILURE_OUTCOMES[reply.failure],
        reply.requestId,
        reply.message,
      );
      if (!RETRYABLE.has(reply.failure)) return fail("rejected");
      const wait = Math.min(reply.retryAfterMs ?? limits.defaultRetryWaitMs, limits.maxRetryWaitMs);
      if (attempt >= 2 || deadline - Date.now() - wait <= 0) return fail("unavailable");
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }

    // A reply the provider sent without usage keeps the attempt's provisional
    // cost, so a missing count never reads as free (B4).
    const priced = reply.usage.map((usage) => ({ ...usage, ...costOf(usage, deps.clock.now()) }));
    const finish = (outcome: string, error: string | null) =>
      priced.length > 0
        ? finishWithUsage(deps, id, outcome, reply.model, reply.requestId, priced, error)
        : finishWithoutUsage(deps, id, outcome, reply.requestId, error, reply.model);
    const costUsd =
      priced.length > 0 ? roundUsd(priced.reduce((sum, run) => sum + run.usd, 0)) : provisional.usd;

    if (reply.kind === "refusal") {
      const said = [reply.category && `refusal: ${reply.category}`, reply.detail].filter(Boolean);
      await finish("refused", said.length > 0 ? said.join("; ") : null);
      return fail("refused");
    }
    if (reply.truncated) {
      await finish("max-tokens", null);
      return fail("max-tokens");
    }
    const parsed = parseOutput(reply.text, input.schema);
    if (!parsed.ok) {
      await finish("invalid-output", parsed.error);
      return fail("invalid-output");
    }
    await finish("ok", null);
    return { ok: true, output: parsed.value, model: reply.model, costUsd };
  }
}

/**
 * Runs one attempt under its two timeouts. The race returns at the deadline
 * even if an adapter ignores the abort signal.
 */
async function runAttempt(
  llm: Llm,
  request: Omit<LlmRequest, "signal" | "onEvent">,
  idleMs: number,
  budgetMs: number,
): Promise<LlmReply | { kind: "timeout" }> {
  const controller = new AbortController();
  let timedOut!: () => void;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timedOut = () => resolve({ kind: "timeout" });
  });
  const stop = () => {
    controller.abort();
    timedOut();
  };
  let idle = setTimeout(stop, idleMs);
  const total = setTimeout(stop, Math.max(0, budgetMs));
  try {
    const call = llm.call({
      ...request,
      signal: controller.signal,
      onEvent: () => {
        clearTimeout(idle);
        idle = setTimeout(stop, idleMs);
      },
    });
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}

/** The provider's count, or a generous estimate when it fails or takes too long. */
async function countInput(
  llm: Llm,
  request: Omit<LlmRequest, "signal" | "onEvent">,
  countMs: number,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), countMs);
  });
  try {
    const counted = await Promise.race([llm.countInputTokens(request), giveUp]);
    return counted ?? estimateInputTokens(request);
  } catch {
    return estimateInputTokens(request);
  } finally {
    clearTimeout(timer);
  }
}

/** A third of the characters as tokens, and every image at the most it can cost. */
export function estimateInputTokens(request: Pick<LlmRequest, "system" | "content">): number {
  let characters = request.system.length;
  let images = 0;
  for (const part of request.content) {
    if (part.type === "text") characters += part.text.length;
    else images += 1;
  }
  return Math.ceil(characters / 3) + images * IMAGE_TOKENS_UPPER_BOUND;
}

function parseOutput<T>(
  text: string,
  schema: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "The answer was not JSON" };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.message.slice(0, 1000) };
}

async function insertRow(
  row: { db: Db; input: ModelCallInput<unknown>; provider: string },
  attempt: number,
  at: Date,
  fields: { outcome: string; costUsd: number; provisional: boolean; priceKnown: boolean },
): Promise<string> {
  const { rows } = await row.db.query<{ id: string }>(
    `insert into {{schema}}.model_calls
       (job_id, stage, attempt, provider, requested_model, started_at, ended_at,
        outcome, cost_usd, cost_provisional, price_known)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      row.input.jobId,
      row.input.stage,
      attempt,
      row.provider,
      row.input.model,
      at,
      fields.outcome === "started" ? null : at,
      fields.outcome,
      fields.costUsd,
      fields.provisional,
      fields.priceKnown,
    ],
  );
  return rows[0]!.id;
}

/** An attempt that ended without usage keeps its provisional cost (B4). */
async function finishWithoutUsage(
  deps: Pick<ModelCallDeps, "db" | "clock">,
  id: string,
  outcome: string,
  requestId: string | null,
  error: string | null,
  answeredModel: string | null = null,
): Promise<void> {
  await deps.db.query(
    `update {{schema}}.model_calls
        set ended_at = $2, outcome = $3, request_id = $4, error = $5, answered_model = $6
      where id = $1`,
    [id, deps.clock.now(), outcome, requestId, error, answeredModel],
  );
}

async function finishWithUsage(
  deps: Pick<ModelCallDeps, "db" | "clock">,
  id: string,
  outcome: string,
  answeredModel: string,
  requestId: string | null,
  runs: readonly {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    usd: number;
    known: boolean;
  }[],
  error: string | null,
): Promise<void> {
  const total = (pick: (run: (typeof runs)[number]) => number) =>
    runs.reduce((sum, run) => sum + pick(run), 0);
  const iterations = runs.map(({ usd, known, ...run }) => ({
    ...run,
    costUsd: usd,
    priceKnown: known,
  }));
  await deps.db.query(
    `update {{schema}}.model_calls
        set ended_at = $2, outcome = $3, answered_model = $4, request_id = $5,
            input_tokens = $6, output_tokens = $7, cache_read_tokens = $8, cache_write_tokens = $9,
            iterations = $10::jsonb, cost_usd = $11, cost_provisional = false, price_known = $12,
            error = $13
      where id = $1`,
    [
      id,
      deps.clock.now(),
      outcome,
      answeredModel,
      requestId,
      total((run) => run.inputTokens),
      total((run) => run.outputTokens),
      total((run) => run.cacheReadTokens),
      total((run) => run.cacheWriteTokens),
      JSON.stringify(iterations),
      roundUsd(total((run) => run.usd)),
      runs.every((run) => run.known),
      error,
    ],
  );
}

/**
 * The runner's part of B4: an attempt left `started` by a killed invocation
 * is marked `abandoned` when its job is next claimed, keeping its provisional
 * cost.
 */
export async function abandonStartedCalls(db: Db, jobId: string, now: Date): Promise<number> {
  const { rowCount } = await db.query(
    `update {{schema}}.model_calls set outcome = 'abandoned', ended_at = $2
      where job_id = $1 and outcome = 'started'`,
    [jobId, now],
  );
  return rowCount;
}
