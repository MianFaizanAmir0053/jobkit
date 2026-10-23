import { describe, expect, it } from "vitest";

import { checkMove, JOB_STATES, type JobState, kindOf, type StageName } from "./jobStates";

// Platform spec B9's table, written out again so the test does not read the code's copy.
const TABLE: Record<JobState, { kind: string; next: JobState[] }> = {
  manual_run: { kind: "owner", next: ["closed"] },
  uploading: { kind: "client", next: ["queued", "upload_failed"] },
  upload_failed: { kind: "owner", next: ["uploading", "closed"] },
  queued: { kind: "running", next: ["extracting"] },
  extracting: {
    kind: "running",
    next: ["needs_role_pick", "checking", "drafting", "stopped", "failed"],
  },
  needs_role_pick: { kind: "waiting", next: ["checking", "closed", "kit_ready"] },
  checking: {
    kind: "running",
    next: ["needs_eligibility_decision", "needs_kit_type", "drafting", "failed"],
  },
  needs_eligibility_decision: { kind: "waiting", next: ["needs_kit_type", "drafting", "closed"] },
  needs_kit_type: { kind: "waiting", next: ["drafting", "closed"] },
  drafting: { kind: "running", next: ["judging", "kit_ready", "drafting", "failed"] },
  judging: { kind: "running", next: ["kit_ready", "failed"] },
  kit_ready: { kind: "ready", next: ["extracting", "drafting", "needs_role_pick"] },
  stopped: { kind: "owner", next: ["extracting", "closed"] },
  failed: {
    kind: "owner",
    next: ["extracting", "checking", "drafting", "judging", "kit_ready", "closed"],
  },
  // Only a take-back of Stop or of "I applied another way" opens a closed job again.
  closed: { kind: "final", next: ["manual_run", "upload_failed", "stopped", "failed"] },
};

// A pending stage each state can be entered with, where it needs one.
const ENTRY_STAGE: Partial<Record<JobState, StageName>> = {
  extracting: "extract",
  checking: "eligibility",
  drafting: "draft",
  judging: "judge",
};

// The stage pending as a running job leaves its state: new form questions on a ready kit
// are the only extraction that goes straight on to drafting, and the templates the only
// drafting that goes straight to a ready kit, or on to draft.
function leavingFor(from: JobState, to: JobState): StageName | null {
  if (from === "extracting") return to === "drafting" ? "extract_questions" : "extract";
  if (from === "drafting") return to === "kit_ready" || to === "drafting" ? "templates" : "draft";
  if (from === "failed" && to === "kit_ready") return "draft";
  return from === "queued" ? null : (ENTRY_STAGE[from] ?? null);
}

// The pending stage a move carries: a failed job keeps the stage it failed at, which closing it
// another way kept, so a take-back opens it again with that stage.
function pendingFor(from: JobState, to: JobState): StageName | null {
  if (from === "closed" && to === "failed") return "draft";
  if (to === "failed") return leavingFor(from, to);
  if (from === "extracting" && to === "drafting") return "draft_answers";
  if (from === "drafting" && to === "drafting") return "draft";
  return ENTRY_STAGE[to] ?? null;
}

