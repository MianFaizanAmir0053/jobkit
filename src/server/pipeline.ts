import { draftStage } from "@/core/drafting/draftStage";
import { judgeStage } from "@/core/drafting/judgeStage";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import type { Pipeline } from "@/core/platform/runner";
import type { Container } from "@/server/container";
import { modelCallDeps } from "@/server/models";

/**
 * The stages the app's runner knows, built on the container. Each module
 * registers its own as it arrives; a job fails at any stage the pipeline
 * lacks, with "This step is not available yet." On the thin path
 * (tasks/todo.md) the address stages are not registered, so drafting runs
 * nothing beside draft.
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
    eligibility: eligibilityStage({ db: container.db, clock: container.clock }),
    draft: draftStage({ db: container.db, random: container.random, models }),
    judge: judgeStage({ db: container.db, random: container.random, models }),
  };
}
