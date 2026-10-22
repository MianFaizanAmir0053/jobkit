import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { DraftOutput } from "@/core/drafting/draftStage";
import type { JudgeOutput } from "@/core/drafting/judgeStage";
import type { Db } from "@/core/ports";
import { getProfileVersion } from "@/core/profile/profile";
import { type Fact, factSchema } from "@/core/profile/schema";

import { JUDGE_LABELS, type JudgeLabel } from "./judgeSet";
import { precisionRecall, type PrecisionRecall, type Proportion, wilson } from "./score";

/**
 * Claims from live drafts (evals spec, "Metrics", the judge): `eval:pull`
 * keeps, beside each live case, the claim sentences of its job's draft as
 * drafted, each with the facts it cites frozen as the draft's profile
 * version held them, and what the separate check said of it then
 * (claims.json, never changed once written). The owner labels each once,
 * blind to that verdict, on /dev/label/claims (claim-labels.json beside
 * it). `--stage judge` scores the check as it ran live against the labels,
 * and runs the model under test on them as the judge set is run. The
 * owner's own sentences, and claims citing a fact the version no longer
 * holds, are left out.
 */

export const CLAIMS_FILE = "claims.json";
export const CLAIM_LABELS_FILE = "claim-labels.json";

const claimSchema = z.strictObject({
  blockId: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/),
  sentence: z.string().min(1),
  facts: z.array(factSchema).min(1),
  /** What the separate check said when the draft was made; null where it did not weigh it. */
  liveVerdict: z.string().nullable(),
});

const claimsSchema = z.strictObject({ jobId: z.string(), claims: z.array(claimSchema) });

const labelsSchema = z.record(
  z.string(),
  z.strictObject({ label: z.enum(JUDGE_LABELS), labelledAt: z.string() }),
);

export type LiveClaim = z.output<typeof claimSchema>;

/** A live case's folder name, as eval:pull makes it: nothing else is read or written. */
const LIVE_CASE = /^live-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;

/** The check's verdicts that call a sentence not supported by its facts. */
const NOT_SUPPORTED: ReadonlySet<string> = new Set(["overstated", "unsupported"]);

/** The claim sentences of a job's draft, as drafted, with the facts they cite and the check's verdicts. */
export async function claimsOfJob(db: Db, jobId: string): Promise<LiveClaim[]> {
  // The latest draft, and the latest check of a draft: its verdicts are this draft's only when it
  // ran after it, as block IDs go by place (S1 to Sn) and a draft made again reuses them.
  const { rows } = await db.query<{ stage: string; id: string | number; output: unknown }>(
    `select distinct on (stage) stage, id, output from {{schema}}.job_stage_runs
      where job_id = $1 and outcome in ('ok', 'reused')
        and (stage = 'draft' or (stage = 'judge' and output->'answers' is null))
      order by stage, id desc`,
    [jobId],
  );
  const draftRun = rows.find((row) => row.stage === "draft");
  if (!draftRun) return [];
  const drafted = draftRun.output as DraftOutput;
  const judgeRun = rows.find((row) => row.stage === "judge");
  const judged =
    judgeRun && Number(judgeRun.id) > Number(draftRun.id)
      ? (judgeRun.output as Partial<JudgeOutput>)
      : undefined;
  const profile = await getProfileVersion(db, drafted.profileVersion);
  const facts = new Map((profile?.facts ?? []).map((fact) => [fact.id, fact]));
  const verdicts = new Map(
    (judged?.checked ? (judged.verdicts ?? []) : []).map((verdict) => [
      verdict.blockId,
      verdict.verdict as string,
    ]),
  );
  return drafted.kit.blocks.flatMap((block): LiveClaim[] => {
    if (block.class !== "claim" || block.owner || block.factIds.length === 0) return [];
    if (block.text.trim() === "") return [];
    const cited = block.factIds.map((id) => facts.get(id));
    if (cited.some((fact) => fact === undefined)) return [];
    return [
      {
        blockId: block.id,
        sentence: block.text,
        facts: cited as Fact[],
        liveVerdict: verdicts.get(block.id) ?? null,
      },
    ];
  });
}

