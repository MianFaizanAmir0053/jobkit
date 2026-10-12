import { extractStage } from "@/core/extraction/extract";
import type { Pipeline } from "@/core/platform/runner";
import type { Container } from "@/server/container";
import { modelCallDeps } from "@/server/models";

/**
 * The stages the app's runner knows, built on the container. Each module
 * registers its own as it arrives (extraction, drafting, review); until
 * then a job fails at the first stage it lacks, with "This step is not
 * available yet."
 */
export function appPipeline(container: Container): Pipeline {
  const models = modelCallDeps(container);
  return {
    extract: extractStage({
      db: container.db,
      storage: container.storage,
      random: container.random,
      models,
    }),
  };
}
