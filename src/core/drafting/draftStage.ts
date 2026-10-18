import { z } from "zod";

import { readExtractOutput } from "@/core/extraction/extract";
import type { JobRecord, Role } from "@/core/extraction/record";
import { chosenRole } from "@/core/extraction/owner";
import { callModel, type ModelCallDeps, type ModelCallFailure } from "@/core/platform/models";
import type { StageDefinition, StageResult, Transition } from "@/core/platform/runner";
import type { Db, Effort, Random } from "@/core/ports";
import { getActiveProfile, getProfileVersion } from "@/core/profile/profile";
import { SKILLS } from "@/core/shared/skills";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import {
  acceptedInstructions,
  BODY_WORD_LIMIT,
  buildEmailKit,
  buildFormKit,
  buildMessageKit,
  oneLine,
} from "./build";
import {
  type DraftAnswer,
  draftAnswerSchema,
  type FitRow,
  formAnswerSchema,
  type Kit,
  kitTypeOf,
  MESSAGE_LIMIT,
} from "./kit";
import {
  DRAFT_LAYOUT_VERSION,
  draftContent,
  draftSystemPrompt,
  formSystemPrompt,
  messageSystemPrompt,
} from "./prompt";
import { TOPICS } from "./topics";
import { hasWord, type KitFlag, validateKit } from "./validate";

/**
 * The `draft` stage (drafting spec, "Stage draft"): one Gemini 3.8 Flash
 * call with the approved profile and the chosen role's typed fields, never
 * raw post text, for the fit table and the body's blocks. Code then writes
 * the gap lines, and for an email the subject, greeting and closing, for a
 * message the profile's sign-off, and runs the checks; the kit is kept with
 * its flags for the owner to review. WhatsApp and LinkedIn routes get a
 * message kit, a form's routes a form kit, its questions answered as the
 * two classifiers decide; every other route an email kit for now (the
 * kit-type pick comes later). The instructions the owner
 * declines on the review page apply to the kit as it stands, never to a
 * draft, so the declined instructions given here are always none.
 */

export const DRAFT = {
  model: "gemini-3.8-flash",
  // Low since decisions A19: at medium, the owner's first job spent 59 seconds here.
  effort: "low" satisfies Effort,
  maxTokens: 16_000,
} as const;

/**
 * What a stored kit holds beyond the model's answer: the parts code builds,
 * the flags it raises, and what the call is shown. Raise it when any of
 * these change: build.ts, validate.ts, fit.ts, bodyWords in kit.ts, the
 * skill lookup in skills.ts (skillTag and its key), or withoutAiLines
 * below, so an output kept from before is not reused. The skills table's
 * data is hashed whole. The templates stage builds its drafts with the same
 * code, so its input carries this too.
 */
export const BUILD_VERSION = 9;

// The prompt as sent (its rules, the user turn's layout, the output's schema) and the build, for
// each kit; an email's as it always was.
const PROMPTS = {
  email: sha256Hex(
    canonicalJson({
      rules: draftSystemPrompt(0),
      layout: DRAFT_LAYOUT_VERSION,
      schema: z.toJSONSchema(draftAnswerSchema),
      build: BUILD_VERSION,
      skills: SKILLS,
    }),
  ),
  message: sha256Hex(
    canonicalJson({
      kit: "message",
      rules: messageSystemPrompt(0),
      layout: DRAFT_LAYOUT_VERSION,
      schema: z.toJSONSchema(draftAnswerSchema),
      build: BUILD_VERSION,
      skills: SKILLS,
      limit: MESSAGE_LIMIT,
    }),
  ),
  form: sha256Hex(
    canonicalJson({
      kit: "form",
      rules: formSystemPrompt(0),
      layout: DRAFT_LAYOUT_VERSION,
      schema: z.toJSONSchema(formAnswerSchema),
      build: BUILD_VERSION,
      skills: SKILLS,
      topics: TOPICS,
    }),
  ),
} as const;

