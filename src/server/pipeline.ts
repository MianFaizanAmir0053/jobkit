import { draftAnswersStage } from "@/core/drafting/answersStage";
import { draftStage } from "@/core/drafting/draftStage";
import { judgeStage } from "@/core/drafting/judgeStage";
import { templatesStage } from "@/core/drafting/templatesStage";
import { addressReadStage, contactOf } from "@/core/extraction/addressReadStage";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import { chosenRole } from "@/core/extraction/owner";
import { extractQuestionsStage } from "@/core/extraction/questionsStage";
import type { Role } from "@/core/extraction/record";
import type { StageName } from "@/core/platform/jobStates";
import type { Pipeline } from "@/core/platform/runner";
import { addressChecksStage } from "@/core/review/addressChecksStage";
import { trackApplications } from "@/core/review/applications";
import { kitOfJob } from "@/core/review/kitType";
import type { Container } from "@/server/container";
import { modelCallDeps } from "@/server/models";

/**
 * The stages the app's runner knows, built on the container. Each module
 * registers its own as it arrives; a job fails at any stage the pipeline
 * lacks, with "This step is not available yet." Beside templates and draft
 * run the contact's second read and, for an email address, its checks (B9).
 */
export function appPipeline(container: Container): Pipeline {
  const models = modelCallDeps(container);
  // The application's statuses follow the job: it opens at the role and is kit_ready with the kit.
  return trackApplications(stagesOf(container, models), container);
}

function stagesOf(container: Container, models: ReturnType<typeof modelCallDeps>): Pipeline {
  return {
    extract: extractStage({
      db: container.db,
      storage: container.storage,
      random: container.random,
      models,
    }),
    // Questions from a form's screenshots the owner added, and their answers (Task 31).
    extract_questions: extractQuestionsStage({
      db: container.db,
      storage: container.storage,
      random: container.random,
      models,
    }),
    draft_answers: draftAnswersStage({ db: container.db, random: container.random, models }),
    eligibility: eligibilityStage({ db: container.db, clock: container.clock, kitOf: kitOfJob }),
    templates: {
      ...templatesStage({ db: container.db, kitOf: kitOfJob }),
      alongside: async (ctx) => besideDraft(await chosenRole(container.db, ctx.job.id)),
    },
    draft: {
      ...draftStage({ db: container.db, random: container.random, models, kitOf: kitOfJob }),
      alongside: async (ctx) => besideDraft(await chosenRole(container.db, ctx.job.id)),
    },
    judge: judgeStage({ db: container.db, random: container.random, models }),
    address_read: addressReadStage({
      db: container.db,
      storage: container.storage,
      random: container.random,
      models,
    }),
    address_checks: addressChecksStage({ db: container.db, dns: container.dns }),
  };
}

/**
 * What runs beside draft (platform spec B9): for a contact the post gives,
 * its second read; for an email address, its checks too. A post with no
 * contact, or one to apply to another way, runs nothing beside.
 */
export function besideDraft(role: Role | null): StageName[] {
  const contact = contactOf(role);
  if (!contact) return [];
  return contact.kind === "email" ? ["address_read", "address_checks"] : ["address_read"];
}
