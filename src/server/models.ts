import { spendGuard } from "@/core/ledger/spend";
import { type ModelCallDeps, providerOf } from "@/core/platform/models";
import type { Clock, Db, Llm } from "@/core/ports";
import { scriptedLlm } from "@/server/scriptedModels";

type Env = Readonly<Record<string, string | undefined>>;

const KEY_NAMES = {
  production: { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" },
  development: { anthropic: "ANTHROPIC_EVALS_API_KEY", gemini: "GEMINI_EVALS_API_KEY" },
  test: null,
} as const;

/**
 * The model behind each model ID, by environment (platform spec B4, B8).
 * Production uses the app's keys. Development uses the evaluation keys from
 * .env.local, so local runs spend from the evaluation workspaces and never
 * from the app's. The test server has no keys: every model there answers
 * from the script the end-to-end tests set (scriptedModels.ts). A model whose key is missing
 * throws when a stage asks for it, before anything is logged or charged, so
 * the rest of the app keeps working without it.
 */
export function modelsFor(kind: keyof typeof KEY_NAMES, env: Env): (model: string) => Llm {
  if (kind === "test") {
    const scripted = scriptedLlm();
    return (model) => {
      // A model no provider serves fails here, as it would with keys.
      providerOf(model);
      return scripted;
    };
  }
  const names = KEY_NAMES[kind];
  const llms = {
    anthropic: lazyLlm(names ? env[names.anthropic] : undefined, async (apiKey) =>
      (await import("@/adapters/anthropic")).createAnthropicLlm({ apiKey }),
    ),
    gemini: lazyLlm(names ? env[names.gemini] : undefined, async (apiKey) =>
      (await import("@/adapters/gemini")).createGeminiLlm({ apiKey }),
    ),
  };
  return (model) => {
    const provider = providerOf(model);
    const llm = llms[provider];
    if (llm) return llm;
    throw new Error(
      names
        ? `${names[provider]} is not set, so ${model} cannot run here`
        : `The ${kind} server has no models`,
    );
  };
}

/**
 * What every model stage hands the wrapper: the container's models, and the
 * monthly spend cap as its guard (ledger spec, "Spend cap").
 */
export function modelCallDeps(container: {
  db: Db;
  clock: Clock;
  llmFor(model: string): Llm;
}): ModelCallDeps {
  return {
    db: container.db,
    clock: container.clock,
    llmFor: (model) => container.llmFor(model),
    guard: spendGuard(container),
  };
}

/**
 * A model that loads its adapter, and the provider's SDK, on first use, so
 * pages and routes that call no model do not pay for loading them. A load
 * that fails is tried again on the next call, as a container that failed to
 * start is. None without a key.
 */
export function lazyLlm(
  apiKey: string | undefined,
  load: (apiKey: string) => Promise<Llm>,
): Llm | null {
  if (!apiKey) return null;
  let loaded: Promise<Llm> | undefined;
  const llm = () =>
    (loaded ??= load(apiKey).catch((error: unknown) => {
      loaded = undefined;
      throw error;
    }));
  return {
    countInputTokens: async (request) => (await llm()).countInputTokens(request),
    call: async (request) => (await llm()).call(request),
  };
}
