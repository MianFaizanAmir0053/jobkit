import type { DraftAnswer } from "./kit";

/*
 * For tests: what a fake drafter and a fake separate check answer for the
 * synthetic post S01 (evals/synthetic/records/S01-email-simple.json) on the
 * sample profile. The drafting group's tests and the evaluation's use them.
 */

/** A block's gap fields when it is no gap line. */
export const NO_GAP = {
  requirement_id: "",
  known_line_id: "",
  template_id: "",
  related_fact_id: "",
};

/** What the fake drafter answers for S01: a post line, two claims, a gap line it leaves to code, thanks. */
export const S01_DRAFT: DraftAnswer = {
  fit: [
    { requirement_id: "R1", verdict: "met", fact_ids: ["F-react-production"], note: "" },
    { requirement_id: "R2", verdict: "met", fact_ids: ["F-node-apis"], note: "" },
    { requirement_id: "R3", verdict: "met", fact_ids: ["F-node-apis"], note: "" },
    { requirement_id: "R4", verdict: "gap", fact_ids: [], note: "" },
  ],
  blocks: [
    {
      id: "S1",
      text: "I am applying for the Senior Full-Stack Engineer role at Northwind Analytics.",
      paragraph_break: true,
      class: "post",
      fact_ids: [],
      fields: ["title", "company.name"],
      gap: NO_GAP,
    },
    {
      id: "S2",
      text: "I have built production React and Next.js applications for five years.",
      paragraph_break: false,
      class: "claim",
      fact_ids: ["F-react-production"],
      fields: [],
      gap: NO_GAP,
    },
    {
      id: "S3",
      text: "I have designed and run REST APIs in Node.js against PostgreSQL in production.",
      paragraph_break: true,
      class: "claim",
      fact_ids: ["F-node-apis"],
      fields: [],
      gap: NO_GAP,
    },
    {
      id: "S4",
      text: "",
      paragraph_break: true,
      class: "gap",
      fact_ids: [],
      fields: [],
      gap: {
        ...NO_GAP,
        requirement_id: "R4",
        template_id: "G-not-professional",
        related_fact_id: "F-docker-deploys",
      },
    },
    {
      id: "S5",
      text: "Thank you for your time.",
      paragraph_break: false,
      class: "courtesy",
      fact_ids: [],
      fields: [],
      gap: NO_GAP,
    },
  ],
};

/** The fake judge's verdicts for S01's draft: the claims and the gap line supported. */
export const S01_JUDGED = {
  verdicts: [
    { block_id: "S1", verdict: "not_a_claim", company_claim: false, note: "" },
    { block_id: "S2", verdict: "supported", company_claim: false, note: "" },
    { block_id: "S3", verdict: "supported", company_claim: false, note: "" },
    { block_id: "S4", verdict: "supported", company_claim: false, note: "" },
    { block_id: "S5", verdict: "not_a_claim", company_claim: false, note: "" },
  ],
};
