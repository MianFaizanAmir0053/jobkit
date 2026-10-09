import { providerOf } from "@/core/platform/models";
import type { Llm } from "@/core/ports";

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
 * from the app's. The test server has no keys; the stages' end-to-end tests
 * will give it scripted models (Task 26). A model whose key is missing
 * throws when a stage asks for it, before anything is logged or charged, so
 * the rest of the app keeps working without it.
 */
export function modelsFor(kind: keyof typeof KEY_NAMES, env: Env): (model: string) => Llm {
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
 * A model that loads its adapter, and the provider's SDK, on first use, so
 * pages and routes that call no model do not pay for loading them. None
 * without a key.
 */
function lazyLlm(apiKey: string | undefined, load: (apiKey: string) => Promise<Llm>): Llm | null {
  if (!apiKey) return null;
  let loaded: Promise<Llm> | undefined;
  const llm = () => (loaded ??= load(apiKey));
  return {
    countInputTokens: async (request) => (await llm()).countInputTokens(request),
    call: async (request) => (await llm()).call(request),
  };
}