/**
 * The kit `draft` writes for a route: a message for WhatsApp and LinkedIn, a
 * form for a form's routes, an email for the rest for now.
 */
export function draftKitOf(route: Role["route"]["kind"]): DraftKit {
  const kit = kitTypeOf(route);
  return kit === "message" || kit === "form" ? kit : "email";
}

type DraftKit = "email" | "message" | "form";

/**
 * A message's budget for the model's sentences and the gap lines: its 600
 * characters less the sign-off and the blank line before it, and never under
 * 100, so a long sign-off leaves the model room to write in. validate counts
 * the message as it stands.
 */
function messageBudget(signOff: string): number {
  return Math.max(100, MESSAGE_LIMIT - [...signOff.trim()].length - 2);
}

export const NO_PROFILE =
  "There is no profile yet. Seed it on the laptop with npm run profile:seed, then press Retry.";

const PASSING: ReadonlySet<ModelCallFailure> = new Set(["timeout", "unavailable"]);

export interface DraftOutput {
  kit: Kit;
  fit: FitRow[];
  flags: KitFlag[];
  /** The email body's limit in words; a message's the default one, as no word limit applies to it. */
  wordLimit: number;
  keyword: string | null;
  /**
   * The post's subject format code applied, so validate can run again from
   * what is stored; none for a message, which has no subject.
   */
  subjectFormat: string | null;
  markers: string[];
  profileVersion: string;
  roleId: string;
}

interface DraftInput {
  record: string;
  role: string;
  profile: string | null;
  kit: DraftKit;
  declined: string[];
  model: string;
  effort: Effort;
  prompt: string;
}

export interface DraftDeps {
  db: Db;
  random: Random;
  models: ModelCallDeps;
}

export function draftStage(deps: DraftDeps): StageDefinition {
  return {
    callsModel: true,

    // B9: the record's output hash, the chosen role, the profile version, the kit type, the declined instructions, the model's settings.
    async input(ctx): Promise<DraftInput> {
      const extract = await ctx.outputOf("extract");
      const role = await chosenRole(deps.db, ctx.job.id);
      if (!extract || !role) throw new Error("draft runs only after extract has chosen a role");
      const profile = await getActiveProfile(deps.db);
      const kit = draftKitOf(role.route.kind);
      return {
        record: extract.outputHash,
        role: role.id,
        profile: profile?.versionId ?? null,
        kit,
        declined: [],
        model: DRAFT.model,
        effort: DRAFT.effort,
        prompt: PROMPTS[kit],
      };
    },

    async run(ctx, raw): Promise<StageResult> {
      const input = raw as DraftInput;
      if (input.profile === null) return { ok: false, reason: NO_PROFILE, retry: false };
      const profile = await getProfileVersion(deps.db, input.profile);
      const extraction = readExtractOutput((await ctx.outputOf("extract"))?.output);
      const role = extraction?.record.roles.find((entry) => entry.id === input.role);
      if (!profile || !extraction || !role) {
        throw new Error("draft's input names a profile, record or role that is gone");
      }
      const kitType = input.kit;
      const accepted = acceptedInstructions(role);
      // Only an email has a subject; no word limit applies to a message: the checklist shows them
      // not applied, for the owner to see to. A form's cover note keeps the limit in force.
      const subjectFormat = kitType === "email" ? accepted.subjectFormat : null;
      const wordLimit = kitType === "message" ? BODY_WORD_LIMIT : accepted.wordLimit;
      const post = withoutAiLines(extraction.record, role, accepted.keyword);
      const marker = Buffer.from(deps.random.bytes(16)).toString("hex");
      const budget = messageBudget(profile.signature);
      const call = {
        stage: "draft",
        jobId: ctx.job.id,
        model: input.model,
        effort: input.effort,
        maxTokens: DRAFT.maxTokens,
      } as const;
      const parts = {
        facts: profile.facts,
        knownGaps: profile.knownGaps,
        gapTemplates: profile.gapTemplates,
      };
      let built: { kit: Kit; fit: FitRow[] };
      if (kitType === "form") {
        const called = await callModel(deps.models, {
          ...call,
          system: formSystemPrompt(wordLimit),
          content: draftContent(profile, post, wordLimit, marker, "form"),
          schema: formAnswerSchema,
        });
        if (!called.ok)
          return { ok: false, reason: called.message, retry: PASSING.has(called.reason) };
        built = buildFormKit(called.output, {
          role,
          profile: parts,
          topics: { home: profile.owner.location.country, answers: profile.fixedAnswers },
        });
      } else {
        const called = await callModel(deps.models, {
          ...call,
          system:
            kitType === "message" ? messageSystemPrompt(budget) : draftSystemPrompt(wordLimit),
          content:
            kitType === "message"
              ? draftContent(profile, post, budget, marker, "message")
              : draftContent(profile, post, wordLimit, marker),
          schema: draftAnswerSchema,
        });
        if (!called.ok)
          return { ok: false, reason: called.message, retry: PASSING.has(called.reason) };
        const answer: DraftAnswer = called.output;
        built =
          kitType === "message"
            ? buildMessageKit(answer, { role, signOff: profile.signature, profile: parts })
            : buildEmailKit(answer, {
                record: extraction.record,
                role,
                ownerName: profile.owner.name,
                accepted,
                profile: parts,
              });
      }
      const { kit, fit } = built;
      const flags = validateKit(kit, {
        record: extraction.record,
        role,
        profile: parts,
        fit,
        wordLimit,
        keyword: post.keyword,
        subjectFormat,
        markers: [marker],
      });
      const output: DraftOutput = {
        kit,
        fit,
        flags,
        wordLimit,
        keyword: post.keyword,
        subjectFormat,
        markers: [marker],
        profileVersion: profile.versionId,
        roleId: role.id,
      };
      return { ok: true, output };
    },

    next(): Transition {
      return { state: "judging", pending: "judge" };
    },
  };
}

