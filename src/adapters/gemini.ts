import {
  ApiError,
  FinishReason,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
  ThinkingLevel,
} from "@google/genai";
import { z, type ZodType } from "zod";

import type { Effort, Llm, LlmFailureKind, LlmInput, LlmReply, LlmUsage } from "@/core/ports";

import { ConnectionLost, type Fetch, networkFetch, reportingChunks } from "./reportingFetch";

/**
 * The Llm port on Gemini (platform spec B4), for the contact-box second read:
 * a streamed request with the stage's schema as the JSON-schema response
 * format, the effort as a thinking level, and the SDK's own retries off. The
 * wrapper parses the answer with the same zod schema.
 *
 * The SDK reports HTTP errors with their own class and everything else as a
 * plain Error. A network failure (marked by reportingChunks) or a stream that
 * stops early is a dropped connection; any other error is a bug and is
 * thrown.
 */
const API_BASE = "https://generativelanguage.googleapis.com/";

const THINKING: Readonly<Record<Effort, ThinkingLevel>> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

/** Finish reasons where the model declined rather than answered. */
const DECLINED: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.LANGUAGE,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT,
  FinishReason.IMAGE_RECITATION,
]);

/** Finish reasons that leave the answer unfinished. */
const CUT_OFF: ReadonlySet<string> = new Set([FinishReason.MAX_TOKENS, FinishReason.CONTINUATION]);

/** What the SDK reports when a stream simply stops partway. */
const ENDED_EARLY: readonly string[] = ["Incomplete JSON segment at the end", "Response body is empty"];

/** The wrapper stops waiting for a count after ten seconds; this ends the request soon after. */
const COUNT_TIMEOUT_MS = 15_000;

export function createGeminiLlm(opts: { apiKey: string; fetch?: Fetch }): Llm {
  const network = opts.fetch ?? networkFetch;
  const ai = new GoogleGenAI({
    apiKey: opts.apiKey,
    // The Gemini API with a key at Google's own address, whatever the
    // environment says about Vertex AI or GOOGLE_GEMINI_BASE_URL.
    vertexai: false,
    // One attempt means no retries; the wrapper retries once itself.
    httpOptions: { baseUrl: API_BASE, retryOptions: { attempts: 1 }, fetch: network },
  });
  return {
    async countInputTokens(request) {
      const counted = await ai.models.countTokens({
        model: request.model,
        // The Gemini API counts no system instruction or response schema
        // here, so both are counted as text: the bound errs high, not low.
        contents: [
          {
            role: "user",
            parts: [
              { text: request.system },
              { text: JSON.stringify(jsonSchemaOf(request.schema)) },
              ...toParts(request.content),
            ],
          },
        ],
        config: { httpOptions: { timeout: COUNT_TIMEOUT_MS } },
      });
      if (counted.totalTokens === undefined) throw new Error("The Gemini API returned no count");
      return counted.totalTokens;
    },
    async call(request) {
      const responseJsonSchema = jsonSchemaOf(request.schema);
      const chunks: GenerateContentResponse[] = [];
      try {
        const stream = await ai.models.generateContentStream({
          model: request.model,
          contents: [{ role: "user", parts: toParts(request.content) }],
          config: {
            systemInstruction: request.system,
            maxOutputTokens: request.maxTokens,
            responseMimeType: "application/json",
            responseJsonSchema,
            // Thought summaries stream while the model thinks, so a long
            // think is not mistaken for a dead connection; fromChunks leaves
            // them out of the answer. Google bills the full thinking either
            // way (https://ai.google.dev/gemini-api/docs/thinking, 2026-10-09).
            thinkingConfig: { thinkingLevel: THINKING[request.effort], includeThoughts: true },
            abortSignal: request.signal,
            // Per request, so each call's fetch reports to that call's idle timer.
            httpOptions: { fetch: reportingChunks(network, request.onEvent) },
          },
        });
        for await (const chunk of stream) chunks.push(chunk);
      } catch (error) {
        return fromError(error, request.signal);
      }
      return fromChunks(chunks, request.model);
    },
  };
}

/**
 * The stage's schema as JSON Schema. The API takes a subset of it; the
 * wrapper's zod parse checks the rest.
 */
