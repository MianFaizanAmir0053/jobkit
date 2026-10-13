/**
 * A judge's verdict on one sentence, and whether it holds the kit back: the
 * part of the judge the outbound gate needs, kept apart from the judge's
 * prompt and schemas so the browser can run the gate without them.
 */

export const JUDGE_VERDICTS = ["supported", "overstated", "unsupported", "not_a_claim"] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

export interface BlockVerdict {
  blockId: string;
  verdict: JudgeVerdict;
  companyClaim: boolean;
  note: string;
}

/**
 * The note on a sentence the separate check never weighed, as in a kit from
 * before it was built: the sentence counts as unsupported (drafting spec).
 */
export const NEVER_WEIGHED = "The separate check never weighed this sentence.";

/** Whether a verdict holds the kit back: overstated, unsupported, or a claim about the company. */
export function isBlocking(verdict: BlockVerdict): boolean {
  return (
    verdict.verdict === "overstated" || verdict.verdict === "unsupported" || verdict.companyClaim
  );
}
