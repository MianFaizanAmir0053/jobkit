import type { Llm, LlmFailureKind, LlmReply, LlmRequest, LlmUsage } from "@/core/ports";

/**
 * A scripted model for tests: each call takes the next step. No test calls a
 * real model (platform spec A8).
 */
export type FakeStep = (request: LlmRequest) => Promise<LlmReply> | LlmReply;

export interface FakeLlm extends Llm {
  readonly calls: LlmRequest[];
}

export function fakeLlm(
  steps: readonly FakeStep[],
  opts: { inputTokens?: number | "fail" | "hang" } = {},
): FakeLlm {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async countInputTokens() {
      if (opts.inputTokens === "fail") throw new Error("counting failed");
      if (opts.inputTokens === "hang") return new Promise<number>(() => undefined);
      return opts.inputTokens ?? 1000;
    },
    async call(request) {
      const step = steps[calls.length];
      calls.push(request);
      if (!step) throw new Error(`The fake model has no step for call ${calls.length}`);
      return step(request);
    },
  };
}

export function usageOf(model: string, inputTokens = 1000, outputTokens = 500): LlmUsage {
  return { model, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function answer(
  output: unknown,
  opts: { model?: string; usage?: LlmUsage[]; truncated?: boolean; requestId?: string } = {},
): FakeStep {
  return (request) => ({
    kind: "answer",
    text: typeof output === "string" ? output : JSON.stringify(output),
    model: opts.model ?? request.model,
    requestId: opts.requestId ?? "req_fake",
    usage: opts.usage ?? [usageOf(opts.model ?? request.model)],
    truncated: opts.truncated ?? false,
  });
}

export function refusal(
  opts: { usage?: LlmUsage[]; category?: string; detail?: string } = {},
): FakeStep {
  return (request) => ({
    kind: "refusal",
    model: request.model,
    requestId: "req_fake",
    usage: opts.usage ?? [usageOf(request.model, 1000, 0)],
    category: opts.category ?? null,
    ...(opts.detail ? { detail: opts.detail } : {}),
  });
}

export function failure(kind: LlmFailureKind, retryAfterMs: number | null = null): FakeStep {
  return () => ({
    kind: "failure",
    failure: kind,
    message: `fake ${kind}`,
    requestId: null,
    retryAfterMs,
  });
}

/** A stream that never sends an event; it ends only when the caller aborts it. */
export function silence(): FakeStep {
  return (request) =>
    new Promise((resolve) => {
      request.signal.addEventListener("abort", () =>
        resolve({
          kind: "failure",
          failure: "aborted",
          message: "aborted",
          requestId: null,
          retryAfterMs: null,
        }),
      );
    });
}

/** A stream that sends an event every `everyMs`, then answers after `events` of them. */
export function slowStream(events: number, everyMs: number, then: FakeStep): FakeStep {
  return async (request) => {
    for (let i = 0; i < events; i++) {
      if (request.signal.aborted) {
        return {
          kind: "failure",
          failure: "aborted",
          message: "aborted",
          requestId: null,
          retryAfterMs: null,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      request.onEvent();
    }
    return then(request);
  };
}

/** Runs `check` when the call arrives, before answering: what had already happened by then. */
export function whenCalled(
  check: (request: LlmRequest) => Promise<void>,
  then: FakeStep,
): FakeStep {
  return async (request) => {
    await check(request);
    return then(request);
  };
}
