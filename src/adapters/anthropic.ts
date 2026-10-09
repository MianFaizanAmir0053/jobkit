import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ZodType } from "zod";

import type { Llm, LlmFailureKind, LlmReply, LlmRequest, LlmUsage } from "@/core/ports";

import { ConnectionLost, type Fetch, networkFetch, reportingChunks } from "./reportingFetch";

/**
 * The Llm port on Claude (platform spec B4), through the official SDK's beta
 * messages API, which carries refusal fallbacks:
 * - a streamed request with the stage's schema as `output_config.format` and
 *   its `output_config.effort`; thinking stays at Claude Opus 5.5's
 *   always-on adaptive default, so it is not sent;
 * - server-side refusal fallbacks in their default form, where the API picks
 *   the fallback model by refusal category, on the models that accept them;
 * - the SDK's own retries off: the wrapper retries once itself;
 * - the endpoint, the credential and the log level fixed here, so variables
 *   such as ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_LOG in the
 *   shell cannot send the key elsewhere, add a second credential, or log a
 *   post's text.
 * Failures come back as values: the API's by kind, and a network failure or
 * a stream that stops early as a dropped connection. Anything else is a bug
 * in the SDK or here, and is thrown.
 */
const API_BASE = "https://api.anthropic.com";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The models that take `fallbacks: "default"`, from the Claude API migration
 * guide (the claude-api skill's shared/model-migration.md) on 2026-10-09.
 * Claude Haiku 5.5 has no server-side fallback, so its requests must not
 * carry the parameter.
 */
const MODELS_WITH_FALLBACKS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

/** The wrapper stops waiting for a count after ten seconds; this ends the request soon after. */
const COUNT_TIMEOUT_MS = 15_000;

export function createAnthropicLlm(opts: { apiKey: string; fetch?: Fetch }): Llm {
  const network = opts.fetch ?? networkFetch;
  const clientOn = (fetch: Fetch) =>
    new Anthropic({
      apiKey: opts.apiKey,
      authToken: null,
      baseURL: API_BASE,
      logLevel: "warn",
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
        { timeout: COUNT_TIMEOUT_MS },
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
          ...(MODELS_WITH_FALLBACKS.has(request.model)
            ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
            : {}),
        },
        { signal: request.signal },
      );
      try {
        return fromMessage(await stream.finalMessage(), stream.request_id ?? null, request.model);
      } catch (error) {
        // A connection that broke after the message ended still delivered all of it.
        const received = stream.receivedMessages.at(-1);
        if (received) return fromMessage(received, stream.request_id ?? null, request.model);
        return fromError(error, stream.request_id ?? null);
      }
    },
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
  return { type, schema: jsonSchema };
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
  if (message.stop_reason === "refusal") {
    const details = message.stop_details;
    if (details?.recommended_model) {
      // The fallback model was rate-limited or overloaded, so no fallback
      // ran: an outage worth the wrapper's one retry, not a verdict on the
      // post. The declined run's usage is lost, so the attempt keeps its
      // provisional cost.
      return {
        kind: "failure",
        failure: "server",
        message: `Declined (${details.category ?? "no category"}) while the fallback model was unavailable`,
        requestId,
        retryAfterMs: null,
      };
    }
    return { kind: "refusal", model: message.model, requestId, usage, category: details?.category ?? null };
  }
  return {
    kind: "answer",
    text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
    model: message.model,
    requestId,
    usage,
    // Only a turn the model ended itself is complete; max_tokens, a full
    // context window or a missing stop reason all cut the answer off.
    truncated: message.stop_reason !== "end_turn" && message.stop_reason !== "stop_sequence",
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
    return failure(kind, error, kind === "client" ? null : retryAfter(error.headers), streamRequestId);
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