describe("job states", () => {
  it("has exactly the spec's states, each of the spec's kind", () => {
    expect([...JOB_STATES].sort()).toEqual(Object.keys(TABLE).sort());
    for (const state of JOB_STATES) expect(kindOf(state)).toBe(TABLE[state].kind);
  });

  it("allows every move in the table and refuses every other", () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        const allowed = TABLE[from].next.includes(to);
        const move = checkMove(from, to, pendingFor(from, to), leavingFor(from, to));
        expect(move.ok, `${from} → ${to}`).toBe(allowed);
      }
    }
  });

  it("enters a running state only with a pending stage that belongs to it", () => {
    expect(checkMove("queued", "extracting", "extract").ok).toBe(true);
    expect(checkMove("kit_ready", "extracting", "extract_questions").ok).toBe(true);
    expect(checkMove("kit_ready", "drafting", "draft_answers").ok).toBe(true);
    expect(checkMove("queued", "extracting", null).ok).toBe(false);
    expect(checkMove("queued", "extracting", "judge").ok).toBe(false);
    expect(checkMove("drafting", "judging", "address_checks").ok).toBe(false);
    expect(checkMove("uploading", "queued", null).ok).toBe(true);
    expect(checkMove("uploading", "queued", "extract").ok).toBe(false);
  });

  it("enters a state that runs nothing with no pending stage, except failed, which keeps the stage that failed", () => {
    expect(checkMove("extracting", "needs_role_pick", "extract").ok).toBe(false);
    expect(checkMove("judging", "kit_ready", null).ok).toBe(true);
    expect(checkMove("drafting", "failed", "draft").ok).toBe(true);
    expect(checkMove("drafting", "failed", null).ok).toBe(false);
    expect(checkMove("drafting", "failed", "judge").ok).toBe(false);
  });

  it("holds the rows of the table that depend on the stage being left", () => {
    // Only new form questions on a ready kit go from extracting straight to drafting.
    expect(checkMove("extracting", "drafting", "draft", "extract").ok).toBe(false);
    expect(checkMove("extracting", "drafting", "draft_answers", "extract").ok).toBe(false);
    expect(checkMove("extracting", "drafting", "draft", "extract_questions").ok).toBe(false);
    expect(checkMove("extracting", "drafting", "draft_answers", "extract_questions").ok).toBe(true);
    expect(checkMove("extracting", "checking", "eligibility", "extract_questions").ok).toBe(false);
    // A new job, and a post the owner confirms, start at extract.
    expect(checkMove("queued", "extracting", "extract_questions").ok).toBe(false);
    expect(checkMove("stopped", "extracting", "extract_questions").ok).toBe(false);
    expect(checkMove("stopped", "extracting", "extract").ok).toBe(true);
    // A failed job keeps the very stage it left.
    expect(checkMove("extracting", "failed", "extract_questions", "extract").ok).toBe(false);
  });

  it("goes from drafting to a ready kit only from the templates, and judges every drafted email", () => {
    expect(checkMove("checking", "drafting", "templates", "eligibility").ok).toBe(true);
    expect(checkMove("drafting", "kit_ready", null, "templates").ok).toBe(true);
    expect(checkMove("drafting", "kit_ready", null, "draft").ok).toBe(false);
    expect(checkMove("drafting", "kit_ready", null, "draft_answers").ok).toBe(false);
    // No template fits: draft writes the email.
    expect(checkMove("drafting", "drafting", "draft", "templates").ok).toBe(true);
    expect(checkMove("drafting", "drafting", "templates", "templates").ok).toBe(false);
    expect(checkMove("drafting", "drafting", "draft", "draft").ok).toBe(false);
    expect(checkMove("drafting", "judging", "judge", "templates").ok).toBe(false);
    expect(checkMove("drafting", "judging", "judge", "draft").ok).toBe(true);
    expect(checkMove("drafting", "failed", "templates", "templates").ok).toBe(true);
    // The owner asks for a Gemini draft beside the templates' (decisions A22).
    expect(checkMove("kit_ready", "drafting", "draft").ok).toBe(true);
  });

  it("retries a failed job only into the running state of the stage it failed at", () => {
    expect(checkMove("failed", "drafting", "draft_answers").ok).toBe(true);
    expect(checkMove("failed", "extracting", "draft").ok).toBe(false);
    expect(checkMove("failed", "closed", null).ok).toBe(true);
    // Back to the templates' drafts, when the Gemini draft the owner asked for, or its check, fails.
    expect(checkMove("failed", "kit_ready", null, "draft").ok).toBe(true);
    expect(checkMove("failed", "kit_ready", null, "judge").ok).toBe(true);
    expect(checkMove("failed", "kit_ready", "draft", "draft").ok).toBe(false);
    for (const stage of [null, "extract", "eligibility", "templates", "address_read"] as const) {
      expect(checkMove("failed", "kit_ready", null, stage).ok, `after ${stage}`).toBe(false);
    }
  });

  it("closes a failed job applied to another way keeping its stage, and opens it again only with it", () => {
    expect(checkMove("failed", "closed", "draft").ok).toBe(true);
    expect(checkMove("closed", "failed", "draft").ok).toBe(true);
    expect(checkMove("closed", "failed", null).ok).toBe(false);
    expect(checkMove("closed", "kit_ready", null).ok).toBe(false);
  });
});