/**
 * The post's typed fields as the drafting call may see them. The extract
 * prompt records lines aimed at AI as instructions or questions, which the
 * role passed on goes without; a requirement, a title or a company name
 * that repeats such a line, or what it asks for, as whole words, is left
 * out too (the fit check then shows the requirement as not weighed), as is
 * a skill tag that does, and a keyword that does is not taken at all, since
 * the kit could not both use it and leave it out. Lines and values under
 * three characters drop nothing: they would match ordinary words. A line
 * the extractor reworded into a requirement is beyond this check: the
 * markers and the system prompt's rule are the defence there.
 */
export function withoutAiLines(
  record: JobRecord,
  role: Role,
  keyword: string | null,
): { company: string; role: Role; keyword: string | null } {
  const lines = record.roles
    .flatMap((each) => [
      ...each.instructions
        .filter((line) => line.addressed_to_ai)
        .flatMap((line) => [line.text, line.value]),
      ...each.screening_questions.filter((line) => line.addressed_to_ai).map((line) => line.text),
    ])
    .map(oneLine)
    .filter((line) => [...line].length >= 3);
  // Whole words, on one line: "Java" leaves "JavaScript" alone, and a line break hides nothing.
  const touched = (text: string) => lines.some((line) => hasWord(oneLine(text), line));
  return {
    company: touched(record.company.name) ? "" : record.company.name,
    role: {
      ...role,
      title: touched(role.title) ? "" : role.title,
      requirements: role.requirements
        .filter((requirement) => !touched(requirement.text))
        .map((requirement) => ({
          ...requirement,
          skills: requirement.skills.filter((skill) => !touched(skill)),
        })),
      instructions: [],
      // A form's questions as it may see them: none addressed to AI, nor one repeating such a line.
      screening_questions: role.screening_questions.filter(
        (question) => !question.addressed_to_ai && !touched(question.text),
      ),
    },
    keyword: keyword !== null && touched(keyword) ? null : keyword,
  };
}