export function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete json.$schema;
  return json;
}

export function toParts(content: readonly LlmInput[]): Part[] {
  return content.map((part) =>
    part.type === "text"
      ? { text: part.text }
      : { inlineData: { mimeType: part.mediaType, data: part.base64 } },
  );
}

/**
 * The streamed chunks as the port's reply. A stream that stops without a
 * finish reason broke off, so it is a dropped connection. An answer or a
 * refusal that came without usage carries none, and the wrapper keeps the
 * attempt's provisional cost.
 */
export function fromChunks(
  chunks: readonly GenerateContentResponse[],
  requestedModel: string,
): LlmReply {
  const model = chunks.findLast((chunk) => chunk.modelVersion)?.modelVersion ?? requestedModel;
  const requestId = chunks.find((chunk) => chunk.responseId)?.responseId ?? null;
  const usage = usageOf(chunks, requestedModel);
  const declined = (category: string): LlmReply => ({
    kind: "refusal",
    model,
    requestId,
    usage,
    category,
  });

  const blocked = chunks.find((chunk) => chunk.promptFeedback?.blockReason)?.promptFeedback
    ?.blockReason;
  if (blocked) return declined(blocked);
  const finish = chunks.findLast((chunk) => chunk.candidates?.[0]?.finishReason)?.candidates?.[0]
    ?.finishReason;
  if (!finish) {
    return {
      kind: "failure",
      failure: "connection",
      message: "The stream ended before the answer finished",
      requestId,
      retryAfterMs: null,
    };
  }
  if (DECLINED.has(finish)) return declined(finish);
  if (finish !== FinishReason.STOP && !CUT_OFF.has(finish)) {
    // OTHER, an unspecified reason or a tool fault: not the answer's length,
    // so not "cut off"; worth the wrapper's one retry.
    return {
      kind: "failure",
      failure: "server",
      message: `Gemini stopped for an unexpected reason: ${finish}`,
      requestId,
      retryAfterMs: null,
    };
  }

  const text = chunks
    .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
    .flatMap((part) => (part.text !== undefined && !part.thought ? [part.text] : []))
    .join("");
  return {
    kind: "answer",
    text,
    model,
    requestId,
    usage,
    truncated: CUT_OFF.has(finish),
  };
}

/**
 * The last chunk's counts are the totals. The prompt count includes cached
 * tokens, which are billed at the cache rate; thinking is billed as output.
 * Prices follow the requested model, since Gemini does not hand a request to
 * another model, and its version string may carry a suffix.
 */
function usageOf(chunks: readonly GenerateContentResponse[], requestedModel: string): LlmUsage[] {
  const counts = chunks.findLast((chunk) => chunk.usageMetadata)?.usageMetadata;
  if (!counts) return [];
  const cached = counts.cachedContentTokenCount ?? 0;
  return [
    {
      model: requestedModel,
      inputTokens: Math.max(0, (counts.promptTokenCount ?? 0) - cached),
      outputTokens: (counts.candidatesTokenCount ?? 0) + (counts.thoughtsTokenCount ?? 0),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
  ];
}

export function fromError(error: unknown, signal: AbortSignal): LlmReply {
  if (!(error instanceof Error)) throw error;
  // Only the wrapper aborts, so whatever the abort broke is its timeout.
  if (signal.aborted) return failure("aborted", error.message, null);
  if (error instanceof ApiError) {
    const kind: LlmFailureKind =
      error.status === 429
        ? "rate-limit"
        : error.status >= 500 || error.status === 408
          ? "server"
          : "client";
    return failure(kind, error.message, kind === "client" ? null : retryDelayOf(error.message));
  }
  if (error instanceof ConnectionLost || ENDED_EARLY.includes(error.message)) {
    return failure("connection", error.message, null);
  }
  throw error;
}

function failure(kind: LlmFailureKind, message: string, retryAfterMs: number | null): LlmReply {
  return { kind: "failure", failure: kind, message, requestId: null, retryAfterMs };
}

/** Google sends its wait in the error body as RetryInfo, such as `"retryDelay": "30s"`. */
export function retryDelayOf(message: string): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}
