import { draftStage } from "@/core/drafting/draftStage";
import { judgePassThrough } from "@/core/drafting/judgeStage";
import { eligibilityPassThrough } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import type { Pipeline } from "@/core/platform/runner";
import type { Container } from "@/server/container";
import { modelCallDeps } from "@/server/models";

/**
 * The stages the app's runner knows, built on the container. Each module
 * registers its own as it arrives; a job fails at any stage the pipeline
 * lacks, with "This step is not available yet." On the thin path
 * (tasks/todo.md) eligibility and the judge pass through unchecked, and the
 * address stages are not registered, so drafting runs nothing beside draft.
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
    eligibility: eligibilityPassThrough(container.db),
    draft: draftStage({ db: container.db, random: container.random, models }),
    judge: judgePassThrough(),
  };
}
