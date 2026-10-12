import { createHash } from "node:crypto";

import { z } from "zod";

import { callModel, type ModelCallDeps, type ModelCallFailure } from "@/core/platform/models";
import type { StageDefinition, StageResult, Transition } from "@/core/platform/runner";
import type { Db, Effort, Random, Storage } from "@/core/ports";
import { canonicalJson } from "@/lib/canonicalJson";
import { sha256Hex } from "@/lib/encoding";

import { extractSystemPrompt, LAYOUT_VERSION, postContent } from "./prompt";
import { FLAG_MESSAGES, jobRecordSchema, type RecordFlagKind, SCAM_KINDS } from "./record";
import { backstopSignals } from "./backstop";
import { checkRecord } from "./record";
import { checkRequest, cutTiles } from "./tiles";
import type { JobRecord } from "./record";

/**
 * The `extract` stage (extraction spec, "Stage extract"): one Claude call
 * with every tile of the job's post screenshots, in order, and any pasted
 * text, parsed with the job record's schema. Output that parses but fails a
 * check is kept with its flags, never retried; the phrase backstop adds scam
 * signals the model missed. Where the job goes next follows the record: a
 * post in another language stops, as does one that is not a job post until
 * the owner confirms it is, as does one with no role found, several roles
 * wait for the owner's pick, and a single role goes on to eligibility.
 */

export const EXTRACT = {
  model: "claude-opus-5-5",
  effort: "medium" satisfies Effort,
  maxTokens: 16_000,
} as const;

// The prompt as sent: its rules, the confirmation, the user turn's layout and the output's schema.
const PROMPT = sha256Hex(
  canonicalJson({
    rules: extractSystemPrompt(false),
    confirmed: extractSystemPrompt(true),
    layout: LAYOUT_VERSION,
    schema: z.toJSONSchema(jobRecordSchema),
  }),
);

export const UNREAD_IMAGE = "The screenshots could not be read from storage just now.";
export const MISSING_IMAGE =
  "A screenshot is missing or changed since it was uploaded. Start a new job with the screenshots.";
const CHANGED_IMAGES = "The job's screenshots changed while this step began.";

// An outage or a timeout may pass; a refusal, a bad answer or a full spend cap will not.
const PASSING: ReadonlySet<ModelCallFailure> = new Set(["timeout", "unavailable"]);

export interface ExtractDeps {
  db: Db;
  storage: Storage;
  random: Random;
  models: ModelCallDeps;
}

const flagKinds = Object.keys(FLAG_MESSAGES) as [RecordFlagKind, ...RecordFlagKind[]];

export const extractOutputSchema = z.object({
  record: jobRecordSchema,
  flags: z.array(z.object({ kind: z.enum(flagKinds), path: z.string(), message: z.string() })),
  /** Scam signals the phrase backstop added because the model reported none. */
  backstop: z.array(z.object({ kind: z.enum(SCAM_KINDS), quote: z.string() })),
  /** Where each tile sent sits in its screenshot, so a contact box maps back to it. */
  tiles: z.array(
    z.object({ image: z.number(), top: z.number(), width: z.number(), height: z.number() }),
  ),
  /** Whether the owner had confirmed the post is a job post. */
  postConfirmed: z.boolean(),
});

export type ExtractOutput = z.output<typeof extractOutputSchema>;

