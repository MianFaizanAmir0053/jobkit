import type { Pipeline } from "@/core/platform/runner";

/**
 * The stages the app's runner knows. Each module registers its own as it
 * arrives (extraction, drafting, review); until then a job fails at the
 * first stage it lacks, with "This step is not available yet."
 */
export function appPipeline(): Pipeline {
  return {};
}
