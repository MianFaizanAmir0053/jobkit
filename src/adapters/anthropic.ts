import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z, type ZodType } from "zod";

import type { Llm, LlmFailureKind, LlmReply, LlmRequest, LlmUsage } from "@/core/ports";

import { ConnectionLost, type Fetch, networkFetch, reportingChunks } from "./reportingFetch";

/**
 * The Llm port on Claude (platform spec B4), through the official SDK's beta
 * messages API, which carries refusal fallbacks:
 * - a streamed request with the stage's schema as `output_config.format` and
 *   its `output_config.effort`; thinking stays at Claude Opus 5.5's
 *   always-on adaptive default, so it is not sent;
 * - server-side refusal fallbacks in their default form, where the API picks
 *   the fallback model by refusal category, on the models that accept them.
 *   The migration guide (the claude-api skill's shared/model-migration.md,
 *   read on 2026-10-09) says a mid-stream fallback keeps the declined
 *   model's partial text and continues it, so the answer joins every text
 *   block; the first live test checks that the API takes fallbacks together
 *   with structured outputs;
 * - the SDK's own retries off: the wrapper retries once itself;
 * - the endpoint, the credential and logging fixed here, so variables such
 *   as ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_CUSTOM_HEADERS or
 *   ANTHROPIC_LOG in the shell cannot send another key, send this one
 *   elsewhere, or log a post's text.
 * Failures come back as values: the API's by kind, and a network failure or
 * a stream that stops early as a dropped connection. Anything else is a bug
 * in the SDK or here, and is thrown.
 */
const API_BASE = "https://api.anthropic.com";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The models that take `fallbacks: "default"`, from the same guide on
 * 2026-10-09. Claude Haiku 5.5 has no server-side fallback, so its requests
 * must not carry the parameter.
 */
const MODELS_WITH_FALLBACKS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

/** The wrapper stops waiting for a count after ten seconds; the request itself ends by this. */
const COUNT_TIMEOUT_MS = 15_000;

export function createAnthropicLlm(opts: { apiKey: string; fetch?: Fetch }): Llm {
  const network = withOwnHeaders(opts.fetch ?? networkFetch, opts.apiKey);
  const clientOn = (fetch: Fetch) =>
    new Anthropic({
      apiKey: opts.apiKey,
      authToken: null,
      baseURL: API_BASE,
      logLevel: "off",
      maxRetries: 0,
      fetch,
    });
  return {
    async countInputTokens(request) {
      const counted = await clientOn(network).beta.messages.countTokens(
        {
          model: request.model,
          system: request.system,
          messages: toMessages(request),
          output_config: { format: outputFormat(request.schema) },
        },
        // The SDK's own timeout stops at the headers; the signal covers the body too.
        { timeout: COUNT_TIMEOUT_MS, signal: AbortSignal.timeout(COUNT_TIMEOUT_MS) },
      );
      return counted.input_tokens;
    },
    async call(request) {
      // A client per call, so each call's fetch reports to that call's idle timer.
      const stream = clientOn(reportingChunks(network, request.onEvent)).beta.messages.stream(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: toMessages(request),
          output_config: { effort: request.effort, format: outputFormat(request.schema) },
          // A dated snapshot takes fallbacks as its model does.
          ...(MODELS_WITH_FALLBACKS.has(request.model.replace(/-\d{8}$/, ""))
            ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
            : {}),
        },
        { signal: request.signal },
      );
      try {
        return fromMessage(await stream.finalMessage(), stream.request_id ?? null, request.model);
      } catch (error) {
        // Throws a bug, which surfaces even after the message ended.
        const failed = fromError(error, stream.request_id ?? null);
        // What arrived before the failure can still settle the call: a whole
        // message, or a refusal whose closing event was lost, which must not
        // be sent again (B4).
        const current = stream.currentMessage;
        const settled =
          stream.receivedMessages.at(-1) ??
          (current?.stop_reason === "refusal" ? current : undefined);
        return settled ? fromMessage(settled, stream.request_id ?? null, request.model) : failed;
      }
    },
  };
}

/** Headers the SDK sets itself, kept as they are. */
const SDK_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "user-agent"]);
const API_VERSION = "2023-06-01";
const OUR_BETAS: ReadonlySet<string> = new Set([FALLBACK_BETA]);

/**
 * Every request carries this adapter's key, its own API version and betas,
 * and the SDK's own headers, and nothing else, whatever the SDK took from
 * the environment: ANTHROPIC_CUSTOM_HEADERS, read in its constructor, can
 * name any header, a gateway's credential or a cookie included.
 */
