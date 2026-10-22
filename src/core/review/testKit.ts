import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { answer, fakeLlm, type FakeLlm, type FakeStep } from "@/adapters/fakeLlm";
import type { LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { draftStage } from "@/core/drafting/draftStage";
import { templatesStage } from "@/core/drafting/templatesStage";
import { noTemplateDrafts } from "@/core/drafting/testTemplates";
import type { BlockVerdict } from "@/core/drafting/judge";
import type { DraftAnswer, FormDraftAnswer } from "@/core/drafting/kit";
import { addressReadStage, contactOf } from "@/core/extraction/addressReadStage";
import { chosenRole } from "@/core/extraction/owner";
import { eligibilityStage } from "@/core/extraction/eligibility";
import { extractStage } from "@/core/extraction/extract";
import type { JobRecord } from "@/core/extraction/record";
import { startJob } from "@/core/intake/jobs";
import type { ModelCallDeps } from "@/core/platform/models";
import type { StageName } from "@/core/platform/jobStates";
import { claimJob, type Pipeline, runJob, type StageContext } from "@/core/platform/runner";
import type { Dns } from "@/core/ports";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";

import { addressChecksStage } from "./addressChecksStage";
import { kitOfJob } from "./kitType";

/**
 * Review tests' ready kits: a job pasted as text and run through every
 * stage to its kit, with the synthetic profile, scripted models and the
 * judge's verdicts given. For tests only.
 */

export interface KitBed {
  db: PgliteDb;
  clock: FakeClock;
  storage: LocalStorage;
}

export const SYNTHETIC = join(process.cwd(), "evals", "synthetic");

const random = { bytes: (length: number) => new Uint8Array(length).fill(7) };

const none = { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" };

/** The kit's draft: one sentence, which the judge calls overstated unless told otherwise. */
export const KIT_DRAFT: DraftAnswer = {
  fit: [
    { requirement_id: "R1", verdict: "met", fact_ids: ["F-react-production"], note: "" },
    { requirement_id: "R2", verdict: "met", fact_ids: ["F-node-apis"], note: "" },
    { requirement_id: "R3", verdict: "met", fact_ids: ["F-node-apis"], note: "" },
    { requirement_id: "R4", verdict: "gap", fact_ids: [], note: "" },
  ],
  blocks: [
    {
      id: "S1",
      text: "I have built production React applications for five years.",
      paragraph_break: true,
      class: "claim",
      fact_ids: ["F-react-production"],
      fields: [],
      gap: none,
    },
  ],
};

/**
 * The judge, as a stage that gives these verdicts on the kit; or the output
 * of a kit from before it was built; or one that fails, as a refusal does.
 */
const judging = (verdicts: BlockVerdict[] | "before the judge" | "fails") => ({
  callsModel: false,
  input: () => ({}),
  run: async () =>
    verdicts === "fails"
      ? { ok: false as const, reason: "The separate check failed.", retry: false }
      : {
          ok: true as const,
          output:
            verdicts === "before the judge"
              ? { checked: false }
              : { checked: true, verdicts, markers: [] },
        },
  next: () => ({ state: "kit_ready" as const, pending: null }),
});

/** Empties the tables a kit touches, and seeds the synthetic profile. */
export async function resetKitBed(bed: KitBed): Promise<void> {
  await bed.db.exec(
    `delete from {{schema}}.kit_sends; delete from {{schema}}.kit_reviews;
     delete from {{schema}}.status_changes; delete from {{schema}}.draft_outcomes;
     delete from {{schema}}.applications; delete from {{schema}}.model_calls;
     delete from {{schema}}.job_stage_runs; delete from {{schema}}.job_leases;
     delete from {{schema}}.job_images; delete from {{schema}}.job_state_changes;
     delete from {{schema}}.measurement; delete from {{schema}}.jobs;
     delete from {{schema}}.profile_versions`,
  );
  const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
    read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  await seedProfile(bed, checked);
}

export interface KitOptions {
  /** The draft the model answers with: an email's or a message's, or a form's for a form route. */
  draft?: DraftAnswer | FormDraftAnswer;
  dns?: Dns;
  verdicts?: BlockVerdict[] | "before the judge" | "fails";
  /** Changes the synthetic record extract answers with. */
  record?: (record: JobRecord) => JobRecord;
  /** Drafts from the sample profile's templates too; by default none, so the kit is drafted. */
  templates?: boolean;
  /** Eligibility fails, as with no profile: the round of drafting stops before the templates. */
  eligibilityFails?: boolean;
}

/** A job run to its kit, its post pasted with `text`, the judge calling S1 overstated. */
export async function readyKit(bed: KitBed, text: string, opts: KitOptions = {}): Promise<string> {
  const { db, clock, storage } = bed;
  const started = await startJob(
    { db, clock, storage },
    { images: [], pastedText: text, clientElapsedMs: 0 },
  );
  if (!started.ok) throw new Error(started.message);
  const read = JSON.parse(
    readFileSync(join(SYNTHETIC, "records", "S01-email-simple.json"), "utf8"),
  ) as JobRecord;
  const record = opts.record ? opts.record(read) : read;
  await runKit(bed, started.jobId, [answer(record), answer(opts.draft ?? KIT_DRAFT)], opts);
  return started.jobId;
}

/**
 * Runs a job's pipeline as far as it goes, the models answering with
 * `steps` in turn: as again after the owner asks for a Gemini draft.
 */
export async function runKit(
  bed: KitBed,
  jobId: string,
  steps: readonly FakeStep[],
  opts: KitOptions = {},
): Promise<void> {
  const { db, clock, storage } = bed;
  const llm: FakeLlm = fakeLlm(steps);
  const models: ModelCallDeps = { db, clock, llmFor: () => llm, guard: async () => ({ ok: true }) };
  // Beside drafting, as the app's pipeline runs them: a contact's second read, and an address's
  // checks; none for a form's route, which has no contact.
  const beside = async (ctx: StageContext): Promise<StageName[]> => {
    const contact = contactOf(await chosenRole(db, ctx.job.id));
    if (!contact) return [];
    return contact.kind === "email" ? ["address_read", "address_checks"] : ["address_read"];
  };
  const pipeline: Pipeline = {
    extract: extractStage({ db, storage, random, models }),
    eligibility: opts.eligibilityFails
      ? {
          callsModel: false,
          input: () => ({ failing: true }),
          run: async () => ({ ok: false as const, reason: "Eligibility failed.", retry: false }),
          next: () => ({ state: "drafting" as const, pending: "templates" as const }),
        }
      : eligibilityStage({ db, clock, kitOf: kitOfJob }),
    templates: {
      ...(opts.templates ? templatesStage({ db, kitOf: kitOfJob }) : noTemplateDrafts()),
      alongside: beside,
    },
    draft: {
      ...draftStage({ db, random, models, kitOf: kitOfJob }),
      alongside: beside,
    },
    address_read: addressReadStage({ db, storage, random, models }),
    address_checks: addressChecksStage({ db, dns: opts.dns ?? offlineDns() }),
    judge: judging(
      opts.verdicts ?? [
        { blockId: "S1", verdict: "overstated", companyClaim: false, note: "Five years is more." },
      ],
    ),
  };
  const deps = { db, clock, pipeline };
  const lease = await claimJob(deps, jobId);
  if (!lease) throw new Error("not claimed");
  await runJob(deps, lease);
}
