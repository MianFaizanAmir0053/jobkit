import type { StageDefinition } from "@/core/platform/runner";

import type { TemplatesOutput } from "./templatesStage";

/**
 * For tests: a templates stage that drafts nothing, with no profile read, so
 * the job goes on to `draft` as when no template fits the role. Tests of the
 * drafted email use it; the sample profile's templates fit its posts.
 */
export function noTemplateDrafts(): StageDefinition {
  const output: TemplatesOutput = { drafts: [] };
  return {
    callsModel: false,
    input: () => ({}),
    run: async () => ({ ok: true as const, output }),
    next: () => ({ state: "drafting" as const, pending: "draft" as const }),
  };
}