function withOwnHeaders(fetch: Fetch, apiKey: string): Fetch {
  return (input, init) => {
    const sent = new Headers(init?.headers);
    const headers = new Headers();
    for (const [name, value] of sent) {
      if (SDK_HEADERS.has(name) || name.startsWith("x-stainless-")) headers.set(name, value);
    }
    const betas = (sent.get("anthropic-beta") ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter((beta) => OUR_BETAS.has(beta));
    if (betas.length > 0) headers.set("anthropic-beta", betas.join(","));
    headers.set("anthropic-version", API_VERSION);
    headers.set("x-api-key", apiKey);
    return fetch(input, { ...init, headers });
  };
}

/**
 * The stage's schema as a plain JSON-schema format. The SDK's zod helper also
 * hooks a parser onto the stream that checks every text block when the
 * message ends and throws on a mismatch, which would turn a refusal, a cut-off
 * answer or an answer split by a fallback into an error. The wrapper
 * validates the answer itself, so only the schema is kept.
 */
export function outputFormat(schema: ZodType): BetaJSONOutputFormat {
  const { type, schema: jsonSchema } = betaZodOutputFormat(schema);
  // The helper reshapes this same JSON Schema.
  restoreMembers(z.toJSONSchema(schema, { reused: "ref" }), jsonSchema);
  return { type, schema: jsonSchema };
}

/**
 * Copies `enum` and `const` back onto the schema the SDK's helper reshaped.
 * The helper folds both into descriptions as text, though the API supports
 * them and constrains the model to their values, if not to their case
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
 * The folded text stays in each description as a harmless repeat.
 *
 * The walk pairs nodes by position along the keys the helper keeps:
 * `$defs`, `$ref` (which ends a node), `anyOf` (which also carries
 * `oneOf`), `allOf`, `properties` and `items`. A pair whose type,
 * `$ref`, union or intersection, or property names differ, or a branch list
 * whose length changed, is not walked further: a helper that one day drops,
 * wraps or retypes nodes then leaves those values as description text
 * rather than putting them on a wrong node. Nodes of one shape that swapped
 * places would trade values; today's helper keeps every node in place, as
 * the tests pin down. Values the helper already keeps are left as they are.
 */
export function restoreMembers(from: unknown, to: unknown): void {
  if (!isRecord(from) || !isRecord(to) || !sameShape(from, to)) return;
  if (isRecord(from.$defs) && isRecord(to.$defs)) {
    for (const [name, definition] of Object.entries(from.$defs)) {
      restoreMembers(definition, ownValue(to.$defs, name));
    }
  }
  if (Object.hasOwn(from, "$ref")) return;
  if (Array.isArray(from.enum) && !Object.hasOwn(to, "enum")) to.enum = [...new Set(from.enum)];
  if (Object.hasOwn(from, "const") && !Object.hasOwn(to, "const")) to.const = from.const;
  const branches = Array.isArray(from.anyOf)
    ? from.anyOf
    : Array.isArray(from.oneOf)
      ? from.oneOf
      : undefined;
  if (branches) restoreEach(branches, to.anyOf);
  else if (Array.isArray(from.allOf)) restoreEach(from.allOf, to.allOf);
  if (isRecord(from.properties) && isRecord(to.properties)) {
    for (const [key, property] of Object.entries(from.properties)) {
      restoreMembers(property, ownValue(to.properties, key));
    }
  }
  restoreMembers(from.items, to.items);
}

function restoreEach(from: readonly unknown[], to: unknown): void {
  if (!Array.isArray(to) || to.length !== from.length) return;
  from.forEach((node, i) => restoreMembers(node, to[i]));
}

/**
 * Whether two nodes can be one node before and after the helper: the same
 * type and `$ref`, a union or intersection on both sides or on neither, and
 * the same property names.
 */
function sameShape(from: Record<string, unknown>, to: Record<string, unknown>): boolean {
  const same = (key: string) => JSON.stringify(from[key]) === JSON.stringify(to[key]);
  if (!same("type") || !same("$ref")) return false;
  const union = (node: Record<string, unknown>) =>
    Array.isArray(node.anyOf) || Array.isArray(node.oneOf);
  if (union(from) !== union(to) || Array.isArray(from.allOf) !== Array.isArray(to.allOf)) {
    return false;
  }
  const names = (node: Record<string, unknown>) =>
    JSON.stringify(Object.keys(isRecord(node.properties) ? node.properties : {}).sort());
  return names(from) === names(to);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A key read only from the object itself, so a "__proto__" key reaches no prototype.
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function toMessages(request: Pick<LlmRequest, "content">): BetaMessageParam[] {
  return [
    {
      role: "user",
      content: request.content.map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : {
              type: "image" as const,
              source: { type: "base64" as const, media_type: part.mediaType, data: part.base64 },
            },
      ),
    },
  ];
}

/** Stop reasons that leave the answer unfinished. */
const CUT_OFF: ReadonlySet<string> = new Set(["max_tokens", "model_context_window_exceeded"]);

/**
 * The final message as the port's reply. After a mid-stream fallback the
 * fallback model continues the declined model's partial text, so the answer
 * is every text block in order. Each model run is priced on its own:
 * `usage.iterations` lists them, the declined run as a `message` entry.
 */
export function fromMessage(
  message: BetaMessage,
  requestId: string | null,
  requestedModel: string,
): LlmReply {
  const usage = usageOf(message, requestedModel);
  const stop = message.stop_reason;
  if (stop === "refusal") {
    // Never retried (B4), even when the fallback model was too busy to run:
    // a resend would be declined, and billed, again. The log says so, since
    // the owner's Retry later may then succeed.
    const busy = message.stop_details?.recommended_model;
    return {
      kind: "refusal",
      model: message.model,
      requestId,
      usage,
      category: message.stop_details?.category ?? null,
      ...(busy
        ? { detail: `the fallback model was too busy to run; the API suggests ${busy}` }
        : {}),
    };
  }
  return {
    kind: "answer",
    text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
    model: message.model,
    requestId,
    usage,
    // Only these cut the answer off. Any other ending, an unexpected one
    // such as pause_turn included, leaves the answer to the wrapper's parse,
    // which keeps its usage and rejects one that is incomplete.
    truncated: CUT_OFF.has(stop ?? ""),
  };
}

function usageOf(message: BetaMessage, requestedModel: string): LlmUsage[] {
  const runs = message.usage.iterations ?? [];
  if (runs.length > 0) {
    return runs.map((run) => ({
      // A run that names no model is the requested model's.
      model: ("model" in run && run.model) || requestedModel,
      inputTokens: run.input_tokens,
      outputTokens: run.output_tokens,
      cacheReadTokens: run.cache_read_input_tokens,
      cacheWriteTokens: run.cache_creation_input_tokens,
    }));
  }
  // No runs listed means only the requested model ran: its price applies,
  // whatever ID the API names it by.
  return [
    {
      model: requestedModel,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
  ];
}

/** What the SDK reports when a stream simply stops before its message ends. */
const ENDED_EARLY: readonly string[] = [
  "stream ended without producing a Message with role=assistant",
  "request ended without sending any chunks",
];

/**
 * Sorts an error from the SDK into the wrapper's failure kinds. The stream
 * wraps whatever breaks it in a plain AnthropicError, so a dropped connection
 * is told apart by its cause, which reportingChunks marks, or by the SDK's
 * message for a stream that stopped early. Anything else is a bug and is
 * thrown.
 */
export function fromError(error: unknown, streamRequestId: string | null = null): LlmReply {
  if (error instanceof Anthropic.APIUserAbortError) {
    return failure("aborted", error, null, streamRequestId);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return failure("connection", error, null, streamRequestId);
  }
  if (error instanceof Anthropic.APIError) {
    const kind = kindOf(error);
    return failure(
      kind,
      error,
      kind === "client" ? null : retryAfter(error.headers),
      streamRequestId,
    );
  }
  if (
    error instanceof Anthropic.AnthropicError &&
    (error.cause instanceof ConnectionLost || ENDED_EARLY.includes(error.message))
  ) {
    return failure("connection", error, null, streamRequestId);
  }
  throw error;
}

/** Error types that mean the request itself was at fault, so a retry cannot help. */
const REQUEST_FAULTS: ReadonlySet<string> = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "billing_error",
]);