/** extract's stored output, or null when it is not one this version can read. */
export function readExtractOutput(output: unknown): ExtractOutput | null {
  const parsed = extractOutputSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

interface ExtractInput {
  images: string[];
  pastedText: string;
  postConfirmed: boolean;
  model: string;
  effort: Effort;
  prompt: string;
}

interface PostImage {
  storagePath: string;
  sha256: string;
}

async function postImages(db: Db, jobId: string): Promise<PostImage[]> {
  const { rows } = await db.query<{ storage_path: string; sha256: string }>(
    `select storage_path, sha256 from {{schema}}.job_images
      where job_id = $1 and purpose = 'post' order by position`,
    [jobId],
  );
  return rows.map((row) => ({ storagePath: row.storage_path, sha256: row.sha256 }));
}

export function extractStage(deps: ExtractDeps): StageDefinition {
  return {
    callsModel: true,

    // B9: the post images' hashes and pasted text, the owner's confirmation, model, effort and prompt.
    async input(ctx): Promise<ExtractInput> {
      const images = await postImages(deps.db, ctx.job.id);
      const { rows } = await deps.db.query<{ pasted_text: string | null; confirmed: boolean }>(
        `select pasted_text, post_confirmed_at is not null as confirmed
           from {{schema}}.jobs where id = $1`,
        [ctx.job.id],
      );
      return {
        images: images.map((image) => image.sha256),
        pastedText: rows[0]?.pasted_text ?? "",
        postConfirmed: rows[0]?.confirmed ?? false,
        model: EXTRACT.model,
        effort: EXTRACT.effort,
        prompt: PROMPT,
      };
    },

    async run(ctx, raw): Promise<StageResult> {
      const input = raw as ExtractInput;
      const images = await postImages(deps.db, ctx.job.id);
      if (images.map((image) => image.sha256).join() !== input.images.join()) {
        return { ok: false, reason: CHANGED_IMAGES, retry: true };
      }
      const bytes: Uint8Array[] = [];
      for (const image of images) {
        let stored: Uint8Array | null;
        try {
          stored = await deps.storage.get(image.storagePath);
        } catch {
          // A passing storage error, not a missing file.
          return { ok: false, reason: UNREAD_IMAGE, retry: true };
        }
        // The hash the input covers must be the bytes the model sees.
        if (!stored || createHash("sha256").update(stored).digest("hex") !== image.sha256) {
          return { ok: false, reason: MISSING_IMAGE, retry: false };
        }
        bytes.push(stored);
      }
      const cut = await cutTiles(bytes);
      if (!cut.ok) return { ok: false, reason: cut.reason, retry: false };
      const fits = checkRequest(cut.tiles, input.pastedText);
      if (!fits.ok) return { ok: false, reason: fits.reason, retry: false };

      const marker = Buffer.from(deps.random.bytes(16)).toString("hex");
      const called = await callModel(deps.models, {
        stage: "extract",
        jobId: ctx.job.id,
        model: input.model,
        system: extractSystemPrompt(input.postConfirmed),
        content: postContent(cut.tiles, input.pastedText, marker),
        schema: jobRecordSchema,
        effort: input.effort,
        maxTokens: EXTRACT.maxTokens,
      });
      if (!called.ok)
        return { ok: false, reason: called.message, retry: PASSING.has(called.reason) };

      const tiles = cut.tiles.map(({ image, top, width, height }) => ({
        image,
        top,
        width,
        height,
      }));
      // Checked as the model wrote it, so a repeated ID is flagged; kept with IDs by position.
      const flags = checkRecord(called.output, tiles);
      const record = numbered(called.output);
      const output: ExtractOutput = {
        record,
        flags,
        backstop: backstopSignals(record, input.pastedText),
        tiles,
        postConfirmed: input.postConfirmed,
      };
      return { ok: true, output };
    },

    next(_ctx, raw): Transition {
      const output = readExtractOutput(raw);
      if (!output) throw new Error("extract's output is not a record this version can read");
      if (stopReasonOf(output) !== null) return { state: "stopped", pending: null };
      if (output.record.roles.length > 1) return { state: "needs_role_pick", pending: null };
      return { state: "checking", pending: "eligibility" };
    },
  };
}

/**
 * Why a record stops its job, or null when the chain goes on: a post in
 * another language (Skip is the only way on), one that is not a job post
 * until the owner confirms it is, and one in which no role was found, which
 * the owner can have read again once (the owner's choice, 2026-10-12).
 */
export type StopReason = "language" | "not_a_job_post" | "no_role";

export function stopReasonOf(output: ExtractOutput): StopReason | null {
  const { record, postConfirmed } = output;
  if (record.language === "other") return "language";
  if (record.post_kind === "not_a_job_post" && !postConfirmed) return "not_a_job_post";
  if (record.roles.length === 0) return "no_role";
  return null;
}

/**
 * The record with its IDs by position, as the spec defines them: roles P1,
 * P2, … and, within each role, requirements R1, … and questions Q1, … A
 * model that repeats an ID is flagged, and the pick, the ledger's key and the
 * fit table still find the right entry.
 */
function numbered(record: JobRecord): JobRecord {
  return {
    ...record,
    roles: record.roles.map((role, i) => ({
      ...role,
      id: `P${i + 1}`,
      requirements: role.requirements.map((requirement, j) => ({
        ...requirement,
        id: `R${j + 1}`,
      })),
      screening_questions: role.screening_questions.map((question, j) => ({
        ...question,
        id: `Q${j + 1}`,
      })),
    })),
  };
}