/** Writes a case's claims into its folder, once: a case that holds them keeps them as they were. */
export function keepClaims(folder: string, jobId: string, claims: readonly LiveClaim[]): void {
  const file = join(folder, CLAIMS_FILE);
  if (claims.length === 0 || existsSync(file)) return;
  writeFileSync(file, `${JSON.stringify(claimsSchema.parse({ jobId, claims }), null, 2)}\n`);
}

function readLabels(folder: string): z.output<typeof labelsSchema> {
  const file = join(folder, CLAIM_LABELS_FILE);
  if (!existsSync(file)) return {};
  const parsed = labelsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is not a labels file this version can read.`);
  return parsed.data;
}

export interface LabelledClaim extends LiveClaim {
  /** The case and the block, as `<case>/<block>`. */
  id: string;
  caseId: string;
  label: JudgeLabel | null;
  labelledAt: string | null;
}

/** Every live case's claims in the archive, with their labels; a case set aside is not read. */
export function liveClaims(archive: string): LabelledClaim[] {
  if (!existsSync(archive)) return [];
  const claims: LabelledClaim[] = [];
  for (const caseId of readdirSync(archive)
    .filter((name) => LIVE_CASE.test(name))
    .sort()) {
    const folder = join(archive, caseId);
    const file = join(folder, CLAIMS_FILE);
    if (!existsSync(file)) continue;
    const parsed = claimsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error(`${file} is not a claims file this version can read.`);
    const labels = readLabels(folder);
    for (const claim of parsed.data.claims) {
      const given = labels[claim.blockId];
      claims.push({
        ...claim,
        id: `${caseId}/${claim.blockId}`,
        caseId,
        label: given?.label ?? null,
        labelledAt: given?.labelledAt ?? null,
      });
    }
  }
  return claims;
}

/** A claim as the labelling page shows it: never the check's verdict. */
export type ClaimForLabelling = Omit<LabelledClaim, "liveVerdict">;

/** The claims for the labelling page, each named field by field, so the verdict never goes with them. */
export function claimsForLabelling(archive: string): ClaimForLabelling[] {
  return liveClaims(archive).map((claim) => ({
    id: claim.id,
    caseId: claim.caseId,
    blockId: claim.blockId,
    sentence: claim.sentence,
    facts: claim.facts,
    label: claim.label,
    labelledAt: claim.labelledAt,
  }));
}

/** Labels one claim, once: a label never changes, so it stays what the owner judged blind. */
export function labelClaim(
  archive: string,
  caseId: string,
  blockId: string,
  label: JudgeLabel,
  at: Date,
): { ok: true } | { ok: false; reason: "not-found" | "labelled" } {
  if (!LIVE_CASE.test(caseId)) return { ok: false, reason: "not-found" };
  const claim = liveClaims(archive).find(
    (each) => each.caseId === caseId && each.blockId === blockId,
  );
  if (!claim) return { ok: false, reason: "not-found" };
  if (claim.label !== null) return { ok: false, reason: "labelled" };
  const folder = join(archive, caseId);
  const labels = { ...readLabels(folder), [blockId]: { label, labelledAt: at.toISOString() } };
  const file = join(folder, CLAIM_LABELS_FILE);
  writeFileSync(`${file}.next`, `${JSON.stringify(labelsSchema.parse(labels), null, 2)}\n`);
  renameSync(`${file}.next`, file);
  return { ok: true };
}

export interface LiveScore {
  /** The labelled claims the check weighed live. */
  claims: number;
  notSupported: PrecisionRecall;
  accuracy: Proportion;
}

/** The check as it ran live, against the owner's labels: nothing is spent. */
export function scoreLive(claims: readonly LabelledClaim[]): LiveScore {
  const weighed = claims.filter(
    (claim): claim is LabelledClaim & { label: JudgeLabel; liveVerdict: string } =>
      claim.label !== null && claim.liveVerdict !== null,
  );
  const rows = weighed.map((claim) => ({
    predicted: NOT_SUPPORTED.has(claim.liveVerdict),
    actual: claim.label === "not_supported",
  }));
  return {
    claims: weighed.length,
    notSupported: precisionRecall(rows),
    accuracy: wilson(rows.filter((row) => row.predicted === row.actual).length, rows.length),
  };
}