/**
 * The SDK's own retry rule: the API's x-should-retry header when it sends
 * one, then 408, 409, 429 and 5xx. An error event in the middle of a stream
 * has no status, only the API's error type, and unless the request caused
 * it, it is the server's.
 */
function kindOf(error: InstanceType<typeof Anthropic.APIError>): LlmFailureKind {
  const { status, type } = error;
  const rateLimited = status === 429 || type === "rate_limit_error";
  const shouldRetry = error.headers?.get("x-should-retry");
  if (shouldRetry === "true") return rateLimited ? "rate-limit" : "server";
  if (shouldRetry === "false") return "client";
  if (rateLimited) return "rate-limit";
  if (status === undefined) return REQUEST_FAULTS.has(type ?? "") ? "client" : "server";
  return status >= 500 || status === 408 || status === 409 ? "server" : "client";
}

function failure(
  kind: LlmFailureKind,
  error: Error,
  retryAfterMs: number | null,
  streamRequestId: string | null,
): LlmReply {
  const ownRequestId = error instanceof Anthropic.APIError ? error.requestID : null;
  return {
    kind: "failure",
    failure: kind,
    message: error.message,
    requestId: ownRequestId ?? streamRequestId,
    retryAfterMs,
  };
}

/** retry-after-ms, then retry-after in seconds or as an HTTP date. */
export function retryAfter(headers: Headers | undefined): number | null {
  const ms = Number(headers?.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const value = headers?.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
